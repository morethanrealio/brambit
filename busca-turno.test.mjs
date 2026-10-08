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
t('ordem e pontuação não mudam a chave', searchKey('Bacurau onde assistir streaming') === searchKey('onde assistir Bacurau (streaming)?'));
t('acento e caixa não mudam a chave', searchKey('Parasita disponível Netflix') === searchKey('parasita disponivel NETFLIX'));
t('filmes diferentes, chaves diferentes', searchKey('Bacurau streaming') !== searchKey('Parasita streaming'));
t('janela de data entra na chave', searchKey('noticias', '2026-09-01') !== searchKey('noticias'));
t('teto padrão 50', MAX_SEARCHES_PER_TURN === 50);

// Budget: cache + cap
const b = createSearchBudget({ max: 3 });
let reais = 0;
const buscar = (x) => async () => { reais++; return `resultado ${x}`; };
const r1 = await b.run(searchKey('Bacurau streaming'), buscar('a'));
const r2 = await b.run(searchKey('streaming Bacurau'), buscar('b'));
t('repetida volta do cache sem nova busca', r2.cached && r2.text === r1.text && reais === 1 && b.used === 1 && b.hits === 1);
await b.run('k2', buscar('c'));
await b.run('k3', buscar('d'));
t('exausto no teto', b.exhausted && b.used === 3);
const r5 = await b.run('k4', buscar('e'));
t('acima do teto não busca', r5.limited && reais === 3 && r5.text === SEARCH_LIMIT_MSG(3));
t('repetida ainda funciona depois do teto', (await b.run(searchKey('Bacurau streaming'), buscar('f'))).cached && reais === 3);

// Error doesn't get cached and doesn't block the next attempt
const b2 = createSearchBudget({ max: 5 });
await b2.run('x', async () => 'ERRO ao buscar na web: timeout');
const again = await b2.run('x', async () => 'ok agora');
t('erro não é cacheado', !again.cached && again.text === 'ok agora');

// Concurrency: same key in parallel = a single search
const b3 = createSearchBudget({ max: 5 });
let n3 = 0;
const lenta = async () => { n3++; await new Promise((r) => setTimeout(r, 20)); return 'lento'; };
const [p1, p2] = await Promise.all([b3.run('y', lenta), b3.run('y', lenta)]);
t('paralelo deduplica', n3 === 1 && p1.text === 'lento' && p2.text === 'lento' && p2.cached);

// A tool with exhausted budget never reaches the network
const tool = webSearchTool({ budget: createSearchBudget({ max: 0 }) });
t('tool bloqueada devolve aviso de teto', (await tool.run({ consulta: 'qualquer coisa' })) === SEARCH_LIMIT_MSG(0));
t('consulta vazia continua erro', (await tool.run({ consulta: ' ' })).startsWith('ERRO'));

// Server wiring: budget shared with the research sub-agent
const src = readFileSync(new URL('./web/server.mjs', import.meta.url), 'utf8');
t('principal usa o orçamento do turno', src.includes('webSearchTool({ onUsage: (e) => mediaUsages.push(e), budget: searchBudget })'));
t('sub-agente usa o mesmo orçamento', src.includes('webSearchTool({ onUsage, budget: searchBudget })') && src.includes('language: userLang, searchBudget })'));
t('pesquisar para quando o teto do turno bate', src.includes('if (searchBudget.exhausted) return SEARCH_LIMIT_MSG(searchBudget.max);'));
t('sem teto separado de pesquisar', !src.includes('MAX_PESQUISAS_POR_TURNO'));
t('saldo repetido na conversa não grava resposta', src.includes('skipAssistant: creditStopRepetida') && src.includes("creditReplyGuard.allow(thread.id, termination, text)"));
t('saldo repetido volta suprimido', src.includes("return { text: '', attachments: [], deviceAction, suppressed: true };"));
const dbsrc = readFileSync(new URL('./web/db.mjs', import.meta.url), 'utf8');
t('saveThreadTurn aceita skipAssistant', dbsrc.includes('skipAssistant = false') && (dbsrc.match(/if \(!skipAssistant\) await client\.query/g) || []).length === 2);
const slsrc = readFileSync(new URL('./web/slack.mjs', import.meta.url), 'utf8');
t('slack não manda (sem resposta) no suprimido', (slsrc.match(/if \(res\?\.suppressed\) return;/g) || []).length === 2);
t('push de chat passa pelo freio de crédito', src.includes('creditPushGuard.allow(userId, termination, text)'));

// Channels: a suppressed response doesn't become a message nor "(no response)"
t('suprimido não gera parte', channelReplyParts({ text: '', suppressed: true }, '(sem resposta)').length === 0);
t('normal continua', channelReplyParts({ text: 'oi' })[0].text === 'oi');
t('janela da resposta repetida 2 min', CREDIT_REPLY_WINDOW_MS === 120000);

// Repeated push about stopping due to credit
let agora = 0;
const g = createRepeatPushGuard({ windowMs: 1000, now: () => agora });
const saldo = 'A reserva estimada para esta chamada ultrapassa o saldo livre.';
t('primeiro push sai', g.allow('u1', 'credit_reservation_unavailable', saldo));
t('segundo igual não sai', !g.allow('u1', 'credit_reservation_unavailable', saldo));
t('outra pessoa sai', g.allow('u2', 'credit_reservation_unavailable', saldo));
t('outro motivo sai', g.allow('u1', 'account_credit_exhausted', 'Seus créditos disponíveis acabaram.'));
agora = 1000;
t('depois da janela sai de novo', g.allow('u1', 'credit_reservation_unavailable', saldo));
t('motivos de crédito conhecidos', CREDIT_STOP_REASONS.has('credit_reservation_unavailable') && !CREDIT_STOP_REASONS.has('completed') && !CREDIT_STOP_REASONS.has('step_limit'));

console.log(`${ok} ok, ${fail} falharam`);
process.exit(fail ? 1 : 0);
