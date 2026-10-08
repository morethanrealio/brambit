#!/usr/bin/env python3
"""
Apps control daemon (control-plane).

DO NOT EDIT ON THIS MACHINE. The source is ops/apps-host/ctl.py in git, deployed
via ops/apps-host/deploy.sh. Editing here gets overwritten on the next deploy.

Since only 443 and 22 are open on the host, the production backend (SP) invokes
this script OVER SSH (port 22), sending ONE JSON command on stdin. No port of
its own. Output = ONE JSON line on stdout: {"ok":true,...} or {"ok":false,"error":...}.

Verbs:
  publish   {label, system, runtime:"node"|"flask", files:{path:b64}, port?, mem?, cpus?, pids?,
             auth?}   -> auth: {"user":..,"password":..} locks the URL (HTTP Basic at the router);
                         {"mode":"none"} opens it; MISSING preserves what was already there (a
                         republish does not unlock a private app by caller oversight)
  set_auth  {label, system, auth}      -> changes/removes the gate without republishing
  inventory {label, system}            -> what user data EXISTS (pre-confirmation of a delete)
  stop      {label, system}
  restart   {label, system}
  delete    {label, system}   -> IRREVERSIBLE: container + code + /app/data + git history
  probe     {label, system?, runtime, files:{path:b64}, port?, mem?, cpus?, pids?, env?}
            -> ephemeral PROOF OF LIFE: brings the code up in a disposable container, checks
               that it stays up and exercises the own app's literal GETs; wipes everything
               at the end. Never touches the published app, its /app/data or its git history.
  logs      {label, system, tail?}
  list      {label?}
  seed_user {label, name}      -> writes label->name to users.json (landing page)

  home_add    {label, kind:"text"|"html"|"link", body, title?, url?}  -> add a block to the home
  home_list   {label}                                                 -> list home blocks
  home_remove {label, id}                                             -> remove 1 block
  home_clear  {label}                                                 -> clear the home (only the default msg)

Runs on plain stdlib (the host only has python3).
"""
import base64, hashlib, hmac, json, os, re, secrets, signal, subprocess, sys, time

APPS_ROOT   = "/opt/brambs-apps"                       # apps code (bind mount)
REG_PATH    = "/opt/brambs-router/apps.json"           # router registry
IKEY_PATH   = "/opt/brambs-router/internal.key"        # secret shared between ctl <-> router
USERS_PATH  = "/opt/brambs-router/users.json"          # label -> name (landing)
HOME_ROOT   = "/opt/brambs-home"                        # <label>.json = user's home blocks
NETWORK     = "brambs-apps"
IMAGE       = "brambs-app-base:latest"
APP_UID     = "10001"
UID_PATH    = "/opt/brambs-ctl/uids.json"            # label -> OS UID per user (isolation)
UID_BASE    = 20000
DEF_PORT    = 8080
DEF_MEM     = "256m"
DEF_CPUS    = "0.5"
DEF_PIDS    = 256
DEF_QUOTA   = "200m"                                   # disk quota per user (free tier)
PROJID_PATH = "/opt/brambs-ctl/projids.json"           # label -> project id (xfs)
PROJID_BASE = 1000
GIT_ROOT    = "/opt/brambs-apps-git"                    # per-app git history (outside the /app mount and the XFS quota)
PROBE_PREFIX = "tst"                                    # prefix of the EPHEMERAL proof-of-life system
PROBE_TTL    = 300                                      # s: a probe older than this is leftover, safe to sweep
PROBE_BUDGET = 75                                       # s: hard cap on a probe (SIGALRM), bounded cost

# Apps domain (<label>.<dominio>/<system>/). Comes in the JSON of each call
# ("dominio"), sent by the backend from its own APPS_DOMAIN, which is the single
# source of truth. Without it (older backend), the environment's APPS_DOMAIN and
# then the default. sudo clears the environment, so the normal path is the JSON.
DOMINIO_PADRAO = "localhost"
DOMINIO = os.environ.get("APPS_DOMAIN") or DOMINIO_PADRAO

# Author of commits with no person behind them: the host's brand name in
# lowercase, read from the same marca.json as the router (see router.py); without
# it, the neutral default.
def _autor_padrao():
    try:
        with open(os.environ.get("BRAMBS_MARCA_FILE", "/opt/brambs-router/marca.json"), encoding="utf-8") as f:
            return str(json.load(f).get("nome") or "Brambit").lower()
    except Exception:
        return "brambit"
AUTOR_PADRAO = _autor_padrao()

def _dominio_valido(d):
    d = str(d or "").strip().lower()
    ok = re.fullmatch(r"[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+", d)
    return d if ok else ""

def _san(s):
    return re.sub(r"[^a-z0-9_-]", "", (s or "").lower())

def cname(label, system):
    return f"brambs-{label}-{system}"

def appdir(label, system):
    return os.path.join(APPS_ROOT, label, system)

def docker(*args, timeout=180, _input=None):
    try:
        return subprocess.run(["docker", *args], capture_output=True, text=True,
                              timeout=timeout, input=_input)
    except Exception as e:
        class _R:
            returncode = 1; stdout = ""; stderr = str(e)
        return _R()

def load_json(path):
    try:
        with open(path) as f:
            return json.load(f)
    except Exception:
        return {}

def save_json(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.replace(tmp, path)

def container_ip(name):
    r = docker("inspect", "-f",
               "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}", name)
    return (r.stdout.strip() or None) if r.returncode == 0 else None

def _healthcheck(name, port, tries=14, delay=0.6):
    """Post-publish: checks whether the container stays up.
    {"state":"ok"|"crashed"|"nostart", "exit_code":int|None}.
    'crashed' = exited (exit != 0, or exit 0 right after starting, abnormal for web).
    'ok' = up (and, if it managed to, responded over HTTP). 'nostart' = unconfirmed."""
    import urllib.request, urllib.error
    ip = None
    for _ in range(tries):
        r = docker("inspect", "-f", "{{.State.Status}}|{{.State.ExitCode}}", name)
        st = (r.stdout or "").strip()
        status, _, code = st.partition("|")
        if status == "exited":
            try:
                ec = int(code)
            except Exception:
                ec = None
            return {"state": "crashed", "exit_code": ec}
        if status == "running":
            if ip is None:
                ip = container_ip(name)
            if ip:
                try:
                    urllib.request.urlopen("http://%s:%d/" % (ip, port), timeout=2)
                    return {"state": "ok", "exit_code": None}
                except urllib.error.HTTPError:
                    return {"state": "ok", "exit_code": None}
                except Exception:
                    pass
        time.sleep(delay)
    r = docker("inspect", "-f", "{{.State.Status}}", name)
    if (r.stdout or "").strip() == "running":
        return {"state": "ok", "exit_code": None}
    return {"state": "nostart", "exit_code": None}


# ---------- smoke test / path normalization ----------
# Apps run under a SUBPATH (label.<dominio>/system/). An absolute path
# (starting with "/") in HTML/JS breaks: the browser looks under the domain
# root and the router doesn't find it. Here we (1) normalize absolute path ->
# relative in the files the agent sent, and (2) test through the router
# whether the assets actually load before marking the app as published.
import re as _re, http.client as _httpc

_ATTR_ABS = _re.compile(r'(\b(?:href|src)\s*=\s*["\'])/(?=[^/"\'])')
_FETCH_ABS = _re.compile(r'(fetch\(\s*["\'`])/(?=[^/"\'`])')
_REF_RE = _re.compile(r'\b(?:href|src)\s*=\s*["\']([^"\']+)["\']', _re.I)
_FETCH_REF_RE = _re.compile(r'\bfetch\(\s*["\']([^"\']+)["\']', _re.I)
_SAFE_SMOKE_REF = _re.compile(r'(?:^|/)(?:status|health|healthz|ping)(?:[/?#]|$)', _re.I)
# BROAD mode (only in the ephemeral probe): captures the whole fetch() call so we
# can require it to be provably GET. The literal has to be the entire argument,
# so concatenation ("/api/" + id) and ${} templates are excluded on their own.
_FETCH_CALL_RE = _re.compile(r'\bfetch\(\s*["\']([^"\'\n]{1,300})["\']\s*([),])')
_METHOD_RE = _re.compile(r'method\s*:\s*["\']([A-Za-z]+)["\']')


def _colher_gets(txt):
    """Literal fetch() refs that are provably GET.
    No second argument = GET by definition. With a second argument, only passes
    if method:"GET" is written; when in doubt the probe does NOT call it (a user
    app's POST/DELETE may write, and the probe can never have a side effect)."""
    out = []
    for m in _FETCH_CALL_RE.finditer(txt):
        ref, sep = m.group(1), m.group(2)
        if "${" in ref:
            continue
        if sep == ",":
            # the window is only PEEKED at, never consumed: consuming it would
            # hide the next match from the same regex and the probe would stop
            # exercising it.
            mm = _METHOD_RE.search(txt[m.end():m.end() + 200])
            if not mm or mm.group(1).upper() != "GET":
                continue
        out.append(ref)
    return out


def _autofix_paths(files):
    """Normalizes absolute path -> relative in .html/.htm/.js/.mjs.
    Returns (new_files, list_of_changed_files)."""
    fixed = []
    out = dict(files)
    for rel, b64 in files.items():
        low = rel.lower()
        if not (low.endswith(".html") or low.endswith(".htm") or
                low.endswith(".js") or low.endswith(".mjs")):
            continue
        try:
            txt = base64.b64decode(b64).decode("utf-8")
        except Exception:
            continue
        new = txt
        if low.endswith(".html") or low.endswith(".htm"):
            new = _ATTR_ABS.sub(r'\1', new)
        new = _FETCH_ABS.sub(r'\1', new)
        if new != txt:
            out[rel] = base64.b64encode(new.encode("utf-8")).decode("ascii")
            fixed.append(rel)
    return out, fixed


# ---------- access gate (HTTP Basic at the router) ----------
# A new app is born PRIVATE: the public URL asks for a username and password
# BEFORE the router wakes the container. The password is NOT kept in the clear
# here: we store sha256(salt+password) in the registry, and the backend keeps
# the encrypted password (so it can show it to the owner and so the assistant
# itself can call the app). See web/db.mjs (access_pass_enc).
#
# sha256 with salt (not pbkdf2/scrypt) on purpose: the router checks on EVERY
# request (including every asset), passwords are generated by us with high
# entropy (~57 bits), and the derivation cost would turn into latency on every
# page. If we ever accept a user-chosen password, this has to become pbkdf2.

def internal_key():
    """Secret shared between ctl <-> router, so an internal call passes the
    gate (the publish smoke test needs to read the HTML of a private app).
    Created on first use, 0600. The O_EXCL + re-read resolves the race with the
    router, which also tries to create it."""
    try:
        with open(IKEY_PATH) as f:
            k = f.read().strip()
            if k:
                return k
    except Exception:
        pass
    k = secrets.token_hex(32)
    try:
        os.makedirs(os.path.dirname(IKEY_PATH), exist_ok=True)
        fd = os.open(IKEY_PATH, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as f:
            f.write(k)
        return k
    except FileExistsError:
        try:
            with open(IKEY_PATH) as f:
                return f.read().strip()
        except Exception:
            return k
    except Exception:
        return k


def _pwhash(salt, password):
    return hashlib.sha256((salt + ":" + password).encode("utf-8")).hexdigest()


def _auth_entry(spec, prev=None):
    """Translates the backend's request into the registry's 'auth' entry.
      None            -> preserves what was already there (a republish doesn't unlock by omission)
      {"mode":"none"} -> removes the gate (public app)
      {user,password} -> new Basic gate
    Returns None when there is no gate."""
    if spec is None:
        return (prev or {}).get("auth")
    if not isinstance(spec, dict):
        return (prev or {}).get("auth")
    if spec.get("mode") == "none" or spec.get("public") is True:
        return None
    user = (spec.get("user") or "").strip()
    pw = spec.get("password") or ""
    if not user or not pw:
        return (prev or {}).get("auth")
    # Republishing a private app resends the SAME credential that is already in
    # the database. Also preserve the salt in that case: the router uses this
    # value to version the HTTP Basic realm. Re-salting on every publish would
    # make the browser forget a valid credential and ask for login again even
    # though the password hasn't changed.
    old = (prev or {}).get("auth") or {}
    if old.get("mode") == "basic" and hmac.compare_digest(
            user, str(old.get("user") or "")):
        old_hash = str(old.get("hash") or "")
        candidate = _pwhash(str(old.get("salt") or ""), pw)
        if old_hash and hmac.compare_digest(candidate, old_hash):
            return old
    salt = secrets.token_hex(8)
    return {"mode": "basic", "user": user, "salt": salt, "hash": _pwhash(salt, pw)}


def _internal_headers(label):
    return {"Host": "%s.%s" % (label, DOMINIO),
            "X-Brambs-Internal": internal_key()}


def _router_get(label, path):
    try:
        conn = _httpc.HTTPConnection("127.0.0.1", 9081, timeout=4)
        conn.request("GET", path, headers=_internal_headers(label))
        r = conn.getresponse()
        st = r.status
        r.read(1)
        conn.close()
        return st
    except Exception:
        return 0


def _router_html(label, system):
    try:
        conn = _httpc.HTTPConnection("127.0.0.1", 9081, timeout=6)
        conn.request("GET", "/%s/" % system, headers=_internal_headers(label))
        r = conn.getresponse()
        ct = (r.getheader("Content-Type") or "").lower()
        body = r.read(400000)
        conn.close()
        if "text/html" not in ct:
            return None
        return body.decode("utf-8", "replace")
    except Exception:
        return None


def _smoketest(label, system, amplo=False):
    """Fetches the HTML served by the router, resolves refs the way a browser
    under /system/ would, and checks whether each asset loads. .css/.js assets
    that don't return 200 = broken_critical (they break the page); the rest =
    broken_other.

    amplo=True can ONLY be used on the EPHEMERAL path (probe verb): there the
    container and /app/data are discarded at the end, so every literal GET of
    the app can be exercised (catching things like /api/pign, which the
    conservative set lets through). On publish the target is the user's REAL
    data, so the narrow allowlist still applies."""
    html = _router_html(label, system)
    if html is None:
        return {}  # no HTML to check (e.g. pure API) -> doesn't block
    crit, other, seen = [], [], set()
    for ref in _REF_RE.findall(html)[:40]:
        ref = ref.strip()
        if not ref or ref[0] in "#?":
            continue
        low = ref.lower()
        if low.startswith(("http://", "https://", "//", "data:", "mailto:",
                           "tel:", "javascript:")):
            continue
        if ref.startswith("/"):
            path = ref
        else:
            r2 = ref[2:] if ref.startswith("./") else ref
            path = "/%s/%s" % (system, r2)
        if path in seen:
            continue
        seen.add(path)
        st = _router_get(label, path)
        if st != 200:
            base = ref.split("?", 1)[0].lower()
            (crit if base.endswith((".css", ".js")) else other).append(
                {"ref": ref, "status": st})
    functional, functional_warnings = [], []
    # Best-effort functional API smoke: declared status/health/ping fetches are
    # exercised through the real router. This catches a booting server whose
    # diagnostic API contract is already broken without calling business routes.
    colher = _colher_gets if amplo else (lambda t: _FETCH_REF_RE.findall(t))
    limite = 24 if amplo else 40
    fetch_refs = list(colher(html))
    root = appdir(label, system)
    scanned = 0
    try:
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = [d for d in dirnames if d not in ("node_modules", ".git", "data")]
            for fn in filenames:
                if scanned >= 80 or len(fetch_refs) >= limite:
                    break
                if not fn.lower().endswith((".js", ".mjs")):
                    continue
                scanned += 1
                p = os.path.join(dirpath, fn)
                if os.path.getsize(p) > 400000:
                    continue
                with open(p, encoding="utf-8", errors="replace") as source:
                    fetch_refs.extend(colher(source.read()))
            if scanned >= 80 or len(fetch_refs) >= limite:
                break
    except Exception:
        pass
    for ref in fetch_refs[:limite]:
        ref = ref.strip()
        if not ref or ref[0] in "#?" or ref.lower().startswith((
                "http://", "https://", "//", "data:", "javascript:")):
            continue
        # Never execute an arbitrary app endpoint during publish: old user apps
        # may (incorrectly) mutate on GET. Only explicit diagnostic conventions
        # are safe enough for an automatic smoke request.
        if not amplo and not _SAFE_SMOKE_REF.search(ref.split("?", 1)[0]):
            continue
        if ref.startswith("/"):
            path = ref
        else:
            r2 = ref[2:] if ref.startswith("./") else ref
            path = "/%s/%s" % (system, r2)
        if path in seen:
            continue
        seen.add(path)
        st = _router_get(label, path)
        item = {"ref": ref, "status": st}
        if st == 0 or st == 404 or st >= 500:
            functional.append(item)
        elif st >= 400:
            functional_warnings.append(item)
    res = {}
    if crit:
        res["broken_critical"] = crit
    if other:
        res["broken_other"] = other
    if functional:
        res["broken_functional"] = functional
    if functional_warnings:
        res["functional_warnings"] = functional_warnings
    return res



# ---------- disk quota (XFS project quota per user) ----------
# /opt/brambs-apps is an XFS image mounted with prjquota. Each user (label)
# becomes a "project" whose tree is APPS_ROOT/<label>; bhard limits the SUM of
# all of their apps. New files inherit the parent dir's projid (XFS behavior).

def _xfsq(cmd):
    try:
        return subprocess.run(["xfs_quota", "-x", "-c", cmd, APPS_ROOT],
                              capture_output=True, text=True, timeout=30)
    except Exception:
        class _R:
            returncode = 1; stdout = ""; stderr = ""
        return _R()

def _projid_for(label):
    m = load_json(PROJID_PATH)
    if label in m:
        return int(m[label])
    used = [int(v) for v in m.values()]
    pid = (max(used) + 1) if used else PROJID_BASE
    m[label] = pid
    save_json(PROJID_PATH, m)
    return pid

def ensure_quota(label, quota=None):
    quota = str(quota or DEF_QUOTA)
    if quota.isdigit():  # no unit -> assume MB (otherwise XFS reads it as bytes and zeroes the quota)
        quota = quota + "m"
    udir = os.path.join(APPS_ROOT, label)
    os.makedirs(udir, exist_ok=True)
    _projid_for(label)
    m = load_json(PROJID_PATH)
    try:
        with open("/etc/projid", "w") as f:
            for lb, i in m.items():
                f.write("%s:%s\n" % (lb, i))
        with open("/etc/projects", "w") as f:
            for lb, i in m.items():
                f.write("%s:%s\n" % (i, os.path.join(APPS_ROOT, lb)))
    except Exception:
        pass
    _xfsq("project -s %s" % label)
    _xfsq("limit -p bhard=%s %s" % (quota, label))

def quota_usage(label):
    r = _xfsq("report -p -N -b")
    if getattr(r, "returncode", 1) != 0:
        return None
    for line in (r.stdout or "").splitlines():
        q = line.split()
        if q and q[0] == label:
            try:
                return {"used_mb": round(int(q[1]) / 1024, 1),
                        "hard_mb": round(int(q[3]) / 1024)}
            except Exception:
                return None
    return None

# ---------- per-app secrets (env injection on boot) ----------
# The real secret value comes encrypted from the backend, decrypted there, and
# arrives here in plain text in the command JSON (SSH channel, ephemeral).
# Becomes -e on the container. NEVER written to disk on the host (doesn't go to
# /app, so it doesn't leak in snapshot/replica).
RE_ENVKEY = re.compile(r"^[A-Z_][A-Z0-9_]*$")

def _env_flags(env):
    flags = []
    if not isinstance(env, dict):
        return flags
    for k, v in env.items():
        k = str(k)
        if k == "PORT" or not RE_ENVKEY.match(k):
            continue
        val = "" if v is None else str(v)
        if len(k) > 128 or len(val) > 8192:
            continue
        flags += ["-e", "%s=%s" % (k, val)]
    return flags

def _uid_for(label):
    """Exclusive OS UID per user (label). Persisted map; allocated on demand
    starting from UID_BASE. Second lock beyond Docker: each user's files on
    the host have their own owner, so even with a container isolation failure
    one app can't read another user's data (Phase 4)."""
    m = load_json(UID_PATH)
    if label in m:
        return int(m[label])
    used = [int(v) for v in m.values()]
    uid = (max(used) + 1) if used else UID_BASE
    m[label] = uid
    save_json(UID_PATH, m)
    return uid


def _run_container(name, runtime, port, mem, cpus, pids, d, env, uid):
    docker("rm", "-f", name)  # recreate from scratch
    # /app/data: durable directory reserved for runtime DATA (SQLite,
    # uploads). It's outside the code plane; not sent on publish and not
    # included in the snapshot, so the data NEVER travels in replication (Phase 2).
    try:
        _dd = os.path.join(d, "data")
        os.makedirs(_dd, exist_ok=True)
        subprocess.run(["chown", "%s:%s" % (uid, uid), _dd])
    except Exception:
        pass
    if runtime == "node":
        cmd = ["node", "--experimental-sqlite", "--disable-warning=ExperimentalWarning", "/app/server.js"]
    else:  # flask -> gunicorn app:app
        cmd = ["gunicorn", "--bind", "0.0.0.0:8080", "--chdir", "/app",
               "--workers", "1", "--timeout", "60", "app:app"]
    return docker(
        "run", "-d", "--name", name,
        "--network", NETWORK,
        "--restart", "no",
        "--memory", str(mem), "--memory-swap", str(mem),
        "--cpus", str(cpus), "--pids-limit", str(pids),
        "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
        "--user", "%d:%d" % (int(uid), int(uid)),
        "-e", "PORT=%d" % int(port), "-e", "HOME=/tmp",
        *_env_flags(env),
        "-v", "%s:/app" % d,
        "-w", "/app",
        IMAGE, *cmd,
    )

# ---------- versioning (git per app) ----------
# Each app has a git repo at GIT_ROOT/<label>/<system>.git, with the work-tree
# pointing at appdir. It's OUTSIDE the /app bind (the container doesn't see the
# .git) and OUTSIDE the XFS image (doesn't count against the user's quota).
# data/ (runtime data) is ignored via info/exclude, so it never enters a commit
# nor is touched by a rollback.

def _gitdir(label, system):
    return os.path.join(GIT_ROOT, label, system + ".git")

def _gitrun(gd, wt, args, author=None, timeout=40):
    cmd = ["git", "--git-dir", gd, "--work-tree", wt, "-c", "safe.directory=*"]
    env = dict(os.environ)
    who = (str(author) if author else AUTOR_PADRAO)[:80] or AUTOR_PADRAO
    env["GIT_AUTHOR_NAME"] = who
    env["GIT_COMMITTER_NAME"] = who
    env["GIT_AUTHOR_EMAIL"] = "apps@" + DOMINIO
    env["GIT_COMMITTER_EMAIL"] = "apps@" + DOMINIO
    try:
        return subprocess.run(cmd + list(args), capture_output=True, text=True,
                              timeout=timeout, env=env)
    except Exception as e:
        class _R:
            returncode = 1; stdout = ""; stderr = str(e)
        return _R()

def _git_ensure(label, system):
    gd = _gitdir(label, system)
    wt = appdir(label, system)
    if not os.path.isdir(gd):
        os.makedirs(os.path.dirname(gd), exist_ok=True)
        subprocess.run(["git", "init", "--bare", gd], capture_output=True, text=True)
        # non-bare to allow work-tree operations (checkout/reset)
        subprocess.run(["git", "--git-dir", gd, "config", "core.bare", "false"],
                       capture_output=True, text=True)
        try:
            with open(os.path.join(gd, "info", "exclude"), "a") as f:
                f.write("\ndata/\n")
        except Exception:
            pass
    return gd, wt

def _exclude_add(gd, paths):
    """Appends paths to the app repo's info/exclude, without duplicating. Lives
    in the repo (not the work-tree): the app never sees it, and it doesn't
    travel in the publish payload."""
    p = os.path.join(gd, "info", "exclude")
    try:
        cur = open(p).read().splitlines() if os.path.exists(p) else []
    except Exception:
        cur = []
    novos = [x for x in paths if x and x not in cur]
    if not novos:
        return []
    try:
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "a") as f:
            f.write("\n" + "\n".join(novos) + "\n")
    except Exception:
        return []
    return novos

def _runtime_leftovers(gd, wt, code_paths):
    """Files that are in appdir, are NOT in git, and were NOT sent by the
    assistant in this publication. The publish payload is always the whole app
    (the draft reseeds from the snapshot), so a file outside of it was created
    by the running app = runtime data written outside /app/data.

    Returns (list of lines for exclude, list of paths for the warning). Only
    looks at UNTRACKED: an already-versioned file is never touched here, so
    code never gets unversioned by mistake."""
    r = _gitrun(gd, wt, ["ls-files", "--others", "--exclude-standard", "-z"])
    if r.returncode != 0:
        return [], []
    novos = [x for x in (r.stdout or "").split("\0") if x]
    sobra = [x for x in novos if x not in code_paths]
    if not sobra:
        return [], []
    # if the top-level directory has NO code file at all, exclude the directory
    # (uploads grow; a per-file entry would bloat the exclude on every publish).
    dirs_codigo = set(p.split("/", 1)[0] for p in code_paths if "/" in p)
    regras, avisos = [], []
    for rel in sorted(sobra)[:200]:
        top = rel.split("/", 1)[0] if "/" in rel else None
        if top and top not in dirs_codigo:
            regra = top + "/"
        else:
            regra = rel
        if regra not in regras:
            regras.append(regra)
        avisos.append(rel)
    return regras, avisos

def _git_commit(label, system, author=None, message=None, code_paths=None):
    """Best-effort: records the current appdir state as a version. Never
    raises; if it goes wrong, it just doesn't version (doesn't block the
    publish).

    With code_paths (what the assistant sent), whatever's left over in appdir
    is runtime data: it goes into info/exclude BEFORE the add, so it's never
    versioned nor rewound by a rollback. Same contract data/ has always had."""
    try:
        gd, wt = _git_ensure(label, system)
        fora = []
        if code_paths:
            regras, fora = _runtime_leftovers(gd, wt, set(code_paths))
            if regras:
                _exclude_add(gd, regras)
        _gitrun(gd, wt, ["add", "-A"])
        r = _gitrun(gd, wt, ["commit", "-m", (message or "publicacao")[:200]], author=author)
        out = {"versioned": r.returncode == 0}
        if fora:
            out["fora_do_data"] = fora[:20]
        return out
    except Exception as e:
        return {"versioned": False, "error": str(e)[:200]}

def _read_tree_files(wt, gd=None):
    """Reads the app's CODE as {rel: b64}, to return to the backend so it can
    update the library snapshot after a rollback.

    Source of truth = what's VERSIONED (git ls-files): runtime data is in
    info/exclude, so it doesn't enter the snapshot nor travel in replication.
    Falls back to a directory walk (minus data/) if git fails."""
    if gd and os.path.isdir(gd):
        r = _gitrun(gd, wt, ["ls-files", "-z"])
        if r.returncode == 0:
            files = {}
            for rel in (r.stdout or "").split("\0"):
                if not rel:
                    continue
                try:
                    with open(os.path.join(wt, rel), "rb") as f:
                        files[rel] = base64.b64encode(f.read()).decode("ascii")
                except Exception:
                    pass
            if files:
                return files
    files = {}
    for root, dirs, fnames in os.walk(wt):
        if root == wt and "data" in dirs:
            dirs.remove("data")
        for fn in fnames:
            fp = os.path.join(root, fn)
            rel = os.path.relpath(fp, wt)
            try:
                with open(fp, "rb") as f:
                    files[rel] = base64.b64encode(f.read()).decode("ascii")
            except Exception:
                pass
    return files

def v_git_log(c):
    label, system = _san(c.get("label")), _san(c.get("system"))
    gd, wt = _gitdir(label, system), appdir(label, system)
    if not os.path.isdir(gd):
        return {"ok": True, "commits": []}
    try:
        limit = min(max(int(c.get("limit") or 20), 1), 100)
    except Exception:
        limit = 20
    r = _gitrun(gd, wt, ["log", "--pretty=format:%h%x1f%an%x1f%cI%x1f%s", "-n", str(limit)])
    if r.returncode != 0:
        return {"ok": True, "commits": []}
    commits = []
    for line in (r.stdout or "").splitlines():
        p = line.split("\x1f")
        if len(p) == 4:
            commits.append({"hash": p[0], "author": p[1], "date": p[2], "message": p[3]})
    return {"ok": True, "commits": commits}

def v_git_diff(c):
    label, system = _san(c.get("label")), _san(c.get("system"))
    gd, wt = _gitdir(label, system), appdir(label, system)
    if not os.path.isdir(gd):
        return {"ok": False, "error": "sem historico ainda"}
    ref = re.sub(r"[^0-9a-zA-Z_^~-]", "", str(c.get("ref") or "HEAD"))[:60] or "HEAD"
    r = _gitrun(gd, wt, ["show", "--stat", "--patch", "--format=%h %an %cI%n%s%n", ref])
    if r.returncode != 0:
        return {"ok": False, "error": ((r.stderr or "").strip() or "versao nao encontrada")[:200]}
    out = r.stdout or ""
    truncated = len(out) > 12000
    return {"ok": True, "diff": out[:12000], "truncated": truncated}

def v_git_rollback(c):
    label, system = _san(c.get("label")), _san(c.get("system"))
    gd, wt = _gitdir(label, system), appdir(label, system)
    if not os.path.isdir(gd):
        return {"ok": False, "error": "sem historico ainda"}
    ref = re.sub(r"[^0-9a-zA-Z_^~-]", "", str(c.get("ref") or ""))[:60]
    if not ref:
        return {"ok": False, "error": "versao invalida"}
    chk = _gitrun(gd, wt, ["rev-parse", "--verify", ref + "^{commit}"])
    if chk.returncode != 0:
        return {"ok": False, "error": "versao nao encontrada"}
    target = (chk.stdout or "").strip()
    head = (_gitrun(gd, wt, ["rev-parse", "HEAD"]).stdout or "").strip()
    # the worktree becomes exactly the target version (removes files that
    # didn't exist in it; data/ is ignored, so runtime data stays intact).
    r1 = _gitrun(gd, wt, ["reset", "--hard", target])
    if r1.returncode != 0:
        return {"ok": False, "error": "falha no reset: " + ((r1.stderr or "").strip())[:200]}
    # moves HEAD back to the tip while keeping the reverted content, and records
    # a new commit representing the rollback (preserves history, doesn't rewrite it).
    if head:
        _gitrun(gd, wt, ["reset", "--soft", head])
    _gitrun(gd, wt, ["commit", "-m", "rollback para %s" % target[:8], "--allow-empty"],
            author=c.get("author"))
    files = _read_tree_files(wt, gd)
    uid = _uid_for(label)
    subprocess.run(["chown", "-R", "%s:%s" % (uid, uid), wt])
    reg = load_json(REG_PATH)
    app = reg.get("%s/%s" % (label, system))
    if not app:
        return {"ok": True, "reverted_to": target[:8], "files": files,
                "warning": "app nao registrado; codigo restaurado mas nao reiniciei o container"}
    runtime = app.get("runtime")
    port = int(app.get("port") or DEF_PORT)
    mem  = str(app.get("mem")  or DEF_MEM)
    cpus = str(app.get("cpus") or DEF_CPUS)
    pids = int(app.get("pids") or DEF_PIDS)
    name = cname(label, system)
    env = c.get("env") or {}
    run = _run_container(name, runtime, port, mem, cpus, pids, wt, env, uid)
    if run.returncode != 0:
        return {"ok": False, "error": "docker run falhou: " + (run.stderr or "").strip()[:300]}
    health = _healthcheck(name, port)
    if health["state"] == "crashed":
        lg = docker("logs", "--tail", "40", name)
        log_txt = ((lg.stdout or "") + (lg.stderr or ""))[-4000:]
        return {"ok": False, "error": "app_crashed", "exit_code": health.get("exit_code"),
                "logs": log_txt, "reverted_to": target[:8]}
    return {"ok": True, "reverted_to": target[:8], "files": files, "health": health["state"]}


# ---------- verbs ----------

def v_publish(c):
    label  = _san(c.get("label"))
    system = _san(c.get("system"))
    runtime = c.get("runtime")
    files  = c.get("files") or {}
    if not label or not system:
        return {"ok": False, "error": "label/system invalidos"}
    if runtime not in ("node", "flask"):
        return {"ok": False, "error": "runtime deve ser node ou flask"}
    if not files:
        return {"ok": False, "error": "sem arquivos"}
    if _PROBE_RE.match(system):
        return {"ok": False, "error": f"nome reservado para prova de vida: {system}"}
    port = int(c.get("port") or DEF_PORT)
    mem  = str(c.get("mem")  or DEF_MEM)
    cpus = str(c.get("cpus") or DEF_CPUS)
    pids = int(c.get("pids") or DEF_PIDS)

    d = appdir(label, system)
    os.makedirs(d, exist_ok=True)
    try:
        ensure_quota(label, c.get("quota"))
    except Exception:
        pass
    # normalize absolute path -> relative (apps run under /system/)
    files, _fixed = _autofix_paths(files)
    # write files (relative path, without escaping the dir)
    for rel, b64 in files.items():
        rel = rel.lstrip("/")
        dest = os.path.normpath(os.path.join(d, rel))
        if not dest.startswith(d + os.sep) and dest != d:
            return {"ok": False, "error": f"caminho suspeito: {rel}"}
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        with open(dest, "wb") as f:
            f.write(base64.b64decode(b64))
    uid = _uid_for(label)
    subprocess.run(["chown", "-R", "%s:%s" % (uid, uid), d])

    name = cname(label, system)
    env = c.get("env") or {}
    run = _run_container(name, runtime, port, mem, cpus, pids, d, env, uid)
    if run.returncode != 0:
        return {"ok": False, "error": "docker run falhou: " + (run.stderr or "").strip()[:300]}

    # validate boot: if the app crashes on startup, do NOT register it and return the log to the agent
    health = _healthcheck(name, port)
    if health["state"] == "crashed":
        lg = docker("logs", "--tail", "40", name)
        log_txt = ((lg.stdout or "") + (lg.stderr or ""))[-4000:]
        docker("rm", "-f", name)
        return {"ok": False, "error": "app_crashed", "exit_code": health.get("exit_code"), "logs": log_txt}

    reg = load_json(REG_PATH)
    key = f"{label}/{system}"
    # the entry gets rewritten whole here, so the access gate has to be loaded
    # explicitly: republishing a private app must NOT unlock the URL.
    auth = _auth_entry(c.get("auth"), reg.get(key))
    entry = {"container": name, "port": port, "runtime": runtime,
             "mem": mem, "cpus": cpus, "pids": pids}
    if auth:
        entry["auth"] = auth
    reg[key] = entry
    save_json(REG_PATH, reg)

    # smoke test through the ROUTER (reproduces what the browser sees under
    # /system/): if a referenced CSS/JS doesn't load, UNDO the registration and don't publish.
    smoke = _smoketest(label, system)
    if smoke.get("broken_critical"):
        reg.pop(f"{label}/{system}", None)
        save_json(REG_PATH, reg)
        docker("rm", "-f", name)
        return {"ok": False, "error": "assets_quebrados",
                "broken": smoke["broken_critical"], "fixed": _fixed}
    if smoke.get("broken_functional"):
        reg.pop(f"{label}/{system}", None)
        save_json(REG_PATH, reg)
        docker("rm", "-f", name)
        return {"ok": False, "error": "smoke_funcional_falhou",
                "broken": smoke["broken_functional"], "fixed": _fixed}
    # versions this publication (best-effort; failure here doesn't block the publish)
    # the payload of this publication IS the app's code; whatever else is in
    # appdir is runtime data and goes to info/exclude (same as data/).
    code_paths = set(os.path.normpath(r.lstrip("/")).replace(os.sep, "/") for r in files)
    gitres = _git_commit(label, system, c.get("author"), c.get("message"), code_paths)
    out = {"ok": True, "container": name,
           "url": f"https://{label}.{DOMINIO}/{system}/",
           "quota": quota_usage(label), "health": health["state"],
           "versioned": bool(gitres.get("versioned")),
           "privado": bool(auth)}
    if gitres.get("fora_do_data"):
        out["dados_fora_do_data"] = gitres["fora_do_data"]
    if _fixed:
        out["fixed_paths"] = _fixed
    if smoke.get("broken_other"):
        out["warnings"] = smoke["broken_other"]
    if smoke.get("functional_warnings"):
        out["functional_warnings"] = smoke["functional_warnings"]
    return out

# ---------- ephemeral proof of life (probe verb) ----------
# publish already brings it up, runs a healthcheck and a smoke test. What was
# missing was running this BEFORE publishing, in a disposable place, so the
# model can discover on its own the error that only shows up by RUNNING it (the
# /api/pign case: a near-right name, lint approves it, only calling the route
# shows the 404).
#
# Everything here is ephemeral on purpose: a system with a random name under
# the "tst-" prefix, its own container, its own /app/data (born empty and dies
# with it). The probe NEVER touches the published app, its data, or its git
# history.

_PROBE_RE = _re.compile(r"^%s-[0-9a-f]{8}$" % PROBE_PREFIX)


class _ProbeTimeout(Exception):
    pass


def _probe_alarme(signum, frame):
    raise _ProbeTimeout()


def _probe_sistemas(label):
    """This user's probes that still exist in ANY place (registry, disk,
    docker). Sweeping all three is what guarantees that an execution
    interrupted midway doesn't leave an orphan container eating host memory."""
    achados = set()
    for key in load_json(REG_PATH):
        lb, _, sy = key.partition("/")
        if lb == label and _PROBE_RE.match(sy):
            achados.add(sy)
    try:
        for sy in os.listdir(os.path.join(APPS_ROOT, label)):
            if _PROBE_RE.match(sy):
                achados.add(sy)
    except Exception:
        pass
    pref = cname(label, "")
    r = docker("ps", "-a", "--filter", "name=%s%s-" % (pref, PROBE_PREFIX),
               "--format", "{{.Names}}")
    for nm in (r.stdout or "").split():
        if nm.startswith(pref) and _PROBE_RE.match(nm[len(pref):]):
            achados.add(nm[len(pref):])
    return sorted(achados)


def _probe_idade(label, system):
    """Age in seconds from the probe dir's mtime. No dir = leftover, sweep it."""
    try:
        return max(0.0, time.time() - os.path.getmtime(appdir(label, system)))
    except Exception:
        return float(PROBE_TTL + 1)


def _probe_teardown(label, system):
    """Undoes EVERYTHING the probe created. Two locks before any rm -rf: the
    name has to match the ephemeral pattern (no published app matches it) and
    the path has to be inside APPS_ROOT/<label>/ itself."""
    label = _san(label)
    if not label or not _PROBE_RE.match(system or ""):
        return False
    docker("rm", "-f", cname(label, system))
    reg = load_json(REG_PATH)
    if reg.pop("%s/%s" % (label, system), None) is not None:
        save_json(REG_PATH, reg)
    d = appdir(label, system)
    if os.path.isdir(d) and d.startswith(APPS_ROOT + os.sep + label + os.sep):
        subprocess.run(["rm", "-rf", d])
    return True


def v_probe(c):
    """Brings the code up in a disposable container, sees whether it stays up,
    and exercises the own app's literal GETs. ALWAYS returns what it observed;
    doesn't publish, doesn't version, and doesn't leave anything behind.

    ok=False only when the PROBE itself can't run (invalid input, another probe
    already running, docker failed, timed out). A broken app is a valid probe
    result: ok=True with veredito != "passou"."""
    label = _san(c.get("label"))
    runtime = c.get("runtime")
    files = c.get("files") or {}
    if not label:
        return {"ok": False, "error": "label invalido"}
    if runtime not in ("node", "flask"):
        return {"ok": False, "error": "runtime deve ser node ou flask"}
    if not files:
        return {"ok": False, "error": "sem arquivos"}

    # Cap of ONE live probe per person (the host's cost lives in concurrency,
    # not volume: 183 publishes in 30 days is ~6/day). Leftovers past the TTL
    # are swept before refusing, otherwise a dead probe would lock the person out.
    for velho in _probe_sistemas(label):
        idade = _probe_idade(label, velho)
        if idade > PROBE_TTL:
            _probe_teardown(label, velho)
        else:
            return {"ok": False, "error": "prova_em_andamento",
                    "restam_s": int(PROBE_TTL - idade)}

    system = "%s-%s" % (PROBE_PREFIX, secrets.token_hex(4))
    d = appdir(label, system)
    name = cname(label, system)
    port = int(c.get("port") or DEF_PORT)
    mem = str(c.get("mem") or DEF_MEM)
    cpus = str(c.get("cpus") or DEF_CPUS)
    pids = int(c.get("pids") or DEF_PIDS)
    env = c.get("env") or {}

    anterior = signal.signal(signal.SIGALRM, _probe_alarme)
    signal.alarm(PROBE_BUDGET)
    try:
        os.makedirs(d, exist_ok=True)
        try:
            ensure_quota(label, c.get("quota"))
        except Exception:
            pass
        files, fixed = _autofix_paths(files)
        for rel, b64 in files.items():
            rel = rel.lstrip("/")
            dest = os.path.normpath(os.path.join(d, rel))
            if not dest.startswith(d + os.sep) and dest != d:
                return {"ok": False, "error": f"caminho suspeito: {rel}"}
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            with open(dest, "wb") as f:
                f.write(base64.b64decode(b64))
        uid = _uid_for(label)
        subprocess.run(["chown", "-R", "%s:%s" % (uid, uid), d])

        run = _run_container(name, runtime, port, mem, cpus, pids, d, env, uid)
        if run.returncode != 0:
            return {"ok": False, "error": "docker run falhou: " + (run.stderr or "").strip()[:300]}

        health = _healthcheck(name, port)
        if health["state"] != "ok":
            lg = docker("logs", "--tail", "40", name)
            log_txt = ((lg.stdout or "") + (lg.stderr or ""))[-4000:]
            return {"ok": True, "efemero": True,
                    "veredito": "crashou" if health["state"] == "crashed" else "nao_subiu",
                    "exit_code": health.get("exit_code"), "logs": log_txt,
                    "fixed_paths": fixed}

        # TEMPORARY registration: it's the only way to talk to the app through
        # the router (the smoke test reproduces the browser at /system/). It's
        # born LOCKED with a random, discarded password, so the probe's URL is
        # never open, not even for the few seconds it exists.
        reg = load_json(REG_PATH)
        reg["%s/%s" % (label, system)] = {
            "container": name, "port": port, "runtime": runtime,
            "mem": mem, "cpus": cpus, "pids": pids,
            "auth": _auth_entry({"user": "prova",
                                 "password": secrets.token_urlsafe(24)})}
        save_json(REG_PATH, reg)

        smoke = _smoketest(label, system, amplo=True)
        quebrado = bool(smoke.get("broken_critical") or smoke.get("broken_functional"))
        out = {"ok": True, "efemero": True,
               "veredito": "quebrado" if quebrado else "passou",
               "health": health["state"]}
        if fixed:
            out["fixed_paths"] = fixed
        for k in ("broken_critical", "broken_functional", "broken_other",
                  "functional_warnings"):
            if smoke.get(k):
                out[k] = smoke[k]
        return out
    except _ProbeTimeout:
        return {"ok": False, "error": "prova_estourou_tempo", "limite_s": PROBE_BUDGET}
    finally:
        # Disarm the alarm BEFORE cleaning up: the cleanup can never be
        # interrupted by the time cap, otherwise the probe itself would become
        # the litter left on the host.
        signal.alarm(0)
        signal.signal(signal.SIGALRM, anterior)
        _probe_teardown(label, system)


def v_reload(c):
    """Recreates the container reusing the files ALREADY on disk, applying the
    env (secrets) sent by the backend. Doesn't receive files: only
    injects/rotates env without a re-upload. The env is never written to disk
    on the host."""
    label  = _san(c.get("label"))
    system = _san(c.get("system"))
    if not label or not system:
        return {"ok": False, "error": "label/system invalidos"}
    d = appdir(label, system)
    if not os.path.isdir(d):
        return {"ok": False, "error": "app nao encontrado no disco"}
    reg = load_json(REG_PATH)
    app = reg.get(f"{label}/{system}")
    if not app:
        return {"ok": False, "error": "app nao registrado"}
    runtime = app.get("runtime")
    port = int(app.get("port") or DEF_PORT)
    mem  = str(app.get("mem")  or DEF_MEM)
    cpus = str(app.get("cpus") or DEF_CPUS)
    pids = int(app.get("pids") or DEF_PIDS)
    uid = _uid_for(label)
    subprocess.run(["chown", "-R", "%s:%s" % (uid, uid), d])
    name = cname(label, system)
    env = c.get("env") or {}
    run = _run_container(name, runtime, port, mem, cpus, pids, d, env, uid)
    if run.returncode != 0:
        return {"ok": False, "error": "docker run falhou: " + (run.stderr or "").strip()[:300]}
    health = _healthcheck(name, port)
    if health["state"] == "crashed":
        lg = docker("logs", "--tail", "40", name)
        log_txt = ((lg.stdout or "") + (lg.stderr or ""))[-4000:]
        return {"ok": False, "error": "app_crashed", "exit_code": health.get("exit_code"), "logs": log_txt}
    return {"ok": True, "container": name, "health": health["state"]}

def v_stop(c):
    name = cname(_san(c.get("label")), _san(c.get("system")))
    r = docker("stop", name)
    return {"ok": r.returncode == 0, "container": name,
            "error": None if r.returncode == 0 else (r.stderr or "").strip()[:200]}

def v_restart(c):
    name = cname(_san(c.get("label")), _san(c.get("system")))
    docker("start", name)
    r = docker("restart", name)
    return {"ok": r.returncode == 0, "container": name,
            "error": None if r.returncode == 0 else (r.stderr or "").strip()[:200]}

def v_set_auth(c):
    """Locks/unlocks the public URL WITHOUT republishing. Only touches the
    registry, which the router re-reads on every request -> immediate effect,
    no restart."""
    label, system = _san(c.get("label")), _san(c.get("system"))
    if not label or not system:
        return {"ok": False, "error": "label/system invalidos"}
    reg = load_json(REG_PATH)
    key = f"{label}/{system}"
    app = reg.get(key)
    if not app:
        return {"ok": False, "error": "app nao registrado"}
    spec = c.get("auth")
    if spec is None:
        return {"ok": False, "error": "auth nao informado"}
    auth = _auth_entry(spec, app)
    if auth:
        app["auth"] = auth
    else:
        app.pop("auth", None)
    reg[key] = app
    save_json(REG_PATH, reg)
    return {"ok": True, "privado": bool(auth),
            "user": (auth or {}).get("user")}


def _dir_stats(root):
    """Counts files and bytes under root (without following symlinks)."""
    n = 0; b = 0
    for dirpath, dirnames, filenames in os.walk(root):
        for fn in filenames:
            p = os.path.join(dirpath, fn)
            try:
                if os.path.islink(p):
                    continue
                b += os.path.getsize(p)
                n += 1
            except Exception:
                pass
    return n, b


def _sqlite_counts(path):
    """Row count per table, OPENING READ-ONLY (uri ro): the inventory can never
    alter the user's database nor create -wal/-shm."""
    import sqlite3
    out = {}
    try:
        con = sqlite3.connect("file:%s?mode=ro" % path, uri=True, timeout=3)
        try:
            tabs = [r[0] for r in con.execute(
                "SELECT name FROM sqlite_master WHERE type='table' "
                "AND name NOT LIKE 'sqlite_%'")]
            for t in tabs[:40]:
                try:
                    out[t] = con.execute('SELECT COUNT(*) FROM "%s"' % t).fetchone()[0]
                except Exception:
                    pass
        finally:
            con.close()
    except Exception:
        pass
    return out


def v_inventory(c):
    """What user data EXISTS in this app. Used for confirmation before a
    delete: the assistant needs to say HOW MANY records are going to be lost,
    not a generic "can't be undone". Read-only."""
    label, system = _san(c.get("label")), _san(c.get("system"))
    if not label or not system:
        return {"ok": False, "error": "label/system invalidos"}
    d = appdir(label, system)
    if not os.path.isdir(d):
        return {"ok": False, "error": "app nao encontrado no disco"}
    code_files, code_bytes = _dir_stats(d)
    data_dir = os.path.join(d, "data")
    data = {"existe": os.path.isdir(data_dir), "arquivos": 0, "bytes": 0,
            "tabelas": {}, "colecoes": {}}
    if data["existe"]:
        n, b = _dir_stats(data_dir)
        data["arquivos"] = n; data["bytes"] = b
        # user data lives in /app/data: sqlite (tables) or json (lists).
        for dirpath, dirnames, filenames in os.walk(data_dir):
            for fn in filenames:
                p = os.path.join(dirpath, fn)
                rel = os.path.relpath(p, data_dir)
                low = fn.lower()
                if low.endswith((".db", ".sqlite", ".sqlite3")):
                    cnt = _sqlite_counts(p)
                    if cnt:
                        data["tabelas"][rel] = cnt
                elif low.endswith(".json") or low.endswith(".jsonl"):
                    try:
                        if os.path.getsize(p) > 20_000_000:
                            continue
                        if low.endswith(".jsonl"):
                            with open(p, "rb") as f:
                                data["colecoes"][rel] = sum(1 for ln in f if ln.strip())
                        else:
                            with open(p) as f:
                                j = json.load(f)
                            if isinstance(j, list):
                                data["colecoes"][rel] = len(j)
                            elif isinstance(j, dict):
                                # {"pedidos":[...]} is the common format; count each list
                                sub = {k: len(v) for k, v in j.items() if isinstance(v, list)}
                                data["colecoes"][rel] = sub or len(j)
                    except Exception:
                        pass
    versoes = None
    gd = _gitdir(label, system)
    if os.path.isdir(gd):
        r = _gitrun(gd, appdir(label, system), ["rev-list", "--count", "HEAD"])
        try:
            versoes = int((r.stdout or "0").strip())
        except Exception:
            versoes = None
    return {"ok": True, "codigo": {"arquivos": code_files, "bytes": code_bytes},
            "dados": data, "versoes": versoes,
            "quota": quota_usage(label)}


def v_delete(c):
    label, system = _san(c.get("label")), _san(c.get("system"))
    name = cname(label, system)
    docker("rm", "-f", name)
    reg = load_json(REG_PATH)
    reg.pop(f"{label}/{system}", None)
    save_json(REG_PATH, reg)
    d = appdir(label, system)
    if os.path.isdir(d) and d.startswith(APPS_ROOT + os.sep):
        subprocess.run(["rm", "-rf", d])
    gd = _gitdir(label, system)
    if os.path.isdir(gd) and gd.startswith(GIT_ROOT + os.sep):
        subprocess.run(["rm", "-rf", gd])
    return {"ok": True, "container": name}

def v_logs(c):
    name = cname(_san(c.get("label")), _san(c.get("system")))
    tail = str(int(c.get("tail") or 100))
    r = docker("logs", "--tail", tail, name)
    if r.returncode != 0:
        return {"ok": False, "error": (r.stderr or "").strip()[:300]}
    out = ((r.stdout or "") + (r.stderr or ""))[-8000:]
    return {"ok": True, "logs": out}

def v_list(c):
    label = _san(c.get("label")) if c.get("label") else None
    reg = load_json(REG_PATH)
    apps = []
    for key, app in reg.items():
        k_label = key.split("/", 1)[0]
        if label and k_label != label:
            continue
        name = app.get("container")
        r = docker("inspect", "-f", "{{.State.Status}}", name)
        status = r.stdout.strip() if r.returncode == 0 else "ausente"
        auth = app.get("auth") or {}
        apps.append({"key": key, "container": name, "runtime": app.get("runtime"),
                     "status": status, "privado": bool(auth),
                     "access_user": auth.get("user") if auth else None})
    quotas = {}
    for lb in sorted({a["key"].split("/", 1)[0] for a in apps}):
        quotas[lb] = quota_usage(lb)
    return {"ok": True, "apps": apps, "quotas": quotas}

def v_quota(c):
    """Applies the LABEL's disk quota without republishing anything.

    The XFS quota applies at the LABEL level, i.e. PER USER, and until now was
    only applied inside publish (ensure_quota in v_publish). Someone who
    changed plans kept the old quota until publishing an app again: upgrading a
    plan didn't grant the paid-for disk, and downgrading kept the big plan's
    disk. This verb is the reconciliation, called by the backend. Doesn't
    touch any app.

    Accepts one label per call ({label, quota}) or a batch ({itens: [...]}).
    Returns before/after for each one so the caller knows what actually changed.
    """
    itens = c.get("itens")
    if not isinstance(itens, list):
        itens = [{"label": c.get("label"), "quota": c.get("quota")}]
    if len(itens) > 500:
        return {"ok": False, "error": "lote grande demais"}
    out = []
    for it in itens:
        if not isinstance(it, dict):
            continue
        label = _san(it.get("label"))
        quota = it.get("quota")
        if not label or quota in (None, ""):
            out.append({"label": it.get("label"), "ok": False, "error": "label/quota invalidos"})
            continue
        antes = quota_usage(label)
        try:
            ensure_quota(label, quota)
        except Exception as e:
            out.append({"label": label, "ok": False, "error": str(e), "antes": antes})
            continue
        out.append({"label": label, "ok": True, "antes": antes, "depois": quota_usage(label)})
    return {"ok": True, "itens": out}

def v_seed_user(c):
    label = _san(c.get("label"))
    name  = (c.get("name") or "").strip()
    if not label:
        return {"ok": False, "error": "label invalido"}
    users = load_json(USERS_PATH)
    users[label] = name
    save_json(USERS_PATH, users)
    return {"ok": True, "label": label, "name": name}

def home_path(label):
    return os.path.join(HOME_ROOT, f"{label}.json")

def v_home_add(c):
    label = _san(c.get("label"))
    kind  = (c.get("kind") or "text").strip().lower()
    if not label:
        return {"ok": False, "error": "label invalido"}
    if kind not in ("text", "html", "link"):
        return {"ok": False, "error": "kind deve ser text, html ou link"}
    body = c.get("body")
    if kind == "link":
        if not (c.get("url") or "").strip():
            return {"ok": False, "error": "link precisa de url"}
    elif not (body or "").strip():
        return {"ok": False, "error": "bloco sem body"}
    home = load_json(home_path(label))
    blocks = home.get("blocks") or []
    bid = (max((b.get("id", 0) for b in blocks), default=0)) + 1
    block = {"id": bid, "kind": kind, "created": int(time.time())}
    if c.get("title"):
        block["title"] = str(c.get("title"))[:200]
    if kind == "link":
        block["url"] = str(c.get("url")).strip()[:2000]
        block["body"] = (body or c.get("url"))
    else:
        block["body"] = str(body)
    blocks.append(block)
    home["blocks"] = blocks
    save_json(home_path(label), home)
    return {"ok": True, "id": bid, "count": len(blocks)}

def v_home_list(c):
    label = _san(c.get("label"))
    if not label:
        return {"ok": False, "error": "label invalido"}
    home = load_json(home_path(label))
    return {"ok": True, "blocks": home.get("blocks") or []}

def v_home_remove(c):
    label = _san(c.get("label"))
    try:
        bid = int(c.get("id"))
    except Exception:
        return {"ok": False, "error": "id invalido"}
    home = load_json(home_path(label))
    blocks = home.get("blocks") or []
    n0 = len(blocks)
    blocks = [b for b in blocks if b.get("id") != bid]
    home["blocks"] = blocks
    save_json(home_path(label), home)
    return {"ok": True, "removed": n0 - len(blocks), "count": len(blocks)}

def v_home_clear(c):
    label = _san(c.get("label"))
    if not label:
        return {"ok": False, "error": "label invalido"}
    save_json(home_path(label), {"blocks": []})
    return {"ok": True, "count": 0}

VERBS = {
    "publish": v_publish, "probe": v_probe, "stop": v_stop, "restart": v_restart,
    "delete": v_delete, "logs": v_logs, "list": v_list, "seed_user": v_seed_user,
    "reload": v_reload, "set_auth": v_set_auth, "inventory": v_inventory,
    "quota": v_quota,
    "git_log": v_git_log, "git_diff": v_git_diff, "git_rollback": v_git_rollback,
    "home_add": v_home_add, "home_list": v_home_list,
    "home_remove": v_home_remove, "home_clear": v_home_clear,
}

def main():
    global DOMINIO
    try:
        cmd = json.load(sys.stdin)
    except Exception as e:
        print(json.dumps({"ok": False, "error": f"json invalido: {e}"}))
        return
    if isinstance(cmd, dict) and _dominio_valido(cmd.get("dominio")):
        DOMINIO = _dominio_valido(cmd.get("dominio"))
    verb = cmd.get("verb")
    fn = VERBS.get(verb)
    if not fn:
        print(json.dumps({"ok": False, "error": f"verbo desconhecido: {verb}"}))
        return
    try:
        print(json.dumps(fn(cmd), ensure_ascii=False))
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e)[:300]}))

if __name__ == "__main__":
    main()
