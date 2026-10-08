#!/usr/bin/env python3
"""
Apps router + scale-to-zero.

Caddy (TLS on-demand on 443) does reverse_proxy of EVERYTHING to this router
(127.0.0.1:9081). The router:
  - reads the Host header -> subdomain label (someone)
  - reads the path -> 1st segment = system name, rest = app path
  - looks up the registry apps.json for the key "<label>/<system>"
  - if the entry has "auth", REQUIRES user/password (HTTP Basic) before
    anything else: a private app doesn't even wake the container for
    whoever isn't authenticated
  - ensures the container is up (docker start if sleeping) and waits for it
    to respond
  - does path-strip and proxies the request to the container (IP:port on
    the bridge)
  - marks activity; a reaper thread stops idle containers (scale-to-zero)

Runs on pure stdlib (the host only has python3, no node).
"""
import base64, hashlib, hmac, json, os, re, secrets, subprocess, threading, time
import urllib.request, urllib.error, http.client, errno
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from html import escape as _attr

REG_PATH     = os.environ.get("BRAMBS_REGISTRY", "/opt/brambs-router/apps.json")
IKEY_PATH    = os.environ.get("BRAMBS_INTERNAL_KEY_FILE", "/opt/brambs-router/internal.key")
USERS_PATH   = os.environ.get("BRAMBS_USERS", "/opt/brambs-router/users.json")
HOME_ROOT    = os.environ.get("BRAMBS_HOME", "/opt/brambs-home")   # <label>.json = home blocks
IDLE_SECONDS = int(os.environ.get("BRAMBS_IDLE_SECONDS", "900"))   # 15 min idle -> sleeps
WAKE_TIMEOUT = int(os.environ.get("BRAMBS_WAKE_TIMEOUT", "20"))    # wait for the container to wake
LISTEN       = ("127.0.0.1", int(os.environ.get("BRAMBS_PORT", "9081")))

# ---- structured logging (sturdy, supports ALL apps) ----
import logging, logging.handlers
LOG_DIR = os.environ.get("BRAMBS_LOG_DIR", "/var/log/brambs")
try:
    os.makedirs(LOG_DIR, exist_ok=True)
except Exception:
    LOG_DIR = "/tmp"
_alog = logging.getLogger("brambs.access")
_alog.setLevel(logging.INFO)
if not _alog.handlers:
    try:
        _fh = logging.handlers.RotatingFileHandler(
            os.path.join(LOG_DIR, "access.log"),
            maxBytes=25 * 1024 * 1024, backupCount=12)
        _fh.setFormatter(logging.Formatter("%(message)s"))
        _alog.addHandler(_fh)
    except Exception:
        pass
    _sh = logging.StreamHandler()
    _sh.setFormatter(logging.Formatter("access %(message)s"))
    _alog.addHandler(_sh)
    _alog.propagate = False

def access_log(rec):
    try:
        _alog.info(json.dumps(rec, ensure_ascii=False, default=str))
    except Exception:
        pass

_lock      = threading.Lock()
_last_seen = {}   # container -> epoch of the last request
_ip_cache  = {}   # container -> ip on the bridge

def load_registry():
    try:
        with open(REG_PATH) as f:
            return json.load(f)
    except Exception:
        return {}


# ---------- access gate (private app) ----------
# Registry entry can have:
#   "auth": {"mode":"basic","user":"...","salt":"...","hash":"sha256(salt:password)"}
# No "auth" = open URL (every app published before 2026-08-31 is like this, and
# stays that way: locking it retroactively would break an already-distributed link).
#
# Internal bypass: the host itself needs to talk to a private app without a
# password (publish's smoke test reads the HTML through the router). Can't
# allow by source IP: Caddy also proxies from 127.0.0.1, meaning ALL
# production traffic arrives from loopback -- allowing loopback would open
# everything. So: a shared secret in a 0600 file, sent in the X-Brambs-Internal
# header, which the router ALWAYS strips before forwarding to the app.

_ikey_cache = {"v": None}

def internal_key():
    if _ikey_cache["v"]:
        return _ikey_cache["v"]
    try:
        with open(IKEY_PATH) as f:
            k = f.read().strip()
        if k:
            _ikey_cache["v"] = k
            return k
    except Exception:
        pass
    # router came up before the first publish: create it (O_EXCL resolves the
    # race with ctl.py, which also tries to create it)
    k = secrets.token_hex(32)
    try:
        os.makedirs(os.path.dirname(IKEY_PATH), exist_ok=True)
        fd = os.open(IKEY_PATH, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as f:
            f.write(k)
    except FileExistsError:
        try:
            with open(IKEY_PATH) as f:
                k = f.read().strip()
        except Exception:
            pass
    except Exception:
        pass
    _ikey_cache["v"] = k
    return k


def _pwhash(salt, password):
    return hashlib.sha256((salt + ":" + password).encode("utf-8")).hexdigest()


def _basic_creds(header):
    """Parses 'Basic base64(user:password)'. Returns (user, password) or (None, None)."""
    if not header:
        return None, None
    parts = header.split(None, 1)
    if len(parts) != 2 or parts[0].lower() != "basic":
        return None, None
    try:
        raw = base64.b64decode(parts[1].strip() + "===", validate=False)
        txt = raw.decode("utf-8", "replace")
    except Exception:
        return None, None
    user, sep, pw = txt.partition(":")
    if not sep:
        return None, None
    return user, pw


def auth_check(app, headers):
    """'ok' (can pass) | 'need' (401). Constant-time comparison."""
    auth = (app or {}).get("auth")
    if not auth or auth.get("mode") != "basic":
        return "ok"
    ik = headers.get("X-Brambs-Internal")
    if ik and hmac.compare_digest(str(ik).strip(), internal_key()):
        return "ok"
    user, pw = _basic_creds(headers.get("Authorization"))
    if user is None:
        return "need"
    u_ok = hmac.compare_digest(user, str(auth.get("user") or ""))
    h_ok = hmac.compare_digest(_pwhash(str(auth.get("salt") or ""), pw),
                               str(auth.get("hash") or ""))
    return "ok" if (u_ok and h_ok) else "need"


def auth_realm(system, auth):
    """Protection space versioned by the active credential, never by its password."""
    token = re.sub(r"[^a-zA-Z0-9_-]", "", str((auth or {}).get("salt") or ""))[:12]
    return "%s: %s%s" % (NOME, (system or "app"), (":" + token) if token else "")

def docker(*args, timeout=30):
    try:
        return subprocess.run(["docker", *args], capture_output=True, text=True, timeout=timeout)
    except Exception:
        class _R: returncode = 1; stdout = ""; stderr = "timeout"
        return _R()

def container_exists(name):
    return docker("inspect", "-f", "{{.State.Status}}", name).returncode == 0

def container_running(name):
    r = docker("inspect", "-f", "{{.State.Running}}", name)
    return r.returncode == 0 and r.stdout.strip() == "true"

def container_ip(name):
    r = docker("inspect", "-f",
               "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}", name)
    return (r.stdout.strip() or None) if r.returncode == 0 else None

def ensure_up(name, port):
    """Starts the container if it's sleeping and waits for it to respond. Returns ip or None."""
    with _lock:
        if not container_exists(name):
            return None
        if not container_running(name):
            docker("start", name)
        ip = container_ip(name)
        _ip_cache[name] = ip
    if not ip:
        return None
    deadline = time.time() + WAKE_TIMEOUT
    while time.time() < deadline:
        try:
            urllib.request.urlopen(f"http://{ip}:{port}/", timeout=2)
            return ip
        except urllib.error.HTTPError:
            return ip            # responded (even an HTTP error) = it's up
        except Exception:
            time.sleep(0.3)
    return ip                    # last attempt, let the proxy handle it

# Host brand: name, site, logo and the badge text. Comes from an optional JSON
# (BRAMBS_MARCA_FILE, default /opt/brambs-router/marca.json, which deploy.sh
# installs when the repository has ops/apps-host/marca.json); without it, the
# neutral brand applies. BRAMBS_SITE_URL and BRAMBS_LOGO_URL from the unit's
# environment take precedence. Read at boot: a new brand takes effect on the
# restart that deploy.sh already does.
MARCA_FILE = os.environ.get("BRAMBS_MARCA_FILE", "/opt/brambs-router/marca.json")
def _marca():
    try:
        with open(MARCA_FILE, encoding="utf-8") as f:
            m = json.load(f)
        return m if isinstance(m, dict) else {}
    except Exception:
        return {}
_m = _marca()
NOME = str(_m.get("nome") or "Brambit")
SITE = os.environ.get("BRAMBS_SITE_URL") or str(_m.get("site") or "http://localhost:8080/")
LOGO = os.environ.get("BRAMBS_LOGO_URL") or str(_m.get("logo") or SITE.rstrip("/") + "/logo.svg")
SELO = str(_m.get("selo") or "Feito com " + NOME)
SELO_ARIA = str(_m.get("selo_aria") or SELO + ", ir para " + NOME)

LANDING = ("<!doctype html><meta charset=utf-8>"
           "<title>" + _attr(NOME) + "</title>"
           "<h1>" + _attr(NOME) + " apps host online</h1>").encode("utf-8")

# Brand badge ("Made with ..."): present on EVERY page served by the host (subdomain
# home AND published apps). Brand colors, logo linking to the home page.
# NEVER floating over the content (2026-09-03): it either sits in the flow at the end
# of the page or takes a reserved 40px STRIP that the app doesn't use.
SELO_HTML = (
    '<a href="' + _attr(SITE) + '" target="_blank" rel="noopener" '
    'aria-label="' + _attr(SELO_ARIA) + '" '
    'style="display:inline-flex;align-items:center;gap:7px;padding:6px 12px;'
    'background:#fffdf8;border:1px solid #e5ddcd;border-radius:999px;'
    'box-shadow:0 2px 10px rgba(43,39,35,.14);'
    'font:500 13px/1.2 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;'
    'color:#2b2723;text-decoration:none">'
    + _attr(SELO, quote=False) +
    '<img src="' + _attr(LOGO) + '" alt="' + _attr(NOME) + '" '
    'style="height:13px;width:auto;display:block"></a>'
)
FOOTER_HTML = (
    '<div style="clear:both;text-align:center;margin:32px 0 20px;padding:0 12px">'
    + SELO_HTML + '</div>'
)

# ---- fullscreen shell (nested viewport) ----
# A fullscreen app (game, canvas, dashboard with html,body{overflow:hidden}) has
# no footer: whatever goes past 100vh is clipped, and a fixed-position badge
# would sit on top of the controls. There's no way to shrink a document's
# viewport with CSS (100vh and window.innerHeight belong to the window). The
# only way for the app to RECEIVE a screen 40px smaller and resize itself (it
# already listens for 'resize') is to serve it inside a nested browsing
# context. So the top document becomes a shell: an iframe taking up
# everything but 40px + the badge strip below. Same origin.
# If the app is a page that SCROLLS, the shell undoes the strip and returns
# the badge to the content flow (the usual behavior) -- decided client-side,
# by measuring.
FRAME_FLAG = "_brambs_frame"
BAR_H = 40

def _strip_frame(rest):
    """Strips the shell marker from the query before proxying to the app."""
    path, _, q = rest.partition("?")
    if not q:
        return rest
    keep = [p for p in q.split("&") if p and not p.startswith(FRAME_FLAG + "=")]
    return path + ("?" + "&".join(keep) if keep else "")

def _blocks_framing(headers):
    """An app that forbids being framed doesn't enter the shell (we honor the header)."""
    for k, v in headers:
        lk = k.lower(); vv = (v or "").lower()
        if lk == "x-frame-options" and "deny" in vv:
            return True
        if lk == "content-security-policy" and "frame-ancestors 'none'" in vv:
            return True
    return False

def shell_page(title, src, extra_head=""):
    return (
        '<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width,initial-scale=1,'
        'viewport-fit=cover">'
        '<title>' + title + '</title>' + extra_head +
        '<style>html,body{margin:0;padding:0;height:100%;overflow:hidden;'
        'background:#fffdf8}'
        '#brambs-shell{position:fixed;inset:0;display:flex;flex-direction:column}'
        '#brambs-app{flex:1 1 auto;min-height:0;width:100%;border:0;display:block}'
        '#brambs-bar{flex:0 0 ' + str(BAR_H) + 'px;height:' + str(BAR_H) + 'px;'
        'display:flex;align-items:center;justify-content:center;'
        'background:#f4eee4;border-top:1px solid #e5ddcd}'
        '</style></head><body><div id="brambs-shell">'
        '<iframe id="brambs-app" title="Aplicativo" src="' + src + '" '
        'allow="fullscreen;clipboard-write;geolocation;camera;microphone" '
        'allowfullscreen></iframe>'
        '<div id="brambs-bar">' + SELO_HTML + '</div></div>'
        '<template id="brambs-tpl">' + FOOTER_HTML + '</template>'
        '<script>(function(){'
        'var f=document.getElementById("brambs-app"),'
        'bar=document.getElementById("brambs-bar"),'
        'tpl=document.getElementById("brambs-tpl");'
        'function adapt(){'
        'var d;try{d=f.contentDocument}catch(e){return}'
        'if(!d||!d.body)return;'
        'var se=d.scrollingElement||d.documentElement;'
        'if(se.scrollHeight<=se.clientHeight+4)return;'   # fullscreen: strip stays
        'bar.style.display="none";'                        # scrolling page: no strip
        'if(!d.getElementById("brambs-footer")){'
        'var w=d.createElement("div");w.id="brambs-footer";'
        'w.appendChild(d.importNode(tpl.content,true));'
        'd.body.appendChild(w)}}'
        'f.addEventListener("load",function(){adapt();setTimeout(adapt,400)});'
        'if(f.contentDocument&&f.contentDocument.readyState==="complete")adapt();'
        '})();</script></body></html>'
    )

def load_users():
    try:
        with open(USERS_PATH) as f:
            return json.load(f)
    except Exception:
        return {}

def _esc(s):
    return (s or "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")

def load_home(label):
    try:
        with open(os.path.join(HOME_ROOT, f"{label}.json")) as f:
            return json.load(f)
    except Exception:
        return {}

def _render_block(b):
    kind = (b.get("kind") or "text").lower()
    title = b.get("title")
    head = f"<h2>{_esc(title)}</h2>" if title else ""
    if kind == "html":
        # content generated by the agent (trusted), embedded raw
        inner = b.get("body") or ""
    elif kind == "link":
        url = b.get("url") or ""
        txt = _esc(b.get("body") or url)
        inner = f'<a href="{_esc(url)}" target="_blank" rel="noopener">{txt}</a>'
    else:  # text -> escapes and preserves line breaks
        inner = _esc(b.get("body") or "").replace("\n", "<br>")
    return f'<section class=block>{head}<div class=body>{inner}</div></section>'

def _systems_for(label):
    """Lists the label's published systems (keys '<label>/<system>' in the registry).
    Returns [(name, private)]. This home is NOT authenticated, so it reveals the
    system NAMES -- the content of private ones stays locked behind the gate. The
    padlock tells the owner which ones are open to the internet."""
    reg = load_registry() or {}
    pref = label + "/"
    out = []
    for key, app in reg.items():
        if key.startswith(pref):
            s = key[len(pref):]
            if s and "/" not in s:
                priv = ((app or {}).get("auth") or {}).get("mode") == "basic"
                out.append((s, priv))
    out.sort()
    return out

def _render_systems(systems):
    if not systems:
        return ""
    cards = ""
    for s, priv in systems:
        pretty = _esc(s.replace("-", " ").replace("_", " "))
        lock = " <span class=sys-lock title='privado: pede usuário e senha'>&#128274;</span>" if priv else ""
        cards += (
            f'<a class=sys href="/{s}/">'
            f'<span class=sys-name>{pretty}{lock}</span>'
            f'<span class=sys-go>abrir &rsaquo;</span></a>'
        )
    return (
        "<section class=block>"
        "<h2>Meus sistemas</h2>"
        f"<div class=sys-grid>{cards}</div>"
        "</section>"
    )

def landing_for(label):
    """Root subdomain home: welcome + automatic box of published systems
    + content the agent has been adding, with the brand's name and logo."""
    name = (load_users().get(label) or "").strip()
    saud = f"Oi, {_esc(name)}." if name else "Oi."
    systems = _systems_for(label)
    blocks = (load_home(label).get("blocks") or [])
    body_parts = _render_systems(systems) + "".join(_render_block(b) for b in blocks)
    if body_parts:
        # has content (systems and/or blocks): greeting becomes a header
        content = (
            "<img class=hlogo src='" + _attr(LOGO) + "' alt='" + _attr(NOME) + "'>"
            f"<header class=home-hd><h1>{saud}</h1>"
            "<p>O que os teus agentes construíram pra você.</p></header>"
            "<main class=blocks>" + body_parts + "</main>"
        )
        layout = "align-items:center;justify-content:flex-start;padding:44px 16px 96px"
    else:
        # empty state: welcome message
        content = (
            "<div class=card>"
            "<img class=hlogo src='" + _attr(LOGO) + "' alt='" + _attr(NOME) + "'>"
            f"<h1>{saud}</h1>"
            "<p>Este é o teu canto no " + _attr(NOME, quote=False) + ". É aqui que os teus agentes montam páginas, "
            "ferramentas e sisteminhas sob medida pra você, tudo num link só, que "
            "você abre de qualquer lugar e compartilha com quem quiser.</p>"
            "<p class=hint>Ainda está vazio. Peça algo a um agente e ele começa a "
            "construir por aqui.</p></div>"
        )
        layout = "align-items:center;justify-content:center;padding:24px 16px 96px"
    html = (
        "<!doctype html><html lang=pt-BR><head><meta charset=utf-8>"
        "<meta name=viewport content='width=device-width,initial-scale=1'>"
        "<title>" + _attr(NOME, quote=False) + "</title>"
        "<style>*{box-sizing:border-box}body{margin:0;min-height:100vh;display:flex;"
        "flex-direction:column;" + layout + ";"
        "background:#f4eee4;color:#2b2723;"
        "font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif}"
        ".hlogo{height:34px;width:auto;display:block;margin:0 auto 22px}"
        ".card{max-width:600px;background:#fffdf8;border:1px solid #e5ddcd;"
        "border-radius:18px;padding:44px 40px;text-align:center;"
        "box-shadow:0 6px 24px rgba(43,39,35,.06)}"
        ".card h1{font-size:1.5rem;margin:0 0 16px;color:#2b2723}"
        ".card p{font-size:1.1rem;line-height:1.6;color:#736c5f;margin:0}"
        ".card .hint{font-size:.98rem;margin-top:16px;color:#a39b89}"
        ".home-hd{max-width:760px;width:100%;margin:0 auto 20px;text-align:center}"
        ".home-hd h1{font-size:1.5rem;margin:0 0 4px;color:#2b2723}"
        ".home-hd p{color:#a39b89;margin:0;font-size:.98rem}"
        ".blocks{max-width:760px;width:100%;margin:0 auto;display:flex;"
        "flex-direction:column;gap:16px}"
        ".block{background:#fffdf8;border:1px solid #e5ddcd;border-radius:14px;"
        "padding:22px 24px;box-shadow:0 3px 14px rgba(43,39,35,.05)}"
        ".block h2{font-size:1.12rem;margin:0 0 10px;color:#2b2723}"
        ".block .body{line-height:1.6;color:#4a453d;word-wrap:break-word}"
        ".block a{color:#c97a52;font-weight:500}"
        ".block img{max-width:100%;height:auto;border-radius:8px}"
        ".sys-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:12px}"
        ".sys{display:flex;flex-direction:column;gap:6px;text-decoration:none;"
        "background:#f7f1e6;border:1px solid #e5ddcd;border-radius:12px;"
        "padding:16px 18px;transition:box-shadow .15s,transform .15s}"
        ".sys:hover{box-shadow:0 4px 16px rgba(43,39,35,.08);transform:translateY(-1px)}"
        ".sys-name{font-size:1.02rem;font-weight:600;color:#2b2723;text-transform:capitalize}"
        ".sys-lock{font-size:.85rem;opacity:.6}"
        ".sys-go{font-size:.9rem;color:#c97a52;font-weight:500}"
        "</style></head><body>" + content + FOOTER_HTML + "</body></html>"
    )
    return html.encode("utf-8")

def _sanitize(s):
    return "".join(c for c in (s or "") if c.isalnum() or c in "-_").lower()

class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "brambs-router"

    def log_message(self, fmt, *args):
        pass  # silent (journald already has it via systemd)

    def _split(self):
        host = (self.headers.get("Host", "") or "").split(":")[0]
        label = _sanitize(host.split(".")[0]) if host else ""
        raw = self.path
        pathonly, q = (raw.split("?", 1) + [""])[:2]
        parts = pathonly.split("/", 2)          # ['', 'sistema', 'resto']
        system = _sanitize(parts[1]) if len(parts) > 1 else ""
        rest = "/" + (parts[2] if len(parts) > 2 else "")
        if q:
            rest += "?" + q
        return label, system, rest

    def _landing(self, code=200, msg=None):
        body = msg if msg is not None else LANDING
        self._status = code
        self.send_response(code)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except Exception:
            pass

    def _unauthorized(self, system, auth=None):
        """401 with a Basic challenge: the browser opens the username/password dialog."""
        body = (
            "<!doctype html><html lang=pt-BR><meta charset=utf-8>"
            "<title>Acesso restrito</title>"
            "<style>body{margin:0;min-height:100vh;display:flex;align-items:center;"
            "justify-content:center;background:#f4eee4;color:#2b2723;font-family:"
            "-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif}"
            ".c{max-width:460px;background:#fffdf8;border:1px solid #e5ddcd;"
            "border-radius:18px;padding:40px;text-align:center}"
            "h1{font-size:1.3rem;margin:0 0 12px}p{color:#736c5f;line-height:1.6;margin:0}"
            "</style><div class=c><h1>Acesso restrito</h1>"
            "<p>Este sistema é privado. Peça o usuário e a senha a quem criou.</p>"
            "</div>"
        ).encode("utf-8")
        self._status = 401
        self._note = "auth_required"
        self.send_response(401)
        # The browser keeps the credential per origin + realm. Versioning the realm
        # with the salt makes a REAL password change open a new challenge, instead
        # of the browser continuing to resend the old password in a 401 loop. ctl
        # preserves the salt when the credential hasn't changed, so a plain
        # republish doesn't knock down valid sessions.
        self.send_header("WWW-Authenticate",
                         'Basic realm="%s", charset="UTF-8"' % auth_realm(system, auth))
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except Exception:
            pass

    def _route(self):
        label, system, rest = self._split()
        # request coming from inside the shell: don't repeat the shell nor inject
        # the badge (in this case, the top document is the one sending the badge)
        self._in_frame = (FRAME_FLAG + "=1") in rest
        if self._in_frame:
            rest = _strip_frame(rest)
        if not system:
            return self._landing(200, landing_for(label))  # root subdomain's default site
        reg = load_registry()
        app = reg.get(f"{label}/{system}")
        if not app:
            return self._landing(404,
                b"<!doctype html><meta charset=utf-8><h1>Sistema nao encontrado</h1>")
        # GATE: before the redirect and before ensure_up, so that a request
        # without credentials doesn't even wake the container (not a cost/DoS vector).
        _gated = bool((app.get("auth") or {}).get("mode") == "basic")
        if _gated and auth_check(app, self.headers) != "ok":
            return self._unauthorized(system, app.get("auth"))
        # Canonical trailing slash at the app's root: ensures relative paths
        # (style.css, app.js, api/...) resolve under /<system>/ and not at the domain root.
        _pathonly = self.path.split("?", 1)[0]
        if _pathonly.rstrip("/") == "/" + system and not _pathonly.endswith("/"):
            _loc = "/" + system + "/"
            if "?" in self.path:
                _loc += "?" + self.path.split("?", 1)[1]
            self._status = 308
            self.send_response(308)
            self.send_header("Location", _loc)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        name = app["container"]
        port = int(app.get("port", 8080))
        ip = ensure_up(name, port)
        if not ip:
            self._note = "wake_fail: ensure_up nao retornou ip"
            return self._landing(502,
                b"<!doctype html><meta charset=utf-8><h1>App indisponivel</h1>")
        _last_seen[name] = time.time()
        # request body (POST/PUT/etc)
        body = None
        clen = self.headers.get("Content-Length")
        if clen:
            try:
                body = self.rfile.read(int(clen))
            except Exception:
                body = None
        url = f"http://{ip}:{port}{rest}"
        # The freshly-woken Node (scale-to-zero) may, on the first burst of
        # connections, not be listening yet (ConnectionRefused) or accept and
        # close without responding (RemoteDisconnected). In these cases NO
        # response byte was read, so retrying is safe. Write safety:
        # ConnectionRefused (never connected) -> retries any method; closed
        # without responding -> retries ONLY idempotent ones (GET/HEAD/OPTIONS),
        # never POST/etc, to avoid risking a duplicate write. Timeout NEVER retries.
        idempotent = self.command in ("GET", "HEAD", "OPTIONS")
        _deadline = time.time() + 8
        attempt = 0
        while True:
            attempt += 1
            req = urllib.request.Request(url, method=self.command, data=body)
            for k, v in self.headers.items():
                lk = k.lower()
                if lk in ("host", "content-length", "connection", "keep-alive",
                          "proxy-connection", "transfer-encoding", "upgrade"):
                    continue
                # internal secret NEVER reaches the app (not even a public app)
                if lk == "x-brambs-internal":
                    continue
                # the gate's credential belongs to the GATE, not the app: if the
                # app has a gate, the Authorization was consumed here and the
                # password doesn't leak to the user's code. An app without a
                # gate keeps receiving it (it may have its own authentication).
                if lk == "authorization" and _gated:
                    continue
                req.add_header(k, v)
            try:
                resp = urllib.request.urlopen(req, timeout=120)
                status, data, headers = resp.status, resp.read(), resp.getheaders()
            except urllib.error.HTTPError as e:
                status, data, headers = e.code, e.read(), e.getheaders()
            except Exception as e:
                reason = getattr(e, "reason", None)
                _en = None
                for _o in (e, reason):
                    _v = getattr(_o, "errno", None)
                    if _v is not None:
                        _en = _v
                        break
                # connection never established (request wasn't even sent) -> safe for ANY method
                connect_fail = (isinstance(e, ConnectionRefusedError) or isinstance(reason, ConnectionRefusedError)
                                or _en in (errno.ECONNREFUSED, errno.EHOSTUNREACH, errno.ENETUNREACH))
                # connected and closed without responding -> ambiguous for writes, idempotent only
                reset = (isinstance(e, (http.client.RemoteDisconnected, ConnectionResetError))
                         or isinstance(reason, (http.client.RemoteDisconnected, ConnectionResetError))
                         or _en == errno.ECONNRESET)
                retryable = connect_fail or (reset and idempotent)
                if retryable and time.time() < _deadline and attempt < 25:
                    time.sleep(0.2)
                    continue
                self._note = "upstream_error: %s: %s (tentativas=%d)" % (type(e).__name__, e, attempt)
                return self._landing(502,
                    b"<!doctype html><meta charset=utf-8><h1>App nao respondeu</h1>")
            if attempt > 1:
                self._note = "cold_start_recovered apos %d tentativa(s)" % attempt
            break
        # Brand badge on HTML responses (only with a plain-text body, no
        # content-encoding: we don't touch gzip/binary).
        #   - top document       -> returns the SHELL (app with a 40px smaller screen)
        #   - inside the shell   -> nothing (the top already shows the badge)
        #   - rest (HTML fragment from fetch, app that forbids iframe) -> badge in the flow
        ctype = ""; cenc = ""
        for k, v in headers:
            lk = k.lower()
            if lk == "content-type": ctype = (v or "").lower()
            elif lk == "content-encoding": cenc = (v or "").lower()
        is_html = ("text/html" in ctype) and not cenc
        in_frame = getattr(self, "_in_frame", False)
        dest = (self.headers.get("Sec-Fetch-Dest") or "").lower()
        if dest in ("iframe", "frame", "embed", "object"):
            in_frame = True
        # top document: modern browser says "document"; without the header
        # (curl, old browser) we fall back to Accept.
        top_doc = (dest == "document") if dest else \
                  ("text/html" in (self.headers.get("Accept") or "").lower())
        if is_html and not in_frame and top_doc and self.command == "GET" \
                and status == 200 and not _blocks_framing(headers):
            try:
                txt = data.decode("utf-8")
                m = re.search(r"<title[^>]*>(.*?)</title>", txt, re.S | re.I)
                title = _esc((m.group(1) if m else system).strip())[:200] or system
                head = ""
                mi = re.search(r'<link[^>]+rel=["\']?[^"\'>]*icon[^>]*>', txt, re.I)
                if mi:
                    head = mi.group(0)
                sep = "&" if "?" in self.path else "?"
                src = _esc(self.path + sep + FRAME_FLAG + "=1").replace('"', "%22")
                shell = shell_page(title, src, head).encode("utf-8")
                self._status = 200
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Cache-Control", "no-store")
                for k, v in headers:      # the app's cookie can't be lost
                    if k.lower() == "set-cookie":
                        self.send_header(k, v)
                self.send_header("Content-Length", str(len(shell)))
                self.end_headers()
                try:
                    self.wfile.write(shell)
                except Exception:
                    pass
                return
            except Exception as e:
                self._note = "shell_fail: %s: %s" % (type(e).__name__, e)
        if is_html and not in_frame:
            try:
                txt = data.decode("utf-8")
                if "brambs-footer" not in txt:
                    inj = "<!--brambs-footer-->" + FOOTER_HTML
                    lower = txt.lower()
                    i = lower.rfind("</body>")
                    if i != -1:
                        txt = txt[:i] + inj + txt[i:]
                    else:
                        txt = txt + inj
                    data = txt.encode("utf-8")
            except Exception:
                pass
        self._status = status
        if status >= 500:
            try:
                self._errbody = data.decode("utf-8", "replace")
            except Exception:
                self._errbody = repr(data[:2000])
        self.send_response(status)
        for k, v in headers:
            if k.lower() in ("transfer-encoding", "connection", "content-length",
                             "keep-alive"):
                continue
            self.send_header(k, v)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        try:
            self.wfile.write(data)
        except Exception:
            pass

    def _handle(self):
        self._status = None
        self._note = None
        self._errbody = None
        self._t0 = time.time()
        try:
            self._label, self._system, _r = self._split()
        except Exception:
            self._label = self._system = ""
        try:
            self._route()
        except Exception as e:
            self._note = "router_exc: %s: %s" % (type(e).__name__, e)
            try:
                self._landing(500,
                    b"<!doctype html><meta charset=utf-8><h1>Erro interno</h1>")
            except Exception:
                pass
        finally:
            try:
                ms = int((time.time() - getattr(self, "_t0", time.time())) * 1000)
                xff = (self.headers.get("X-Forwarded-For", "") or "")
                client = xff.split(",")[0].strip() or self.client_address[0]
                rec = {
                    "ts": round(time.time(), 3),
                    "user": getattr(self, "_label", ""),
                    "app": getattr(self, "_system", ""),
                    "method": self.command,
                    "path": self.path,
                    "status": self._status,
                    "ms": ms,
                    "client": client,
                }
                if self._note:
                    rec["note"] = self._note
                if self._errbody:
                    rec["error"] = self._errbody[:2000]
                access_log(rec)
            except Exception:
                pass

    do_GET = do_POST = do_PUT = do_DELETE = do_PATCH = do_HEAD = do_OPTIONS = _handle

def reaper():
    while True:
        time.sleep(60)
        now = time.time()
        for key, app in load_registry().items():
            name = app.get("container")
            if not name or not container_running(name):
                continue
            last = _last_seen.get(name)
            if last is None:
                _last_seen[name] = now  # grace period: only reaps from the next cycle on
                continue
            if now - last > IDLE_SECONDS:
                docker("stop", name)
                _last_seen.pop(name, None)

def main():
    threading.Thread(target=reaper, daemon=True).start()
    srv = ThreadingHTTPServer(LISTEN, Handler)
    srv.serve_forever()

if __name__ == "__main__":
    main()
