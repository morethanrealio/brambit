import assert from 'node:assert/strict';
import test from 'node:test';
import { routineCutResult } from '../web/routine-delivery.mjs';
import { createRoutineExecutor } from '../web/routine-execution.mjs';

// RSI 2026-10-27: a routine cut by the repetition guard was salvaged, echoed the
// previous week's shopping list and was recorded as complete. A cut run must keep
// the model's text, append an honest note, and be recorded as 'partial'.

test('a clean finish (no termination, or completed) is returned unchanged', () => {
  assert.equal(routineCutResult('A lista está pronta.', null, 'pt-BR'), 'A lista está pronta.');
  assert.equal(routineCutResult('done', undefined, 'en'), 'done');
  // The core reports a clean finish as 'completed'; it is not a cut, and a
  // validated no-news silence ('') must stay silent instead of becoming the note.
  assert.equal(routineCutResult('A lista está pronta.', 'completed', 'pt-BR'), 'A lista está pronta.');
  assert.equal(routineCutResult('', 'completed', 'pt-BR'), '');
});

test('a cut keeps the body and appends the honest note, marked partial', () => {
  const out = routineCutResult('Boa noite! Lista de compras...', 'repeated_calls', 'pt-BR');
  assert.equal(out.contentStatus, 'partial');
  assert.match(out.text, /^Boa noite! Lista de compras\.\.\./);
  assert.match(out.text, /Tive um problema nesta execução\. Se a resposta estiver incompleta/);
});

test('the note is translated by language; pt for pt, en as the default', () => {
  assert.match(routineCutResult('x', 'step_limit', 'pt-BR').text, /Tive um problema nesta execução/);
  assert.match(routineCutResult('x', 'step_limit', 'es').text, /Tuve un problema/);
  // Unknown/absent language follows the product default (en), like routineFinalText.
  assert.match(routineCutResult('x', 'step_limit', 'fr').text, /I had a problem in this run/);
  assert.match(routineCutResult('x', 'step_limit', undefined).text, /I had a problem in this run/);
});

test('an empty body delivers the note alone', () => {
  const out = routineCutResult('', 'empty_end', 'pt-BR');
  assert.equal(out.contentStatus, 'partial');
  assert.match(out.text, /^Tive um problema/);
});

test('the executor records a cut envelope as partial and delivers a string', async () => {
  let finished = null;
  const store = {
    claim: async () => true,
    phase: async () => true,
    finish: async (r, token, status, value) => { finished = { status, value }; return true; },
  };
  const executor = createRoutineExecutor(store, { heartbeatMs: 10_000, log: { error() {} } });
  let delivered = null;
  const res = await executor.execute({ id: 'r1', user_id: 'u1' }, {
    slot: 'manual:test',
    run: async () => routineCutResult('Boa noite! Lista...', 'repeated_calls', 'pt-BR'),
    deliver: async (r, payload) => { delivered = payload; return { status: 'accepted' }; },
  });
  assert.equal(typeof delivered, 'string'); // never "[object Object]"
  assert.match(delivered, /Tive um problema/);
  assert.equal(res.contentStatus, 'partial');
  assert.equal(res.status, 'partial');
  assert.equal(finished.status, 'partial');
  assert.equal(finished.value.content.status, 'partial');
});
