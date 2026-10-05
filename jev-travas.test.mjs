import test from 'node:test';
import assert from 'node:assert/strict';
import { jevEnabled, jevChoice } from './web/jev.mjs';
import { GATED_TOOLS, IRREVERSIBLE_TOOLS, describe, describeDone } from './web/confirm.mjs';
import { PORTAO_TEXTOS, PORTAO_IRREVERSIVEIS } from './web/confirm-textos-portao.mjs';

test('Jev sem chave fica desligado e devolve null (a regra antiga segue valendo)', async () => {
  const key = process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  try {
    assert.equal(jevEnabled(), false);
    assert.equal(await jevChoice({ state: 'x', instructions: 'y', criteria: { a: 'a' } }), null);
  } finally { if (key !== undefined) process.env.TYPESAFE_API_KEY = key; }
});

test('JEV_TRAVAS=0 desliga mesmo com chave', () => {
  const [key, flag] = [process.env.TYPESAFE_API_KEY, process.env.JEV_TRAVAS];
  process.env.TYPESAFE_API_KEY = 'k'; process.env.JEV_TRAVAS = '0';
  try { assert.equal(jevEnabled(), false); }
  finally {
    if (key === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = key;
    if (flag === undefined) delete process.env.JEV_TRAVAS; else process.env.JEV_TRAVAS = flag;
  }
});

test('Jev em erro de rede devolve null, nunca uma escolha inventada', async () => {
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

test('toda tool da auditoria 28/09 está no portão, com frase própria nos 3 idiomas', () => {
  for (const name of Object.keys(PORTAO_TEXTOS)) {
    assert.ok(GATED_TOOLS.has(name), name);
    for (const lang of ['pt-BR', 'en', 'es']) {
      assert.doesNotMatch(describe(name, {}, lang), /executar a ação|run the action|ejecutar la acción/, `${name} ${lang}`);
      assert.doesNotMatch(describeDone(name, {}, lang), /concluída\.$|completed\.$|completada\.$/, `${name} ${lang}`);
    }
  }
  for (const name of PORTAO_IRREVERSIVEIS) assert.ok(IRREVERSIBLE_TOOLS.has(name), name);
});
