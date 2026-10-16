// splitMessage: a long response becomes several messages in order, without losing text.
// Offline.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { splitMessage } from '../web/channel-split.mjs';

const semEspacoDeBorda = (partes) => partes.join('').replace(/\s+/g, '');

test('text that fits goes whole in one message', () => {
  assert.deepEqual(splitMessage('oi', 10), ['oi']);
  assert.deepEqual(splitMessage('', 10), []);
  assert.deepEqual(splitMessage('   ', 10), []);
});

test('prefers paragraph, then line, then space', () => {
  const para = 'a'.repeat(60) + '\n\n' + 'b'.repeat(60);
  assert.deepEqual(splitMessage(para, 100), ['a'.repeat(60), 'b'.repeat(60)]);

  const linha = 'a'.repeat(60) + '\n' + 'b'.repeat(60);
  assert.deepEqual(splitMessage(linha, 100), ['a'.repeat(60), 'b'.repeat(60)]);

  // paragraph too early (first half) loses to a line in the second half
  const misto = 'a'.repeat(10) + '\n\n' + 'b'.repeat(60) + '\n' + 'c'.repeat(60);
  assert.deepEqual(splitMessage(misto, 100), ['a'.repeat(10) + '\n\n' + 'b'.repeat(60), 'c'.repeat(60)]);

  const palavras = 'palavra '.repeat(30).trim();
  const partes = splitMessage(palavras, 100);
  for (const p of partes) {
    assert.ok(p.length <= 100);
    assert.match(p, /^(palavra ?)+$/, `split word: ${p}`);
  }
  assert.equal(partes.join(' '), palavras);
});

test('with no boundary, cuts hard at the cap', () => {
  const partes = splitMessage('x'.repeat(250), 100);
  assert.deepEqual(partes.map((p) => p.length), [100, 100, 50]);
});

test('hard cut does not split a URL: backs up to its start', () => {
  const url = 'https://example.invalid/caminho/longo?q=1&r=2';
  const texto = 'x'.repeat(70) + url + 'y'.repeat(40);
  const partes = splitMessage(texto, 100);
  assert.equal(partes[0], 'x'.repeat(70));
  assert.ok(partes[1].startsWith(url), partes[1]);
  assert.equal(partes.join(''), texto);
});

test('URL separated by a space stays whole in the next message', () => {
  const url = 'https://example.invalid/' + 'p'.repeat(40);
  const texto = 'ver ' + 'x'.repeat(60) + ' ' + url;
  const partes = splitMessage(texto, 100);
  assert.ok(partes.some((p) => p.includes(url)), JSON.stringify(partes));
});

test('a URL bigger than the cap is the only thing that still gets a hard cut', () => {
  const url = 'https://example.invalid/' + 'p'.repeat(200);
  const partes = splitMessage(url, 100);
  assert.equal(partes.join(''), url);
  assert.ok(partes.every((p) => p.length <= 100));
});

test('emoji at the hard-cut boundary does not turn into half a character', () => {
  const partes = splitMessage('🙂'.repeat(120), 101);
  for (const p of partes) assert.ok(!/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(p), 'half an emoji');
  assert.equal(partes.join(''), '🙂'.repeat(120));
});

test('large text loses nothing and does not change order', () => {
  const blocos = Array.from({ length: 400 }, (_, i) => `Item ${i}: https://example.invalid/i/${i} texto de apoio ${i}.`);
  const texto = blocos.join('\n');
  for (const max of [1024, 3500, 4000]) {
    const partes = splitMessage(texto, max);
    assert.ok(partes.every((p) => p.length <= max));
    assert.equal(semEspacoDeBorda(partes), texto.replace(/\s+/g, ''));
    assert.equal(partes.join('\n'), texto, 'line break with no leftover');
  }
});

test('channels no longer carry the cut-off notice', () => {
  for (const f of ['whatsapp.mjs', 'telegram.mjs', 'slack.mjs']) {
    const src = readFileSync(new URL(`../web/${f}`, import.meta.url), 'utf8');
    assert.ok(src.includes("from './channel-split.mjs'"), `${f} uses the splitter`);
    assert.ok(!/body\.slice\(0, *(?:TG|SLACK|WA)_MAX/.test(src), `${f} still cuts`);
    assert.ok(!/'\\n\\n\[…resposta muito longa, cortei o resto\]'/.test(src), `${f} still pastes the notice`);
  }
});
