// ── Fetch with pinned IP (anti DNS rebinding) ────────────────────────────────
// Problem this module solves: the classic SSRF guard resolves the hostname,
// checks that the IP isn't internal and then calls fetch() with the SAME hostname. The
// fetch does its own DNS resolution, so a domain with a short TTL can return
// a public IP at check time and 169.254.169.254 (metadata) or a VPC IP at the
// real connection. The window between validating and connecting is the bug (TOCTOU).
//
// Here resolution happens ONCE: we validate all the addresses and bind the
// connection exactly to them, passing our own `lookup` for http/https (Node's
// native fetch doesn't accept a lookup nor an agent, so it can't be used).
// The original hostname still goes in the Host header and the TLS SNI, so the certificate and
// virtual host keep working normally.
import net from 'node:net';
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';

export function ipPrivado(ip) {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(String(ip || ''));
  const alvo = mapped ? mapped[1] : String(ip || '');
  if (net.isIPv4(alvo)) {
    const p = alvo.split('.').map(Number);
    const [a, b] = p;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;                 // link-local / metadata
    if (a === 172 && b >= 16 && b <= 31) return true;        // 172.16/12
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;       // CGNAT 100.64/10
    if (a === 192 && b === 0 && p[2] === 0) return true;     // 192.0.0/24
    if (a === 198 && (b === 18 || b === 19)) return true;    // benchmarking 198.18/15
    if (a >= 224) return true;                               // multicast + reservado
    return false;
  }
  const lo = alvo.toLowerCase();
  if (lo === '::1' || lo === '::') return true;
  if (/^fe[89ab]/.test(lo)) return true;                     // fe80::/10 link-local
  if (/^f[cd]/.test(lo)) return true;                        // fc00::/7 unique-local
  return false;
}

// Resolves the host and returns the list of already-validated addresses. Throws if any
// of them is internal: just one is enough for the attacker to win the connection.
export async function resolverPublico(hostname) {
  if (net.isIP(hostname)) {
    if (ipPrivado(hostname)) throw new Error('destino interno bloqueado');
    return [{ address: hostname, family: net.isIPv6(hostname) ? 6 : 4 }];
  }
  let achados;
  try { achados = await dns.promises.lookup(hostname, { all: true }); }
  catch { throw new Error('host não resolve'); }
  if (!achados.length) throw new Error('host não resolve');
  for (const a of achados) if (ipPrivado(a.address)) throw new Error('destino interno bloqueado');
  return achados.map((a) => ({ address: a.address, family: a.family }));
}

function lookupFixado(addrs) {
  return (_hostname, options, cb) => {
    if (options && options.all) cb(null, addrs);
    else cb(null, addrs[0].address, addrs[0].family);
  };
}

// Own agents, on purpose: Node's global agent may be configured
// to go out through a proxy (NODE_USE_ENV_PROXY / HTTP_PROXY), and then whoever resolves the name
// is the proxy, not us, which would nullify the pinned IP.
const agenteHttp = new http.Agent({ keepAlive: false });
const agenteHttps = new https.Agent({ keepAlive: false });

export const MAX_RESPOSTA_BYTES = 12 * 1024 * 1024;

// Makes the request and returns a standard Response (status/headers/arrayBuffer/text/
// json), so whoever already used fetch stays the same. NEVER follows a redirect on its own:
// every hop has to pass through here again, otherwise the Location header reopens the hole.
export async function fetchFixado(rawUrl, opts = {}) {
  const url = new URL(rawUrl);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('protocolo não permitido');
  // opts.resolver exists only so tests can pin the address without depending on DNS.
  const addrs = await (opts.resolver || resolverPublico)(url.hostname);
  const mod = url.protocol === 'https:' ? https : http;
  const maxBytes = opts.maxBytes || MAX_RESPOSTA_BYTES;
  const timeoutMs = opts.timeoutMs || 20000;
  return await new Promise((resolve, reject) => {
    let req;
    const abortar = (e) => { try { req?.destroy(e); } catch { /* noop */ } };
    const onAbort = () => abortar(new Error('abortado'));
    req = mod.request(url, {
      method: opts.method || 'GET',
      headers: opts.headers || {},
      agent: url.protocol === 'https:' ? agenteHttps : agenteHttp,
      lookup: lookupFixado(addrs),
      servername: url.hostname,
    }, (res) => {
      const pedacos = []; let total = 0; let estourou = false;
      res.on('data', (c) => {
        if (estourou) return;
        total += c.length;
        if (total > maxBytes) {
          estourou = true;
          abortar(new Error('resposta grande demais'));
          reject(new Error('resposta grande demais'));
          return;
        }
        pedacos.push(c);
      });
      res.on('end', () => {
        if (estourou) return;
        opts.signal?.removeEventListener?.('abort', onAbort);
        const headers = new Headers();
        for (const [k, v] of Object.entries(res.headers)) {
          if (Array.isArray(v)) for (const item of v) headers.append(k, item);
          else if (v != null) headers.set(k, String(v));
        }
        const semCorpo = res.statusCode === 204 || res.statusCode === 304 || opts.method === 'HEAD';
        // A status outside 200..599 (e.g. the 999 LinkedIn sends to bots) makes
        // Response throw. This is an event callback, outside the Promise: the error
        // used to escape unhandled and crash the process (2026-09-22 and 2026-09-30).
        let r;
        try {
          r = new Response(semCorpo ? null : Buffer.concat(pedacos), {
            status: res.statusCode,
            statusText: res.statusMessage || '',
            headers,
          });
        } catch {
          console.warn(`[net-pin] unexpected status host=${url.hostname} status=${res.statusCode}`);
          reject(new Error(`status HTTP fora do padrão (${res.statusCode})`));
          return;
        }
        Object.defineProperty(r, 'url', { value: url.toString() });
        resolve(r);
      });
      res.on('error', reject);
    });
    req.setTimeout(timeoutMs, () => abortar(new Error('timeout')));
    req.on('error', (e) => { opts.signal?.removeEventListener?.('abort', onAbort); reject(e); });
    if (opts.signal) {
      if (opts.signal.aborted) { abortar(new Error('abortado')); return; }
      opts.signal.addEventListener('abort', onAbort, { once: true });
    }
    if (opts.body) req.write(opts.body);
    req.end();
  });
}
