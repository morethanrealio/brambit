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
