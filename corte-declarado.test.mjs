import test from 'node:test';
import assert from 'node:assert/strict';
import { recortar, comAviso } from './web/recorte.mjs';

test('text within the cap passes through whole and with no marker', () => {
  const r = recortar('abc', 10);
  assert.deepEqual(r, { corpo: 'abc', corte: '', truncado: false });
  assert.equal(comAviso('abc', 10), 'abc');
});

test('text above the cap is cut and the cut is declared with the numbers', () => {
  const r = recortar('a'.repeat(100), 30, 'saída');
  assert.equal(r.corpo.length, 30);
  assert.equal(r.truncado, true);
  assert.match(r.corte, /truncada/);
  assert.match(r.corte, /30 de 100 caracteres/);
});

test('the label goes into the marker to say WHAT was cut', () => {
  assert.match(recortar('x'.repeat(50), 10, 'corpo do e-mail').corte, /corpo do e-mail truncad/);
});

test('empty, null and an invalid cap do not break or invent a marker', () => {
  assert.deepEqual(recortar(undefined, 10), { corpo: '', corte: '', truncado: false });
  assert.deepEqual(recortar(null, 10), { corpo: '', corte: '', truncado: false });
  assert.equal(recortar('abc', 0).corpo, 'abc');
  assert.equal(recortar('abc', 0).truncado, false);
});

test('text exactly at the cap is not marked as truncated', () => {
  assert.equal(recortar('abcde', 5).truncado, false);
});
