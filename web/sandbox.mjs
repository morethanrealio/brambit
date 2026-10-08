// ── Sandbox tools (per-user code execution) ──
// Each user has an isolated container on the dedicated sandbox host. These tools
// talk to `runnerd` (HTTP, VPC private network, Bearer token), which orchestrates
// docker on the host. The real isolation is on the host: non-root container, read-only
// rootfs, resource limits, and a firewall blocking the internal network + metadata.
//
// Only turns on if SANDBOX_URL + SANDBOX_TOKEN are in the environment (sandboxEnabled()).

import { tipoPlanilha } from './planilha.mjs';

const URL = process.env.SANDBOX_URL || '';     // ex http://10.0.0.20:9000
const TOKEN = process.env.SANDBOX_TOKEN || '';

export function sandboxEnabled() { return !!(URL && TOKEN); }

async function call(path, body, { timeoutMs = 75_000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(`${URL}${path}`, {
      method: 'POST',
      headers: { 'authorization': `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error(`runnerd ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return await r.json();
  } finally { clearTimeout(t); }
}

// Low-level helpers reusable by other modules (e.g. ssh.mjs), tied to the
// user's runnerd. Return the raw runnerd object.
export async function sandboxShell(userId, command, timeoutMs = 60_000) {
  return call('/shell', { userId, command, timeout: timeoutMs }, { timeoutMs: timeoutMs + 15_000 });
}
export async function sandboxWrite(userId, path, content) {
  return call('/write', { userId, path, content: String(content) });
}
export async function sandboxRead(userId, path) {
  return call('/read', { userId, path });
}
// Writes RAW BYTES to a sandbox file (binary-safe), via base64. The runnerd's /write
// only accepts a string, so we send the base64 and decode it in the shell.
// Creates the folder if needed. Returns { ok, path, bytes } or { ok:false, error }.
export async function sandboxWriteBytes(userId, path, buffer) {
  if (!sandboxEnabled()) return { ok: false, error: 'sandbox desligado' };
  const b64 = Buffer.from(buffer).toString('base64');
  const safe = String(path).replace(/'/g, `'\\''`);
  const w = await call('/write', { userId, path: `${path}.b64`, content: b64 });
  if (!w.ok) return { ok: false, error: w.error || 'falha ao gravar' };
  const res = await call('/shell', {
    userId,
    command: `base64 -d '${safe}.b64' > '${safe}' && rm -f '${safe}.b64' && wc -c < '${safe}'`,
    timeout: 60_000,
  }, { timeoutMs: 75_000 });
  if (res.exitCode !== 0) return { ok: false, error: (res.stderr || 'falha ao decodificar base64').slice(0, 200) };
  return { ok: true, path, bytes: Number((res.stdout || '').trim()) || null };
}

// Formats the execution output in a short and useful way for the model.
function fmtRun(res) {
  const parts = [];
  if (res.timedOut) parts.push('[TIMEOUT: comando excedeu o tempo limite]');
  parts.push(`exit=${res.exitCode}`);
  if (res.stdout) parts.push(`--- stdout ---\n${res.stdout}`);
  if (res.stderr) parts.push(`--- stderr ---\n${res.stderr}`);
  if (!res.stdout && !res.stderr) parts.push('(sem saída)');
  return parts.join('\n');
}

// Reads the RAW BYTES of a file from the user's sandbox (binary-safe).
// Uses the runnerd's /readfile endpoint, which streams the raw bytes directly
// (application/octet-stream), in a single round trip. The old path was `base64 -w0`
// through /shell, which runnerd killed above 200KB of stdout (any binary
// of real size failed with a misleading "file not found"). Here there's no
// base64 inflation nor N calls: runnerd runs `docker exec cat` and pipes it.
// Returns { ok, buffer } or { ok:false, error }.
export async function sandboxReadBytes(userId, path) {
  if (!sandboxEnabled()) return { ok: false, error: 'sandbox desligado' };
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 120_000);
  try {
    const r = await fetch(`${URL}/readfile`, {
      method: 'POST',
      headers: { 'authorization': `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ userId, path }),
      signal: ctrl.signal,
    });
    if (!r.ok) {
      let msg = `falha ao ler no sandbox (${r.status})`;
      try { const j = await r.json(); if (j && j.error) msg = j.error; } catch { /* non-json body */ }
      return { ok: false, error: String(msg).slice(0, 200) };
    }
    const buffer = Buffer.from(await r.arrayBuffer());
    if (!buffer.length) return { ok: false, error: 'arquivo vazio' };
    return { ok: true, buffer };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e).slice(0, 200) };
  } finally { clearTimeout(t); }
}

// The container's home is read-only: npm/npx, pip --user and CLIs that
// store login in ~/.something break. In the model's tools the home becomes the
// /workspace (persistent and user-only). This stays out of sandboxShell on
// purpose: SSH depends on the default home for known_hosts.
const USER_ENV = 'export HOME=/workspace XDG_CACHE_HOME=/workspace/.cache npm_config_cache=/workspace/.cache/npm; ';

// Assembles the sandbox tools for THIS user (userId stays bound in the closure).
export function sandboxTools(userId) {
  if (!sandboxEnabled()) return [];
  return [
    {
      name: 'sandbox_shell',
      description: 'Runs a shell (bash) command in the user\'s isolated environment (Linux, with python3, node, git, pip). Has internet to download packages/scrape. Files live in /workspace and persist across calls; the home ($HOME) is /workspace itself. Use it to install libs, run scripts, process data, install and run third-party programs/CLIs/MCP servers (npx, pip, git clone), etc. Each command has at most 120s; a process left in the background (nohup ... &) stays alive across calls. OAuth login that sends the browser back to localhost: the user\'s browser cannot reach the sandbox; leave the program waiting in the background, ask the user to authorize and paste here the full address of the page that did not load, and hand that address to the program with curl inside the sandbox. Never repeat in the chat the code, token or secret that comes in it.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'bash command to run' },
          timeout_s: { type: 'number', description: 'maximum time in seconds (default 60, max 120)' },
        },
        required: ['command'],
      },
      async run({ command, timeout_s }) {
        const timeout = Math.min(Math.max(Number(timeout_s) || 60, 1), 120) * 1000;
        return fmtRun(await call('/shell', { userId, command: USER_ENV + command, timeout }));
      },
    },
    {
      name: 'sandbox_python',
      description: 'Runs a Python code snippet in the user\'s isolated environment (has requests, beautifulsoup4, lxml, httpx, pandas pre-installed; pip available). Has internet. Returns stdout/stderr. Use print() to see results.',
      parameters: {
        type: 'object',
        properties: {
          code: { type: 'string', description: 'Python code' },
          timeout_s: { type: 'number', description: 'maximum time in seconds (default 60, max 120)' },
        },
        required: ['code'],
      },
      async run({ code, timeout_s }) {
        const timeout = Math.min(Math.max(Number(timeout_s) || 60, 1), 120) * 1000;
        const w = await call('/write', { userId, path: '/workspace/.run/main.py', content: String(code) });
        if (!w.ok) return `Falha ao escrever o script: ${w.error || 'erro'}`;
        return fmtRun(await call('/shell', { userId, command: USER_ENV + 'python3 /workspace/.run/main.py', timeout }));
      },
    },
    {
      name: 'sandbox_write_file',
      description: 'Writes a file to the /workspace of the user\'s isolated environment (creates folders if needed). Relative paths go to /workspace.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'file path (e.g.: dados.csv or /workspace/x/y.txt)' },
          content: { type: 'string', description: 'file content' },
        },
        required: ['path', 'content'],
      },
      async run({ path, content }) {
        const r = await call('/write', { userId, path, content: String(content) });
        return r.ok ? `Arquivo gravado: ${r.path}` : `Falha: ${r.error || 'erro'}`;
      },
    },
    {
      name: 'sandbox_read_file',
      description: 'Reads a file from the /workspace of the user\'s isolated environment. A spreadsheet (.xlsx/.xls/.csv/.tsv) is not read here: use analisar_planilha or pandas in sandbox_python.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'file path' } },
        required: ['path'],
      },
      async run({ path }) {
        // Spreadsheet doesn't become text for the model (see planilha.mjs): the content
        // is queried by code, which reads the whole file.
        if (tipoPlanilha(path, '')) return 'Este arquivo é uma planilha e não é lido como texto. Para consultar os dados use analisar_planilha, ou leia com pandas no sandbox_python.';
        const r = await call('/read', { userId, path });
        return r.ok ? r.content : `Falha: ${r.error || 'erro'}`;
      },
    },
  ];
}
