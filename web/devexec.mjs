// ── devexec runner client (dev workspaces on the mini-PaaS host) ──
//
// The harness (prod SP) talks to the `devexecd.py` runner that runs on the dev
// workspaces host (same VPC, private IP allowed in the SG only for prod). The
// runner is the CONTROL channel: provisions/clones/executes in each user's dev
// containers via devctl.sh. Config by env: DEVEXEC_URL + DEVEXEC_TOKEN.
//
// Difference from ssh.mjs: ssh.mjs connects to the USER's own infra with their
// own key (own_ssh case); this operates OUR workspaces host (system
// provisioning). GitHub token, when it's sent, is passed to the container only
// in memory.
import { maskSecrets } from './ssh.mjs';

const URL_BASE = (process.env.DEVEXEC_URL || '').replace(/\/+$/, '');
const TOKEN = process.env.DEVEXEC_TOKEN || '';

export function devexecEnabled() {
  return Boolean(URL_BASE && TOKEN);
}

async function call(method, path, body = null, timeoutMs = 130_000) {
  if (!devexecEnabled()) return { ok: false, error: 'Workspace de dev não configurado (DEVEXEC_URL/TOKEN ausentes).' };
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(`${URL_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: ac.signal,
    });
    const txt = await res.text();
    let data;
    try { data = JSON.parse(txt); } catch { data = { ok: false, error: `resposta inválida (${res.status})`, saida: txt.slice(0, 500) }; }
    if (res.status === 401) return { ok: false, error: 'Runner recusou o token (401).' };
    return data;
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? `timeout após ${Math.round(timeoutMs / 1000)}s` : String(e.message || e) };
  } finally {
    clearTimeout(t);
  }
}

// Normalizes the runner's response into a stable object, masking secrets in the output.
function norm(r) {
  return {
    ok: Boolean(r.ok),
    exit: r.exit,
    saida: maskSecrets(r.saida || ''),
    stderr: maskSecrets(r.stderr || ''),
    error: r.error,
  };
}

// Provisions (or reconnects) the user/project's workspace. Optional `repo` does
// an ANONYMOUS clone on create (only works for a public repo); for a private
// one use devClone.
export async function devCreate({ user, proj, repo } = {}) {
  return norm(await call('POST', '/create', { user, proj, repo: repo || undefined }, 180_000));
}

// AUTHENTICATED clone: the user's GitHub token goes to the container only in
// memory (credential helper), the remote's URL stays clean.
export async function devClone({ user, proj, repo, token } = {}) {
  return norm(await call('POST', '/clone', { user, proj, repo, token }, 180_000));
}

// Runs a command in the workspace. Optional `token` enables authenticated git
// operations (push/pull) via GH_TOKEN in the container.
export async function devExec({ user, proj, cmd, token, timeout } = {}) {
  return norm(await call('POST', '/exec', { user, proj, cmd, token: token || undefined, timeout }, 180_000));
}

export async function devRm({ user, proj, purge } = {}) {
  return norm(await call('POST', '/rm', { user, proj, purge: Boolean(purge) }, 60_000));
}

export async function devLs() {
  return norm(await call('GET', '/ls', null, 30_000));
}
