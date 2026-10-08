import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_PAGE_CHARS, recortarPagina } from './web/websearch.mjs';

// The page-reading cap was 6,000 characters. The São Miguel Lent page
// (from a real routine) has ~15,000: it reached the model cut off in the middle
// of the litany, with no notice at all that it had been cut. The cap is now the
// same as the PDF's (20,000), and the cut, when it happens, is declared.

test('teto de página é o mesmo do PDF', () => {
  assert.equal(MAX_PAGE_CHARS, 20000);
});

test('página comum passa inteira e sem aviso de corte', () => {
  const texto = 'a'.repeat(15000);
  const { corpo, corte } = recortarPagina(texto);
  assert.equal(corpo.length, 15000);
  assert.equal(corte, '');
});

test('página maior que o teto é cortada e o corte é declarado', () => {
  const { corpo, corte } = recortarPagina('b'.repeat(25000));
  assert.equal(corpo.length, MAX_PAGE_CHARS);
  assert.match(corte, /mostrando o começo/);
});

test('entrada vazia ou ausente não quebra', () => {
  assert.deepEqual(recortarPagina(''), { corpo: '', corte: '' });
  assert.deepEqual(recortarPagina(undefined), { corpo: '', corte: '' });
});
