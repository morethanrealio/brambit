import test from 'node:test';
import assert from 'node:assert/strict';
import { jevEnabled, jevChoice } from '../web/jev.mjs';
import { GATED_TOOLS, GATE_TOOLS, describe, describeDone } from '../web/confirm.mjs';

test('Jev with no key stays off and returns null (the old rule still applies)', async () => {
  const key = process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  try {
    assert.equal(jevEnabled(), false);
    assert.equal(await jevChoice({ state: 'x', instructions: 'y', criteria: { a: 'a' } }), null);
  } finally { if (key !== undefined) process.env.TYPESAFE_API_KEY = key; }
});

test('JEV_TRAVAS=0 turns it off even with a key', () => {
  const [key, flag] = [process.env.TYPESAFE_API_KEY, process.env.JEV_TRAVAS];
  process.env.TYPESAFE_API_KEY = 'k'; process.env.JEV_TRAVAS = '0';
  try { assert.equal(jevEnabled(), false); }
  finally {
    if (key === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = key;
    if (flag === undefined) delete process.env.JEV_TRAVAS; else process.env.JEV_TRAVAS = flag;
  }
});

test('Jev on a network error returns null, never a made-up choice', async () => {
  const [key, fetch0] = [process.env.TYPESAFE_API_KEY, globalThis.fetch];
  process.env.TYPESAFE_API_KEY = 'k';
  try {
    globalThis.fetch = async () => { throw new Error('rede'); };
    assert.equal(await jevChoice({ state: 'x', instructions: 'y', criteria: { a: 'a' } }), null);
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ answers: { q: { choice: 'fora_da_lista' } } }) });
    assert.equal(await jevChoice({ state: 'x', instructions: 'y', criteria: { a: 'a' } }), null);
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ answers: { q: { choice: 'a' } } }) });
    assert.equal(await jevChoice({ state: 'x', instructions: 'y', criteria: { a: 'a' } }), 'a');
  } finally {
    globalThis.fetch = fetch0;
    if (key === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = key;
  }
});

test('every tool from the 28/09 audit is in the gate, with its own phrase in all 3 languages', () => {
  for (const name of GATE_TOOLS) {
    assert.ok(GATED_TOOLS.has(name), name);
    for (const lang of ['pt-BR', 'en', 'es']) {
      assert.doesNotMatch(describe(name, {}, lang), /executar a ação|run the action|ejecutar la acción/, `${name} ${lang}`);
      assert.doesNotMatch(describeDone(name, {}, lang), /concluída\.$|completed\.$|completada\.$/, `${name} ${lang}`);
    }
  }
});
