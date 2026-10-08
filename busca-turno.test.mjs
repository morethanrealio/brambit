// Tests for the per-turn search guard and the repeated push about stopping due to credit
// (2026-09-28 case). Pure: no network, no database.
// Run: node busca-turno.test.mjs
import { readFileSync } from 'fs';
import { searchKey, createSearchBudget, webSearchTool, SEARCH_LIMIT_MSG, MAX_SEARCHES_PER_TURN } from './web/websearch.mjs';
import { createRepeatPushGuard } from './web/push-repeat-guard.mjs';
import { CREDIT_STOP_REASONS } from './web/execution-credit-errors.mjs';
import { channelReplyParts } from './web/confirmation-target.mjs';
import { CREDIT_REPLY_WINDOW_MS } from './web/push-repeat-guard.mjs';

let ok = 0, fail = 0;
const t = (nome, cond) => { if (cond) { ok++; } else { fail++; console.log(`FALHOU: ${nome}`); } };

// Chave quase igual
t('word order and punctuation do not change the key', searchKey('Bacurau onde assistir streaming') === searchKey('onde assistir Bacurau (streaming)?'));
t('accent and case do not change the key', searchKey('Parasita disponível Netflix') === searchKey('parasita disponivel NETFLIX'));
t('different movies, different keys', searchKey('Bacurau streaming') !== searchKey('Parasita streaming'));
t('date window enters the key', searchKey('noticias', '2026-09-01') !== searchKey('noticias'));
t('default cap is 50', MAX_SEARCHES_PER_TURN === 50);

// Budget: cache + cap
const b = createSearchBudget({ max: 3 });
let reais = 0;
const buscar = (x) => async () => { reais++; return `resultado ${x}`; };
const r1 = await b.run(searchKey('Bacurau streaming'), buscar('a'));
const r2 = await b.run(searchKey('streaming Bacurau'), buscar('b'));
t('repeated query returns from cache without a new search', r2.cached && r2.text === r1.text && reais === 1 && b.used === 1 && b.hits === 1);
await b.run('k2', buscar('c'));
await b.run('k3', buscar('d'));
t('exhausted at the cap', b.exhausted && b.used === 3);
const r5 = await b.run('k4', buscar('e'));
t('above the cap does not search', r5.limited && reais === 3 && r5.text === SEARCH_LIMIT_MSG(3));
t('repeated still works after the cap', (await b.run(searchKey('Bacurau streaming'), buscar('f'))).cached && reais === 3);

// Error doesn't get cached and doesn't block the next attempt
const b2 = createSearchBudget({ max: 5 });
await b2.run('x', async () => 'ERRO ao buscar na web: timeout');
const again = await b2.run('x', async () => 'ok agora');
t('error is not cached', !again.cached && again.text === 'ok agora');

// Concurrency: same key in parallel = a single search
const b3 = createSearchBudget({ max: 5 });
let n3 = 0;
const lenta = async () => { n3++; await new Promise((r) => setTimeout(r, 20)); return 'lento'; };
const [p1, p2] = await Promise.all([b3.run('y', lenta), b3.run('y', lenta)]);
t('parallel deduplicates', n3 === 1 && p1.text === 'lento' && p2.text === 'lento' && p2.cached);

// A tool with exhausted budget never reaches the network
const tool = webSearchTool({ budget: createSearchBudget({ max: 0 }) });
t('blocked tool returns cap warning', (await tool.run({ consulta: 'qualquer coisa' })) === SEARCH_LIMIT_MSG(0));
t('empty query still errors', (await tool.run({ consulta: ' ' })).startsWith('ERRO'));

// Server wiring: budget shared with the research sub-agent
const src = readFileSync(new URL('./web/server.mjs', import.meta.url), 'utf8');
t('main agent uses the turn budget', src.includes('webSearchTool({ onUsage: (e) => mediaUsages.push(e), budget: searchBudget, fontes: fontesDoTurno })'));
t('sub-agent uses the same budget', src.includes('webSearchTool({ onUsage, budget: searchBudget, fontes })') && src.includes('language: userLang, searchBudget, fontes: fontesDoTurno })'));
t('search stops when the turn cap is hit', src.includes('if (searchBudget.exhausted) return SEARCH_LIMIT_MSG(searchBudget.max);'));
t('no separate search cap', !src.includes('MAX_PESQUISAS_POR_TURNO'));
t('repeated balance message in the conversation does not save a reply', src.includes('skipAssistant: creditStopRepetida') && src.includes("creditReplyGuard.allow(thread.id, termination, text)"));
t('repeated balance message comes back suppressed', src.includes("return { text: '', attachments: [], deviceAction, suppressed: true };"));
const dbsrc = readFileSync(new URL('./web/db.mjs', import.meta.url), 'utf8');
t('saveThreadTurn accepts skipAssistant', dbsrc.includes('skipAssistant = false') && (dbsrc.match(/if \(!skipAssistant\) await client\.query/g) || []).length === 2);
const slsrc = readFileSync(new URL('./web/slack.mjs', import.meta.url), 'utf8');
t('slack does not send (no response) when suppressed', (slsrc.match(/if \(res\?\.suppressed\) return;/g) || []).length === 1 && (slsrc.match(/await responder\(/g) || []).length === 2);
t('chat push goes through the credit guard', src.includes('creditPushGuard.allow(userId, termination, text)'));

// Channels: a suppressed response doesn't become a message nor "(no response)"
t('suppressed does not generate a part', channelReplyParts({ text: '', suppressed: true }, '(sem resposta)').length === 0);
t('normal case still works', channelReplyParts({ text: 'oi' })[0].text === 'oi');
t('repeated response window is 2 min', CREDIT_REPLY_WINDOW_MS === 120000);

// Repeated push about stopping due to credit
let agora = 0;
const g = createRepeatPushGuard({ windowMs: 1000, now: () => agora });
const saldo = 'A reserva estimada para esta chamada ultrapassa o saldo livre.';
t('first push goes out', g.allow('u1', 'credit_reservation_unavailable', saldo));
t('second identical one does not go out', !g.allow('u1', 'credit_reservation_unavailable', saldo));
t('different person goes out', g.allow('u2', 'credit_reservation_unavailable', saldo));
t('different reason goes out', g.allow('u1', 'account_credit_exhausted', 'Seus créditos disponíveis acabaram.'));
agora = 1000;
t('after the window it goes out again', g.allow('u1', 'credit_reservation_unavailable', saldo));
t('known credit reasons', CREDIT_STOP_REASONS.has('credit_reservation_unavailable') && !CREDIT_STOP_REASONS.has('completed') && !CREDIT_STOP_REASONS.has('step_limit'));

console.log(`${ok} ok, ${fail} falharam`);
process.exit(fail ? 1 : 0);
