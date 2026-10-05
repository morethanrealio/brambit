// Alvo das sondas de isolamento entre contas (ops/tenancy-*.mjs).
//
// Sem BASE, a sonda bate no servidor LOCAL. Endereço fora da própria máquina
// (produção inclusive) só com ALLOW_REMOTE=1 junto: a sonda de escrita cria e
// apaga coisa de verdade na conta A, e antes o padrão era o endereço de produção,
// ou seja, esquecer o BASE rodava contra produção.
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

// Para os scripts: resolve ou sai com 2 (erro de setup), dizendo o alvo.
export function baseOrExit(env = process.env) {
  try {
    const r = resolveBase(env);
    console.log(`Alvo: ${r.base}${r.remote ? '  (REMOTO, ALLOW_REMOTE=1)' : ''}`);
    return r.base;
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
}
