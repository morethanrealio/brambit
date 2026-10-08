import test from 'node:test';
import assert from 'node:assert/strict';
import { prepararTextoWa } from './web/whatsapp.mjs';

// Until 2026-09-29, WhatsApp had a cap of 8 bubbles: the excess disappeared and the last
// bubble carried "[…resposta muito longa, cortei o resto]". Now the long reply
// goes out in full, in as many bubbles as needed, in order. These tests guard against this.

const BALAO = 1024;

test('short reply goes in a single bubble, no notice', () => {
  const partes = prepararTextoWa('oi, tudo certo por aqui');
  assert.deepEqual(partes, ['oi, tudo certo por aqui']);
});

test('empty text becomes the placeholder, never silence', () => {
  assert.deepEqual(prepararTextoWa('   '), ['(sem resposta)']);
  assert.deepEqual(prepararTextoWa(undefined), ['(sem resposta)']);
});

test('huge reply goes out in full, no cut-off notice', () => {
  const texto = 'palavra '.repeat(20000).trim();
  const partes = prepararTextoWa(texto);
  assert.ok(partes.length > 8, `generated only ${partes.length} bubbles`);
  for (const p of partes) assert.ok(p.length <= BALAO, `bubble of ${p.length}`);
  assert.ok(!partes.join('').includes('cortei o resto'));
  assert.equal(partes.join(' '), texto, 'no word disappeared or changed order');
});

test('emoji at the cut boundary does not become a broken character', () => {
  const partes = prepararTextoWa('🙂'.repeat(9000));
  const inteiro = partes.join('');
  assert.equal(inteiro, '🙂'.repeat(9000));
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(inteiro), 'half an emoji was left over');
  assert.ok(!/(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(inteiro), 'half an emoji was left over');
  for (const p of partes) assert.ok(!/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(p), 'bubble starts or ends in half an emoji');
});

test('reply with 8 full bubbles stays the same, no notice', () => {
  const partes = prepararTextoWa('a'.repeat(BALAO * 8));
  assert.equal(partes.length, 8);
  assert.ok(!partes.join('').includes('cortei o resto'));
});
