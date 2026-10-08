// Target of the cross-account isolation probes (ops/tenancy-*.mjs).
//
// Without BASE, the probe hits the LOCAL server. An address outside the machine itself
// (production included) only with ALLOW_REMOTE=1 alongside it: the write probe creates and
// deletes real stuff in account A, and the default used to be the production address,
// meaning forgetting BASE would run against production.
export const DEFAULT_BASE = 'http://127.0.0.1:8080';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export function resolveBase(env = process.env) {
  const raw = (env.BASE || DEFAULT_BASE).trim().replace(/\/+$/, '');
  let url;
  try { url = new URL(raw); } catch { throw new Error(`BASE inválida: ${raw}`); }
  if (!/^https?:$/.test(url.protocol)) throw new Error(`BASE precisa ser http(s): ${raw}`);
  const remote = !LOOPBACK.has(url.hostname);
  if (remote && env.ALLOW_REMOTE !== '1') {
    throw new Error(`BASE=${raw} não é esta máquina. Para sondar um servidor remoto (produção inclusive), rode de novo com ALLOW_REMOTE=1.`);
  }
  return { base: raw, remote };
}

// For the scripts: resolves or exits with 2 (setup error), stating the target.
export function baseOrExit(env = process.env) {
  try {
    const r = resolveBase(env);
    console.log(`Target: ${r.base}${r.remote ? '  (REMOTO, ALLOW_REMOTE=1)' : ''}`);
    return r.base;
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
}
