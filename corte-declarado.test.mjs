import test from 'node:test';
import assert from 'node:assert/strict';
import { recortar, comAviso } from './web/recorte.mjs';

test('texto dentro do teto passa inteiro e sem marcador', () => {
  const r = recortar('abc', 10);
  assert.deepEqual(r, { corpo: 'abc', corte: '', truncado: false });
  assert.equal(comAviso('abc', 10), 'abc');
});

test('texto acima do teto é cortado e o corte é declarado com os números', () => {
  const r = recortar('a'.repeat(100), 30, 'saída');
  assert.equal(r.corpo.length, 30);
  assert.equal(r.truncado, true);
  assert.match(r.corte, /truncada/);
  assert.match(r.corte, /30 de 100 caracteres/);
});

test('o rótulo entra no marcador pra dizer O QUE foi cortado', () => {
  assert.match(recortar('x'.repeat(50), 10, 'corpo do e-mail').corte, /corpo do e-mail truncad/);
});

test('vazio, nulo e teto inválido não quebram nem inventam marcador', () => {
  assert.deepEqual(recortar(undefined, 10), { corpo: '', corte: '', truncado: false });
  assert.deepEqual(recortar(null, 10), { corpo: '', corte: '', truncado: false });
  assert.equal(recortar('abc', 0).corpo, 'abc');
  assert.equal(recortar('abc', 0).truncado, false);
});

test('texto exatamente no teto não é marcado como truncado', () => {
  assert.equal(recortar('abcde', 5).truncado, false);
});
