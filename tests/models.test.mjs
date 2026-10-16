// modelos.yaml: what protects production (no file = the usual routing),
// inheritance between functions, and the guard against a key pasted into the file.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { carregarModelos, escolhaDe, lerModelos } from '../core-proto/modelos.mjs';

test('with no modelos.yaml, no function is configured', () => {
  const cfg = carregarModelos({ env: { MODELOS_ARQUIVO: '/nao/existe/modelos.yaml' }, recarregar: true });
  assert.equal(cfg, null);
  assert.equal(escolhaDe('conversa', cfg), null);
});

test('a function with no entry inherits from the parent; the repo example is valid', () => {
  const cfg = lerModelos(readFileSync(new URL('../modelos.example.yaml', import.meta.url), 'utf8'));
  const proprio = lerModelos(`
provedores:
  a: { endereco: https://a/v1 }
  b: { endereco: https://b/v1 }
funcoes:
  padrao: a/m1
  conversa: { modelo: b/m2, reserva: a/m1 }
`);
  assert.equal(escolhaDe('leitura_imagem', proprio).de, 'conversa');
  assert.equal(escolhaDe('leitura_imagem', proprio).reserva.modelo, 'm1');
  assert.equal(escolhaDe('memoria', proprio).de, 'padrao');
  assert.equal(escolhaDe('conversa', cfg).principal.modelo, 'deepseek-ai/DeepSeek-V4.1-Flash');
});

test('a key pasted in place of the variable name is rejected', () => {
  assert.throws(() => lerModelos('provedores:\n  a: { endereco: https://a/v1, chave: sk-123abc }\nfuncoes:\n  padrao: a/m'),
    /NOME da variável/);
});

test('a live edit applies, and a broken edit keeps the last good file', async (t) => {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { startModelsWatch, stopModelsWatch } = await import('../web/modelos-live.mjs');
  const file = join(mkdtempSync(join(tmpdir(), 'brambit-modelos-')), 'modelos.yaml');
  const yaml = (m) => `provedores:\n  a: { endereco: https://a/v1 }\nfuncoes:\n  padrao: a/${m}\n`;
  writeFileSync(file, yaml('m1'));
  const prev = process.env.MODELOS_ARQUIVO;
  process.env.MODELOS_ARQUIVO = file;
  carregarModelos({ recarregar: true });
  t.after(() => { stopModelsWatch(); if (prev === undefined) delete process.env.MODELOS_ARQUIVO; else process.env.MODELOS_ARQUIVO = prev; carregarModelos({ recarregar: true }); });
  startModelsWatch({ intervalMs: 20, log: { log() {}, error() {} } });
  const model = () => escolhaDe('conversa', carregarModelos())?.principal.modelo;
  const until = async (want, rewrite) => {
    for (let i = 0, end = Date.now() + 3000; Date.now() < end; i++, await new Promise((r) => setTimeout(r, 20))) {
      if (model() === want) return;
      // The watcher takes its first look at the file asynchronously: an edit before that look counts as the start.
      if (rewrite && i % 10 === 0) writeFileSync(file, rewrite);
    }
    assert.equal(model(), want);
  };
  await until('m2-longer', yaml('m2-longer'));
  writeFileSync(file, 'funcoes:\n  padrao: nowhere/m3\n');
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(model(), 'm2-longer');
  rmSync(file);
  await until(undefined);
});
