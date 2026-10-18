// A 'grupo' agent keeps only the tools of its enabled groups. abrir_ferramentas stays
// in its base and opens deferred groups in the middle of the turn, after the pruning,
// so whatever is added later has to go through the same allow-list and host lock.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ToolRegistry } from '../core-proto/core.mjs';
import { podarRegistryGrupo } from '../web/group-agent-tools.mjs';

const tool = (name, run = async () => 'ok') => ({ name, description: name, parameters: { type: 'object' }, run });

test('a tool group opened after the pruning cannot add tools outside the allow-list', async () => {
  const registry = new ToolRegistry();
  for (const name of ['abrir_ferramentas', 'buscar_web', 'notion_search']) registry.add(tool(name));
  podarRegistryGrupo(registry, { groups: ['web'], host: null });
  assert.deepEqual([...registry.map.keys()].sort(), ['abrir_ferramentas', 'buscar_web']);

  // What abrir_ferramentas({grupo:'cofre'}) / ({grupo:'skills'}) does mid-turn.
  registry.add(tool('notion_search')).add(tool('criar_skill')).add(tool('abrir_link'));
  assert.deepEqual([...registry.map.keys()].sort(), ['abrir_ferramentas', 'abrir_link', 'buscar_web']);
  assert.match(await registry.run('notion_search', {}), /tool desconhecida/);
});

test('an SSH tool opened after the pruning runs only on the configured host', async () => {
  const locked = new ToolRegistry();
  podarRegistryGrupo(locked, { groups: ['shell'], host: 'box.example.invalid' });
  locked.add(tool('rodar_comando', async (args) => args.host));
  assert.equal(await locked.run('rodar_comando', { host: 'other.example.invalid' }), 'box.example.invalid');

  const noHost = new ToolRegistry();
  podarRegistryGrupo(noHost, { groups: ['shell'], host: '' });
  noHost.add(tool('rodar_comando')).add(tool('sandbox_shell'));
  assert.deepEqual([...noHost.map.keys()], ['sandbox_shell']);
});
