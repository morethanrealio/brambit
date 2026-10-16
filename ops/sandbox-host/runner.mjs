// ── Per-user sandbox runner (Docker) ──
// One container per user, from the `brambs-sandbox` image. The agent calls the
// tools (shell_run / write_file / read_file) and they become `docker exec` in the
// user's container. The person's files persist in a per-user named volume.
//
// ISOLATION (what really matters in v1) lives in the `docker run` flags:
//   - non-root user (set in the image)
//   - --cap-drop ALL  + --security-opt no-new-privileges
//   - --read-only rootfs, only /workspace (volume) and /tmp writable
//   - memory, cpu and pids limits
//   - NETWORK: own egress-only network; NO access to the internal network
//     (Postgres 172.31.x, other hosts) or to AWS metadata (169.254.169.254).
//     This is blocked by the host firewall; Docker alone can't be trusted.
//
// This module does NOT run on the application server. It runs on the dedicated
// sandbox host and is called by the backend over HTTP (runnerd) or embedded.

import { spawn } from 'node:child_process';
import path from 'node:path';

const IMAGE = process.env.SANDBOX_IMAGE || 'brambs-sandbox:latest';
const NETWORK = process.env.SANDBOX_NETWORK || 'brambs-sbx';      // egress-only docker network
const MEM = process.env.SANDBOX_MEM || '512m';
const CPUS = process.env.SANDBOX_CPUS || '1';
const PIDS = process.env.SANDBOX_PIDS || '256';
const EXEC_TIMEOUT_MS = Number(process.env.SANDBOX_EXEC_TIMEOUT_MS || 60_000);
const IDLE_STOP = process.env.SANDBOX_IDLE_STOP || '30m';         // (external cleanup uses this)

const cname = (userId) => `sbx_${userId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 32)}`;
const vname = (userId) => `sbxvol_${userId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 32)}`;
const sshCname = (userId) => `sbxssh_${userId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 32)}`;
const sshVname = (userId) => `sbxsshvol_${userId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 32)}`;

function run(cmd, args, { input, timeout } = {}) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '', killed = false;
    const t = timeout ? setTimeout(() => { killed = true; p.kill('SIGKILL'); }, timeout) : null;
    p.stdout.on('data', (d) => { out += d; if (out.length > 200_000) p.kill('SIGKILL'); });
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => { if (t) clearTimeout(t); resolve({ code, out, err, killed }); });
    if (input != null) { p.stdin.write(input); p.stdin.end(); }
  });
}

async function exists(name) {
  const r = await run('docker', ['ps', '-aq', '-f', `name=^${name}$`]);
  return r.out.trim().length > 0;
}
async function isRunning(name) {
  const r = await run('docker', ['ps', '-q', '-f', `name=^${name}$`]);
  return r.out.trim().length > 0;
}

// Ensures the user's container is up (creates/starts if needed). Idempotent.
export async function ensureSandbox(userId) {
  return ensureContainer(cname(userId), vname(userId), userId, { mem: MEM, pids: PIDS });
}

async function ensureContainer(name, vol, userId, { mem, pids, labels = [] }) {
  if (await isRunning(name)) return name;
  if (await exists(name)) { await run('docker', ['start', name]); return name; }
  await run('docker', ['volume', 'create', vol]);
  const args = [
    'run', '-d', '--name', name,
    '--network', NETWORK,
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--read-only',
    '--tmpfs', '/tmp:size=128m,exec',
    '-v', `${vol}:/workspace`,
    '--memory', mem, '--memory-swap', mem,
    '--cpus', CPUS,
    '--pids-limit', pids,
    '--label', 'brambs.sandbox=1',
    '--label', `brambs.user=${userId}`,
    ...labels.flatMap((l) => ['--label', l]),
    IMAGE,
  ];
  const r = await run('docker', args);
  if (r.code !== 0) throw new Error(`docker run falhou: ${r.err.slice(0, 300)}`);
  return name;
}

// Runs a shell command in the user's sandbox.
export async function shellRun(userId, command, { timeout = EXEC_TIMEOUT_MS, cwd = '/workspace' } = {}) {
  const name = await ensureSandbox(userId);
  const r = await run('docker', ['exec', '-w', cwd, name, 'bash', '-lc', command], { timeout });
  return {
    exitCode: r.killed ? 124 : r.code,
    stdout: r.out.slice(0, 100_000),
    stderr: r.err.slice(0, 20_000),
    timedOut: r.killed,
  };
}

// Writes a file to the user's /workspace (via stdin, no shell-escaping).
export async function writeFile(userId, path, content) {
  const name = await ensureSandbox(userId);
  const safe = path.startsWith('/') ? path : `/workspace/${path}`;
  const dir = safe.replace(/\/[^/]*$/, '') || '/workspace';
  await run('docker', ['exec', name, 'mkdir', '-p', dir]);
  const r = await run('docker', ['exec', '-i', name, 'bash', '-lc', `cat > ${JSON.stringify(safe)}`], { input: content });
  return { ok: r.code === 0, path: safe, error: r.code === 0 ? undefined : r.err.slice(0, 300) };
}

export async function readFile(userId, path) {
  const name = await ensureSandbox(userId);
  const safe = path.startsWith('/') ? path : `/workspace/${path}`;
  const r = await run('docker', ['exec', name, 'cat', safe], { timeout: 15_000 });
  if (r.code !== 0) return { ok: false, error: r.err.slice(0, 300) };
  return { ok: true, path: safe, content: r.out.slice(0, 100_000) };
}

// Metadata of a sandbox file, confined to /workspace. Used by
// /readfile to check existence + size BEFORE streaming (clear message and
// size cap). Returns { ok, name, norm, size } or { ok:false, error }.
export async function statFile(userId, filePath) {
  const raw = String(filePath || '').startsWith('/') ? String(filePath) : `/workspace/${filePath || ''}`;
  const norm = path.posix.normalize(raw);
  // defensive confinement: nothing outside /workspace (blocks traversal via `..`).
  // The `cat`/`stat` already runs inside the container's namespace (read-only rootfs,
  // no reach to the host), this is belt+suspenders so it doesn't even read the inside of the image.
  if (norm !== '/workspace' && !norm.startsWith('/workspace/')) return { ok: false, error: 'path fora de /workspace' };
  const name = await ensureSandbox(userId);
  const r = await run('docker', ['exec', name, 'stat', '-c', '%s', norm], { timeout: 15_000 });
  if (r.code !== 0) return { ok: false, error: 'arquivo não encontrado' };
  return { ok: true, name, norm, size: Number((r.out || '').trim()) || 0 };
}

// Streams the RAW BYTES of a container file to the caller (runnerd pipes it
// straight into the HTTP response). Does NOT go through run() (no 200KB ceiling on the shell's
// stdout) — this is the binary file transport, with its own cap in runnerd.
export function spawnCat(name, norm) {
  return spawn('docker', ['exec', name, 'cat', norm], { stdio: ['ignore', 'pipe', 'pipe'] });
}

export async function stopSandbox(userId) {
  await run('docker', ['stop', '-t', '2', cname(userId), sshCname(userId)]);
  return { ok: true };
}

// ── SSH in a container of its own (audit item 8) ──
// The user's private key used to be written into their sandbox for the length of the
// command, where any process the model started (same container, same uid) could
// read it. Now SSH runs in a SECOND per-user container, from the same image and with
// the same flags (same egress firewall), that only runnerd execs into: the model
// has no way to see its files or processes. The key arrives via stdin, lives in that
// container's /tmp only while the command runs, and the ControlMaster socket of free
// mode stays there too. known_hosts lives in the helper's own volume.
const SSH_USER = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/;
const SSH_HOST = /^[A-Za-z0-9_.:[\]][A-Za-z0-9_.:[\]-]{0,252}$/;
const SSH_SESSION = /^[A-Za-z0-9_-]{1,64}$/;
const SSH_MAX_TIMEOUT_MS = 300_000;

// ssh argv after `-i <key>`. Never starts host/user with "-" and puts `--` before
// the target, so neither can become an option (`-oProxyCommand=...` would run
// a command next to the key). `-F /dev/null` ignores any ssh_config.
export function sshArgs({ user, host, remote, session }) {
  if (!SSH_USER.test(String(user || ''))) throw new SshInputError('usuario SSH invalido');
  if (!SSH_HOST.test(String(host || ''))) throw new SshInputError('host SSH invalido');
  if (typeof remote !== 'string' || !remote) throw new SshInputError('comando remoto obrigatorio');
  const o = ['-F', '/dev/null', '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'UserKnownHostsFile=/workspace/known_hosts', '-o', 'ConnectTimeout=15'];
  if (session != null) {
    if (!SSH_SESSION.test(String(session))) throw new SshInputError('sessao SSH invalida');
    o.push('-o', 'ControlMaster=auto', '-o', `ControlPath=/tmp/cm_${session}.sock`, '-o', 'ControlPersist=300', '-o', 'ServerAliveInterval=15');
  }
  return [...o, '-l', user, '--', host, remote];
}
export class SshInputError extends Error {}

const KEY_SCRIPT = 'T=$1; shift; umask 077; k=$(mktemp /tmp/k.XXXXXX) || exit 1; cat > "$k"; timeout -k 5 "$T" ssh -i "$k" "$@"; rc=$?; rm -f "$k"; exit $rc';

export async function sshRun(userId, { key, user, host, remote, session, timeout = 90_000 }) {
  if (typeof key !== 'string' || !key.includes('PRIVATE KEY')) throw new SshInputError('chave obrigatoria');
  const argv = sshArgs({ user, host, remote, session });
  const ms = Math.min(Number(timeout) || 90_000, SSH_MAX_TIMEOUT_MS);
  const name = await ensureContainer(sshCname(userId), sshVname(userId), userId, { mem: '128m', pids: '64', labels: ['brambs.ssh=1'] });
  const r = await run('docker', ['exec', '-i', name, 'sh', '-c', KEY_SCRIPT, 'sh', String(Math.ceil(ms / 1000)), ...argv],
    { input: key.endsWith('\n') ? key : key + '\n', timeout: ms + 15_000 });
  return {
    exitCode: r.killed ? 124 : r.code,
    stdout: r.out.slice(0, 100_000),
    stderr: r.err.slice(0, 20_000),
    timedOut: r.killed || r.code === 124,
  };
}

// Generates an ed25519 pair in the helper and returns it; nothing stays on disk.
const KEYGEN_SCRIPT = 'd=$(mktemp -d /tmp/g.XXXXXX) || exit 1; ssh-keygen -q -t ed25519 -N "" -C "$1" -f "$d/k" </dev/null && cat "$d/k.pub" && cat "$d/k"; rc=$?; rm -rf "$d"; exit $rc';

export async function sshKeygen(userId, comment) {
  const name = await ensureContainer(sshCname(userId), sshVname(userId), userId, { mem: '128m', pids: '64', labels: ['brambs.ssh=1'] });
  const r = await run('docker', ['exec', name, 'sh', '-c', KEYGEN_SCRIPT, 'sh', String(comment || 'brambs').slice(0, 100)], { timeout: 30_000 });
  const i = r.out.indexOf('-----BEGIN');
  if (r.code !== 0 || i < 0) return { ok: false, error: (r.err || 'ssh-keygen falhou').slice(0, 300) };
  return { ok: true, publicKey: r.out.slice(0, i).trim(), privateKey: r.out.slice(i) };
}
