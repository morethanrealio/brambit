// Cookies on the person's own computer. Every cookie we set is Secure, and that
// stays true for any request that came over a network. The one exception is a
// local install (BRAMBS_LOCAL) opened in a browser on the SAME machine, over
// http://localhost: Safari (WebKit bug 281149) drops Secure cookies there, so
// login would never stick. Chrome and Firefox already accept them, so for them
// nothing changes. A tunnel or proxy arrives with its public Host or with
// X-Forwarded-Proto: https, and keeps Secure.
const LOOPBACK_ADDR = /^(127\.\d+\.\d+\.\d+|::1|::ffff:127\.\d+\.\d+\.\d+)$/;
const LOOPBACK_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

export const modoLocal = (env = process.env) => /^(1|true|on|yes)$/i.test(env.BRAMBS_LOCAL || '');

export function pedidoLocal(req, env = process.env) {
  if (!modoLocal(env)) return false;
  if (!LOOPBACK_ADDR.test(req.socket?.remoteAddress || '')) return false;
  if (!LOOPBACK_HOST.test(String(req.headers?.host || ''))) return false;
  return !req.headers?.['x-forwarded-proto'] && !req.headers?.['x-forwarded-host'] && !req.headers?.forwarded;
}

export const semSecure = (cookie) => String(cookie).replace(/;\s*Secure(?=;|$)/gi, '');

// First thing on every response: the security headers, and on a local request
// a setHeader that drops Secure from set-cookie. writeHead goes through
// setHeader once a header has been set, so cookies passed to it are covered too.
export function prepararResposta(req, res, headers, env = process.env) {
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  if (!pedidoLocal(req, env)) return;
  const original = res.setHeader.bind(res);
  res.setHeader = (nome, valor) => original(nome, String(nome).toLowerCase() === 'set-cookie'
    ? (Array.isArray(valor) ? valor.map(semSecure) : semSecure(valor)) : valor);
}
