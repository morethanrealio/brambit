// Offline test of the turn-context fixes (nothing goes out to the network):
//  A) blob pruning only collapses what the model has ALREADY READ (consumedUpTo)
//  B) the anti-loop guard says WHICH call triggered the cut
//  C) the cut by message count of the coding sub-agent preserves the goal
// Run with: node contexto-turno.test.mjs
let ok = 0, fail = 0;
const t = (nome, cond) => { if (cond) { ok++; console.log('  ok  ', nome); } else { fail++; console.log('  FALHA', nome); } };

const { runAgent } = await import('./core-proto/core.mjs');

const BLOB = 'x'.repeat(5000); // > TURN_BLOB_MAX (2000)
const STUB = 'Você já viu esse conteúdo antes neste turno';

// ── A) a round with more large results than the recent window (4) ──
// The 6 results are born at the END of step 0; pruning runs at the TOP of step 1,
// BEFORE complete(). Before the fix, the 2 oldest ones turned into a stub without
// ever having been read — the model received "you've already seen this" about content
// it had never seen.
{
  const registry = { defs: [], run: async () => BLOB };
  const vistos = [];
  let passo = 0;
  await runAgent({
    system: 's', tools: registry, userInput: 'lê tudo',
    provider: {
      name: 'fake',
      complete: async ({ messages }) => {
        vistos.push(messages.filter((m) => m.role === 'tool').map((m) => m.content));
        passo++;
        if (passo === 1) return { stop: 'tool', toolCalls: Array.from({ length: 6 }, (_, i) => ({ id: `a${i}`, name: 'ler', args: { f: i } })) };
        if (passo === 2) return { stop: 'tool', toolCalls: [{ id: 'b0', name: 'ler', args: { f: 9 } }] };
        return { stop: 'end', text: 'pronto' };
      },
    },
  });
  const noPasso2 = vistos[1] || [];
  t('passo 1: modelo vê os 6 resultados da rodada, nenhum stub', noPasso2.length === 6 && !noPasso2.some((c) => c.includes(STUB)));
  const noPasso3 = vistos[2] || [];
  const stubs = noPasso3.filter((c) => c.includes(STUB)).length;
  // Recent window = the last 4 MESSAGES (here 2 old results + the
  // assistant message from the 2nd round + the new result), so 3 whole results.
  t('passo 2: o que já foi lido vira stub (poda continua funcionando)', stubs === 4);
  t('passo 2: a janela recente segue inteira', noPasso3.length - stubs === 3);
  t('passo 2: o resultado ainda não lido está inteiro', noPasso3.at(-1) === BLOB);
}

// ── B) freio anti-loop identifica a chamada culpada ──
{
  const registry = { defs: [], run: async () => 'ok' };
  const eventos = [];
  await runAgent({
    system: 's', tools: registry, userInput: 'trava',
    onEvent: (e) => eventos.push(e),
    provider: {
      name: 'fake',
      complete: async () => ({ stop: 'tool', toolCalls: [{ id: 'z', name: 'buscar', args: { q: 'sempre igual' } }] }),
    },
  });
  const lb = eventos.find((e) => e.type === 'loop_break');
  t('loop_break emitido', !!lb);
  t('loop_break nomeia a tool', lb?.tool === 'buscar');
  t('loop_break carrega os args pra diagnóstico', String(lb?.args || '').includes('sempre igual') && lb?.argsLen > 0);
}

// ── C) coding sub-agent: the cut by message count does not lose the goal ──
{
  process.env.CODING_COMPACT = '0'; // forces the cut path, not the summary path
  const { runCodingSubagent, resetCodingSession } = await import('./web/coding-subagent.mjs');
  const registry = { defs: [], run: async () => 'feito' };
  const provider = {
    name: 'fake',
    complete: async ({ messages }) => {
      const n = messages.filter((m) => m.role === 'assistant').length;
      return n < 40
        ? { stop: 'tool', toolCalls: [{ id: `c${n}`, name: 'rodar', args: { i: n } }] }
        : { stop: 'end', text: 'ok' };
    },
  };
  const key = 'teste:objetivo';
  resetCodingSession(key);
  await runCodingSubagent({
    objetivo: 'MIGRAR O ENDPOINT DE PAGAMENTO PRO NOVO SDK', tools: registry, provider,
    sessionKey: key, maxSteps: 45,
  });
  // 2nd round: the history has already gone past HISTORY_MAX (60) and is cut from the tail.
  let sessionVista = null;
  await runCodingSubagent({
    objetivo: 'continua', tools: registry, sessionKey: key, maxSteps: 2,
    provider: {
      name: 'fake',
      complete: async ({ messages }) => { sessionVista ??= messages; return { stop: 'end', text: 'ok' }; },
    },
  });
  const texto = (sessionVista || []).map((m) => String(m.content || '')).join('\n');
  t('objetivo original sobrevive ao corte por nº de mensagens', texto.includes('MIGRAR O ENDPOINT DE PAGAMENTO PRO NOVO SDK'));
  t('a âncora é marcada como contexto, não como pedido novo', texto.includes('[OBJETIVO ORIGINAL DESTA SESSÃO DE CÓDIGO]'));
}

console.log(`\n${ok} ok, ${fail} falha(s)`);
process.exit(fail ? 1 : 0);
