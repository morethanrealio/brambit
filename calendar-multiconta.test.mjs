import test from 'node:test';
import assert from 'node:assert/strict';
const { calendarWritesPorConta } = await import('./web/connectors.mjs');

const fake = (conta) => ['calendar_create', 'calendar_update', 'calendar_delete', 'gmail_send'].map((name) => ({
  name, parameters: { type: 'object', properties: { id: { type: 'string' } } },
  run: async (a) => JSON.stringify({ conta, name, a }),
  ...(name.startsWith('calendar') ? {
    prepareConfirmation: async (a) => ({ descriptor: { account: conta }, run: async () => `${conta}:${a.id}` }),
    restoreConfirmation: async (a, d) => { if (d.account !== conta) throw Error('A conta Google mudou.'); return { run: async () => `${conta}:${a.id}` }; },
  } : {}),
}));

test('with no other account, tools stay the same', () => {
  const tools = fake('a@x');
  assert.equal(calendarWritesPorConta(tools, { contas: ['a@x'], padrao: 'a@x', construir: fake }), tools);
});

test('the chosen account flows to the proposal, the confirmation and the execution', async () => {
  const tools = calendarWritesPorConta(fake('a@x'), { contas: ['a@x', 'b@x'], padrao: 'a@x', construir: fake });
  const upd = tools.find((t) => t.name === 'calendar_update');
  assert.ok(upd.parameters.properties.conta);
  assert.ok(!tools.find((t) => t.name === 'gmail_send').parameters.properties.conta);
  const p = await upd.prepareConfirmation({ id: 'e1', conta: 'B@x' });
  assert.equal(p.descriptor.account, 'b@x');
  assert.equal(await (await upd.restoreConfirmation({ id: 'e1', conta: 'b@x' }, p.descriptor)).run(), 'b@x:e1');
  await assert.rejects(upd.restoreConfirmation({ id: 'e1' }, p.descriptor), /conta Google mudou/);
  assert.equal(JSON.parse(await upd.run({ id: 'e1' })).conta, 'a@x');
  assert.match(JSON.parse(await upd.run({ id: 'e1', conta: 'z@x' })).error, /não está conectada/);
});
