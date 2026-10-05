// ── Fetch com IP fixado (anti DNS rebinding) ─────────────────────────────────
// Problema que este módulo resolve: a guarda clássica de SSRF resolve o hostname,
// confere que o IP não é interno e depois chama fetch() com o MESMO hostname. O
// fetch faz a própria resolução DNS, então um domínio com TTL curto pode devolver
// um IP público na checagem e 169.254.169.254 (metadata) ou um IP da VPC na
// conexão real. A janela entre validar e conectar é o bug (TOCTOU).
//
// Aqui a resolução acontece UMA vez: validamos todos os endereços e amarramos a
// conexão exatamente a eles, passando um `lookup` próprio para http/https (o
// fetch nativo do Node não aceita lookup nem agente, por isso não dá pra usá-lo).
// O hostname original continua indo no Host e no SNI do TLS, então certificado e
// virtual host seguem funcionando normalmente.
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

// Resolve o host e devolve a lista de endereços já validados. Lança se qualquer
// um deles for interno: basta um para o atacante ganhar a conexão.
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

// Agentes próprios, de propósito: o agente global do Node pode estar configurado
// para sair por proxy (NODE_USE_ENV_PROXY / HTTP_PROXY), e aí quem resolve o nome
// é o proxy, não a gente, o que anularia o IP fixado.
const agenteHttp = new http.Agent({ keepAlive: false });
const agenteHttps = new https.Agent({ keepAlive: false });

export const MAX_RESPOSTA_BYTES = 12 * 1024 * 1024;

// Faz a requisição e devolve um Response padrão (status/headers/arrayBuffer/text/
// json), então quem já usava fetch continua igual. NUNCA segue redirect sozinho:
// cada salto tem que passar por aqui de novo, senão o Location reabre o buraco.
export async function fetchFixado(rawUrl, opts = {}) {
  const url = new URL(rawUrl);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('protocolo não permitido');
  // opts.resolver existe só pros testes fixarem o endereço sem depender de DNS.
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
        // Status fora de 200..599 (ex.: o 999 que o LinkedIn manda pra robô) faz
        // o Response lançar. Aqui é callback de evento, fora do Promise: o erro
        // escapava sem tratamento e derrubava o processo (22/09 e 30/09/2026).
        let r;
        try {
          r = new Response(semCorpo ? null : Buffer.concat(pedacos), {
            status: res.statusCode,
            statusText: res.statusMessage || '',
            headers,
          });
        } catch {
          console.warn(`[net-pin] status fora do padrão host=${url.hostname} status=${res.statusCode}`);
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
