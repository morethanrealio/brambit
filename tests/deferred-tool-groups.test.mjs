// After compaction the model may call a tool of a deferred group (splitwise_add_expense)
// without abrir_ferramentas in the history. The closed group has to open by itself and
// the call run through its normal path, instead of `ERRO: tool desconhecida`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ToolRegistry } from '../core-proto/core.mjs';
import { openGroupsOnDemand, gruposAbertosNoHistory } from '../web/deferred-tool-groups.mjs';

const tool = (name, run = async () => `ran ${name}`) => ({ name, description: name, parameters: { type: 'object' }, run });

function turno() {
  const registry = new ToolRegistry().add(tool('abrir_ferramentas'));
  const loadedGroups = new Set(), populated = [];
  const deferredGroups = {
    cofre: { populate: () => { populated.push('cofre'); registry.add(tool('splitwise_add_expense')).add(tool('notion_search')); } },
    espacos: { populate: () => { populated.push('espacos'); registry.add(tool('criar_espaco')); } },
  };
  openGroupsOnDemand(registry, deferredGroups, loadedGroups);
  return { registry, loadedGroups, populated };
}

test('a tool of a closed group opens only the group that has it and runs', async () => {
  const { registry, loadedGroups, populated } = turno();
  assert.equal(await registry.run('splitwise_add_expense', {}), 'ran splitwise_add_expense');
  assert.deepEqual(populated, ['cofre']);
  assert.deepEqual([...loadedGroups], ['cofre']);
});

test('the step text check opens the group before run, so the text is kept', () => {
  const { registry } = turno();
  assert.equal(registry.keepsStepText('splitwise_add_expense'), false);
  assert.ok(registry.map.has('splitwise_add_expense'));
});

test('a name no group has keeps the error and does not reopen groups on every call', async () => {
  const { registry, populated } = turno();
  assert.match(await registry.run('nao_existe', {}), /tool desconhecida "nao_existe"/);
  assert.match(await registry.run('nao_existe', {}), /tool desconhecida "nao_existe"/);
  assert.deepEqual(populated, ['cofre', 'espacos']);
});

test('a turn that pruned abrir_ferramentas keeps its groups closed', async () => {
  const { registry, populated } = turno();
  registry.map.delete('abrir_ferramentas');
  assert.match(await registry.run('splitwise_add_expense', {}), /tool desconhecida/);
  assert.deepEqual(populated, []);
});

test('a known tool does not open anything', async () => {
  const { registry, populated } = turno();
  await registry.run('abrir_ferramentas', {});
  assert.deepEqual(populated, []);
});

test('groups opened in previous turns come from the abrir_ferramentas calls', () => {
  const history = [
    { role: 'assistant', toolCalls: [{ name: 'abrir_ferramentas', args: { grupo: ' cofre ' } }, { name: 'splitwise_add_expense', args: {} }] },
    { role: 'tool', content: 'Ferramentas do grupo "espacos" carregadas' },
  ];
  assert.deepEqual([...gruposAbertosNoHistory(history)], ['cofre']);
});
