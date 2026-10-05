// ── Ponto único de saída (egress) ──
// Envolve o `fetch` global e registra, uma vez por host, QUEM chamou e PRA ONDE
// foi. Serve duas coisas:
//
//   1. hoje: prova em execução do inventário de saídas (a lista abaixo). Host
//      que aparece no log e não está na lista abaixo é achado.
//   2. depois (Fase 4): a MESMA lista vira cerca de rede. `EGRESS_MODE=block`
//      faz host fora da lista falhar em vez de sair.
//
// O log NUNCA inclui path, query, header, body nem token: só hostname, porta
// (quando não é 443) e o módulo que chamou. URL assinada de S3 e chave de API
// viajam no path/query, então logar URL inteira seria criar o vazamento que
// este arquivo existe pra evitar.
//
// Cobertura: tudo que passa por `fetch()` (é o caso de ~todos os ~60 módulos e
// dos providers). NÃO passa por aqui, por não usar fetch:
//   - `web/kms.mjs` (IMDS + KMS via `https.request`)
//   - `web/avscan.mjs` (clamd via `net.connect`)
//   - SMTP/IMAP do `email.mjs`/`mailer.mjs` (socket do nodemailer/imap)
//   - Postgres (`pg`)
// Esses quatro são destinos fixos e conhecidos, não roteados por modelo.
//
// Importar UMA vez, o mais cedo possível, em `web/server.mjs`.

import path from 'path';
import { assertDeepSeekEgress } from '../core-proto/deepseek/scope.mjs';
import { marca } from './marca.mjs';

// Hosts esperados, do inventário de 27/08/2026. Cada entrada casa com o host
// exato OU com qualquer subdomínio dele. Integração nova entra aqui no mesmo
// commit que a adiciona (e na linha correspondente do inventário). Os domínios
// da própria instalação não ficam aqui: vêm da marca (hostsDeSaida), lidos na
// hora do uso por hostsPermitidos().
export const EGRESS_ALLOW = [
  // infra
  'amazonaws.com',            // S3, KMS, IMDS
  // modelos
  'api.deepseek.com',
  'api.together.xyz',
  'api.deepinfra.com',
  'api.openai.com',
  'generativelanguage.googleapis.com',
  // busca
  'serpapi.com',
  'api.tavily.com',
  'vertexaisearch.cloud.google.com',
  // thumbnail de resultado de busca, checado por `imageServed` (server.mjs:45)
  // antes de virar foto de card. Sai a URL do resultado, nada do usuário.
  'gstatic.com',
  // canais
  'graph.facebook.com',
  // CDN da Meta de onde a mídia RECEBIDA no WhatsApp é baixada
  // (`whatsapp.mjs:218`). Atenção: esse GET leva o nosso `WA_TOKEN`.
  'lookaside.fbsbx.com',
  'api.telegram.org',
  'api.resend.com',
  'exp.host',
  // login e cobrança
  'accounts.google.com',
  'oauth2.googleapis.com',
  'api.stripe.com',
  // conectores que o usuário liga
  'googleapis.com',
  'api.github.com',
  'github.com',
  'slack.com',
  'graph.microsoft.com',
  'login.microsoftonline.com',
  'api.linkedin.com',
  'www.linkedin.com',
  'api.nuvemshop.com.br',
  'www.tiendanube.com',
  'api.notion.com',
  'secure.splitwise.com',
  'app.startinfinity.com',
  'api.asaas.com',
  'api.appstoreconnect.apple.com',
  // Servidor MCP configurado pelo próprio usuário (tabela `mcp_servers`). O
  // host é ARBITRÁRIO por desenho: o usuário cola a URL e as tools daquele
  // servidor entram no tool-loop, recebendo argumento que pode conter conteúdo
  // dele. Hoje só existe este, do Marcos (26/06). Na Fase 4, `block` precisa
  // ler `mcp_servers` em vez de depender desta linha fixa, senão MCP novo do
  // usuário passa a falhar.
  'mcp.deepwiki.com',
];

const MODE = (process.env.EGRESS_MODE || 'log').toLowerCase();

// Rede interna e localhost não são egress: sandbox runnerd, Postgres, Comfy e
// painel local. Ficam fora do log pra ele não afogar o que importa.
function isInternal(host) {
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.local')) return true;
  if (/^127\./.test(host) || host === '::1' || host === '[::1]') return true;
  if (/^10\./.test(host)) return true;
  if (/^192\.168\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  return false;
}

export const hostsPermitidos = () => [...marca().hostsDeSaida, ...EGRESS_ALLOW];

function isAllowed(host) {
  const h = String(host).toLowerCase();
  return hostsPermitidos().some((a) => h === a || h.endsWith('.' + a));
}

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);

// Quem chamou: primeiro frame da pilha que é arquivo NOSSO e não é este módulo.
function callerModule() {
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = 30;
  const stack = new Error().stack || '';
  Error.stackTraceLimit = limit;
  for (const line of stack.split('\n').slice(2)) {
    // Aceita as duas formas que o V8 usa: `(/caminho/x.mjs:1:2)` e
    // `file:///caminho/x.mjs:1:2` (frame de topo de módulo ESM).
    const m = line.match(/(?:file:\/\/)?(\/[^\s():]+\.mjs):\d+:\d+/);
    if (!m) continue;
    const file = m[1].replace(/^\/+/, '/');
    if (file.endsWith('/web/egress.mjs')) continue;
    if (file.includes('/node_modules/')) continue;
    if (!file.startsWith(ROOT)) continue;
    return path.relative(ROOT, file);
  }
  return '?';
}

// host -> { calls, vias:Set, lastWarn }
const seen = new Map();

export function egressHosts() {
  return [...seen.entries()]
    .map(([host, s]) => ({ host, calls: s.calls, vias: [...s.vias], conhecido: isAllowed(host) }))
    .sort((a, b) => b.calls - a.calls);
}

let installed = false;

export function installEgress() {
  if (installed) return;
  const orig = globalThis.fetch;
  if (typeof orig !== 'function') {
    console.error('[egress] fetch global ausente; ponto de saída NÃO instalado');
    return;
  }
  installed = true;

  globalThis.fetch = function fetch(input, init) {
    let host = '';
    let port = '';
    try {
      const raw = typeof input === 'string' ? input : (input?.url ?? String(input));
      const u = new URL(raw);
      host = u.hostname.toLowerCase();
      port = u.port && u.port !== '443' ? ':' + u.port : '';
    } catch {
      // URL relativa ou objeto exótico: não é saída pra host externo.
      return orig.call(this, input, init);
    }

    try { assertDeepSeekEgress(host); } catch (error) { return Promise.reject(error); }
    if (!isInternal(host)) {
      const known = isAllowed(host);
      let s = seen.get(host);
      if (!s) {
        s = { calls: 0, vias: new Set(), lastWarn: 0 };
        seen.set(host, s);
      }
      s.calls++;
      const via = callerModule();
      const novoVia = !s.vias.has(via);
      s.vias.add(via);

      if (!known) {
        // Host fora do inventário: avisa sempre (com teto de 1/min por host,
        // pra um laço não afogar o journal).
        const now = Date.now();
        if (now - s.lastWarn > 60_000) {
          s.lastWarn = now;
          console.warn(`[egress] FORA DO INVENTARIO host=${host}${port} via=${via} calls=${s.calls} mode=${MODE}`);
        }
        if (MODE === 'block') {
          return Promise.reject(new Error(`[egress] host bloqueado: ${host} (via ${via}). Entre no inventário antes.`));
        }
      } else if (novoVia) {
        // Host conhecido: uma linha por (host, módulo), só pra provar quem sai.
        console.log(`[egress] host=${host}${port} via=${via}`);
      }
    }

    return orig.call(this, input, init);
  };

  console.log(`[egress] ponto de saída instalado (mode=${MODE}, ${hostsPermitidos().length} hosts no inventário)`);
}

installEgress();
