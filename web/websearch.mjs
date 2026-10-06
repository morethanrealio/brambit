// ── Tool de busca na web pra modelos SEM grounding embutido ──
// O Gemini tem busca nativa (google_search); OpenAI/GLM não. Pra dar grounding a
// esses modelos no nosso tool-loop, expomos a tool `buscar_web`.
//
// Dois backends possíveis:
//  1. TAVILY (preferido quando TAVILY_API_KEY existe): API de busca feita pra LLM,
//     ~1-2s por consulta, devolve snippets + um "answer" curto. NÃO gera texto,
//     então é MUITO mais rápido que o Gemini (que faz uma geração inteira por
//     busca, ~10-20s). Custo ~$0,008/busca (basic), free tier 1000/mês.
//  2. GEMINI groundedSearch (fallback): faz uma busca grounded + síntese no
//     Gemini. Mais lento, mas reaproveita a cota grátis de busca (5k/mês).
//
// O custo de cada busca é reportado via onUsage (kind='search') pra cair no mesmo
// pipeline de crédito das outras chamadas.
import { uaBot } from './marca.mjs';
import { isDeepSeekTurn } from '../core-proto/deepseek/scope.mjs';
import { groundedSearch } from '../core-proto/providers/gemini.mjs';
import { extractPdfText } from './pdf.mjs';
import { resolveGroundingUri, renderFontes } from './links.mjs';
import dns from 'dns';
import net from 'net';
import { fetchFixado } from './net-pin.mjs';
import { pageContentQuality, improvePageReading, PARTIAL_PAGE_MARKER } from './page-content-quality.mjs';
import { analisePlanilhaConector, tipoPlanilha } from './planilha.mjs';

// ── Proteção anti-SSRF pra abrir_link ──
// abrir_link busca uma URL controlada pelo modelo/usuário DE DENTRO da VPC. Sem
// filtro, dá pra alcançar o endpoint de metadata da cloud (169.254.169.254) ou
// serviços internos (172.31.x.x, localhost). Aqui a gente: (1) só aceita http/https
// nas portas 80/443, (2) resolve o host e recusa se QUALQUER IP cair em faixa
// privada/loopback/link-local, e (3) segue redirects manualmente revalidando cada
// hop (um destino público que redireciona pra um interno não passa) e (4) a conexão
// sai por fetchFixado, que resolve o host UMA vez e amarra o socket nos IPs já
// validados. O (4) fecha o DNS rebinding: antes, o fetch nativo refazia a
// resolução por conta própria depois do check, e um domínio com TTL curto podia
// devolver IP público na validação e IP interno na conexão.
function ipv4Private(ip) {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) return true;
  const [a, b] = p;
  if (a === 0 || a === 10 || a === 127) return true;         // this-host / privada / loopback
  if (a === 169 && b === 254) return true;                    // link-local + metadata
  if (a === 172 && b >= 16 && b <= 31) return true;           // 172.16/12
  if (a === 192 && b === 168) return true;                    // 192.168/16
  if (a === 100 && b >= 64 && b <= 127) return true;          // CGNAT 100.64/10
  if (a === 192 && b === 0 && p[2] === 0) return true;        // 192.0.0/24
  if (a === 198 && (b === 18 || b === 19)) return true;       // benchmarking 198.18/15
  if (a >= 224) return true;                                  // multicast + reservado
  return false;
}
function isPrivateIp(ip) {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return ipv4Private(mapped[1]);
  if (net.isIPv4(ip)) return ipv4Private(ip);
  const low = ip.toLowerCase();
  if (low === '::1' || low === '::') return true;             // loopback / unspecified
  if (/^fe[89ab]/.test(low)) return true;                     // fe80::/10 link-local
  if (/^f[cd]/.test(low)) return true;                        // fc00::/7 unique-local
  return false;
}
async function assertPublicUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new Error('URL inválida'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('protocolo não permitido');
  const port = url.port ? Number(url.port) : (url.protocol === 'https:' ? 443 : 80);
  if (port !== 80 && port !== 443) throw new Error('porta não permitida');
  const host = url.hostname;
  let addrs = [];
  if (net.isIP(host)) addrs = [host];
  else {
    const looked = await dns.promises.lookup(host, { all: true });
    addrs = looked.map((a) => a.address);
  }
  if (!addrs.length) throw new Error('host não resolve');
  for (const ip of addrs) if (isPrivateIp(ip)) throw new Error('destino interno bloqueado');
}
async function safeFetch(startUrl, opts = {}, maxRedirects = 4) {
  let current = startUrl;
  for (let i = 0; i <= maxRedirects; i++) {
    await assertPublicUrl(current);
    const res = await fetchFixado(current, opts);
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) return res;
      const next = new URL(loc, current).toString();
      try { await res.body?.cancel?.(); } catch { /* noop */ }
      current = next;
      continue;
    }
    return res;
  }
  throw new Error('redirects demais');
}

const TAVILY_URL = process.env.TAVILY_URL || 'https://api.tavily.com/search';
const TAVILY_EXTRACT_URL = process.env.TAVILY_EXTRACT_URL || 'https://api.tavily.com/extract';

export function tavilyEnabled() {
  return !!process.env.TAVILY_API_KEY;
}

// Extrai o conteúdo REAL de uma URL (título + texto legível da página). É o jeito
// certo de descobrir o que é um link que o usuário mandou — MUITO mais confiável
// que buscar por palavra-chave num link solto (a busca "ancora" no contexto da
// conversa e pode devolver o produto errado; bug reportado por um usuário em 01/07, em
// que um link de pratos foi confundido com um produto da conversa anterior).
async function tavilyExtract(url) {
  const res = await fetch(TAVILY_EXTRACT_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.TAVILY_API_KEY}` },
    body: JSON.stringify({ urls: [url] }),
  });
  if (!res.ok) throw new Error(`tavily extract ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  const r = Array.isArray(data.results) ? data.results[0] : null;
  const raw = r?.raw_content ? String(r.raw_content) : '';
  // Custo modelado como 1 busca (mesma linha de pricing).
  const usage = { model: 'tavily-search', in: 0, cached: 0, out: 1, think: 0, total: 1 };
  console.log(`[tavily extract] url="${String(url).slice(0, 80)}" ok=${!!raw} len=${raw.length}`);
  return { text: raw, url: r?.url || url, usage };
}

// "Relaxa" uma query que provavelmente se auto-sabotou: tira operador site:
// (com domínio chutado ele zera tudo) e aspas de frase exata (matam o recall).
// Só serve pra REFAZER quando a busca original volta vazia.
function relaxQuery(q) {
  return String(q || '')
    .replace(/-?site:\S+/gi, ' ')          // operador site:dominio
    .replace(/["""'']/g, ' ')              // aspas retas e tipográficas
    .replace(/\s+/g, ' ')
    .trim();
}

function searchDateFilters(dataInicio, dataFim) {
  const filters = {};
  for (const [name, field, value] of [['data_inicio', 'start_date', dataInicio], ['data_fim', 'end_date', dataFim]]) {
    if (value === undefined) continue;
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)
      || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) {
      throw new Error(`${name} deve ser uma data válida no formato YYYY-MM-DD.`);
    }
    filters[field] = value;
  }
  if (filters.start_date && filters.end_date && filters.start_date > filters.end_date) {
    throw new Error('data_inicio não pode ser posterior a data_fim.');
  }
  return filters;
}

// Uma chamada crua ao Tavily. depth 'basic' (rápido) ou 'advanced' (mais recall).
async function tavilyCall(query, { maxResults = 10, depth = 'basic', dateFilters = {} } = {}) {
  const res = await fetch(TAVILY_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.TAVILY_API_KEY}` },
    body: JSON.stringify({
      query,
      search_depth: depth,
      max_results: maxResults,
      include_answer: true,
      // Keep the native window, but preserve candidates without an indexed
      // date. Strict filtering would discard those before the page is read.
      // Tavily estimates publication OR update dates; neither proves publication.
      // https://docs.tavily.com/documentation/api-reference/endpoint/search
      ...(Object.keys(dateFilters).length ? { ...dateFilters, include_published_date: true } : {}),
    }),
  });
  if (!res.ok) throw new Error(`tavily ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  const results = Array.isArray(data.results) ? data.results : [];
  console.log(`[tavily search] q="${String(query).slice(0, 60)}" depth=${depth} results=${results.length}`);
  return { results, answer: data.answer || '' };
}

// Busca "crua" no Tavily: devolve { text, sources, usage } no MESMO shape do
// groundedSearch, pra o run() abaixo tratar os dois iguais. Se a busca voltar
// VAZIA, refaz UMA vez com a query relaxada (sem aspas/site:) e depth advanced,
// pra não devolver "0 resultados" cru — foi assim que a IA disse "não existe" pra
// um site que existia (caso TAB, Flávio 03/08). O determinismo aqui evita que o
// modelo interprete busca falha como "não existe".
async function tavilySearch(query, { maxResults = 10, dateFilters = {} } = {}) {
  let calls = 1;
  let { results, answer } = await tavilyCall(query, { maxResults, dateFilters });
  let relaxedNote = '';
  if (!results.length) {
    const relaxed = relaxQuery(query);
    if (relaxed && relaxed.toLowerCase() !== String(query).toLowerCase()) {
      calls += 1;
      const r2 = await tavilyCall(relaxed, { maxResults, depth: 'advanced', dateFilters });
      if (r2.results.length) {
        results = r2.results; answer = r2.answer;
        relaxedNote = `(sua busca voltou vazia; refiz sem aspas/operadores como "${relaxed}")`;
      }
    }
  }
  const sources = results.map((r) => ({ title: r.title || r.url, uri: r.url }));
  // Texto = o "answer" do Tavily (se veio) + os snippets dos resultados, pra dar
  // ao modelo conteúdo concreto pra sintetizar (Tavily não escreve resposta longa).
  const parts = [];
  if (answer) parts.push(answer);
  for (const r of results) {
    const filtered = Object.keys(dateFilters).length > 0;
    const dated = typeof r.published_date === 'string' && Number.isFinite(Date.parse(r.published_date));
    const date = filtered ? dated
      ? ` [data estimada pelo buscador: ${r.published_date.replace(/[\r\n]/g, ' ').slice(0, 100)}]`
      : ' [data não verificada no índice; confira na página]' : '';
    if (r.content || filtered) parts.push(`• ${r.title || r.url}${date}: ${r.content ? String(r.content).slice(0, 500) : '(sem trecho; leia a página)'}`);
  }
  const text = parts.join('\n');
  // Custo por CHAMADA (não por token): modelamos cada chamada Tavily como 1 token
  // de saída na linha 'tavily-search' do pricing → costOf ≈ $0,008/busca.
  const usage = { model: 'tavily-search', in: 0, cached: 0, out: calls, think: 0, total: calls };
  return { text, sources, usage, empty: !results.length, relaxedNote };
}

// `resolveGroundingUri` e `renderFontes` moraram aqui até 08/09/2026. Foram pro
// `links.mjs` junto com a conferência de link (é tudo a mesma coisa: URL que sai
// pro usuário) e porque o caminho de turno precisa delas sem arrastar este módulo
// inteiro atrás. Seguem reexportadas daqui pra não quebrar quem já importava.
// ATENÇÃO: `export { x } from` NÃO cria o nome dentro deste módulo; o import
// explícito acima é o que deixa o run() abaixo chamar renderFontes. Sem ele, toda
// busca caiu em "renderFontes is not defined" de 08/09 a 12/09/2026 e o log
// culpou a Tavily ("TAVILY CAIU") por um bug nosso.
export { resolveGroundingUri, renderFontes } from './links.mjs';

// O caminho rápido (Tavily) cair não pode ser SILENCIOSO. Antes, o catch abaixo
// caía no Gemini sem deixar rastro: a Tavily estourou a cota em 13/08/2026 (HTTP
// 432) e a plataforma inteira rodou 17 dias no caminho lento (~15s por busca em
// vez de ~2s) sem ninguém perceber. Agora toda queda grita em duas frentes:
// no log (tag fixa, greppável no journalctl) e no usage_events com
// kind='search_degraded', que dá pra contar em SQL sem schema novo.
// Quota estourada é permanente até alguém trocar o plano, então ela é marcada
// separado de falha transitória (timeout, 5xx).
let _tavilyFails = 0;
// Erro de PROGRAMAÇÃO (ReferenceError/TypeError/SyntaxError) não é a Tavily caindo:
// a resposta dela já chegou e quebramos depois. Fica com tag própria pra ninguém
// gastar dias olhando pro provedor errado (foi o que aconteceu em 09-12/09/2026).
function isBugInterno(err) {
  return err instanceof ReferenceError || err instanceof TypeError || err instanceof SyntaxError;
}
function noteTavilyFailure(err, onUsage, planoB = 'fallback Gemini (lento)') {
  const msg = err?.message ?? String(err);
  const bug = isBugInterno(err);
  const quota = !bug && /\b(432|429)\b|usage limit|exceeds your plan/i.test(msg);
  _tavilyFails += 1;
  if (bug) console.error(`[websearch] BUG INTERNO na busca (não é a Tavily) fails=${_tavilyFails} -> ${planoB}. ${err?.stack?.split('\n').slice(0, 2).join(' | ') || msg.slice(0, 200)}`);
  else console.error(`[websearch] TAVILY CAIU (${quota ? 'COTA/PLANO' : 'transitório'}) fails=${_tavilyFails} -> ${planoB}. ${msg.slice(0, 200)}`);
  try {
    onUsage?.({
      usage: { model: bug ? 'websearch-bug' : quota ? 'tavily-quota' : 'tavily-erro', in: 0, cached: 0, out: 0, think: 0, total: 0 },
      kind: 'search_degraded',
    });
  } catch { /* nunca deixa a métrica derrubar a busca */ }
}

// Modelo do FALLBACK de busca (quando o Tavily cai/estoura cota). Era o
// gemini-3.5-flash, que é o modelo mais CARO que a gente tem (1,50 in / 9,00 out
// contra 0,75 / 3,75 do primário): na queda do Tavily de 22 a 30/08/2026 a busca
// ficou 2x mais cara em vez de degradar barato. O 3.7 responde grounding com o
// mesmo número de fontes (probado 02/09), então o fallback passa a ser ele.
// Trocável por env pra rollback sem deploy.
const SEARCH_FALLBACK_MODEL = process.env.SEARCH_FALLBACK_MODEL || 'gemini-3.7-flash';

// ── Orçamento de buscas POR TURNO (caso de 28/09/2026) ──
// Num único turno pedindo "onde assistir" pra uma lista de filmes, o modelo
// chamou `pesquisar` 6 vezes seguidas e cada sub-agente refez as mesmas buscas
// filme por filme: 139 buscas, Bacurau e Parasita buscados 3 a 4 vezes, ~1.100
// créditos num turno só, até o saldo acabar. A instrução no prompt ("1 a 3
// buscas amplas") não segurou, então o freio agora é no código: um objeto por
// turno, compartilhado entre o principal e os sub-agentes de pesquisa, que
// (1) devolve do cache a busca repetida ou quase igual sem gastar outra chamada,
// e (2) corta de vez quando o teto do turno é atingido, mandando o modelo
// responder com o que já tem. Teto em 50 (Marcos, 28/09): nos últimos 10 dias
// só 13 de 127 pedidos com busca passaram de 20, então 50 pega só o caso fora
// da curva sem cortar pedido legítimo grande.
export const MAX_SEARCHES_PER_TURN = Number(process.env.MAX_SEARCHES_PER_TURN) || 50;

// Chave "quase igual": sem acento, sem pontuação, sem palavra curta e com as
// palavras em ordem alfabética, pra "Bacurau onde assistir streaming" e
// "onde assistir Bacurau (streaming)" caírem na mesma busca.
export function searchKey(consulta, dataInicio, dataFim) {
  const palavras = String(consulta || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ').split(' ').filter((w) => w.length > 2);
  return `${[...new Set(palavras)].sort().join(' ')}|${dataInicio || ''}|${dataFim || ''}`;
}

export const SEARCH_LIMIT_MSG = (max) => `LIMITE DE BUSCAS DESTE TURNO ATINGIDO (${max}). Nenhuma busca nova foi feita e as próximas também não serão. NÃO chame buscar_web nem pesquisar de novo agora: responda JÁ com o que você levantou até aqui, diga com honestidade o que ficou sem confirmar e ofereça continuar numa próxima mensagem.`;

export function createSearchBudget({ max = MAX_SEARCHES_PER_TURN } = {}) {
  const cache = new Map();
  let used = 0;
  let hits = 0;
  let blocked = 0;
  return {
    max,
    get used() { return used; },
    get hits() { return hits; },
    get blocked() { return blocked; },
    get exhausted() { return used >= max; },
    // Envolve UMA busca real. Mesma chave: devolve o resultado já obtido
    // (inclusive se a primeira ainda estiver em andamento). Teto: não busca.
    async run(key, doSearch) {
      if (cache.has(key)) { hits += 1; return { text: await cache.get(key), cached: true }; }
      if (used >= max) { blocked += 1; return { text: SEARCH_LIMIT_MSG(max), limited: true }; }
      used += 1;
      const p = Promise.resolve().then(doSearch);
      cache.set(key, p);
      try {
        const text = await p;
        // Erro não fica no cache: a próxima tentativa pode dar certo.
        if (typeof text !== 'string' || text.startsWith('ERRO')) cache.delete(key);
        return { text };
      } catch (e) { cache.delete(key); throw e; }
    },
  };
}

export function webSearchTool({ onUsage, model = SEARCH_FALLBACK_MODEL, budget = null, fontes = null } = {}) {
  const useTavily = tavilyEnabled();
  return {
    name: 'buscar_web',
    description: 'Busca informação ATUAL na web (preço, horário, notícia, disponibilidade, endereço, evento, lugares, produtos, qualquer dado de tempo real ou que você não tenha certeza). Uma única busca já devolve VÁRIOS resultados concretos (nomes, endereços, fontes). Use SEMPRE que precisar de um fato factual/atual em vez de responder de memória. EFICIÊNCIA IMPORTA: busque de forma AMPLA, por categoria/região (ex: "melhores casas de jazz em São Paulo endereço programação"), NUNCA uma busca separada por cada item/lugar/produto (isso deixa a resposta lenta demais). Para um roteiro/lista, 1 a 3 buscas amplas bastam; só busque de novo se faltar um dado específico. Não responda no genérico se ainda não buscou o suficiente, mas também não fique buscando item por item. Monte a consulta SIMPLES, poucas palavras em pt-BR: NÃO use aspas de frase exata nem o operador site: com domínio chutado (zeram os resultados). Se o usuário mandar "vá no site de X", ache o site oficial e ABRA com abrir_link em vez de caçar o fato por palavra-chave. NUNCA conclua que algo "não existe" só porque uma busca voltou vazia.',
    parameters: {
      type: 'object',
      properties: {
        consulta: { type: 'string', description: 'O que buscar, em linguagem natural (pt-BR). Ex: "preço passagem São Paulo Paraty ônibus hoje".' },
        data_inicio: { type: 'string', format: 'date', description: 'Opcional: limite inicial YYYY-MM-DD da janela pedida. Use com data_fim em buscas de notícias/curadoria com período definido. O buscador filtra pela estimativa de publicação ou atualização e pode retornar candidatos sem data no índice; confira a data original na página.' },
        data_fim: { type: 'string', format: 'date', description: 'Opcional: limite final YYYY-MM-DD da janela pedida. Não amplie a janela para preencher resultados. Sem provedor com suporte, a ferramenta informa que não conseguiu aplicar o filtro.' },
      },
      required: ['consulta'],
    },
    run: async (args) => {
      if (!args?.consulta || !String(args.consulta).trim()) return 'ERRO: consulta vazia.';
      if (!budget) return buscar(args);
      const r = await budget.run(searchKey(args.consulta, args.data_inicio, args.data_fim), () => buscar(args));
      if (r.cached) console.log(`[websearch] busca repetida no turno, devolvida do cache q="${String(args.consulta).slice(0, 60)}"`);
      if (r.limited) console.log(`[websearch] teto de ${budget.max} buscas no turno, bloqueada q="${String(args.consulta).slice(0, 60)}"`);
      return r.cached ? `(mesma busca já feita neste turno; resultado reaproveitado, não repita)\n${r.text}` : r.text;
    },
  };
  async function buscar({ consulta, data_inicio, data_fim }) {
    {
      let dateFilters;
      try { dateFilters = searchDateFilters(data_inicio, data_fim); }
      catch (e) { return `ERRO: ${e.message} Nenhuma busca foi feita.`; }
      const filtered = Object.keys(dateFilters).length > 0;
      const dateNote = filtered ? `Filtro de datas enviado ao buscador: ${data_inicio || 'sem limite inicial'} a ${data_fim || 'sem limite final'}. A data estimada pode ser de publicação ou atualização; confirme a data original na página antes de selecionar um artigo. Candidatos sem data no índice foram permitidos para leitura, mas ainda não têm data verificada nem elegibilidade confirmada.\n` : '';
      if (filtered && !useTavily) return 'ERRO: o provedor de busca disponível não suporta os filtros estruturados de data desta ferramenta. Nenhuma busca foi feita; não trate a janela solicitada como verificada.';
      if (isDeepSeekTurn() && !useTavily) return 'ERRO: Tavily indisponível. Nenhuma busca Gemini foi feita; não responda como se tivesse pesquisado.';
      try {
        const { text, sources, usage, empty, relaxedNote } = useTavily
          ? await tavilySearch(consulta, { dateFilters })
          : await groundedSearch(consulta, { model });
        if (usage && onUsage) onUsage({ usage, kind: 'search' });
        if (empty || (!text && !sources.length)) {
          if (filtered) return `${dateNote}Não achei resultados com esses filtros. A janela foi preservada, inclusive ao simplificar a consulta quando aplicável. Isso não comprova ausência de publicações; não amplie o período nem preencha com fontes antigas.`;
          // Não devolve "0 resultados" seco: instrui a IA a NÃO afirmar ausência
          // e a tentar o caminho certo (busca simples / abrir o site oficial).
          return 'Não achei resultados, mesmo depois de ampliar a busca (tirei aspas e operadores). NÃO conclua que a informação não existe a partir disso. Refaça com uma busca mais SIMPLES (poucas palavras em pt-BR); se o usuário citou um site ou empresa, procure o site oficial e use abrir_link pra ler a página direto.';
        }
        const lista = await renderFontes(sources, fontes);
        const prefix = dateNote + (relaxedNote ? `${relaxedNote}\n` : '');
        return `${prefix}${text || '(sem resumo)'}\n\nFontes:\n${lista || '(sem fontes)'}`;
      } catch (e) {
        // Se o Tavily falhar, cai no Gemini como rede de segurança.
        // Datas são uma restrição: não gastar uma segunda busca sem suporte
        // que silenciosamente devolva notícias fora da janela pedida.
        if (useTavily && filtered) {
          noteTavilyFailure(e, onUsage, 'sem fallback: filtros estruturados de data não suportados pelo provedor alternativo');
          return 'ERRO: a busca com filtros de data falhou. O provedor alternativo não suporta esses filtros nesta ferramenta, então não fiz uma busca sem eles. Não consegui verificar a janela solicitada.';
        }
        if (useTavily && isDeepSeekTurn()) {
          noteTavilyFailure(e, onUsage, 'sem fallback por seleção DeepSeek');
          return 'ERRO: a busca Tavily falhou. Nenhuma busca Gemini foi feita; não responda como se tivesse pesquisado.';
        }
        if (useTavily) {
          noteTavilyFailure(e, onUsage);
          try {
            const { text, sources, usage } = await groundedSearch(consulta, { model });
            if (usage && onUsage) onUsage({ usage, kind: 'search' });
            const lista = await renderFontes(sources, fontes);
            return `${text || '(sem resumo)'}\n\nFontes:\n${lista || '(sem fontes)'}`;
          } catch (e2) {
            return `ERRO ao buscar na web: ${e2?.message ?? e2}`;
          }
        }
        return `ERRO ao buscar na web: ${e?.message ?? e}`;
      }
    }
  }
}

// Tool pra ABRIR um link específico e ler o conteúdo real da página. Use SEMPRE
// que o usuário mandar uma URL (produto, artigo, etc.) e você precisar saber o que
// é — em vez de deduzir pela conversa ou buscar por palavra-chave num link solto.
// Só faz sentido com Tavily (extract); sem ele, o agente cai no sandbox/curl.
// Deriva um nome de arquivo a partir da URL (pra legenda no bucket).
function nameFromUrl(u) {
  try {
    const p = new URL(u).pathname;
    const base = decodeURIComponent(p.split('/').filter(Boolean).pop() || '');
    if (base && /\.pdf$/i.test(base)) return base;
    if (base) return base.endsWith('.pdf') ? base : `${base}.pdf`;
  } catch { /* noop */ }
  return 'documento.pdf';
}

// savePdf: callback opcional (buffer, nome) pra persistir o PDF no bucket privado
// do usuário (regra: toda mídia vai pra pasta do dono). Injetado pelo server.

// ── Planilha por link ──
// Planilha nunca chega ao modelo como texto (ver planilha.mjs): o texto da página
// do Google Sheets ou do Tavily traz só um pedaço das células, e o modelo
// respondia "não está na planilha" olhando esse pedaço. Link de Google Sheets
// vira o export .xlsx (todas as abas) e vai pro ambiente de análise; link direto
// pra .xlsx/.csv idem.
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

// Link de Google Sheets → URL do export xlsx. Cobre o link de edição/visualização
// (/spreadsheets/d/<id>/...) e o de "publicar na web" (/spreadsheets/d/e/<id>/...).
export function exportGoogleSheets(raw) {
  let url;
  try { url = new URL(raw); } catch { return null; }
  if (url.hostname !== 'docs.google.com') return null;
  const pub = /^\/spreadsheets\/d\/e\/([\w-]+)/.exec(url.pathname);
  if (pub) return { id: pub[1], publicado: true, url: `https://docs.google.com/spreadsheets/d/e/${pub[1]}/pub?output=xlsx` };
  const ed = /^\/spreadsheets\/d\/([\w-]+)/.exec(url.pathname);
  if (ed) return { id: ed[1], publicado: false, url: `https://docs.google.com/spreadsheets/d/${ed[1]}/export?format=xlsx` };
  return null;
}

function nomeDoDownload(res, fallback) {
  const cd = res.headers.get('content-disposition') || '';
  const star = /filename\*\s*=\s*[^']*''([^;]+)/i.exec(cd);
  if (star) { try { return decodeURIComponent(star[1].trim()); } catch { /* segue */ } }
  const simples = /filename\s*=\s*"?([^";]+)"?/i.exec(cd);
  return simples ? simples[1].trim() : fallback;
}

function nomeDoPath(u) {
  try { return decodeURIComponent(new URL(u).pathname.split('/').filter(Boolean).pop() || ''); } catch { return ''; }
}

const PLANILHA_SEM_ANALISE = 'Este link é uma PLANILHA. Planilha só é lida pelo ambiente de análise, que não está disponível aqui: não descreva, cite nem suponha nada do conteúdo dela. Diga a quem pediu que o link é uma planilha e que ele precisa ser aberto com abrir_link na conversa principal.';

async function abrirPlanilhaGoogle(sheet, onSheetLoad) {
  if (typeof onSheetLoad !== 'function') return PLANILHA_SEM_ANALISE;
  let res;
  try {
    res = await safeFetch(sheet.url, { headers: { 'user-agent': uaBot({ comSite: false }) } });
  } catch (e) {
    console.error('[abrir_link] export do Sheets:', e?.message ?? e);
    return `ERRO: não consegui baixar a planilha do Google Sheets (${e?.message ?? e}). Não li nada dela; diga isso ao usuário e não descreva o conteúdo.`;
  }
  const ct = res.headers.get('content-type') || '';
  // Planilha privada não dá erro: o Google redireciona pra tela de login (HTML).
  if (!res.ok || !/spreadsheetml/i.test(ct)) {
    try { await res.body?.cancel?.(); } catch { /* noop */ }
    console.warn(`[abrir_link] Sheets ${sheet.id} sem acesso público status=${res.status} ct=${ct.slice(0, 60)}`);
    return `Essa planilha do Google Sheets não está aberta ao público (o link pede login), então NÃO li nada dela. Não descreva, cite nem suponha o conteúdo. Se o Google do usuário estiver conectado, abra pelo Google Drive dele (id do arquivo: ${sheet.id}); senão peça pra ele compartilhar como "qualquer pessoa com o link" ou mandar o arquivo aqui.`;
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const nome = nomeDoDownload(res, `planilha-${sheet.id.slice(0, 12)}.xlsx`);
  return analisePlanilhaConector(onSheetLoad, buf, nome, XLSX_MIME);
}
// ── Leitura DIRETA de página (rede de segurança do abrir_link) ──
// Ler link dependia 100% do Tavily: se ele caísse, `abrir_link` devolvia erro e
// pronto. Foi esse o buraco que deixou a leitura de links 17 dias quebrada em
// agosto/2026 sem ninguém ver (o erro voltava como texto pro modelo, nunca ia
// pro log). Aqui a gente baixa a página e arranca o texto por conta própria.
// A extração do Tavily é MELHOR (ele tira menu, rodapé e propaganda), então ele
// segue sendo o caminho principal; isto é plano B. Ler uma página torta é muito
// melhor que não ler nada.
// Só roda no caminho de FALHA, então não custa nada no fluxo normal.
const MAX_HTML_BYTES = 2 * 1024 * 1024; // página maior que isso não vale a pena

// Teto de texto entregue ao modelo quando ele abre uma página. Era 6.000, o que
// cortava página comum no meio (a da Canção Nova, 15k de texto, chegava pela
// metade sem ninguém saber). 20.000 é o mesmo teto que o caminho de PDF já usa.
export const MAX_PAGE_CHARS = 20000;

export function recortarPagina(texto) {
  const t = String(texto ?? '');
  return {
    corpo: t.slice(0, MAX_PAGE_CHARS),
    // Silêncio no corte é o que esconde leitura pela metade: o caminho de PDF já
    // avisa, o de página não avisava.
    corte: t.length > MAX_PAGE_CHARS ? ' (página longa, mostrando o começo)' : '',
  };
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", '#160': ' ' };

function decodeEntidades(s) {
  return s.replace(/&([a-z]+|#\d+);/gi, (m, e) => ENTITIES[e.toLowerCase()] ?? m);
}

function htmlToText(html) {
  const semRuido = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|iframe|template)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');
  const titulo = (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(semRuido)?.[1] || '').trim();
  const corpo = semRuido
    // quebra de bloco vira quebra de linha, senão o texto inteiro vira um parágrafo só
    .replace(/<\/(p|div|section|article|li|tr|h[1-6]|br)\s*>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  const limpo = decodeEntidades(corpo)
    .replace(/[ \t\r\f\v]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { titulo: decodeEntidades(titulo).replace(/\s+/g, ' ').trim(), texto: limpo };
}

async function lerPaginaDireto(url) {
  const res = await safeFetch(url, { headers: { 'user-agent': uaBot({ comSite: false }), accept: 'text/html,*/*' } });
  if (!res.ok) throw new Error(`http ${res.status}`);
  const ct = res.headers.get('content-type') || '';
  if (!/text\/html|text\/plain|application\/xhtml/i.test(ct)) throw new Error(`content-type ${ct || 'desconhecido'}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const html = buf.subarray(0, MAX_HTML_BYTES).toString('utf8');
  const { titulo, texto } = htmlToText(html);
  return { titulo, texto, url: res.url || url };
}

export function openLinkTool({ onUsage, savePdf, onSheetLoad, fontes = null } = {}) {
  // Página lida entra no registro de fontes do turno (citacoes.mjs): o número
  // vai junto do conteúdo pro modelo citar com [n].
  const ref = (url, title) => {
    const n = fontes?.add({ title: title || url, uri: url });
    return n ? ` (cite como [${n}])` : '';
  };
  return {
    name: 'abrir_link',
    description: 'Abre uma URL e lê o conteúdo REAL da página ou documento (título, texto, no caso de produto o nome/preço; e se o link for um PDF, o texto do PDF). Se o link for uma PLANILHA (Google Sheets, .xlsx, .csv), ela é aberta no ambiente de análise e volta só a estrutura (abas, colunas, linhas), nunca as células: para qualquer pergunta sobre os dados use analisar_planilha. Use SEMPRE que o usuário mandar um LINK e você precisar saber o que é aquilo — NUNCA deduza pela conversa anterior nem busque por palavra-chave num link solto (isso confunde e traz o produto/página errado). Depois de abrir e identificar, aí sim use buscar_web se precisar comparar preços em outros sites.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'A URL completa a abrir (ex: o link que o usuário mandou).' },
      },
      required: ['url'],
    },
    run: async ({ url }) => {
      const u = String(url || '').trim();
      if (!/^https?:\/\//i.test(u)) return 'ERRO: url inválida (precisa começar com http:// ou https://).';
      try { await assertPublicUrl(u); } catch (e) { return `ERRO: não posso abrir esse link (${e.message}).`; }
      // 0) Google Sheets: baixa o export xlsx pro ambiente de análise. Nunca cai
      //    no texto da página (Tavily/leitura direta), nem quando o export falha.
      const sheet = exportGoogleSheets(u);
      if (sheet) return abrirPlanilhaGoogle(sheet, onSheetLoad);
      // 1) Tenta detectar PDF: baixa checando o content-type. Se for PDF, extrai o
      //    texto aqui (o Tavily não parseia binário de PDF) e guarda o arquivo no
      //    bucket do usuário. Se NÃO for PDF, cancela o corpo e cai no Tavily (HTML).
      try {
        const res = await safeFetch(u, { headers: { 'user-agent': uaBot({ comSite: false }) } });
        const ct = res.headers.get('content-type') || '';
        const isPdf = /application\/pdf/i.test(ct) || (/\.pdf(\?|#|$)/i.test(u) && !/text\/html/i.test(ct));
        if (isPdf) {
          const buf = Buffer.from(await res.arrayBuffer());
          const name = nameFromUrl(res.url || u);
          if (savePdf) { try { await savePdf(buf, name); } catch (e) { console.error('[pdf-link] persist:', e?.message ?? e); } }
          const { text, pages, truncated } = await extractPdfText(buf, { maxChars: 20000 });
          // Local PDF extraction performs no Tavily call and incurs no search usage.
          if (!text) return `Abri o PDF (${u}) mas ele não tem texto extraível (provavelmente é escaneado, só imagem). Avise o usuário disso.`;
          return `Conteúdo do PDF ${u}${ref(res.url || u, name)}${pages ? ` (${pages} página(s))` : ''}${truncated ? ' — texto longo, mostrando o começo' : ''}:\n\n${text}`;
        }
        // Arquivo de planilha (xlsx, xls, csv, tsv) servido direto: mesma regra,
        // vai pro ambiente de análise e só a estrutura volta.
        const nomeArq = nomeDoDownload(res, nomeDoPath(res.url || u));
        if (!/text\/html|application\/xhtml/i.test(ct) && tipoPlanilha(nomeArq, ct)) {
          if (!res.ok) { try { await res.body?.cancel?.(); } catch { /* noop */ } return `ERRO: não consegui baixar a planilha desse link (HTTP ${res.status}). Não li nada dela; diga isso ao usuário e não descreva o conteúdo.`; }
          if (typeof onSheetLoad !== 'function') { try { await res.body?.cancel?.(); } catch { /* noop */ } return PLANILHA_SEM_ANALISE; }
          const buf = Buffer.from(await res.arrayBuffer());
          return analisePlanilhaConector(onSheetLoad, buf, nomeArq || 'planilha', ct);
        }
        // não é PDF nem planilha: descarta o corpo pra não baixar HTML grande à toa.
        try { await res.body?.cancel?.(); } catch { /* noop */ }
      } catch (e) {
        console.error('[abrir_link] pré-check:', e?.message ?? e);
        // Link que é claramente arquivo de planilha não cai no texto do Tavily.
        if (tipoPlanilha(nomeDoPath(u), '')) return `ERRO: não consegui baixar a planilha desse link (${e?.message ?? e}). Não li nada dela; diga isso ao usuário e não descreva o conteúdo.`;
        // segue pro Tavily como fallback
      }
      // 2) Página HTML normal via Tavily (melhor extração de conteúdo legível),
      //    com leitura direta como rede de segurança em TODA saída ruim: sem
      //    chave, exceção (cota/timeout/5xx) ou extração vazia (site que bloqueia
      //    o Tavily mas responde pra gente).
      const direto = async (motivo) => {
        try {
          const { titulo, texto, url: finalUrl } = await lerPaginaDireto(u);
          if (!texto) return `Não consegui ler o conteúdo dessa página (${finalUrl}). Pode ser que o site bloqueie leitura.`;
          const { corpo, corte } = recortarPagina(texto);
          const partial = !pageContentQuality(texto, finalUrl).sufficient;
          return `Conteúdo de ${finalUrl}${titulo ? ` (título: ${titulo})` : ''}${ref(finalUrl, titulo)}${corte}:\n\n${partial ? PARTIAL_PAGE_MARKER+'\n\n' : ''}${corpo}`;
        } catch (e2) {
          console.error(`[abrir_link] leitura direta falhou (após ${motivo}): ${e2?.message ?? e2}`);
          return `ERRO ao abrir o link: ${e2?.message ?? e2}`;
        }
      };
      if (!tavilyEnabled()) return direto('sem TAVILY_API_KEY');
      try {
        const { text, url: finalUrl, usage } = await tavilyExtract(u);
        if (usage && onUsage) onUsage({ usage, kind: 'search' });
        if (!text) return direto('extração vazia do Tavily');
        const reading = await improvePageReading({text,url:finalUrl}, async () => {
          const direct = await lerPaginaDireto(u);
          return {text:direct.texto,url:direct.url};
        });
        const { corpo, corte } = recortarPagina(reading.text);
        return `Conteúdo de ${reading.url}${ref(reading.url)}${corte}:\n\n${reading.partial ? PARTIAL_PAGE_MARKER+'\n\n' : ''}${corpo}`;
      } catch (e) {
        noteTavilyFailure(e, onUsage, 'leitura direta da página');
        return direto('queda do Tavily');
      }
    },
  };
}

// ── Busca REVERSA por imagem (SerpApi Google Lens) ──
// Dada uma URL PÚBLICA e temporária de uma imagem (gerada via presignGet no
// bucket privado do usuário), acha o MESMO produto / produtos visualmente
// parecidos à venda. Descoberta empírica (14/08): passar hl/country ZERA os
// resultados do google_lens; a chamada crua já traz lojas BR naturalmente.
// Retry porque às vezes volta vazio/503 no 1º tiro.
const _sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BR_RX = /\.com\.br|mercadolivre|mercadolibre|shopee|americanas|magazineluiza|magalu|casasbahia|amazon\.com\.br|elo7|enjoei|dafiti|renner|leroymerlin|madeiramadeira|tokstok|westwing|camicado|\bR\$/i;

export function serpapiEnabled() { return !!process.env.SERPAPI_KEY; }

export async function lensSearchByUrl(imageUrl, { max = 24, tries = 4 } = {}) {
  const key = process.env.SERPAPI_KEY;
  if (!key) { const e = new Error('SERPAPI_KEY ausente'); throw e; }
  const api = 'https://serpapi.com/search.json?engine=google_lens&url='
    + encodeURIComponent(imageUrl) + '&api_key=' + key;
  let lastErr = null;
  for (let i = 0; i < tries; i++) {
    let j = null;
    try {
      const r = await fetch(api, { signal: AbortSignal.timeout(20000) });
      j = await r.json();
    } catch (e) { lastErr = e?.message || String(e); await _sleep(1500); continue; }
    const vm = Array.isArray(j.visual_matches) ? j.visual_matches : [];
    if (vm.length) {
      const norm = vm.map((m) => {
        const p = m.price || null;
        const priceStr = p ? String(p.value || (p.extracted_value != null ? `${p.currency || ''} ${p.extracted_value}` : '')) : '';
        const link = String(m.link || '');
        const loja = String(m.source || '');
        const br = BR_RX.test(`${link} ${loja} ${priceStr}`);
        return { titulo: String(m.title || '').trim(), loja, preco: priceStr.trim(), link, imagem: String(m.thumbnail || ''), br };
      }).filter((x) => x.link);
      norm.sort((a, b) => (b.br === a.br ? 0 : (b.br ? 1 : -1)));
      return norm.slice(0, max);
    }
    lastErr = j.error || 'sem resultados';
    await _sleep(1500);
  }
  const e = new Error(lastErr || 'Google Lens não retornou resultados');
  e.empty = true;
  throw e;
}

// Busca estruturada de produtos via Google Shopping (SerpApi).
// Uma chamada devolve nome/preço/loja/link/imagem JUNTOS, na mesma fonte
// autoritativa, sem o modelo inventar URL de imagem nem o servidor raspar og:image.
export async function shoppingSearch(query, { max = 12, tries = 3 } = {}) {
  const key = process.env.SERPAPI_KEY;
  if (!key) { const e = new Error('SERPAPI_KEY ausente'); throw e; }
  const api = 'https://serpapi.com/search.json?engine=google_shopping'
    + '&hl=pt&gl=br&google_domain=google.com.br&location=Brazil'
    + '&q=' + encodeURIComponent(query) + '&api_key=' + key;
  let lastErr = null;
  for (let i = 0; i < tries; i++) {
    let j = null;
    try {
      const r = await fetch(api, { signal: AbortSignal.timeout(20000) });
      j = await r.json();
    } catch (e) { lastErr = e?.message || String(e); await _sleep(1500); continue; }
    const sr = Array.isArray(j.shopping_results) ? j.shopping_results : [];
    if (sr.length) {
      const norm = sr.map((m) => {
        const preco = String(m.price || (m.extracted_price != null ? `R$ ${m.extracted_price}` : '')).trim();
        const link = String(m.product_link || m.link || '');
        const loja = String(m.source || '').trim();
        const imagem = String(m.thumbnail || '');
        const br = BR_RX.test(`${link} ${loja} ${preco}`);
        return { titulo: String(m.title || '').trim(), loja, preco, link, imagem, br };
      }).filter((x) => x.link && x.imagem);
      norm.sort((a, b) => (b.br === a.br ? 0 : (b.br ? 1 : -1)));
      return norm.slice(0, max);
    }
    lastErr = j.error || 'sem resultados';
    await _sleep(1500);
  }
  const e = new Error(lastErr || 'Google Shopping não retornou resultados');
  e.empty = true;
  throw e;
}
