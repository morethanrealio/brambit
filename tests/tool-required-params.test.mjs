import assert from 'node:assert/strict';
import test from 'node:test';
import { ToolRegistry } from '../core-proto/core.mjs';

// RSI 2026-10-27: a routine called a real tool (ler_espaco) with no `espaco`.
// The tool ran degraded ("Space not found"), the model repeated the empty call
// and the turn was cut by the repetition guard. ToolRegistry.run must refuse a
// call missing a required schema parameter BEFORE running the tool, with an
// error that names the missing field so the model corrects instead of repeating.
const makeTool = (required, onRun) => ({
  name: 'ler_espaco',
  parameters: { type: 'object', properties: {}, required },
  run: async (args) => { onRun?.(args); return { ok: true, args }; },
});

test('a missing required parameter is refused and the tool does not run', async () => {
  let ran = false;
  const reg = new ToolRegistry().add(makeTool(['espaco'], () => { ran = true; }));
  const out = await reg.run('ler_espaco', {});
  assert.equal(ran, false);
  assert.match(out, /^ERRO:/);
  assert.match(out, /"espaco"/);
});

test('a blank string counts as missing; false and 0 do not', async () => {
  const reg = new ToolRegistry().add(makeTool(['espaco'], () => {}));
  assert.match(await reg.run('ler_espaco', { espaco: '   ' }), /^ERRO:/);
  assert.match(await reg.run('ler_espaco', { espaco: null }), /^ERRO:/);
  // Valid falsy values must pass through.
  const falsyReg = new ToolRegistry().add(makeTool(['ativo'], () => {}));
  assert.deepEqual((await falsyReg.run('ler_espaco', { ativo: false })).ok, true);
  assert.deepEqual((await falsyReg.run('ler_espaco', { ativo: 0 })).ok, true);
});

test('a complete call runs normally', async () => {
  let seen = null;
  const reg = new ToolRegistry().add(makeTool(['espaco'], (a) => { seen = a; }));
  const out = await reg.run('ler_espaco', { espaco: 'Casa & Rotina' });
  assert.equal(out.ok, true);
  assert.deepEqual(seen, { espaco: 'Casa & Rotina' });
});

test('every missing parameter is named when several are required', async () => {
  const reg = new ToolRegistry().add(makeTool(['owner', 'repo', 'number'], () => {}));
  const out = await reg.run('ler_espaco', { owner: 'acme' });
  assert.match(out, /"repo"/);
  assert.match(out, /"number"/);
  assert.doesNotMatch(out, /"owner"/);
});

test('a tool with no required array is unaffected', async () => {
  let ran = false;
  const reg = new ToolRegistry().add({
    name: 'provar_app',
    parameters: { type: 'object', properties: {} },
    run: async () => { ran = true; return { ok: true }; },
  });
  const out = await reg.run('provar_app', {});
  assert.equal(ran, true);
  assert.equal(out.ok, true);
});
