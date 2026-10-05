// ── Cliente do devexec runner (workspaces de dev no host mini-PaaS) ──
//
// O harness (prod SP) fala com o runner `devexecd.py` que roda no host de
// workspaces de dev (mesma VPC, IP privado liberado no SG só pro prod). O runner
// é o canal de CONTROLE: provisiona/clona/executa nos containers de dev de cada
// usuário via devctl.sh. Config por env: DEVEXEC_URL + DEVEXEC_TOKEN.
//
// Diferença pro ssh.mjs: ssh.mjs conecta na infra DO USUÁRIO com a chave dele
// (caso own_ssh); isto opera o NOSSO host de workspaces (provisionamento de
// sistema). Token do GitHub, quando vai, é repassado ao container só em memória.
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

// Normaliza a resposta do runner num objeto estável, mascarando segredo na saída.
function norm(r) {
  return {
    ok: Boolean(r.ok),
    exit: r.exit,
    saida: maskSecrets(r.saida || ''),
    stderr: maskSecrets(r.stderr || ''),
    error: r.error,
  };
}

// Provisiona (ou religa) o workspace do usuário/projeto. `repo` opcional faz um
// clone ANÔNIMO no create (só serve pra repo público); pra privado use devClone.
export async function devCreate({ user, proj, repo } = {}) {
  return norm(await call('POST', '/create', { user, proj, repo: repo || undefined }, 180_000));
}

// Clone AUTENTICADO: o token do GitHub do usuário vai pro container só em
// memória (credential helper), a URL do remote fica limpa.
export async function devClone({ user, proj, repo, token } = {}) {
  return norm(await call('POST', '/clone', { user, proj, repo, token }, 180_000));
}

// Roda um comando no workspace. `token` opcional habilita operações git
// autenticadas (push/pull) via GH_TOKEN no container.
export async function devExec({ user, proj, cmd, token, timeout } = {}) {
  return norm(await call('POST', '/exec', { user, proj, cmd, token: token || undefined, timeout }, 180_000));
}

export async function devRm({ user, proj, purge } = {}) {
  return norm(await call('POST', '/rm', { user, proj, purge: Boolean(purge) }, 60_000));
}

export async function devLs() {
  return norm(await call('GET', '/ls', null, 30_000));
}
