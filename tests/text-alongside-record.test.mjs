// Text the model writes in the same step as a keepsStepText tool (record an offer,
// propose an action for confirmation) must reach the user. Before this, only the
// last step's text was delivered and the answer vanished (routine offer, 03-05/10/2026).
import test from 'node:test';
import assert from 'node:assert/strict';
import { runAgent, ToolRegistry } from '../core-proto/core.mjs';

const registry = new ToolRegistry()
  .add({ name: 'registrar', keepsStepText: true, description: '', parameters: {}, run: async () => 'ok' })
  .add({ name: 'confirmar', confirmationTool: { keepsStepText: true }, description: '', parameters: {}, run: async () => 'ok' })
  .add({ name: 'buscar', description: '', parameters: {}, run: async () => 'ok' });

const turn = async (steps) => {
  let i = 0;
  const r = await runAgent({ system: 's', tools: registry, userInput: 'x', provider: { name: 'fake', complete: async () => steps[i++] } });
  return r.text;
};
const call = (name, text) => ({ stop: 'tool', text, toolCalls: [{ id: name, name, args: {} }] });

test('text written alongside a flagged tool is delivered before the final text', async () => {
  assert.equal(await turn([call('registrar', 'ANSWER'), { stop: 'end', text: 'Invite?' }]), 'ANSWER\n\nInvite?');
});

test('a gated tool inherits the flag from the wrapped tool', async () => {
  assert.equal(await turn([call('confirmar', 'PLAN'), { stop: 'end', text: 'Confirm above.' }]), 'PLAN\n\nConfirm above.');
});

test('text alongside an ordinary tool is still dropped', async () => {
  assert.equal(await turn([call('buscar', 'searching...'), { stop: 'end', text: 'FINAL' }]), 'FINAL');
});

test('a final step that repeats the kept text is not doubled', async () => {
  assert.equal(await turn([call('registrar', 'ANSWER'), { stop: 'end', text: 'ANSWER\n\nInvite?' }]), 'ANSWER\n\nInvite?');
});

test('an empty final step delivers the kept text', async () => {
  assert.equal(await turn([call('registrar', 'ANSWER'), { stop: 'end', text: '' }]), 'ANSWER');
});
