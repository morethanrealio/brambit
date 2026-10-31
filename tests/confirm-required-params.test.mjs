// A gated call missing a required schema parameter must be refused before any
// pending action is created, so the model fixes it in the same turn instead of
// the missing field only being caught after the user confirms a hollow card
// (e.g. falar_com_agente with no objetivo). Offline: only the real gate.
process.env.BRAMBIT_DEFAULT_LANGUAGE = 'pt-BR';
import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === './shopping.mjs' && context.parentURL?.endsWith('/web/confirm.mjs')) {
      return {
        url: 'data:text/javascript,export function descreverCarrinho(){throw Error("unused offline")};export function plataformaDoCarrinho(){throw Error("unused offline")}',
        shortCircuit: true,
      };
    }
    return nextResolve(specifier, context);
  },
});

const { gateTool, hasPending, peekPending, takePending } = await import('../web/confirm.mjs');

const gated = (threadId, executions) => gateTool({
  name: 'falar_com_agente',
  parameters: { type: 'object', properties: {
    contato: { type: 'string' }, objetivo: { type: 'string' },
  }, required: ['contato', 'objetivo'] },
  run: async (args) => { executions.push(args); return 'ran'; },
}, threadId);

test('a missing required parameter is refused and registers nothing', async (t) => {
  const threadId = 'req-missing';
  t.after(() => takePending(threadId));
  const executions = [];
  const out = await gated(threadId, executions).run({ contato: 'Ana' });
  assert.match(out, /NÃO registrei o pedido/);
  assert.match(out, /objetivo/);
  assert.equal(hasPending(threadId), false);
  assert.equal(executions.length, 0);
});

test('an empty-string required parameter counts as missing', async (t) => {
  const threadId = 'req-blank';
  t.after(() => takePending(threadId));
  const executions = [];
  const out = await gated(threadId, executions).run({ contato: 'Ana', objetivo: '   ' });
  assert.match(out, /NÃO registrei o pedido/);
  assert.equal(hasPending(threadId), false);
  assert.equal(executions.length, 0);
});

test('with every required parameter the request becomes a pending card, not an execution', async (t) => {
  const threadId = 'req-ok';
  t.after(() => takePending(threadId));
  const executions = [];
  const out = await gated(threadId, executions).run({ contato: 'Ana', objetivo: 'ver 3 horários livres' });
  assert.match(out, /AÇÃO PENDENTE DE CONFIRMAÇÃO/);
  assert.equal(hasPending(threadId), true);
  assert.equal(executions.length, 0);
  assert.ok(peekPending(threadId));
});
