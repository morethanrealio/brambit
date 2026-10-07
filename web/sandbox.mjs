// ── Tools de sandbox (execução de código por usuário) ──
// Cada usuário tem um container isolado no host dedicado de sandbox. Estas tools
// falam com o `runnerd` (HTTP, rede privada da VPC, Bearer token) que orquestra
// o docker no host. O isolamento real está no host: container não-root, rootfs
// só-leitura, limites de recurso, e firewall bloqueando a rede interna + metadata.
//
// Liga só se SANDBOX_URL + SANDBOX_TOKEN estiverem no ambiente (sandboxEnabled()).

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

// Helpers de baixo nível reusáveis por outros módulos (ex: ssh.mjs), presos ao
// runnerd do usuário. Devolvem o objeto cru do runnerd.
export async function sandboxShell(userId, command, timeoutMs = 60_000) {
  return call('/shell', { userId, command, timeout: timeoutMs }, { timeoutMs: timeoutMs + 15_000 });
}
export async function sandboxWrite(userId, path, content) {
  return call('/write', { userId, path, content: String(content) });
}
export async function sandboxRead(userId, path) {
  return call('/read', { userId, path });
}
// Grava BYTES crus num arquivo do sandbox (binário-seguro), via base64. O /write
// do runnerd só aceita string, então mandamos o base64 e decodificamos no shell.
// Cria a pasta se preciso. Devolve { ok, path, bytes } ou { ok:false, error }.
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

// Formata a saída de execução de forma curta e útil pro modelo.
function fmtRun(res) {
  const parts = [];
  if (res.timedOut) parts.push('[TIMEOUT: comando excedeu o tempo limite]');
  parts.push(`exit=${res.exitCode}`);
  if (res.stdout) parts.push(`--- stdout ---\n${res.stdout}`);
  if (res.stderr) parts.push(`--- stderr ---\n${res.stderr}`);
  if (!res.stdout && !res.stderr) parts.push('(sem saída)');
  return parts.join('\n');
}

// Lê os BYTES crus de um arquivo do sandbox do usuário (binário-seguro).
// Usa o endpoint /readfile do runnerd, que streama os bytes crus direto
// (application/octet-stream), numa ida só. O caminho antigo era `base64 -w0`
// pelo /shell, que o runnerd matava acima de 200KB de stdout (qualquer binário
// de tamanho real falhava com "arquivo não encontrado" enganoso). Aqui não há
// inflação de base64 nem N chamadas: o runnerd faz `docker exec cat` e pipa.
// Devolve { ok, buffer } ou { ok:false, error }.
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
      try { const j = await r.json(); if (j && j.error) msg = j.error; } catch { /* corpo não-json */ }
      return { ok: false, error: String(msg).slice(0, 200) };
    }
    const buffer = Buffer.from(await r.arrayBuffer());
    if (!buffer.length) return { ok: false, error: 'arquivo vazio' };
    return { ok: true, buffer };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e).slice(0, 200) };
  } finally { clearTimeout(t); }
}

// A home do container é somente leitura: npm/npx, pip --user e CLIs que
// guardam login em ~/.algo quebram. Nas tools do modelo a home passa a ser o
// /workspace (persistente e só do usuário). Fica fora do sandboxShell de
// propósito: o SSH depende da home padrão pra known_hosts.
const USER_ENV = 'export HOME=/workspace XDG_CACHE_HOME=/workspace/.cache npm_config_cache=/workspace/.cache/npm; ';

// Monta as tools de sandbox pra ESTE usuário (userId fica preso na closure).
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
        // Planilha não vira texto pro modelo (ver planilha.mjs): o conteúdo se
        // consulta por código, que lê o arquivo inteiro.
        if (tipoPlanilha(path, '')) return 'Este arquivo é uma planilha e não é lido como texto. Para consultar os dados use analisar_planilha, ou leia com pandas no sandbox_python.';
        const r = await call('/read', { userId, path });
        return r.ok ? r.content : `Falha: ${r.error || 'erro'}`;
      },
    },
  ];
}
