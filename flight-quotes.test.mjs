import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { marca } from './web/marca.mjs';
import vm from 'node:vm';

const source = readFileSync(new URL('./web/voos.mjs', import.meta.url), 'utf8')
  .replace(/import \{ createHash \} from 'node:crypto';/, '')
  .replace(/import \{[\s\S]*?\} from '\.\/db.mjs';/, '')
  .replace("import { marca } from './marca.mjs';", '').replaceAll('export ', '');
const leg = (from, to, date, hour, price, token, notes = []) => ({ price, departure_token: token,
  flights: [{ departure_airport: { id: from, time: `${date} ${hour}:00` },
    arrival_airport: { id: to, time: `${date} ${String(Number(hour) + 1).padStart(2, '0')}:20` },
    airline: 'Example Air', flight_number: 'EX 42' }], total_duration: 80, layovers: [], extensions: notes });
const query = { origem: 'FLN', destino: 'GRU', data_ida: '2026-10-15', data_volta: '2026-10-19', adultos: 2, malas_despachadas_por_pessoa: 1 };
function setup({ missingToken = false, badReturn = false, monitor = false } = {}) {
  const calls = [], usages = [], cache = new Map(), observed = [];
  const ctx = vm.createContext({ marca, createHash, process: { env: { SERPAPI_KEY: 'fake' } }, URLSearchParams, AbortSignal,
    getFlightCache: async key => cache.has(key) ? { payload: cache.get(key), stale: false, ageMin: 1 } : null,
    putFlightCache: async (key, value) => cache.set(key, value.payload), recordFlightPrice: async () => {},
    flightPriceStats: async () => ({ avg: 1, n: 100, days: 90 }), setTimeout: fn => fn(),
    fetch: async url => {
      const params = new URL(url).searchParams; calls.push(params);
      const token = params.get('departure_token');
      const flights = token ? [leg(badReturn ? 'CGH' : 'GRU', 'FLN', '2026-10-19', token === 'ida-a' ? '18' : '20', token === 'ida-a' ? 2500 : 2700,
        null, token === 'ida-a' ? ['1 checked bag included (23 kg)'] : [])]
        : [leg('FLN', 'GRU', '2026-10-15', '06', 2120, missingToken ? null : 'ida-a', ['Checked baggage for a fee']),
          leg('FLN', 'GRU', '2026-10-15', '11', 2439, missingToken ? null : 'ida-b')];
      return { ok: true, json: async () => ({ best_flights: flights, search_parameters: { currency: 'BRL' },
        search_metadata: { google_flights_url: `https://www.google.com/travel/flights?selection=${token || 'initial'}` } }) };
    },
  });
  vm.runInContext(source + ';globalThis.makeTools=voosTools;', ctx);
  const tool = ctx.makeTools('u', 'a', { onUsage: e => usages.push(e), ...(monitor ? { onObservation: o => observed.push(o) } : {}) })[0];
  return { tool, calls, usages, cache, observed };
}

test('round trip preserves each departure token and selects actual return and combined price', async () => {
  const s = setup(); const answer = await s.tool.run(query);
  assert.equal(s.calls.length, 3); assert.equal(s.usages.length, 3);
  assert.equal(s.calls[1].get('departure_token'), 'ida-a'); assert.equal(s.calls[2].get('departure_token'), 'ida-b');
  for (const params of s.calls) { assert.equal(params.get('adults'), '2'); assert.equal(params.get('return_date'), '2026-10-19'); }
  assert.match(answer, /Volta 2026-10-19:.*GRU→FLN 18:00/);
  assert.match(answer, /combinação: R\$ 2\.500/);
  assert.match(answer, /combinação: R\$ 2\.700/);
  assert.match(answer, /selection=ida-a/); assert.match(answer, /selection=ida-b/);
  assert.doesNotMatch(answer, /R\$ 4\.240|R\$ 5\.000|Preço de ida e volta por pessoa/);
  assert.match(answer, /não multiplique, divida/);
});

test('baggage is attributed per leg and remains unknown when absent, never a generic fee', async () => {
  const s = setup(); const answer = await s.tool.run(query);
  assert.match(answer, /Ida: Bagagem — informação da fonte: Checked baggage for a fee/);
  assert.match(answer, /Volta: Bagagem — informação da fonte: 1 checked bag included \(23 kg\)/);
  assert.match(answer, /Bagagem despachada: franquia e custo não informados/);
  assert.match(answer, /Exigência do pedido: 1 mala/);
  assert.doesNotMatch(answer, /R\$ 130|R\$ 520|econômica sem bagagem/);
  assert.ok(s.calls.every(params => !params.has('bags')));
});

test('cache retains actual returns and does not bill/refetch same quote', async () => {
  const s = setup(); await s.tool.run(query); const answer = await s.tool.run(query);
  assert.equal(s.calls.length, 3); assert.equal(s.usages.length, 3);
  assert.match(answer, /GRU→FLN 18:00/);
});

test('missing reference or wrong-airport return does not fabricate complete itinerary', async () => {
  const missing = setup({ missingToken: true }); const a = await missing.tool.run(query);
  assert.equal(missing.calls.length, 1); assert.match(a, /não forneceu referência/);
  assert.match(a, /sem volta confirmada/); assert.doesNotMatch(a, /Volta 2026-10-19:/);
  const wrong = setup({ badReturn: true }); const b = await wrong.tool.run(query);
  assert.match(b, /Nenhuma volta compatível/); assert.doesNotMatch(b, /Volta 2026-10-19:/);
});

test('monitor retains one search and observed original price; one-way does not seek a return', async () => {
  const s = setup({ monitor: true }); await s.tool.run(query);
  assert.equal(s.calls.length, 1); assert.equal(s.observed[0].price, 2120);
  const one = setup(); const a = await one.tool.run({ ...query, data_volta: undefined, adultos: 1 });
  assert.equal(one.calls.length, 1); assert.match(a, /um passageiro, só ida/);
});
