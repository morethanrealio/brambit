// Markdown from the model becomes WhatsApp formatting before sending. Offline.
import test from 'node:test';
import assert from 'node:assert/strict';
import { markdownParaWa } from './web/wa-format.mjs';
import { prepararTextoWa } from './web/whatsapp.mjs';

test('bold, heading and strikethrough become WhatsApp markup', () => {
  const md = '## Vocabulário de hoje\n\n**to build** = construir\n***atenção*** e ~~errado~~';
  assert.equal(markdownParaWa(md), '*Vocabulário de hoje*\n\n*to build* = construir\n*atenção* e ~errado~');
});

test('what is already in WhatsApp format does not change', () => {
  const wa = '*negrito* _itálico_ ~tachado~\n- item\n1. item';
  assert.equal(markdownParaWa(wa), wa);
});

test('link becomes text + url, and a raw url is left untouched', () => {
  assert.equal(markdownParaWa('Leia [o artigo](https://ex.com/a_b)'), 'Leia o artigo (https://ex.com/a_b)');
  assert.equal(markdownParaWa('[https://ex.com](https://ex.com/)'), 'https://ex.com/');
  assert.equal(markdownParaWa('veja https://ex.com/__init__**x**'), 'veja https://ex.com/__init__**x**');
  // asterisk stuck at the end is bold, not a link; a link in bold goes out without the marker
  assert.equal(markdownParaWa('Acesse **https://brambs.com.br** e faça **login**'), 'Acesse https://brambs.com.br e faça *login*');
  assert.equal(markdownParaWa('**[brambs.com.br](https://brambs.com.br)** › **Conexões**'), 'https://brambs.com.br › *Conexões*');
});

test('masked CPF does not become bold', () => {
  assert.equal(markdownParaWa('Pix para Ana (CPF ***.365.199-**), **confirma?**'), 'Pix para Ana (CPF ***.365.199-**), *confirma?*');
});

test('code passes through untouched', () => {
  const md = 'rode `a**b**c` e\n```\n# não é título\n**x**\n```';
  assert.equal(markdownParaWa(md), md);
});

test('__ in the middle of a word does not become bold', () => {
  assert.equal(markdownParaWa('meu__nome__x e __sim__'), 'meu__nome__x e *sim*');
});

test('sending via WhatsApp applies the conversion', () => {
  assert.deepEqual(prepararTextoWa('**Bom dia!**'), ['*Bom dia!*']);
  assert.deepEqual(prepararTextoWa('   '), ['(sem resposta)']);
});
