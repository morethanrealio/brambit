// ── Guarda de saída pra URL que o USUÁRIO escolhe (SSRF) ──
//
// Tem um punhado de lugares no harness onde quem diz o endereço é o usuário
// (hoje: servidor MCP). O fetch sai do BACKEND, que vive dentro da VPC, então
// uma URL apontando pra `http://169.254.169.254/` (metadata da AWS),
// `http://127.0.0.1:8090/` (nós mesmos) ou um IP 172.31.x.x (Postgres, sandbox)
// faz o servidor buscar, pelo usuário, coisa que ele não alcançaria de fora. É
// o SSRF clássico. Pior: como a URL carrega o header `Authorization` que o
// usuário cadastrou, `http://` ainda manda o Bearer dele em texto puro pela
// rede.
//
// Regra aqui: só `https`, só endereço PÚBLICO, e a checagem se repete a cada
// salto de redirect (senão um host público responde 302 pro 169.254 e o
// bloqueio vira decoração).
//
// Limite conhecido e assumido: entre resolver o nome e abrir a conexão existe
// uma janela de DNS rebinding (o nome resolve público na checagem e privado no
// connect). Fechar isso exige fixar o IP resolvido no socket, o que o fetch do
// Node só permite com um dispatcher da undici, que não é dependência nossa.
// Está documentado aqui de propósito: não é "resolvido", é o que falta.
import { lookup } from 'node:dns/promises';
import net from 'node:net';

// Faixas que NÃO são internet pública. Decidido sobre o IP RESOLVIDO, nunca
// sobre o texto do host: `meu-dominio.com` que resolve 127.0.0.1 é loopback.
function ipv4Privado(ip) {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = p;
  if (a === 0 || a === 10 || a === 127) return true;               // this-network, privada, loopback
  if (a === 169 && b === 254) return true;                          // link-local (metadata da nuvem)
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
  if (h === '::' || h === '::1') return true;                       // não especificado, loopback
  // IPv4 embutido (::ffff:1.2.3.4, ::ffff:102:304, 64:ff9b::/96, 2002::/16):
  // vale a regra do IPv4, senão dá pra alcançar a rede interna por v6.
  const v4 = h.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (v4 && (h.startsWith('::ffff:') || h.startsWith('::') || h.startsWith('64:ff9b:') || h.startsWith('2002:'))) {
    return ipv4Privado(v4[1]);
  }
  if (/^(fc|fd)/.test(h)) return true;                              // ULA fc00::/7
  if (/^fe[89ab]/.test(h)) return true;                             // link-local fe80::/10
  if (/^ff/.test(h)) return true;                                   // multicast
  if (/^2002:/.test(h) || /^64:ff9b:/.test(h)) return true;         // 6to4/NAT64 sem v4 legível: recusa
  return false;
}

export function ipPrivado(ip) {
  const v = net.isIP(ip);
  if (v === 4) return ipv4Privado(ip);
  if (v === 6) return ipv6Privado(ip);
  return true; // não é IP = não sei dizer que é público
}

// Valida uma URL de destino. Lança Error com mensagem pro usuário se recusar.
// `{ url }` de volta já é o objeto URL parseado.
export async function assertUrlPublica(raw) {
  let u;
  try { u = new URL(String(raw)); } catch { throw new Error('URL inválida.'); }
  if (u.protocol !== 'https:') {
    throw new Error('Só aceito endereço https. Em http o token que você cadastrou viajaria em texto puro.');
  }
  if (u.username || u.password) throw new Error('Tire usuário e senha da URL; o token vai no campo próprio.');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  // Host que JÁ é IP: decide direto, sem passar por DNS.
  if (net.isIP(host)) {
    if (ipPrivado(host)) throw new Error('Esse endereço é de rede interna. Só consigo conectar em servidor acessível pela internet.');
    return { url: u, enderecos: [host] };
  }
  let addrs;
  try { addrs = await lookup(host, { all: true, verbatim: true }); }
  catch { throw new Error('Não consegui resolver esse domínio.'); }
  if (!addrs.length) throw new Error('Não consegui resolver esse domínio.');
  // TODOS os endereços precisam ser públicos: se um nome devolve um público e um
  // privado, quem escolhe qual usar é o sistema, não a gente.
  for (const a of addrs) {
    if (ipPrivado(a.address)) {
      throw new Error('Esse domínio aponta pra rede interna. Só consigo conectar em servidor acessível pela internet.');
    }
  }
  return { url: u, enderecos: addrs.map((a) => a.address) };
}

// fetch com a guarda aplicada na URL e em CADA redirect, mais timeout.
// Redirect é seguido na mão (redirect:'manual') justamente pra revalidar o
// destino; o fetch seguindo sozinho passaria por cima da checagem.
export async function fetchExterno(raw, opts = {}, { timeoutMs = 20_000, maxRedirects = 3 } = {}) {
  let alvo = raw;
  for (let i = 0; i <= maxRedirects; i++) {
    const { url } = await assertUrlPublica(alvo);
    const r = await fetch(url, { ...opts, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    if (r.status < 300 || r.status > 399) return r;
    const loc = r.headers.get('location');
    if (!loc) return r;
    alvo = new URL(loc, url).toString();
    // 303 (e 302/301 em POST, na prática dos servidores) vira GET sem corpo.
    if (r.status === 303 && opts.method && opts.method !== 'GET') {
      opts = { ...opts, method: 'GET', body: undefined };
    }
  }
  throw new Error('Redirecionamento demais nesse endereço.');
}
