#!/usr/bin/env python3
"""
Apps control daemon (control-plane).

NAO EDITAR NESTA MAQUINA. A fonte e ops/apps-host/ctl.py no git e sobe pelo
ops/apps-host/deploy.sh. Editar aqui e ser sobrescrito no proximo deploy.

Como so a 443 e a 22 estao abertas no host, o backend de producao (SP) invoca
este script POR SSH (porta 22), mandando UM comando JSON no stdin. Nada de porta
propria. Saida = UMA linha JSON no stdout: {"ok":true,...} ou {"ok":false,"error":...}.

Verbos:
  publish   {label, system, runtime:"node"|"flask", files:{path:b64}, port?, mem?, cpus?, pids?,
             auth?}   -> auth: {"user":..,"password":..} tranca a URL (HTTP Basic no roteador);
                         {"mode":"none"} abre; AUSENTE preserva o que ja estava (republish nao
                         destranca app privado por esquecimento do chamador)
  set_auth  {label, system, auth}      -> troca/remove o portao sem republicar
  inventory {label, system}            -> o que EXISTE de dado do usuario (pre-confirmacao de delete)
  stop      {label, system}
  restart   {label, system}
  delete    {label, system}   -> IRREVERSIVEL: container + codigo + /app/data + historico git
  probe     {label, system?, runtime, files:{path:b64}, port?, mem?, cpus?, pids?, env?}
            -> PROVA DE VIDA efemera: sobe o codigo num container descartavel, confere que
               fica de pe e exercita os GET literais do proprio app; apaga tudo no fim.
               Nunca toca no app publicado, no /app/data dele nem no historico git.
  logs      {label, system, tail?}
  list      {label?}
  seed_user {label, name}      -> grava label->nome em users.json (landing page)

  home_add    {label, kind:"text"|"html"|"link", body, title?, url?}  -> add bloco na home
  home_list   {label}                                                 -> lista blocos da home
  home_remove {label, id}                                             -> remove 1 bloco
  home_clear  {label}                                                 -> zera a home (so a msg padrao)

Roda com stdlib pura (host so tem python3).
"""
import base64, hashlib, hmac, json, os, re, secrets, signal, subprocess, sys, time

APPS_ROOT   = "/opt/brambs-apps"                       # codigo das apps (bind mount)
REG_PATH    = "/opt/brambs-router/apps.json"           # registry do roteador
IKEY_PATH   = "/opt/brambs-router/internal.key"        # segredo compartilhado ctl <-> roteador
USERS_PATH  = "/opt/brambs-router/users.json"          # label -> nome (landing)
HOME_ROOT   = "/opt/brambs-home"                        # <label>.json = blocos da home do usuario
NETWORK     = "brambs-apps"
IMAGE       = "brambs-app-base:latest"
APP_UID     = "10001"
UID_PATH    = "/opt/brambs-ctl/uids.json"            # label -> UID de SO por usuario (isolamento)
UID_BASE    = 20000
DEF_PORT    = 8080
DEF_MEM     = "256m"
DEF_CPUS    = "0.5"
DEF_PIDS    = 256
DEF_QUOTA   = "200m"                                   # cota de disco por usuario (free tier)
PROJID_PATH = "/opt/brambs-ctl/projids.json"           # label -> project id (xfs)
PROJID_BASE = 1000
GIT_ROOT    = "/opt/brambs-apps-git"                    # historico git por app (fora do mount /app e da cota XFS)
PROBE_PREFIX = "tst"                                    # prefixo do sistema EFEMERO da prova de vida
PROBE_TTL    = 300                                      # s: prova mais velha que isso e sobra, pode varrer
PROBE_BUDGET = 75                                       # s: teto duro de uma prova (SIGALRM), custo limitado

# Dominio dos apps (<label>.<dominio>/<sistema>/). Vem no JSON de cada chamada
# ("dominio"), mandado pelo backend a partir do APPS_DOMAIN dele, que e a fonte
# unica. Sem ele (backend antigo), APPS_DOMAIN do ambiente e depois o padrao.
# sudo limpa o ambiente, por isso o caminho normal e o JSON.
DOMINIO_PADRAO = "localhost"
DOMINIO = os.environ.get("APPS_DOMAIN") or DOMINIO_PADRAO

# Autor dos commits sem pessoa por tras: o nome da marca do host em minusculas,
# lido do mesmo marca.json do roteador (ver router.py); sem ele, o neutro.
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
    """Pos-publish: confere se o container fica de pe.
    {"state":"ok"|"crashed"|"nostart", "exit_code":int|None}.
    'crashed' = saiu (exit != 0 ou exit 0 logo apos subir, anormal p/ web).
    'ok' = de pe (e, se der, respondeu HTTP). 'nostart' = nao confirmou."""
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


# ---------- smoke test / normalizacao de caminhos ----------
# Apps rodam sob um SUBCAMINHO (label.<dominio>/system/). Caminho absoluto
# (comecando com "/") no HTML/JS quebra: o navegador busca na raiz do dominio e
# o roteador nao acha. Aqui a gente (1) normaliza caminho absoluto -> relativo
# nos arquivos que o agente mandou e (2) testa pelo roteador se os assets
# realmente carregam antes de dar o app como publicado.
import re as _re, http.client as _httpc

_ATTR_ABS = _re.compile(r'(\b(?:href|src)\s*=\s*["\'])/(?=[^/"\'])')
_FETCH_ABS = _re.compile(r'(fetch\(\s*["\'`])/(?=[^/"\'`])')
_REF_RE = _re.compile(r'\b(?:href|src)\s*=\s*["\']([^"\']+)["\']', _re.I)
_FETCH_REF_RE = _re.compile(r'\bfetch\(\s*["\']([^"\']+)["\']', _re.I)
_SAFE_SMOKE_REF = _re.compile(r'(?:^|/)(?:status|health|healthz|ping)(?:[/?#]|$)', _re.I)
# Modo AMPLO (so na prova efemera): pega a chamada de fetch inteira pra poder
# exigir que seja comprovadamente GET. O literal tem que ser o argumento inteiro,
# entao concatenacao ("/api/" + id) e template com ${} ficam de fora sozinhos.
_FETCH_CALL_RE = _re.compile(r'\bfetch\(\s*["\']([^"\'\n]{1,300})["\']\s*([),])')
_METHOD_RE = _re.compile(r'method\s*:\s*["\']([A-Za-z]+)["\']')


def _colher_gets(txt):
    """Refs de fetch() literais e comprovadamente GET.
    Sem segundo argumento = GET por definicao. Com segundo argumento, so passa
    se houver method:"GET" escrito; na duvida a prova NAO chama (POST/DELETE de
    app de usuario podem gravar, e a prova nunca pode ter efeito colateral)."""
    out = []
    for m in _FETCH_CALL_RE.finditer(txt):
        ref, sep = m.group(1), m.group(2)
        if "${" in ref:
            continue
        if sep == ",":
            # a janela e OLHADA, nunca consumida: consumir escondia a chamada
            # seguinte do proprio regex e a prova deixava de exercita-la.
            mm = _METHOD_RE.search(txt[m.end():m.end() + 200])
            if not mm or mm.group(1).upper() != "GET":
                continue
        out.append(ref)
    return out


def _autofix_paths(files):
    """Normaliza caminho absoluto -> relativo em .html/.htm/.js/.mjs.
    Devolve (files_novo, lista_de_arquivos_alterados)."""
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


# ---------- portao de acesso (HTTP Basic no roteador) ----------
# App novo nasce PRIVADO: a URL publica pede usuario e senha ANTES de o roteador
# acordar o container. A senha NAO fica em claro aqui: guardamos sha256(salt+senha)
# no registry, e o backend guarda a senha cifrada (pra poder mostrar ao dono e pra
# o proprio assistente chamar o app). Ver web/db.mjs (access_pass_enc).
#
# sha256 com salt (e nao pbkdf2/scrypt) de proposito: o roteador verifica a CADA
# request (inclui todo asset), as senhas sao geradas por nos com entropia alta
# (~57 bits) e o custo de derivacao viraria latencia em toda pagina. Se algum dia
# aceitarmos senha escolhida pelo usuario, isso tem que virar pbkdf2.

def internal_key():
    """Segredo compartilhado ctl <-> roteador, pra chamada interna passar pelo
    portao (smoke test do publish precisa ler o HTML do app privado).
    Cria na primeira vez, 0600. O O_EXCL + releitura resolve a corrida com o
    roteador, que tambem tenta criar."""
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
    """Traduz o pedido do backend na entrada 'auth' do registry.
      None            -> preserva o que ja estava (republish nao destranca por omissao)
      {"mode":"none"} -> remove o portao (app publico)
      {user,password} -> portao Basic novo
    Devolve None quando nao ha portao."""
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
    # Republicar um app privado reenvia a MESMA credencial que ja esta no banco.
    # Preserve tambem o salt nesse caso: o roteador usa esse valor para versionar
    # o realm do HTTP Basic. Se re-salgasse todo publish, o navegador esqueceria
    # uma credencial valida e pediria login de novo sem a senha ter mudado.
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
    """Pega o HTML servido pelo roteador, resolve os refs como um navegador em
    /system/ faria, e confere se cada asset carrega. Assets .css/.js que nao
    devolvem 200 = broken_critical (quebram a pagina); o resto = broken_other.

    amplo=True SO pode ser usado no caminho EFEMERO (verbo probe): ali o
    container e o /app/data sao descartados no fim, entao da pra exercitar todo
    GET literal do app (e assim pegar /api/pign, que o conjunto conservador
    deixa passar). No publish o alvo e o dado REAL do usuario, por isso a
    allowlist estreita continua valendo."""
    html = _router_html(label, system)
    if html is None:
        return {}  # sem HTML pra checar (ex: API pura) -> nao bloqueia
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



# ---------- cota de disco (XFS project quota por usuario) ----------
# /opt/brambs-apps e uma imagem XFS montada com prjquota. Cada usuario (label)
# vira um "project" cujo tree e APPS_ROOT/<label>; o bhard limita a SOMA de todos
# os apps dele. Arquivos novos herdam o projid do dir pai (comportamento do XFS).

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
    if quota.isdigit():  # sem unidade -> assume MB (senao o XFS le como bytes e zera a cota)
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

# ---------- segredos por app (injecao de env no boot) ----------
# O valor real do segredo vem cifrado do backend, e decifrado la, e chega aqui
# em texto no JSON do comando (canal SSH, efemero). Vira -e no container. NUNCA
# e gravado em disco no host (nao vai pro /app, logo nao vaza no snapshot/replica).
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
    """UID de SO exclusivo por usuario (label). Mapa persistido; aloca sob
    demanda a partir de UID_BASE. Segunda tranca alem do Docker: os arquivos
    de cada usuario no host tem dono proprio, entao mesmo com falha de
    isolamento do container um app nao le o dado de outro usuario (Fase 4)."""
    m = load_json(UID_PATH)
    if label in m:
        return int(m[label])
    used = [int(v) for v in m.values()]
    uid = (max(used) + 1) if used else UID_BASE
    m[label] = uid
    save_json(UID_PATH, m)
    return uid


def _run_container(name, runtime, port, mem, cpus, pids, d, env, uid):
    docker("rm", "-f", name)  # recria do zero
    # /app/data: diretorio duravel e reservado a DADO de runtime (SQLite,
    # uploads). Fica fora do plano de codigo; nao e enviado no publish nem
    # entra no snapshot, entao o dado NUNCA viaja na replicacao (Fase 2).
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

# ---------- versionamento (git por app) ----------
# Cada app tem um repo git em GIT_ROOT/<label>/<system>.git, com o work-tree
# apontando pro appdir. Fica FORA do bind /app (o container nao ve o .git) e FORA
# da imagem XFS (nao conta na cota do usuario). data/ (dado de runtime) e ignorado
# via info/exclude, entao nunca entra em commit nem e mexido no rollback.

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
        # nao-bare pra permitir operacoes de work-tree (checkout/reset)
        subprocess.run(["git", "--git-dir", gd, "config", "core.bare", "false"],
                       capture_output=True, text=True)
        try:
            with open(os.path.join(gd, "info", "exclude"), "a") as f:
                f.write("\ndata/\n")
        except Exception:
            pass
    return gd, wt

def _exclude_add(gd, paths):
    """Acrescenta caminhos ao info/exclude do repo do app, sem duplicar. Fica no
    repo (nao no work-tree): o app nunca ve, e nao viaja no payload de publish."""
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
    """Arquivos que estao no appdir, NAO estao no git e NAO foram mandados pelo
    assistente nesta publicacao. O payload de publish e sempre o app inteiro
    (o rascunho re-semeia do snapshot), entao arquivo fora dele foi criado pelo
    app rodando = dado de runtime gravado fora de /app/data.

    Devolve (lista de linhas pro exclude, lista de caminhos pro aviso). So olha
    UNTRACKED: arquivo ja versionado nao e tocado aqui, pra nunca desversionar
    codigo por engano."""
    r = _gitrun(gd, wt, ["ls-files", "--others", "--exclude-standard", "-z"])
    if r.returncode != 0:
        return [], []
    novos = [x for x in (r.stdout or "").split("\0") if x]
    sobra = [x for x in novos if x not in code_paths]
    if not sobra:
        return [], []
    # se o diretorio de topo nao tem NENHUM arquivo de codigo, exclui o diretorio
    # (uploads crescem; entrada por arquivo incharia o exclude a cada publish).
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
    """Best-effort: registra o estado atual do appdir como uma versao. Nunca
    lanca; se der ruim, so nao versiona (nao bloqueia o publish).

    Com code_paths (o que o assistente mandou), o que sobrou no appdir e dado de
    runtime: entra no info/exclude ANTES do add, pra nao ser versionado nem
    rebobinado por rollback. E o mesmo contrato que data/ sempre teve."""
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
    """Le o CODIGO do app como {rel: b64}, pra devolver ao backend atualizar o
    snapshot da biblioteca apos um rollback.

    Fonte da verdade = o que esta VERSIONADO (git ls-files): dado de runtime esta
    no info/exclude, entao nao entra no snapshot nem viaja em replicacao. Cai pro
    walk do diretorio (menos data/) se o git falhar."""
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
    # worktree passa a ser exatamente a versao alvo (remove arquivos que nao
    # existiam nela; data/ e ignorado, entao dado de runtime fica intacto).
    r1 = _gitrun(gd, wt, ["reset", "--hard", target])
    if r1.returncode != 0:
        return {"ok": False, "error": "falha no reset: " + ((r1.stderr or "").strip())[:200]}
    # move o HEAD de volta pro tip mantendo o conteudo revertido, e grava um novo
    # commit representando o rollback (preserva o historico, nao reescreve).
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


# ---------- verbos ----------

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
    # normaliza caminho absoluto -> relativo (apps rodam sob /system/)
    files, _fixed = _autofix_paths(files)
    # grava arquivos (path relativo, sem escapar do dir)
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

    # valida boot: se o app crashar ao subir, NAO registra e devolve o log pro agente
    health = _healthcheck(name, port)
    if health["state"] == "crashed":
        lg = docker("logs", "--tail", "40", name)
        log_txt = ((lg.stdout or "") + (lg.stderr or ""))[-4000:]
        docker("rm", "-f", name)
        return {"ok": False, "error": "app_crashed", "exit_code": health.get("exit_code"), "logs": log_txt}

    reg = load_json(REG_PATH)
    key = f"{label}/{system}"
    # a entrada e reescrita inteira aqui, entao o portao de acesso tem que ser
    # carregado explicitamente: republicar app privado NAO pode destrancar a URL.
    auth = _auth_entry(c.get("auth"), reg.get(key))
    entry = {"container": name, "port": port, "runtime": runtime,
             "mem": mem, "cpus": cpus, "pids": pids}
    if auth:
        entry["auth"] = auth
    reg[key] = entry
    save_json(REG_PATH, reg)

    # smoke test pelo ROTEADOR (reproduz o que o navegador ve sob /system/):
    # se um CSS/JS referenciado nao carregar, DESFAZ o registro e nao publica.
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
    # versiona esta publicacao (best-effort; falha aqui nao bloqueia o publish)
    # o payload desta publicacao E o codigo do app; o resto que estiver no appdir
    # e dado de runtime e vai pro info/exclude (idem data/).
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

# ---------- prova de vida efemera (verbo probe) ----------
# O publish ja sobe, faz healthcheck e smoke. O que faltava era rodar isso ANTES
# de publicar, num lugar descartavel, pra o modelo descobrir sozinho o erro que
# so aparece EXECUTANDO (o caso /api/pign: nome quase certo, lint aprova, so
# quem chama a rota ve o 404).
#
# Tudo aqui e efemero de proposito: sistema com nome sorteado sob o prefixo
# "tst-", container proprio, /app/data proprio (nasce vazio e morre junto).
# A prova NUNCA toca no app publicado, no dado dele nem no historico git.

_PROBE_RE = _re.compile(r"^%s-[0-9a-f]{8}$" % PROBE_PREFIX)


class _ProbeTimeout(Exception):
    pass


def _probe_alarme(signum, frame):
    raise _ProbeTimeout()


def _probe_sistemas(label):
    """Provas desse usuario que ainda existem em ALGUM lugar (registry, disco,
    docker). Varrer os tres e o que garante que uma execucao interrompida no
    meio nao deixa container orfao comendo memoria do host."""
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
    """Idade em segundos pela mtime do dir da prova. Sem dir = sobra, varre."""
    try:
        return max(0.0, time.time() - os.path.getmtime(appdir(label, system)))
    except Exception:
        return float(PROBE_TTL + 1)


def _probe_teardown(label, system):
    """Desfaz TUDO que a prova criou. Duas trancas antes de qualquer rm -rf: o
    nome tem que casar com o padrao efemero (nenhum app publicado casa) e o
    caminho tem que estar dentro do proprio APPS_ROOT/<label>/."""
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
    """Sobe o codigo num container descartavel, ve se fica de pe e exercita os
    GET literais do proprio app. Devolve SEMPRE o que observou; nao publica,
    nao versiona e nao deixa nada pra tras.

    ok=False so quando a PROVA nao pode rodar (entrada invalida, outra prova em
    andamento, docker falhou, estourou o tempo). App quebrado e resultado
    valido da prova: ok=True com veredito != "passou"."""
    label = _san(c.get("label"))
    runtime = c.get("runtime")
    files = c.get("files") or {}
    if not label:
        return {"ok": False, "error": "label invalido"}
    if runtime not in ("node", "flask"):
        return {"ok": False, "error": "runtime deve ser node ou flask"}
    if not files:
        return {"ok": False, "error": "sem arquivos"}

    # Teto de UMA prova viva por pessoa (o custo do host mora na simultaneidade,
    # nao no volume: 183 publishes em 30 dias e ~6/dia). Sobra passada do TTL e
    # varrida antes de recusar, senao uma prova morta trancaria a pessoa.
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

        # Registro TEMPORARIO: e o unico jeito de falar com o app pelo roteador
        # (o smoke reproduz o navegador em /system/). Nasce TRANCADO com senha
        # sorteada e descartada, entao a URL da prova nunca fica aberta, nem
        # pelos poucos segundos que ela existe.
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
        # Desarma o alarme ANTES de limpar: a limpeza nunca pode ser interrompida
        # pelo teto de tempo, senao a prova e que viraria o lixo no host.
        signal.alarm(0)
        signal.signal(signal.SIGALRM, anterior)
        _probe_teardown(label, system)


def v_reload(c):
    """Recria o container reusando os arquivos JA no disco, aplicando o env
    (segredos) mandado pelo backend. Nao recebe arquivos: so injeta/rotaciona
    env sem re-upload. O env nunca e gravado em disco no host."""
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
    """Tranca/destranca a URL publica SEM republicar. So mexe no registry, que o
    roteador rele a cada request -> efeito imediato, sem restart."""
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
    """Conta arquivos e bytes debaixo de root (sem seguir symlink)."""
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
    """Contagem de linhas por tabela, ABRINDO READ-ONLY (uri ro): inventario nunca
    pode alterar o banco do usuario nem criar -wal/-shm."""
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
    """O que EXISTE de dado do usuario neste app. Serve pra confirmacao antes do
    delete: o assistente precisa dizer QUANTOS registros vao morrer, nao um
    'nao da pra desfazer' genarico. Somente leitura."""
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
        # dado de usuario mora em /app/data: sqlite (tabelas) ou json (listas).
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
                                # {"pedidos":[...]} e o formato comum; conta cada lista
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
    """Aplica a cota de disco do LABEL sem republicar nada.

    A cota do XFS vale no LABEL, ou seja, POR USUARIO, e ate agora so era aplicada
    dentro do publish (ensure_quota em v_publish). Quem trocava de plano seguia com
    a cota antiga ate publicar um app de novo: quem subiu de plano nao ganhava o
    disco que pagou, e quem desceu ficava com o disco do plano grande. Este verbo
    e a reconciliacao, chamada pelo backend. Nao toca em app nenhum.

    Aceita um label por chamada ({label, quota}) ou um lote ({itens: [...]}).
    Devolve antes/depois de cada um pra quem chamou saber o que de fato mudou.
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
