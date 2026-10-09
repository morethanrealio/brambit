// Synthetic/offline. A tool name written as a plain text line (observed 2026-10-09)
// gets one repair, and a raw command line never reaches the user.
import test from 'node:test';
import assert from 'node:assert/strict';
import { toolNameLines, stripToolNameLines } from '../core-proto/providers/ferramenta-em-texto.mjs';
import { runAgent, ToolRegistry } from '../core-proto/core.mjs';

const names = ['send_to_drive', 'read_file'];
const leaked = 'The sheet is updated.\n\nsend_to_drive "Accounts.xlsx"\n\nShall I go on?';

test('only a line that starts with a known tool and an argument counts', () => {
  assert.deepEqual(toolNameLines(leaked, names), ['send_to_drive']);
  assert.deepEqual(toolNameLines('`read_file`({"id":1})', names), ['read_file']);
  for (const prose of ['send_to_drive uploads a copy to Drive.', '- `send_to_drive`: uploads a copy',
    'I can use send_to_drive "x" if you want.', '```\nsend_to_drive("x")\n```', 'other_tool "x"']) {
    assert.deepEqual(toolNameLines(prose, names), [], prose);
  }
  assert.equal(stripToolNameLines(leaked, names), 'The sheet is updated.\n\nShall I go on?');
});

test('the loop asks for the real call once, then drops the line', async () => {
  let runs = 0, calls = 0;
  const tools = () => new ToolRegistry().add({ name: 'send_to_drive', parameters: {}, run: async () => { runs++; return 'ok'; } });
  const r = await runAgent({ tools: tools(), userInput: 'update it', provider: { name: 'offline', complete: async ({ system }) => {
    calls++;
    if (calls === 1) return { stop: 'end', text: leaked };
    if (calls === 2) { assert.ok(system.includes('send_to_drive written as text')); return { stop: 'tool', toolCalls: [{ id: 'a', name: 'send_to_drive', args: {} }] }; }
    return { stop: 'end', text: 'Sent to Drive.' };
  } } });
  assert.equal(runs, 1);
  assert.equal(r.text, 'Sent to Drive.');

  calls = 0;
  const again = await runAgent({ tools: tools(), userInput: 'update it', provider: { name: 'offline', complete: async () => { calls++; return { stop: 'end', text: leaked }; } } });
  assert.equal(calls, 2);
  assert.equal(again.text, 'The sheet is updated.\n\nShall I go on?');
});
