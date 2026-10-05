import test from 'node:test';
import assert from 'node:assert/strict';
import { prepararTextoWa } from './web/whatsapp.mjs';

// Até 29/09/2026 o WhatsApp tinha teto de 8 balões: o excesso sumia e o último
// balão levava "[…resposta muito longa, cortei o resto]". Agora a resposta longa
// vai inteira, em quantos balões precisar, na ordem. Estes testes travam isso.

const BALAO = 1024;

test('resposta curta vai num balão só, sem aviso', () => {
  const partes = prepararTextoWa('oi, tudo certo por aqui');
  assert.deepEqual(partes, ['oi, tudo certo por aqui']);
});

test('texto vazio vira o placeholder, nunca silêncio', () => {
  assert.deepEqual(prepararTextoWa('   '), ['(sem resposta)']);
  assert.deepEqual(prepararTextoWa(undefined), ['(sem resposta)']);
});

test('resposta gigante vai inteira, sem aviso de corte', () => {
  const texto = 'palavra '.repeat(20000).trim();
  const partes = prepararTextoWa(texto);
  assert.ok(partes.length > 8, `gerou só ${partes.length} balões`);
  for (const p of partes) assert.ok(p.length <= BALAO, `balão de ${p.length}`);
  assert.ok(!partes.join('').includes('cortei o resto'));
  assert.equal(partes.join(' '), texto, 'nenhuma palavra sumiu nem mudou de ordem');
});

test('emoji na fronteira do corte não vira caractere quebrado', () => {
  const partes = prepararTextoWa('🙂'.repeat(9000));
  const inteiro = partes.join('');
  assert.equal(inteiro, '🙂'.repeat(9000));
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(inteiro), 'sobrou meio emoji');
  assert.ok(!/(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(inteiro), 'sobrou meio emoji');
  for (const p of partes) assert.ok(!/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(p), 'balão começa ou termina em meio emoji');
});

test('resposta de 8 balões cheios segue igual e sem aviso', () => {
  const partes = prepararTextoWa('a'.repeat(BALAO * 8));
  assert.equal(partes.length, 8);
  assert.ok(!partes.join('').includes('cortei o resto'));
});
