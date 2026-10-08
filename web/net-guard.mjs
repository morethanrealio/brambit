// ── Outbound guard for USER-chosen URLs (SSRF) ──
//
// There's a handful of places in the harness where the address is given by the user
// (today: MCP server). The fetch goes out from the BACKEND, which lives inside the VPC, so
// a URL pointing to `http://169.254.169.254/` (AWS metadata),
// `http://127.0.0.1:8090/` (ourselves) or a 172.31.x.x IP (Postgres, sandbox)
// would make the server fetch, on the user's behalf, something they couldn't reach from outside. That's
// the classic SSRF. Worse: since the URL carries the `Authorization` header the
// user registered, `http://` would still send their Bearer in plain text over the
// network.
//
// Rule here: only `https`, only a PUBLIC address, and the check repeats on every
// redirect hop (otherwise a public host responds 302 to 169.254 and the
// block becomes decoration).
//
// Known and accepted limitation: between resolving the name and opening the connection there's
// a DNS-rebinding window (the name resolves public at the check and private at
// connect). Closing that requires pinning the resolved IP on the socket, which Node's fetch
// only allows via an undici dispatcher, which isn't our dependency.
// It's documented here on purpose: it's not "solved", it's what's missing.
import { lookup } from 'node:dns/promises';
import net from 'node:net';

// Ranges that are NOT public internet. Decided on the RESOLVED IP, never
// on the host's text: `meu-dominio.com` that resolves to 127.0.0.1 is loopback.
function ipv4Privado(ip) {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = p;
  if (a === 0 || a === 10 || a === 127) return true;               // this-network, privada, loopback
  if (a === 169 && b === 254) return true;                          // link-local (cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true;                 // privada
  if (a === 192 && b === 168) return true;                          // privada
  if (a === 100 && b >= 64 && b <= 127) return true;                // CGNAT
  if (a === 198 && (b === 18 || b === 19)) return true;             // benchmark
  if (a === 192 && b === 0 && p[2] === 0) return true;              // IETF protocol assignments
  if (a >= 224) return true;                                        // multicast + reservado + broadcast
  return false;
}

function ipv6Privado(ip) {
  const h = ip.toLowerCase().split('%')[0];                         // tira o scope (fe80::1%eth0)
  if (h === '::' || h === '::1') return true;                       // unspecified, loopback
  // Embedded IPv4 (::ffff:1.2.3.4, ::ffff:102:304, 64:ff9b::/96, 2002::/16):
  // the IPv4 rule applies, otherwise the internal network could be reached over v6.
  const v4 = h.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (v4 && (h.startsWith('::ffff:') || h.startsWith('::') || h.startsWith('64:ff9b:') || h.startsWith('2002:'))) {
    return ipv4Privado(v4[1]);
  }
  if (/^(fc|fd)/.test(h)) return true;                              // ULA fc00::/7
  if (/^fe[89ab]/.test(h)) return true;                             // link-local fe80::/10
  if (/^ff/.test(h)) return true;                                   // multicast
  if (/^2002:/.test(h) || /^64:ff9b:/.test(h)) return true;         // 6to4/NAT64 with no readable v4: refuse
  return false;
}

export function ipPrivado(ip) {
  const v = net.isIP(ip);
  if (v === 4) return ipv4Privado(ip);
  if (v === 6) return ipv6Privado(ip);
  return true; // not an IP = can't say it's public
}

// Validates a destination URL. Throws an Error with a message for the user if it refuses.
// The returned `{ url }` is already the parsed URL object.
export async function assertUrlPublica(raw) {
  let u;
  try { u = new URL(String(raw)); } catch { throw new Error('URL inválida.'); }
  if (u.protocol !== 'https:') {
    throw new Error('Só aceito endereço https. Em http o token que você cadastrou viajaria em texto puro.');
  }
  if (u.username || u.password) throw new Error('Tire usuário e senha da URL; o token vai no campo próprio.');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  // Host that's ALREADY an IP: decides directly, without going through DNS.
  if (net.isIP(host)) {
    if (ipPrivado(host)) throw new Error('Esse endereço é de rede interna. Só consigo conectar em servidor acessível pela internet.');
    return { url: u, enderecos: [host] };
  }
  let addrs;
  try { addrs = await lookup(host, { all: true, verbatim: true }); }
  catch { throw new Error('Não consegui resolver esse domínio.'); }
  if (!addrs.length) throw new Error('Não consegui resolver esse domínio.');
  // ALL addresses need to be public: if a name returns one public and one
  // private, the one who chooses which to use is the system, not us.
  for (const a of addrs) {
    if (ipPrivado(a.address)) {
      throw new Error('Esse domínio aponta pra rede interna. Só consigo conectar em servidor acessível pela internet.');
    }
  }
  return { url: u, enderecos: addrs.map((a) => a.address) };
}

// fetch with the guard applied to the URL and to EVERY redirect, plus a timeout.
// Redirect is followed by hand (redirect:'manual') exactly to revalidate the
// destination; fetch following on its own would bypass the check.
export async function fetchExterno(raw, opts = {}, { timeoutMs = 20_000, maxRedirects = 3 } = {}) {
  let alvo = raw;
  for (let i = 0; i <= maxRedirects; i++) {
    const { url } = await assertUrlPublica(alvo);
    const r = await fetch(url, { ...opts, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    if (r.status < 300 || r.status > 399) return r;
    const loc = r.headers.get('location');
    if (!loc) return r;
    alvo = new URL(loc, url).toString();
    // 303 (and 302/301 on POST, in server practice) becomes a GET with no body.
    if (r.status === 303 && opts.method && opts.method !== 'GET') {
      opts = { ...opts, method: 'GET', body: undefined };
    }
  }
  throw new Error('Redirecionamento demais nesse endereço.');
}
