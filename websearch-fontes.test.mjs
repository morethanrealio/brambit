// Offline DRY-RUN: web search (buscar_web) has to return the "Fontes:" block when
// Tavily responds. Regression from the 2026-09-08 to 2026-09-12 bug: renderFontes became only
// RE-EXPORTED from links.mjs (`export { x } from` doesn't create the local name) and every search
// fell into "renderFontes is not defined", with the log blaming Tavily.
import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const forbidden = () => { throw new Error('I/O REAL PROIBIDO NO DRY-RUN'); };
net.Socket.prototype.connect = forbidden; tls.connect = forbidden;
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) childProcess[name] = forbidden;
syncBuiltinESMExports();
process.env.TAVILY_API_KEY = 'MOCK_ONLY';
let fetchMode = 'ok';
const fetchCalls = [];
globalThis.fetch = async (url, opts) => {
  fetchCalls.push(String(url));
  if (!String(url).includes('api.tavily.com/search')) throw new Error(`fetch inesperado: ${url}`);
  if (fetchMode === 'rede') throw new Error('fetch failed: ECONNRESET');
  const body = JSON.parse(opts.body);
  return {
    ok: true, status: 200,
    json: async () => ({
      answer: `resumo mock para "${body.query}"`,
      results: [
        { title: 'Epagri/Ciram', url: 'https://ciram.epagri.sc.gov.br/vento', content: 'rosa dos ventos de Florianópolis' },
        { title: 'INMET', url: 'https://bdmep.inmet.gov.br/', content: 'estação A802' },
      ],
    }),
    text: async () => '',
  };
};
const { webSearchTool } = await import('./web/websearch.mjs');
const { withDeepSeek } = await import('./core-proto/deepseek/scope.mjs');
let checks = 0;
const check = (c, label) => { assert.ok(c, label); checks++; };
const usos = [];
const tool = webSearchTool({ onUsage: (u) => usos.push(u) });

// 1) happy path: Tavily responds → text + numbered Sources, no binding error.
const out = await tool.run({ consulta: 'frequência de chuva com vento oeste em Florianópolis' });
check(typeof out === 'string' && !/renderFontes|not defined|ERRO/.test(out), `output without ReferenceError: ${out.slice(0, 120)}`);
check(out.includes('Fontes:'), 'has the Fontes: block');
check(out.includes('[1] Epagri/Ciram — https://ciram.epagri.sc.gov.br/vento'), 'source 1 numbered with URL');
check(out.includes('[2] INMET — https://bdmep.inmet.gov.br/'), 'source 2 numbered with URL');
check(out.includes('resumo mock'), 'brings the Tavily answer');
check(usos.some(u => u.kind === 'search' && u.usage.model === 'tavily-search'), 'counts the search');
check(!usos.some(u => u.kind === 'search_degraded'), 'does NOT mark degraded search when it succeeded');
check(fetchCalls.length === 1, 'a single call (no relaxing or fallback)');

// 1b) with the turn's registry, the numbering is for the whole turn: the 2nd search
// reuses the number of whoever already appeared (that's the one that goes to the final list).
const { registroDeFontes } = await import('./web/citacoes.mjs');
const reg = registroDeFontes();
reg.add({ title: 'Outra', uri: 'https://outra.example.invalid/' });
const comReg = await webSearchTool({ onUsage: () => {}, fontes: reg }).run({ consulta: 'vento sul em Florianópolis' });
check(comReg.includes('[2] Epagri/Ciram — https://ciram.epagri.sc.gov.br/vento') && comReg.includes('[3] INMET'), 'numbers using the turn registry');
check(reg.size === 3, 'search sources enter the registry');

// 2) REAL network drop in a DeepSeek turn: honest error, labeled as Tavily, no Gemini.
fetchMode = 'rede'; usos.length = 0;
const err = await withDeepSeek(() => ({}), () => tool.run({ consulta: 'x' }));
check(/^ERRO: a busca Tavily falhou/.test(err), `honest error in DeepSeek: ${err.slice(0, 80)}`);
check(/não responda como se tivesse pesquisado/.test(err), 'instructs not to fake a search');
check(usos.some(u => u.kind === 'search_degraded' && u.usage.model === 'tavily-erro'), 'network drop counts as tavily-erro');
check(!usos.some(u => u.usage.model === 'websearch-bug'), 'network drop is NOT labeled as an internal bug');

console.log(`websearch-fontes: ${checks} checagens ok`);
