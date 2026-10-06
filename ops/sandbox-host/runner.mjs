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
const NETWORK = process.env.SANDBOX_NETWORK || 'brambs-sbx';      // rede docker só-egress
const MEM = process.env.SANDBOX_MEM || '512m';
const CPUS = process.env.SANDBOX_CPUS || '1';
const PIDS = process.env.SANDBOX_PIDS || '256';
const EXEC_TIMEOUT_MS = Number(process.env.SANDBOX_EXEC_TIMEOUT_MS || 60_000);
const IDLE_STOP = process.env.SANDBOX_IDLE_STOP || '30m';         // (faxina externa usa isso)

const cname = (userId) => `sbx_${userId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 32)}`;
const vname = (userId) => `sbxvol_${userId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 32)}`;

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

// Garante o container do usuário de pé (cria/inicia se preciso). Idempotente.
export async function ensureSandbox(userId) {
  const name = cname(userId), vol = vname(userId);
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
    '--memory', MEM, '--memory-swap', MEM,
    '--cpus', CPUS,
    '--pids-limit', PIDS,
    '--label', 'brambs.sandbox=1',
    '--label', `brambs.user=${userId}`,
    IMAGE,
  ];
  const r = await run('docker', args);
  if (r.code !== 0) throw new Error(`docker run falhou: ${r.err.slice(0, 300)}`);
  return name;
}

// Roda um comando shell no sandbox do usuário.
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

// Escreve um arquivo no /workspace do usuário (via stdin, sem shell-escaping).
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

// Metadados de um arquivo do sandbox, confinado a /workspace. Usado pelo
// /readfile pra checar existência + tamanho ANTES de streamar (mensagem clara e
// cap de tamanho). Devolve { ok, name, norm, size } ou { ok:false, error }.
export async function statFile(userId, filePath) {
  const raw = String(filePath || '').startsWith('/') ? String(filePath) : `/workspace/${filePath || ''}`;
  const norm = path.posix.normalize(raw);
  // confinamento defensivo: nada fora de /workspace (barra traversal via `..`).
  // O `cat`/`stat` já roda dentro do namespace do container (rootfs só-leitura,
  // sem alcance ao host), isto é cinto+suspensório pra não ler nem o interior da imagem.
  if (norm !== '/workspace' && !norm.startsWith('/workspace/')) return { ok: false, error: 'path fora de /workspace' };
  const name = await ensureSandbox(userId);
  const r = await run('docker', ['exec', name, 'stat', '-c', '%s', norm], { timeout: 15_000 });
  if (r.code !== 0) return { ok: false, error: 'arquivo não encontrado' };
  return { ok: true, name, norm, size: Number((r.out || '').trim()) || 0 };
}

// Streama os BYTES CRUS de um arquivo do container pro chamador (o runnerd pipa
// direto na resposta HTTP). NÃO passa pelo run() (sem o teto de 200KB do stdout
// do shell) — este é o transporte de arquivo binário, com cap próprio no runnerd.
export function spawnCat(name, norm) {
  return spawn('docker', ['exec', name, 'cat', norm], { stdio: ['ignore', 'pipe', 'pipe'] });
}

export async function stopSandbox(userId) {
  const name = cname(userId);
  await run('docker', ['stop', '-t', '2', name]);
  return { ok: true };
}
