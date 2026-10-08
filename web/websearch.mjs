// ── Web search tool for models WITHOUT built-in grounding ──
// Gemini has native search (google_search); OpenAI/GLM don't. To give grounding to
// those models in our tool-loop, we expose the `buscar_web` tool.
//
// Two possible backends:
//  1. TAVILY (preferred when TAVILY_API_KEY exists): a search API built for LLMs,
//     ~1-2s per query, returns snippets + a short "answer". Does NOT generate text,
//     so it is MUCH faster than Gemini (which does a whole generation per
//     search, ~10-20s). Cost ~$0.008/search (basic), free tier 1000/month.
//  2. GEMINI groundedSearch (fallback): does a grounded search + synthesis in
//     Gemini. Slower, but reuses the free search quota (5k/month).
//
// The cost of each search is reported via onUsage (kind='search') to fall into the same
// credit pipeline as the other calls.
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

// ── Anti-SSRF protection for abrir_link ──
// abrir_link fetches a URL controlled by the model/user FROM INSIDE the VPC. Without a
// filter, it's possible to reach the cloud metadata endpoint (169.254.169.254) or
// internal services (172.31.x.x, localhost). Here we: (1) only accept http/https
// on ports 80/443, (2) resolve the host and refuse if ANY IP falls in a
// private/loopback/link-local range, and (3) follow redirects manually, revalidating each
// hop (a public destination that redirects to an internal one doesn't pass), and (4) the connection
// goes out through fetchFixado, which resolves the host ONCE and ties the socket to the already
// validated IPs. (4) closes off DNS rebinding: before, the native fetch would redo the
// resolution on its own after the check, and a domain with a short TTL could
// return a public IP at validation time and an internal IP at connection time.
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

// Extracts the REAL content of a URL (title + readable page text). It's the right
// way to find out what a link the user sent is — MUCH more reliable
// than searching by keyword for a bare link (the search "anchors" on the conversation
// context and can return the wrong product; bug reported by a user on 2026-07-01, where
// a link to dishes was confused with a product from an earlier conversation).
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
  // Cost modeled as 1 search (same pricing line).
  const usage = { model: 'tavily-search', in: 0, cached: 0, out: 1, think: 0, total: 1 };
  console.log(`[tavily extract] url="${String(url).slice(0, 80)}" ok=${!!raw} len=${raw.length}`);
  return { text: raw, url: r?.url || url, usage };
}

// "Relaxes" a query that probably sabotaged itself: removes the site:
// operator (with a guessed domain it zeroes everything out) and exact-phrase quotes (which kill recall).
// Only used to REDO the search when the original one comes back empty.
function relaxQuery(q) {
  return String(q || '')
    .replace(/-?site:\S+/gi, ' ')          // operador site:dominio
    .replace(/["""'']/g, ' ')              // straight and typographic quotes
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

// A raw call to Tavily. depth 'basic' (fast) or 'advanced' (more recall).
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

// "Raw" Tavily search: returns { text, sources, usage } in the SAME shape as
// groundedSearch, so the run() below treats both the same. If the search comes back
// EMPTY, redoes it ONCE with the relaxed query (no quotes/site:) and depth advanced,
// so it doesn't return a raw "0 results" — that's how the AI said a site "doesn't exist" for
// a site that did exist (TAB case, Flávio 2026-08-03). The determinism here prevents the
// model from interpreting a failed search as "doesn't exist".
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
  // Text = Tavily's "answer" (if it came back) + the snippets of the results, to give
  // the model concrete content to synthesize (Tavily doesn't write a long reply).
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
  // Cost per CALL (not per token): we model each Tavily call as 1 output
  // token on the 'tavily-search' pricing line → costOf ≈ $0.008/search.
  const usage = { model: 'tavily-search', in: 0, cached: 0, out: calls, think: 0, total: calls };
  return { text, sources, usage, empty: !results.length, relaxedNote };
}

// `resolveGroundingUri` and `renderFontes` lived here until 2026-09-08. They moved to
// `links.mjs` together with link checking (it's all the same thing: a URL that goes out
// to the user), and because the turn code path needs them without dragging this whole
// module along. They remain re-exported from here so as not to break whoever already imported them.
// ATTENTION: `export { x } from` does NOT create the name inside this module; the
// explicit import above is what lets the run() below call renderFontes. Without it, every
// search fell into "renderFontes is not defined" from 2026-09-08 to 2026-09-12 and the log
// blamed Tavily ("TAVILY CAIU") for a bug of ours.
export { resolveGroundingUri, renderFontes } from './links.mjs';

// The fast path (Tavily) going down can't be SILENT. Before, the catch below
// would fall back to Gemini without leaving a trace: Tavily blew its quota on 2026-08-13 (HTTP
// 432) and the entire platform ran for 17 days on the slow path (~15s per search instead
// of ~2s) without anyone noticing. Now every drop shouts on two fronts:
// in the log (fixed tag, greppable in journalctl) and in usage_events with
// kind='search_degraded', which can be counted in SQL with no new schema.
// A blown quota is permanent until someone changes the plan, so it's marked
// separately from a transient failure (timeout, 5xx).
let _tavilyFails = 0;
// A PROGRAMMING error (ReferenceError/TypeError/SyntaxError) is not Tavily going down:
// its response already arrived and we broke afterward. Gets its own tag so nobody
// spends days looking at the wrong provider (that's what happened 2026-09-09 to 2026-09-12).
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
  } catch { /* never let the metric bring the search down */ }
}

// Search FALLBACK model (for when Tavily goes down/blows its quota). Used to be
// gemini-3.5-flash, which is the most EXPENSIVE model we have (1.50 in / 9.00 out
// versus 0.75 / 3.75 for the primary): during Tavily's outage from 2026-08-22 to 2026-08-30, search
// ended up 2x more expensive instead of degrading cheaply. 3.7 responds to grounding with the
// same number of sources (tested 2026-09-02), so the fallback becomes it.
// Swappable via env for rollback with no deploy.
const SEARCH_FALLBACK_MODEL = process.env.SEARCH_FALLBACK_MODEL || 'gemini-3.7-flash';

// ── Search budget PER TURN (case of 28/09/2026) ──
// In a single turn asking "where to watch" for a list of films, the model
// called `pesquisar` 6 times in a row and each sub-agent redid the same
// searches film by film: 139 searches, Bacurau and Parasite searched 3 to 4
// times, ~1,100 credits in one turn, until the balance ran out. The prompt
// instruction ("1 to 3 broad searches") didn't hold, so the brake is now in
// code: one object per turn, shared by the main agent and research sub-agents,
// which (1) returns a repeated or near-identical search from cache without
// another call, and (2) cuts off once the turn cap is hit, telling the model to
// answer with what it has. Cap at 50 (28/09): in the previous 10 days only 13
// of 127 requests with search went past 20, so 50 only catches the outlier
// without cutting a large legitimate request.
export const MAX_SEARCHES_PER_TURN = Number(process.env.MAX_SEARCHES_PER_TURN) || 50;

// "Near-equal" key: no accents, no punctuation, no short words, and with the
// words in alphabetical order, so that "Bacurau onde assistir streaming" and
// "onde assistir Bacurau (streaming)" fall into the same search.
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
    // Wraps ONE real search. Same key: returns the result already obtained
    // (including if the first one is still in progress). Ceiling: doesn't search.
    async run(key, doSearch) {
      if (cache.has(key)) { hits += 1; return { text: await cache.get(key), cached: true }; }
      if (used >= max) { blocked += 1; return { text: SEARCH_LIMIT_MSG(max), limited: true }; }
      used += 1;
      const p = Promise.resolve().then(doSearch);
      cache.set(key, p);
      try {
        const text = await p;
        // Error doesn't stay in the cache: the next attempt might succeed.
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
    description: 'Searches for CURRENT information on the web (price, opening hours, news, availability, address, event, places, products, any real-time data or anything you are not sure about). A single search already returns SEVERAL concrete results (names, addresses, sources). Use ALWAYS when you need a factual/current fact instead of answering from memory. EFFICIENCY MATTERS: search BROADLY, by category/region (e.g.: "melhores casas de jazz em São Paulo endereço programação"), NEVER a separate search for each item/place/product (that makes the response far too slow). For an itinerary/list, 1 to 3 broad searches are enough; only search again if a specific piece of data is missing. Do not answer generically if you have not searched enough yet, but also do not keep searching item by item. Build a SIMPLE query, a few words in pt-BR: do NOT use exact-phrase quotes or the site: operator with a guessed domain (they zero out the results). If the user says "vá no site de X", find the official site and OPEN it with abrir_link instead of hunting for the fact by keyword. NEVER conclude that something "não existe" just because a search came back empty.',
    parameters: {
      type: 'object',
      properties: {
        consulta: { type: 'string', description: 'What to search for, in natural language (pt-BR). E.g.: "preço passagem São Paulo Paraty ônibus hoje".' },
        data_inicio: { type: 'string', format: 'date', description: 'Optional: start bound YYYY-MM-DD of the requested window. Use with data_fim in news/curation searches with a defined period. The search engine filters by the estimated publication or update date and may return candidates with no date in the index; check the original date on the page.' },
        data_fim: { type: 'string', format: 'date', description: 'Optional: end bound YYYY-MM-DD of the requested window. Do not widen the window to fill in results. Without a provider that supports it, the tool reports that it could not apply the filter.' },
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
          // Doesn't return a bare "0 results": instructs the AI to NOT assert absence
          // and to try the right path (simple search / open the official site).
          return 'Não achei resultados, mesmo depois de ampliar a busca (tirei aspas e operadores). NÃO conclua que a informação não existe a partir disso. Refaça com uma busca mais SIMPLES (poucas palavras em pt-BR); se o usuário citou um site ou empresa, procure o site oficial e use abrir_link pra ler a página direto.';
        }
        const lista = await renderFontes(sources, fontes);
        const prefix = dateNote + (relaxedNote ? `${relaxedNote}\n` : '');
        return `${prefix}${text || '(sem resumo)'}\n\nFontes:\n${lista || '(sem fontes)'}`;
      } catch (e) {
        // If Tavily fails, falls back to Gemini as a safety net.
        // Dates are a constraint: don't spend a second search with no support
        // that silently returns news outside the requested window.
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

// Tool to OPEN a specific link and read the page's real content. ALWAYS use it
// when the user sends a URL (product, article, etc.) and you need to know what it
// is — instead of guessing from the conversation or searching by keyword for a bare link.
// Only makes sense with Tavily (extract); without it, the agent falls back to sandbox/curl.
// Derives a file name from the URL (for the caption in the bucket).
function nameFromUrl(u) {
  try {
    const p = new URL(u).pathname;
    const base = decodeURIComponent(p.split('/').filter(Boolean).pop() || '');
    if (base && /\.pdf$/i.test(base)) return base;
    if (base) return base.endsWith('.pdf') ? base : `${base}.pdf`;
  } catch { /* noop */ }
  return 'documento.pdf';
}

// savePdf: optional callback (buffer, name) to persist the PDF in the user's
// private bucket (rule: all media goes into the owner's folder). Injected by the server.

// ── Spreadsheet by link ──
// A spreadsheet never reaches the model as text (see planilha.mjs): the page text
// from Google Sheets or Tavily only brings a piece of the cells, and the model
// used to answer "it's not in the spreadsheet" looking at that piece. A Google Sheets link
// becomes the .xlsx export (all tabs) and goes to the analysis environment; a direct link
// to .xlsx/.csv likewise.
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

// Google Sheets link → xlsx export URL. Covers the edit/view link
// (/spreadsheets/d/<id>/...) and the "publish to web" one (/spreadsheets/d/e/<id>/...).
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
  // A private spreadsheet doesn't error out: Google redirects to the login screen (HTML).
  if (!res.ok || !/spreadsheetml/i.test(ct)) {
    try { await res.body?.cancel?.(); } catch { /* noop */ }
    console.warn(`[abrir_link] Sheets ${sheet.id} sem acesso público status=${res.status} ct=${ct.slice(0, 60)}`);
    return `Essa planilha do Google Sheets não está aberta ao público (o link pede login), então NÃO li nada dela. Não descreva, cite nem suponha o conteúdo. Se o Google do usuário estiver conectado, abra pelo Google Drive dele (id do arquivo: ${sheet.id}); senão peça pra ele compartilhar como "qualquer pessoa com o link" ou mandar o arquivo aqui.`;
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const nome = nomeDoDownload(res, `planilha-${sheet.id.slice(0, 12)}.xlsx`);
  return analisePlanilhaConector(onSheetLoad, buf, nome, XLSX_MIME);
}
// ── DIRECT page reading (abrir_link safety net) ──
// Reading a link depended 100% on Tavily: if it went down, `abrir_link` returned an error
// and that was it. That was the hole that left link reading broken for 17 days in
// August 2026 with nobody seeing it (the error came back as text to the model, never went
// to the log). Here we download the page and extract the text ourselves.
// Tavily's extraction is BETTER (it strips menu, footer and ads), so it
// remains the main path; this is plan B. Reading a messy page is much
// better than reading nothing at all.
// Only runs on the FAILURE path, so it costs nothing in the normal flow.
const MAX_HTML_BYTES = 2 * 1024 * 1024; // a page bigger than this isn't worth it

// Ceiling for text delivered to the model when it opens a page. It used to be 6,000, which
// cut a common page in half (Canção Nova's, with 15k of text, arrived
// half-way with nobody knowing). 20,000 is the same ceiling the PDF path already uses.
export const MAX_PAGE_CHARS = 20000;

export function recortarPagina(texto) {
  const t = String(texto ?? '');
  return {
    corpo: t.slice(0, MAX_PAGE_CHARS),
    // Silence on truncation is what hides a half-read page: the PDF path already
    // warns, the page path didn't.
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
    // block break becomes a line break, otherwise the whole text becomes a single paragraph
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
  // A page that was read enters the turn's source registry (citacoes.mjs): the number
  // goes along with the content for the model to cite with [n].
  const ref = (url, title) => {
    const n = fontes?.add({ title: title || url, uri: url });
    return n ? ` (cite como [${n}])` : '';
  };
  return {
    name: 'abrir_link',
    description: 'Opens a URL and reads the REAL content of the page or document (title, text, for a product the name/price; and if the link is a PDF, the PDF text). If the link is a SPREADSHEET (Google Sheets, .xlsx, .csv), it is opened in the analysis environment and only the structure comes back (sheets, columns, rows), never the cells: for any question about the data use analisar_planilha. Use ALWAYS when the user sends a LINK and you need to know what it is — NEVER deduce it from the earlier conversation nor search by keyword for a loose link (that confuses things and brings up the wrong product/page). After opening and identifying it, then use buscar_web if you need to compare prices on other sites.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The full URL to open (e.g.: the link the user sent).' },
      },
      required: ['url'],
    },
    run: async ({ url }) => {
      const u = String(url || '').trim();
      if (!/^https?:\/\//i.test(u)) return 'ERRO: url inválida (precisa começar com http:// ou https://).';
      try { await assertPublicUrl(u); } catch (e) { return `ERRO: não posso abrir esse link (${e.message}).`; }
      // 0) Google Sheets: downloads the xlsx export to the analysis environment. Never falls
      //    back to the page text (Tavily/direct read), even when the export fails.
      const sheet = exportGoogleSheets(u);
      if (sheet) return abrirPlanilhaGoogle(sheet, onSheetLoad);
      // 1) Tries to detect a PDF: downloads while checking the content-type. If it's a PDF, extracts the
      //    text here (Tavily doesn't parse PDF binary) and stores the file in the
      //    user's bucket. If it's NOT a PDF, cancels the body and falls back to Tavily (HTML).
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
        // Spreadsheet file (xlsx, xls, csv, tsv) served directly: same rule,
        // goes to the analysis environment and only the structure comes back.
        const nomeArq = nomeDoDownload(res, nomeDoPath(res.url || u));
        if (!/text\/html|application\/xhtml/i.test(ct) && tipoPlanilha(nomeArq, ct)) {
          if (!res.ok) { try { await res.body?.cancel?.(); } catch { /* noop */ } return `ERRO: não consegui baixar a planilha desse link (HTTP ${res.status}). Não li nada dela; diga isso ao usuário e não descreva o conteúdo.`; }
          if (typeof onSheetLoad !== 'function') { try { await res.body?.cancel?.(); } catch { /* noop */ } return PLANILHA_SEM_ANALISE; }
          const buf = Buffer.from(await res.arrayBuffer());
          return analisePlanilhaConector(onSheetLoad, buf, nomeArq || 'planilha', ct);
        }
        // not a PDF nor a spreadsheet: discards the body so as not to download a big HTML for nothing.
        try { await res.body?.cancel?.(); } catch { /* noop */ }
      } catch (e) {
        console.error('[abrir_link] pré-check:', e?.message ?? e);
        // A link that is clearly a spreadsheet file doesn't fall back to Tavily's text.
        if (tipoPlanilha(nomeDoPath(u), '')) return `ERRO: não consegui baixar a planilha desse link (${e?.message ?? e}). Não li nada dela; diga isso ao usuário e não descreva o conteúdo.`;
        // falls through to Tavily as a fallback
      }
      // 2) Normal HTML page via Tavily (better readable-content extraction),
      //    with direct reading as a safety net for EVERY bad outcome: no
      //    key, exception (quota/timeout/5xx), or empty extraction (a site that blocks
      //    Tavily but responds to us).
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

// ── REVERSE image search (SerpApi Google Lens) ──
// Given a PUBLIC, temporary URL of an image (generated via presignGet in the
// user's private bucket), finds the SAME product / visually similar products
// for sale. Empirical finding (2026-08-14): passing hl/country ZEROES OUT the
// google_lens results; the raw call already brings BR stores naturally.
// Retry because it sometimes comes back empty/503 on the 1st try.
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

// Structured product search via Google Shopping (SerpApi).
// One call returns name/price/store/link/image TOGETHER, from the same authoritative
// source, with no model making up an image URL nor the server scraping og:image.
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
