// Local HTTP doubles only: no provider, credentials or paid search is used.
import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';
import { syncBuiltinESMExports } from 'node:module';

const originalFetch = globalThis.fetch, originalConnect = net.Socket.prototype.connect, originalTls = tls.connect;
const envNames = ['TAVILY_API_KEY', 'TAVILY_URL', 'GEMINI_API_KEY'];
const originalEnv = Object.fromEntries(envNames.map(k => [k, process.env[k]]));
const noNetwork = () => { throw Error('Real network forbidden in web-search-dates'); };
net.Socket.prototype.connect = noNetwork; tls.connect = noNetwork; syncBuiltinESMExports();
process.env.TAVILY_API_KEY = 'MOCK_ONLY';
process.env.TAVILY_URL = 'https://tavily.test/search';
process.env.GEMINI_API_KEY = 'MOCK_ONLY';

const calls = [];
let replies = [];
globalThis.fetch = async (url, init = {}) => {
  const body = JSON.parse(init.body || '{}');
  calls.push({ url: String(url), body });
  if (!replies.length) throw Error('Unexpected fake HTTP call');
  const next = replies.shift();
  if (next instanceof Error) throw next;
  return { ok: (next.status || 200) < 400, status: next.status || 200,
    json: async () => next.json, text: async () => next.text || '' };
};

const { webSearchTool } = await import('../web/websearch.mjs');
const { withDeepSeek } = await import('../core-proto/deepseek/scope.mjs');
const item = { title: 'Artigo observado', url: 'https://publisher.example/article', content: 'Trecho observado da publicação.', published_date: 'Tue, 22 Sep 2026 10:00:00 GMT' };
const result = () => ({ json: { answer: 'Resumo observado.', results: [item] } });
const empty = () => ({ json: { results: [] } });
const dates = { data_inicio: '2026-09-01', data_fim: '2026-09-22' };

beforeEach(() => { calls.length = 0; replies = []; process.env.TAVILY_API_KEY = 'MOCK_ONLY'; });
after(() => {
  globalThis.fetch = originalFetch; net.Socket.prototype.connect = originalConnect; tls.connect = originalTls; syncBuiltinESMExports();
  for (const k of envNames) originalEnv[k] === undefined ? delete process.env[k] : process.env[k] = originalEnv[k];
});

test('date filters are optional schema fields, validated and sent as structured Tavily bounds', async () => {
  replies = [result()];
  const usages = [], tool = webSearchTool({ onUsage: u => usages.push(u) });
  assert.deepEqual(tool.parameters.required, ['consulta']);
  assert.equal(tool.parameters.properties.data_inicio.format, 'date');
  assert.equal(tool.parameters.properties.data_fim.format, 'date');
  const out = await tool.run({ consulta: 'IA aplicada', ...dates });
  assert.deepEqual(calls[0].body, { query: 'IA aplicada', search_depth: 'basic', max_results: 10, include_answer: true,
    start_date: dates.data_inicio, end_date: dates.data_fim, include_published_date: true });
  assert.match(out, /2026-09-01 a 2026-09-22/);
  assert.match(out, /publicação ou atualização; confirme a data original/);
  assert.match(out, /data estimada pelo buscador: Tue, 22 Sep 2026/);
  assert.match(out, /\[1\] Artigo observado — https:\/\/publisher\.example\/article/);
  assert.equal(calls.length, 1); assert.equal(usages.length, 1); assert.equal(usages[0].usage.out, 1);
});

test('search without date filters keeps its original request and response', async () => {
  replies = [result()];
  const out = await webSearchTool().run({ consulta: 'IA aplicada' });
  assert.deepEqual(calls[0].body, { query: 'IA aplicada', search_depth: 'basic', max_results: 10, include_answer: true });
  assert.equal(out, 'Resumo observado.\n• Artigo observado: Trecho observado da publicação.\n\nFontes:\n[1] Artigo observado — https://publisher.example/article');
});

test('relaxed-query refetch retains both native bounds without dropping undated candidates', async () => {
  replies = [empty(), result()];
  const out = await webSearchTool().run({ consulta: 'site:publisher.example "IA aplicada"', ...dates });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].body.query, 'IA aplicada');
  assert.equal(calls[1].body.search_depth, 'advanced');
  for (const { body } of calls) {
    assert.equal(body.start_date, dates.data_inicio); assert.equal(body.end_date, dates.data_fim);
    assert.equal(Object.hasOwn(body, 'filter_by_published_date'), false); assert.equal(body.include_published_date, true);
  }
  assert.match(out, /refiz sem aspas\/operadores/); assert.match(out, /2026-09-01 a 2026-09-22/);
});

test('unknown indexed dates remain candidates and are never presented as verified publication dates', async () => {
  const unknowns = [null, undefined, '', 'not a date'].map((published_date, i) => ({
    title: `Candidato ${i + 1}`, url: `https://publisher.example/candidate-${i + 1}`,
    content: i === 0 ? '' : 'A página precisa ser lida para confirmar a publicação.', published_date,
  }));
  replies = [{ json: { results: [item, ...unknowns] } }];
  const out = await webSearchTool().run({ consulta: 'Mercado de IA', ...dates });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.start_date, dates.data_inicio); assert.equal(calls[0].body.end_date, dates.data_fim);
  assert.equal(Object.hasOwn(calls[0].body, 'filter_by_published_date'), false);
  assert.equal(calls[0].body.include_published_date, true);
  assert.match(out, /data estimada pelo buscador: Tue, 22 Sep 2026/);
  assert.equal(out.match(/data não verificada no índice; confira na página/g)?.length, 4);
  assert.match(out, /nem elegibilidade confirmada/);
  for (const candidate of unknowns) assert.ok(out.includes(candidate.url));
  assert.match(out, /Candidato 1 \[data não verificada no índice; confira na página\]: \(sem trecho; leia a página\)/);
  assert.doesNotMatch(out, /data estimada pelo buscador: (?:null|undefined|not a date)/);
});

test('empty refetch does not expand the requested window or claim absence of publications', async () => {
  replies = [empty(), empty()];
  const out = await webSearchTool().run({ consulta: '"IA aplicada"', ...dates });
  assert.equal(calls.length, 2);
  assert.ok(calls.every(c => c.body.start_date === dates.data_inicio && c.body.end_date === dates.data_fim));
  assert.match(out, /Isso não comprova ausência de publicações/);
  assert.match(out, /não amplie o período/);
});

test('one-sided windows and real leap dates are preserved without inventing another bound', async () => {
  for (const args of [{ data_inicio: '2024-02-29' }, { data_fim: '2026-09-22' }, { data_inicio: '2026-09-22', data_fim: '2026-09-22' }]) {
    replies.push(result());
    await webSearchTool().run({ consulta: 'IA aplicada', ...args });
    const { body } = calls.at(-1);
    assert.equal(body.start_date, args.data_inicio); assert.equal(body.end_date, args.data_fim);
    assert.equal(Object.hasOwn(body, 'start_date'), Object.hasOwn(args, 'data_inicio'));
    assert.equal(Object.hasOwn(body, 'end_date'), Object.hasOwn(args, 'data_fim'));
  }
  assert.equal(calls.length, 3);
});

test('invalid dates and inverted windows cause no HTTP call or usage', async () => {
  const usages = [], tool = webSearchTool({ onUsage: u => usages.push(u) });
  for (const value of [null, '', '2026-02-29', '2026-04-31', '2026-13-01', '2026-09-1', '2026-09-01T00:00:00Z', ' 2026-09-01', 20260901, [], {}]) {
    for (const name of ['data_inicio', 'data_fim']) {
      const out = await tool.run({ consulta: 'IA aplicada', [name]: value });
      assert.match(out, /^ERRO:/); assert.match(out, /Nenhuma busca foi feita/);
    }
  }
  assert.match(await tool.run({ consulta: 'IA aplicada', data_inicio: '2026-09-22', data_fim: '2026-09-01' }), /posterior/);
  assert.equal(calls.length, 0); assert.equal(usages.length, 0);
});

test('a provider without structured-date support is reported without an unfiltered request', async () => {
  delete process.env.TAVILY_API_KEY;
  const tool = webSearchTool();
  const out = await tool.run({ consulta: 'IA aplicada', ...dates });
  assert.match(out, /não suporta os filtros estruturados de data/);
  assert.match(out, /Nenhuma busca foi feita/);
  const deepSeek = await withDeepSeek(() => ({}), () => tool.run({ consulta: 'IA aplicada', ...dates }));
  assert.match(deepSeek, /não suporta os filtros estruturados de data/);
  assert.equal(calls.length, 0);
});

test('failed filtered search does not fall back to unfiltered Gemini or drop dates on retry', async () => {
  for (const failure of [{ status: 422, text: 'date filter unavailable' }, Error('ECONNRESET')]) {
    replies = [failure];
    const before = calls.length, usages = [];
    const out = await webSearchTool({ onUsage: u => usages.push(u) }).run({ consulta: 'IA aplicada', ...dates });
    assert.equal(calls.length, before + 1); assert.equal(calls.at(-1).url, 'https://tavily.test/search');
    assert.equal(calls.at(-1).body.start_date, dates.data_inicio);
    assert.match(out, /não fiz uma busca sem eles/); assert.match(out, /Não consegui verificar a janela/);
    assert.equal(usages.length, 1); assert.equal(usages[0].kind, 'search_degraded');
  }
});

test('ordinary searches still use Gemini without Tavily and on Tavily failure', async () => {
  const gemini = () => ({ json: { candidates: [{ content: { parts: [{ text: 'Resposta do fallback.' }] },
    groundingMetadata: { groundingChunks: [{ web: { title: item.title, uri: item.url } }] } }], usageMetadata: { totalTokenCount: 3 } } });
  delete process.env.TAVILY_API_KEY; replies = [gemini()];
  assert.match(await webSearchTool().run({ consulta: 'IA aplicada' }), /Resposta do fallback/);
  assert.match(calls[0].url, /generativelanguage\.googleapis\.com/);
  process.env.TAVILY_API_KEY = 'MOCK_ONLY'; replies = [{ status: 500, text: 'temporary failure' }, gemini()];
  assert.match(await webSearchTool().run({ consulta: 'IA aplicada' }), /Resposta do fallback/);
  assert.equal(calls.length, 3);
  assert.equal(calls[1].url, 'https://tavily.test/search'); assert.match(calls[2].url, /generativelanguage\.googleapis\.com/);
  for (const call of [calls[0], calls[2]]) assert.equal(call.body.contents[0].parts[0].text, 'IA aplicada');
});
