import assert from 'node:assert/strict';
import test from 'node:test';
import { createActionJournal } from '../web/action-evidence.mjs';
import { ToolRegistry } from '../core-proto/core.mjs';

// The registry refuses a call BEFORE running the tool (unknown name, missing
// required parameter). Nothing happened, yet the receipt read it as "unknown":
// the doubt sentence showed next to the retry that worked, and for a connector
// the whole reply became "check the service" about a service never called.
// The refusals below come from the real registry, so a reworded refusal that
// the receipt no longer recognizes fails here.
const unknownPt = 'Não consegui confirmar isso agora', failedPt = 'A ação não foi concluída', checkPt = 'Confira o serviço';
const registry = new ToolRegistry()
  .add({ name:'splitwise_add_expense', parameters:{ type:'object', properties:{}, required:['descricao','cost'] }, run: async () => { throw Error('socket hang up'); } })
  .add({ name:'editar_lista', parameters:{ type:'object', properties:{}, required:['lista','versao'] }, run: async () => '' });
const call = async (j, name, args, out) => j.toolResult({ name, args }, out ?? await registry.run(name, args));
const dinner = { descricao:'Jantar' }, pending = 'AÇÃO PENDENTE DE CONFIRMAÇÃO: despesa Jantar R$ 120,00';

test('a refused call is a certain failure, hidden once the corrected call goes through', async () => {
  // Connector: refused, then the corrected call waits on the confirmation card.
  const j = createActionJournal();
  await call(j, 'splitwise_add_expense', dinner);
  await call(j, 'splitwise_add_expense', { ...dinner, cost:'120.00' }, pending);
  const text = 'Montei a despesa do jantar; é só confirmar no cartão abaixo.';
  assert.equal(j.finish(text, { proposalShown:true }), text);
  assert.deepEqual(j.entries.map(e => e.state), ['failed', 'pending']); // evidence preserved
  // Native tool: refused, then saved.
  const l = createActionJournal();
  await call(l, 'editar_lista', { lista:'Mercado' });
  await call(l, 'editar_lista', { lista:'Mercado', versao:2 }, JSON.stringify({ ok:true, lista:{ id:'l-1', nome:'Mercado', versao:3, itens:[] } }));
  const out = l.finish('Pronto.');
  assert.match(out, /Lista "Mercado" salva/);
  assert.ok(!out.includes(unknownPt) && !out.includes(failedPt), out);
  // A name the registry does not have is the same kind of refusal.
  const u = createActionJournal();
  await call(u, 'splitwise_add_expense', dinner, await registry.run('tool_that_does_not_exist', {}));
  assert.equal(u.entries[0].state, 'failed');
});

test('a refused call that was never corrected does not become success or doubt', async () => {
  const j = createActionJournal();
  await call(j, 'splitwise_add_expense', dinner);
  const out = j.finish('Lancei a despesa do jantar no Splitwise.');
  assert.match(out, new RegExp(failedPt));
  assert.ok(!/Lancei/.test(out) && !out.includes(unknownPt) && !out.includes(checkPt), out);
  // Another tool finishing well does not vouch for it.
  const g = createActionJournal();
  await call(g, 'splitwise_add_expense', dinner);
  await call(g, 'editar_lista', { lista:'Mercado', versao:2 }, JSON.stringify({ ok:true, lista:{ id:'l-1', nome:'Mercado', versao:3, itens:[] } }));
  assert.match(g.finish('Pronto.'), new RegExp(failedPt));
});

test('a tool that threw while running stays uncertain, even next to a later success', async () => {
  const j = createActionJournal();
  await call(j, 'splitwise_add_expense', { ...dinner, cost:'120.00' }); // ran and threw: it may have written
  await call(j, 'splitwise_add_expense', { ...dinner, cost:'120.00' }, pending);
  const out = j.finish('Montei a despesa do jantar.', { proposalShown:true });
  assert.ok(out.includes(unknownPt) && out.includes(checkPt), out);
});
