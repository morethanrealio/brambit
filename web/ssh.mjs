// ── SSH via credential vault (option B: key per user) ──
//
// Flow:
//  1) `gerar_chave_ssh(host, usuario)` generates an ed25519 pair INSIDE the
//     user's sandbox, stores the PRIVATE key encrypted in the vault (kind 'ssh_key') and returns
//     the PUBLIC key for the user to paste into the server's ~/.ssh/authorized_keys.
//  2) `rodar_no_servidor(comando)` (GATED) fetches the key from the vault, decrypts it in
//     memory, connects from the SP sandbox (BR egress, internal network blocked
//     by the host's firewall) and runs the command. Requires explicit confirmation.
//
// Why it runs from the SANDBOX and not the backend: the sandbox has a firewall that drops
// the VPC's internal network (metadata, Postgres, 10/172.16/192.168), so a user
// can't aim at the infra from inside. The backend is on the VPC, it would be dangerous.
import { comAviso } from './recorte.mjs';
import { sandboxEnabled, sandboxShell, sandboxWrite, sandboxRead } from './sandbox.mjs';
import { encryptSecret, decryptSecret, vaultEnabled } from './vault.mjs';
import { addConnection, listConnections, getConnection } from './db.mjs';
import { runnerOnline, runnerExec } from './runner.mjs';
import { createHash } from 'node:crypto';
import { marca } from './marca.mjs';

const executionEffect=(state,operation)=>({version:1,state,operation});
const executionResult=(body,state,operation)=>JSON.stringify({...body,effect:executionEffect(state,operation)});

const SSH_DIR = '/workspace/.ssh';
const KNOWN_HOSTS = `${SSH_DIR}/known_hosts`;

// Masks secrets in the OUTPUT of any remote command before returning it to the
// model (and so to the chat/history). A safety net that does NOT depend on the
// model behaving: if a `cat .env`/`grep` spits a credential, it comes out
// redacted. Covers what leaked into a chat on 15/07 (Postgres password in
// DATABASE_URL, AWS_ACCESS_KEY_ID/SECRET) + the usual suspects. Used here and
// in coding.mjs (which imports it to avoid duplication).
export function maskSecrets(s, { prose = false } = {}) {
  let t = String(s ?? '');
  // Password in connection string: scheme://user:PASSWORD@host  ->  user:***@host
  t = t.replace(/([a-z][a-z0-9+.-]*:\/\/[^:\s/@]+:)([^@\s/]+)(@)/gi, '$1***$3');
  // AWS Access Key ID (AKIA/ASIA + 16 alfanum).
  t = t.replace(/\b((?:AKIA|ASIA)[0-9A-Z]{16})\b/g, '***AWS_KEY***');
  // Tokens by FORMAT (don't depend on appearing in a `NOME=`). Covers the ones the
  // by-name regex let through in the live-feed/output: Authorization Bearer/Basic,
  // JWT, GitHub, Slack, OpenAI/Anthropic, Google (ya29/AIza), Stripe.
  t = t.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 ***');
  t = t.replace(/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g, '***JWT***');
  t = t.replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '***GH_TOKEN***');
  t = t.replace(/\bgh[pousr]_[A-Za-z0-9]{16,}\b/g, '***GH_TOKEN***');
  t = t.replace(/\bxox[baprse]-[A-Za-z0-9-]{8,}\b/g, '***SLACK_TOKEN***');
  t = t.replace(/\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}\b/g, '***API_KEY***');
  t = t.replace(/\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g, '***STRIPE_KEY***');
  t = t.replace(/\bya29\.[A-Za-z0-9._-]{10,}/g, '***GOOGLE_TOKEN***');
  t = t.replace(/\bAIza[0-9A-Za-z_-]{30,}/g, '***GOOGLE_KEY***');
  // env/config assignment whose NAME looks like a secret: X=value  ->  X=***
  // (SECRET, PASSWORD/PASS, TOKEN, APIKEY/API_KEY, ACCESS_KEY, PRIVATE_KEY, etc.)
  // In the assistant's PROSE (prose:true) it only triggers when the NAME looks like a real
  // env/config identifier (ALL_CAPS or snake_case with _);
  // that way a common pt-BR text word ("passo:", "Passagens:", "tokens:") is no longer
  // caught, but a real secret (DB_PASS=, CLIENT_SECRET:, PASSWORD=) stays
  // masked. In terminal output (prose:false) keeps the always-aggressive
  // behavior.
  t = t.replace(
    /\b([A-Za-z0-9_]*(?:SECRET|PASSWORD|PASSWD|PASS|TOKEN|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CLIENT_SECRET)[A-Za-z0-9_]*)(\s*[:=]\s*)("[^"]*"|'[^']*'|\S+)/gi,
    (m, name, sep) => (prose && !(name.includes('_') || /^[A-Z0-9]+$/.test(name)) ? m : `${name}${sep}***`),
  );
  // Entire PEM private key block.
  t = t.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '***PRIVATE_KEY***');
  return maskPasswordLabels(t);
}

// Password written in plain text (pt/es/en), which the by-NAME regex above doesn't catch
// in prose: "senha: casa2026", "a senha do wifi é casa2026", "contraseña: x",
// "password is x". Only the value becomes ***. "chave"/"clave" are left out on
// purpose: a Pix key is data the owner asks for.
// With ":"/"=" any value is masked. With a verb ("é", "is", "es") only when the
// value has a digit/symbol or comes between quotes/backticks/bold, otherwise "a senha é
// obrigatória" would lose the word.
const PW_LABEL = String.raw`(?<![\p{L}\p{N}_])(?:senha|contraseña|contrasena|password|passwd|pwd)`;
const PW_QUAL = String.raw`(?:[ \t]+(?:nova|atual|antiga|provis[oó]ria|tempor[aá]ria|nueva|actual|new|current|temporary))?(?:[ \t]+(?:d[oa]s?|de|del|de la|of|for|to)[ \t]+[\p{L}\p{N}._@/-]{1,40}(?:[ \t]+(?:d[oa]s?|de|del|ao|à|no|na|en|of|for|to|on)[ \t]+[\p{L}\p{N}._@/-]{1,40})?)?`;
const PW_VALUE = String.raw`("[^"\n]+"|'[^'\n]+'|\x60[^\x60\n]+\x60|\*\*[^*\n]+\*\*|[^\s"'\x60*]+?)(?=[.,;!?)]*(?:\s|$))`;
const RE_PW_SEP = new RegExp(String.raw`(${PW_LABEL}${PW_QUAL}[ \t]*[:=][ \t]*)${PW_VALUE}`, 'giu');
const RE_PW_VERB = new RegExp(String.raw`(${PW_LABEL}${PW_QUAL}[ \t]+(?:é|eh|era|será|es|is|was)[ \t]+)${PW_VALUE}`, 'giu');
const PW_EMPTY = /^(?:\*+|-+|n\/a|não|nao|nenhuma|none|ninguna|no)$/i;

function maskPasswordValue(value) {
  // Quotes and backtick stay; bold becomes just *** (otherwise "*******" would remain).
  const q = /^["'`]/.exec(value)?.[0] || '';
  return q ? `${q}***${q}` : '***';
}

function maskPasswordLabels(t) {
  t = t.replace(RE_PW_SEP, (m, head, value) => (PW_EMPTY.test(value) ? m : head + maskPasswordValue(value)));
  return t.replace(RE_PW_VERB, (m, head, value) => {
    if (PW_EMPTY.test(value)) return m;
    const forte = /^(?:\*\*|["'`])/.test(value) || /[\p{N}\p{P}\p{S}]/u.test(value);
    return forte ? head + maskPasswordValue(value) : m;
  });
}

function shq(s) { return `'${String(s).replace(/'/g, `'\\''`)}'`; }

// Checks whether the SSH client is installed in the sandbox. Without openssh-client (see
// Dockerfile), ssh/ssh-keygen don't exist: degrades with a useful message.
async function sshAvailable(userId) {
  try {
    const r = await sandboxShell(userId, 'command -v ssh-keygen && command -v ssh', 15_000);
    return r.exitCode === 0 && (r.stdout || '').trim().length > 0;
  } catch { return false; }
}

const NO_SSH = 'O ambiente ainda não tem o cliente SSH instalado (openssh-client). Avise o suporte pra habilitar; assim que o ambiente for atualizado, isso funciona.';

// Finds the user's SSH key connection. If `host` comes in, matches by host; otherwise,
// uses the only one that exists (or asks to specify when there are several).
function pickKeyConn(conns, host, rotulo) {
  const keys = conns.filter((c) => c.kind === 'ssh_key');
  if (!keys.length) return { error: 'Você ainda não tem uma chave SSH criada. Use "gerar chave ssh" primeiro, cole a chave pública no servidor e depois rode o comando.' };
  const labels = () => keys.map((k) => k.label || k.meta?.host || '(sem rótulo)').join(', ');
  // An explicit label resolves ANY ambiguity: matches by label (or by the key's
  // fixed host). It's the parameter the model passes when there's more than one key.
  if (rotulo) {
    const r = String(rotulo).toLowerCase().trim();
    const m = keys.filter((c) => String(c.label || '').toLowerCase() === r || String(c.meta?.host || '').toLowerCase() === r);
    if (m.length === 1) return { conn: m[0] };
    if (m.length > 1) return { error: `Mais de uma chave com o rótulo "${rotulo}". Rótulos: ${labels()}.` };
    return { error: `Não achei chave com o rótulo "${rotulo}". Rótulos disponíveis: ${labels()}.` };
  }
  if (host) {
    const h = String(host).toLowerCase();
    const m = keys.filter((c) => (c.meta?.host || '').toLowerCase() === h);
    if (m.length === 1) return { conn: m[0] };
    if (m.length > 1) return { error: `Há mais de uma chave pro host ${host}. Passe o parâmetro "rotulo" pra escolher. Rótulos: ${labels()}.` };
    // No key bound to that host: if only one exists in total, uses it.
    if (keys.length === 1) return { conn: keys[0] };
    // Otherwise, tries a "loose" key (generated without a fixed host).
    const unbound = keys.filter((c) => !c.meta?.host);
    if (unbound.length === 1) return { conn: unbound[0] };
    if (unbound.length > 1) return { error: `Você tem mais de uma chave sem host fixo. Passe o parâmetro "rotulo" pra escolher qual usar com ${host}. Rótulos: ${labels()}.` };
    return { error: `Não achei chave SSH pro host ${host}. Chaves existentes: ${labels()}.` };
  }
  if (keys.length === 1) return { conn: keys[0] };
  return { error: `Você tem várias chaves SSH (${labels()}). Passe o parâmetro "rotulo" pra escolher, ou diga o host.` };
}

// Reusable transport: runs a command on the user's server via SSH from the
// sandbox, using the vault's key. Used by rodar_no_servidor and by the
// coding tools (coding.mjs). Returns an OBJECT (not a string): { ok, host, exit,
// saida, stderr, error }. Doesn't truncate saida/stderr — whoever calls it cuts as they like.
export async function sshExec(userId, comando, { host, usuario, rotulo, timeout = 90_000 } = {}) {
  if (!(await sshAvailable(userId))) return { ok: false, error: NO_SSH };
  if (!comando) return { ok: false, error: 'Sem comando pra rodar.' };
  const conns = await listConnections(userId);
  const pick = pickKeyConn(conns, host, rotulo);
  if (pick.error) return { ok: false, error: pick.error };
  const full = await getConnection(userId, pick.conn.id);
  if (!full || !full.secret_enc) return { ok: false, error: 'Não achei a chave privada no cofre.' };
  let priv;
  try { priv = decryptSecret(full.secret_enc); }
  catch { return { ok: false, error: 'Falha ao decifrar a chave (cofre).' }; }
  const usuarioFinal = usuario || full.meta?.usuario || 'root';
  const alvo = host || full.meta?.host;
  if (!alvo) return { ok: false, error: 'Não sei em qual servidor rodar. Me diga o host (IP ou domínio) do servidor.' };
  const keyPath = `${SSH_DIR}/run_${pick.conn.id}`;
  const w = await sandboxWrite(userId, keyPath, priv.endsWith('\n') ? priv : priv + '\n');
  if (!w.ok) return { ok: false, error: 'Não consegui preparar a chave no ambiente.' };
  const b64 = Buffer.from(String(comando), 'utf8').toString('base64');
  const remote = `echo ${b64} | base64 -d | bash`;
  const cmd = `chmod 600 ${shq(keyPath)} && mkdir -p ${SSH_DIR} && touch ${shq(KNOWN_HOSTS)} && ssh -i ${shq(keyPath)} -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=${shq(KNOWN_HOSTS)} -o ConnectTimeout=15 ${shq(usuarioFinal + '@' + alvo)} ${shq(remote)}`;
  let res;
  try { res = await sandboxShell(userId, cmd, timeout); }
  finally { await sandboxShell(userId, `rm -f ${shq(keyPath)}`, 10_000); }
  return {
    ok: res.exitCode === 0,
    host: alvo,
    exit: res.exitCode,
    saida: res.stdout || '',
    stderr: res.stderr || '',
    error: res.exitCode === 0 ? undefined : `Comando terminou com código ${res.exitCode}.`,
  };
}

// Is there any connected machine (SSH key in the vault)? Used to decide whether
// FREE mode applies (live terminal instead of the basic toolset).
export async function userHasSshKey(userId) {
  try {
    const conns = await listConnections(userId);
    return conns.some((c) => c.kind === 'ssh_key');
  } catch { return false; }
}

// ── FREE mode: persistent session ON the user's connected machine ──
//
// In the advanced tier (perm_mode 'livre') the assistant does NOT keep relaying
// command by command from a bare sandbox: it operates AS IF it were logged
// into the machine the user connected. Technically we still go out of the SP sandbox
// (the sandbox is just the SSH CLIENT: custody of the encrypted key + BR egress), but the
// session is PERSISTENT, unlike the stateless sshExec:
//  • ControlMaster/ControlPersist: a single connection, multiplexed and reused on every
//    command (no re-handshake), so it feels like a live shell.
//  • PERSISTENT cwd per thread: a `cd` in one command carries over to the next, because
//    we track the current directory and prefix `cd <cwd>` to the next command.
// The terminal is NOT gated: the owner already took on the risk by turning on free mode and
// connecting their OWN host (the risk is theirs). Secrets are still
// masked in the OUTPUT (history safety net), same as sshExec.
const CWD = new Map(); // `${userId}:${threadId}:${connId}` -> current remote directory
const CWD_MARK = '__BRAMBS_CWD__';

export async function livreExec(userId, comando, { threadId, host, usuario, rotulo, timeout = 180_000 } = {}) {
  if (!(await sshAvailable(userId))) return { ok: false, error: NO_SSH };
  if (!comando) return { ok: false, error: 'Sem comando pra rodar.' };
  const conns = await listConnections(userId);
  const pick = pickKeyConn(conns, host, rotulo);
  if (pick.error) return { ok: false, error: pick.error };
  const full = await getConnection(userId, pick.conn.id);
  if (!full || !full.secret_enc) return { ok: false, error: 'Não achei a chave privada no cofre.' };
  let priv;
  try { priv = decryptSecret(full.secret_enc); }
  catch { return { ok: false, error: 'Falha ao decifrar a chave (cofre).' }; }
  const usuarioFinal = usuario || full.meta?.usuario || 'root';
  const alvo = host || full.meta?.host;
  if (!alvo) return { ok: false, error: 'Não sei em qual máquina rodar. Me diga o host (IP ou domínio) da máquina conectada.' };
  const keyPath = `${SSH_DIR}/livre_${pick.conn.id}`;
  const w = await sandboxWrite(userId, keyPath, priv.endsWith('\n') ? priv : priv + '\n');
  if (!w.ok) return { ok: false, error: 'Não consegui preparar a chave no ambiente.' };
  // persistent cwd per (user, thread, connection): a `cd` carries over to the next command.
  // TARGET key (user+host). Goes into the ControlMaster socket and the cwd:
  // both are state of ONE session, and a session is per machine, not per credential.
  const alvoKey = createHash('sha256').update(`${usuarioFinal}@${alvo}`).digest('hex').slice(0, 12);
  const cwdKey = `${userId}:${threadId || 'no-thread'}:${pick.conn.id}:${alvoKey}`;
  const cwd = CWD.get(cwdKey) || '';
  // Wraps the command: enters the tracked cwd (or ~), runs, and emits the final pwd
  // in a marker so we can update the cwd. This way a `cd` persists without a live shell.
  const inner = cwd ? `cd ${shq(cwd)} 2>/dev/null || cd ~\n${comando}` : `cd ~\n${comando}`;
  const wrapped = `${inner}\n__brc=$?\nprintf '\\n${CWD_MARK}%s\\n' "$(pwd)"\nexit $__brc`;
  const b64 = Buffer.from(wrapped, 'utf8').toString('base64');
  const remote = `echo ${b64} | base64 -d | bash`;
  // The socket NEEDS the target in the name. With ControlPersist=300 the master stays alive
  // 5 min; if the name depended only on the vault connection (a single key often opens
  // SEVERAL machines), the command for host B would be multiplexed in host A's master
  // and run on the wrong machine, silently.
  const sock = `${SSH_DIR}/cm_${pick.conn.id}_${alvoKey}.sock`;
  const sshOpts = [
    `-i ${shq(keyPath)}`,
    '-o BatchMode=yes',
    '-o StrictHostKeyChecking=accept-new',
    `-o UserKnownHostsFile=${shq(KNOWN_HOSTS)}`,
    '-o ConnectTimeout=15',
    '-o ControlMaster=auto',
    `-o ControlPath=${shq(sock)}`,
    '-o ControlPersist=300',
    '-o ServerAliveInterval=15',
  ].join(' ');
  const cmd = `chmod 600 ${shq(keyPath)} && mkdir -p ${SSH_DIR} && touch ${shq(KNOWN_HOSTS)} && ssh ${sshOpts} ${shq(usuarioFinal + '@' + alvo)} ${shq(remote)}`;
  let res;
  // Deletes the key from disk afterward; the connection persists via the ControlMaster's socket,
  // so the following commands reuse the session without the key being on disk.
  try { res = await sandboxShell(userId, cmd, timeout); }
  finally { await sandboxShell(userId, `rm -f ${shq(keyPath)}`, 10_000); }
  let out = res.stdout || '';
  const idx = out.lastIndexOf(CWD_MARK);
  if (idx >= 0) {
    const newCwd = out.slice(idx + CWD_MARK.length).split('\n')[0].trim();
    if (newCwd) CWD.set(cwdKey, newCwd);
    out = out.slice(0, idx).replace(/\n+$/, '');
  }
  return {
    ok: res.exitCode === 0,
    host: alvo,
    cwd: CWD.get(cwdKey) || '~',
    exit: res.exitCode,
    saida: out,
    stderr: res.stderr || '',
    error: res.exitCode === 0 ? undefined : `Comando terminou com código ${res.exitCode}.`,
  };
}

// FREE mode's toolset: a single live, persistent and non-gated terminal.
// `sshLivre` says whether THIS agent has the right to SSH-in (super category + a key in the
// vault). When free mode came ONLY from the Runner (regular assistant bound to the
// owner's local machine), the only legitimate target is that machine: host/rotulo — which
// address a server via SSH — disappear from the schema and the fallback to
// livreExec is blocked at run time. Without this, relaxing the Runner's gate would give out free SSH.
export function livreTools(userId, threadId, runnerBound = false, sshLivre = true) {
  if (!sandboxEnabled() || !vaultEnabled()) return [];
  const soRunner = runnerBound && !sshLivre;
  const alvo = soRunner
    ? `LIVE terminal on the user's LOCAL MACHINE (their computer, via the ${marca().nome} Runner).`
    : 'LIVE terminal on the machine the user connected (advanced/free mode).';
  const consentimento = soRunner
    ? 'Runs DIRECTLY, without asking for confirmation per command (the owner installed the Runner on their machine and bound YOU to it; writing is confined to the folders they authorized there).'
    : 'Runs DIRECTLY, without asking for confirmation per command (the owner turned on free mode on this host, the risk is on their machine).';
  const props = {
    comando: { type: 'string', description: 'shell command to run on the connected machine (can be multi-line; can use cd, heredoc, pipes, &&). Prefer grouping several independent steps here in a single call.' },
    comandos: { type: 'array', items: { type: 'string' }, description: 'ALTERNATIVE to "comando": list of commands to run in sequence in the SAME call (they become a script, one per line, in the same session/cwd). Use it to group steps that do not depend on reading each other\'s output. If you want to abort on the first error, use "comando" with &&.' },
  };
  if (!soRunner) {
    props.host = { type: 'string', description: 'machine host (only needed if the user has more than one connected). Optional.' };
    props.rotulo = { type: 'string', description: 'label of the SSH key to use (the "label" shown in the vault). Pass this when you have more than one saved key and the host is not enough to choose, e.g.: "aws-build-server". Optional.' };
  }
  return [
    {
      name: 'terminal',
      description: `${alvo} You operate AS IF you were logged into it: run ANY shell command (read, edit with heredoc/sed, install, compile, build, git, systemctl, start a process) and the output comes back to you. The session is PERSISTENT: the current directory is kept between commands (a "cd projeto" holds for the next ones), so really navigate instead of rewriting the absolute path on every command. GROUP steps: each call to this tool costs a whole step of your turn — when the next commands do not depend on you READING the previous output to decide, send them all in a single call (multi-line, or \`a && b && c\` to abort on the first error, or the \`comandos\` parameter). E.g.: create folder + write file + run build = ONE call, not three. Split into separate calls only when you need the output to decide the next step. ${consentimento} The user here is technical: show the real output/error, without dressing it up. NEVER echo a secret (.env contents, key, token). If you keep hitting the SAME error 2-3 times, STOP and summarize instead of firing commands blindly. RIGHT AT THE START of the session run \`hostname; whoami; pwd; nproc\` to confirm you landed on the right machine: if the environment does not match what the user described (host/resources/expected folder), STOP and warn them, do not work on the wrong machine.`,
      parameters: {
        type: 'object',
        properties: props,
        required: [],
      },
      async run({ comando, comandos, host, rotulo }) {
        // Hard guard: an agent that only has the Runner doesn't address a server via SSH,
        // even if the model makes up a host/rotulo (they aren't in the schema).
        if (soRunner) { host = undefined; rotulo = undefined; }
        // Batching: `comandos` (list) becomes a script run in a single call —
        // same session, same cwd, one network round trip and ONE step of the turn.
        if (!comando && Array.isArray(comandos) && comandos.length) {
          comando = comandos.filter((c) => typeof c === 'string' && c.trim()).join('\n');
        }
        if (!comando || !String(comando).trim()) {
          return executionResult({ ok: false, error: 'Passe "comando" (string) ou "comandos" (lista de strings).' },'not_applied','terminal');
        }
        // Transport seam: if the user has a Brambit Runner online, IT is bound
        // to THIS assistant (runnerBound, set in Connections) and no host/label
        // was given (those point to a specific SSH machine), the target is the
        // user's LOCAL MACHINE (outbound runner). Otherwise, the usual SSH-in.
        // Same return signature for both; maskSecrets below covers both.
        const useRunner = !host && !rotulo && runnerBound && runnerOnline(userId);
        if (!useRunner && soRunner) {
          return executionResult({ ok: false, error: `O ${marca().nome} Runner saiu do ar (a máquina do usuário desconectou). Peça pra ele reabrir o Runner na máquina dele e tente de novo.` },'not_applied','terminal');
        }
        const r = useRunner
          ? await runnerExec(userId, comando, { threadId, timeout: 180_000 })
          : await livreExec(userId, comando, { threadId, host, rotulo, timeout: 180_000 });
        return executionResult({
          ok: r.ok,
          host: r.host,
          cwd: r.cwd,
          exit: r.exit,
          // Masks first, cuts afterward, and says it cut: a long command output used to
          // come out truncated with no marker at all, so the model would conclude
          // from a log it had seen only half of.
          saida: comAviso(maskSecrets(r.saida || ''), 12000, 'saída'),
          stderr: comAviso(maskSecrets(r.stderr || ''), 4000, 'saída de erro'),
          error: r.error,
        },r.ok?'applied':'unknown','terminal');
      },
    },
  ];
}

export function sshTools(userId) {
  if (!sandboxEnabled() || !vaultEnabled()) return [];
  return [
    {
      name: 'gerar_chave_ssh',
      description: 'Generates an SSH key pair (ed25519) for the user to access a server of theirs. The PRIVATE key is stored encrypted in the vault; the response carries the PUBLIC key for the user to paste into the server\'s ~/.ssh/authorized_keys. The host and the user are OPTIONAL here: if you do not know the address yet, generate the key anyway; the destination is set when running the first command (rodar_no_servidor).',
      parameters: {
        type: 'object',
        properties: {
          host: { type: 'string', description: 'server address (IP or domain), e.g.: 1.2.3.4 or meu.servidor.com (optional)' },
          usuario: { type: 'string', description: 'login user on the server, e.g.: ubuntu, root, ec2-user (optional)' },
          rotulo: { type: 'string', description: 'friendly name to identify this key (optional)' },
        },
        required: [],
      },
      async run({ host, usuario, rotulo }) {
        if (!(await sshAvailable(userId))) return executionResult({ok:false,error:NO_SSH},'not_applied','ssh_key_create');
        const nome = rotulo || host || 'chave-ssh';
        const id = 'k' + Math.abs(Date.now() % 1e9).toString(36) + Math.floor((Date.now() / 7) % 1e6).toString(36);
        const base = `${SSH_DIR}/gen_${id}`;
        const mk = await sandboxShell(
          userId,
          `mkdir -p ${SSH_DIR} && chmod 700 ${SSH_DIR} && ssh-keygen -t ed25519 -N '' -C ${shq('brambs-' + nome)} -f ${shq(base)} >/dev/null 2>&1 && cat ${shq(base + '.pub')}`,
          30_000,
        );
        if (mk.exitCode !== 0) return executionResult({ok:false,error:`Não consegui gerar a chave: ${(mk.stderr || 'erro').slice(0, 200)}`},'unknown','ssh_key_create');
        const publicKey = (mk.stdout || '').trim();
        const priv = await sandboxRead(userId, base);
        if (!priv.ok || !priv.content) { await sandboxShell(userId, `rm -f ${shq(base)} ${shq(base + '.pub')}`, 10_000); return executionResult({ok:false,error:'Não consegui ler a chave privada gerada.'},'unknown','ssh_key_create'); }
        try {
          await addConnection(userId, {
            provider: 'ssh',
            kind: 'ssh_key',
            label: nome,
            secretEnc: encryptSecret(priv.content),
            meta: { host: host || null, usuario: usuario || null, public_key: publicKey, type: 'ed25519' },
          });
        } finally {
          await sandboxShell(userId, `rm -f ${shq(base)} ${shq(base + '.pub')}`, 10_000);
        }
        const destino = host ? ` do servidor (${(usuario || 'seu-usuario')}@${host})` : ' do servidor';
        return executionResult({ok:true,saida:[
          'Chave criada e guardada com segurança no cofre.',
          '',
          `Cole a chave PÚBLICA abaixo no arquivo ~/.ssh/authorized_keys${destino}:`,
          '',
          publicKey,
          '',
          host
            ? 'Depois disso me peça pra rodar um comando no servidor pra testar.'
            : 'Depois de colar, me diga o host (IP ou domínio) e o usuário, e eu rodo um comando no servidor pra testar.',
        ].join('\n')},'applied','ssh_key_create');
      },
    },
    {
      name: 'rodar_no_servidor',
      description: 'Runs a command via SSH on a user\'s server, using an SSH key already stored in the vault. Only works after the public key has been pasted on the server (gerar_chave_ssh). Returns the command output.',
      parameters: {
        type: 'object',
        properties: {
          comando: { type: 'string', description: 'shell command to run on the remote server' },
          host: { type: 'string', description: 'server host (IP or domain). Required if the key was generated without a host, or if the user has more than one key.' },
          usuario: { type: 'string', description: 'login user on the server, e.g.: ubuntu, root. Use it if the key was generated without a fixed user (optional).' },
          rotulo: { type: 'string', description: 'label of the SSH key to use (the vault "label"). Pass this when there is more than one key and the host is not enough to choose, e.g.: "aws-build-server". Optional.' },
        },
        required: ['comando'],
      },
      async run({ comando, host, usuario, rotulo }) {
        const r = await sshExec(userId, comando, { host, usuario, rotulo, timeout: 90_000 });
        return executionResult({
          ok: r.ok,
          host: r.host,
          exit: r.exit,
          saida: comAviso(maskSecrets(r.saida || ''), 6000, 'saída'),
          stderr: comAviso(maskSecrets(r.stderr || ''), 2000, 'saída de erro'),
          error: r.error,
        },r.ok?'applied':'unknown','ssh_command');
      },
    },
  ];
}
