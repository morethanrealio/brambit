// splitMessage: resposta longa vira várias mensagens na ordem, sem perder texto.
// Offline.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { splitMessage } from './web/channel-split.mjs';

const semEspacoDeBorda = (partes) => partes.join('').replace(/\s+/g, '');

test('texto que cabe vai inteiro numa mensagem', () => {
  assert.deepEqual(splitMessage('oi', 10), ['oi']);
  assert.deepEqual(splitMessage('', 10), []);
  assert.deepEqual(splitMessage('   ', 10), []);
});

test('prefere parágrafo, depois linha, depois espaço', () => {
  const para = 'a'.repeat(60) + '\n\n' + 'b'.repeat(60);
  assert.deepEqual(splitMessage(para, 100), ['a'.repeat(60), 'b'.repeat(60)]);

  const linha = 'a'.repeat(60) + '\n' + 'b'.repeat(60);
  assert.deepEqual(splitMessage(linha, 100), ['a'.repeat(60), 'b'.repeat(60)]);

  // parágrafo cedo demais (primeira metade) perde pra linha na segunda metade
  const misto = 'a'.repeat(10) + '\n\n' + 'b'.repeat(60) + '\n' + 'c'.repeat(60);
  assert.deepEqual(splitMessage(misto, 100), ['a'.repeat(10) + '\n\n' + 'b'.repeat(60), 'c'.repeat(60)]);

  const palavras = 'palavra '.repeat(30).trim();
  const partes = splitMessage(palavras, 100);
  for (const p of partes) {
    assert.ok(p.length <= 100);
    assert.match(p, /^(palavra ?)+$/, `palavra partida: ${p}`);
  }
  assert.equal(partes.join(' '), palavras);
});

test('sem fronteira, corta seco no teto', () => {
  const partes = splitMessage('x'.repeat(250), 100);
  assert.deepEqual(partes.map((p) => p.length), [100, 100, 50]);
});

test('corte seco não parte URL: recua pro começo dela', () => {
  const url = 'https://example.invalid/caminho/longo?q=1&r=2';
  const texto = 'x'.repeat(70) + url + 'y'.repeat(40);
  const partes = splitMessage(texto, 100);
  assert.equal(partes[0], 'x'.repeat(70));
  assert.ok(partes[1].startsWith(url), partes[1]);
  assert.equal(partes.join(''), texto);
});

test('URL separada por espaço fica inteira na mensagem seguinte', () => {
  const url = 'https://example.invalid/' + 'p'.repeat(40);
  const texto = 'ver ' + 'x'.repeat(60) + ' ' + url;
  const partes = splitMessage(texto, 100);
  assert.ok(partes.some((p) => p.includes(url)), JSON.stringify(partes));
});

test('URL maior que o teto é a única coisa que ainda corta seco', () => {
  const url = 'https://example.invalid/' + 'p'.repeat(200);
  const partes = splitMessage(url, 100);
  assert.equal(partes.join(''), url);
  assert.ok(partes.every((p) => p.length <= 100));
});

test('emoji na borda do corte seco não vira meio caractere', () => {
  const partes = splitMessage('🙂'.repeat(120), 101);
  for (const p of partes) assert.ok(!/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(p), 'meio emoji');
  assert.equal(partes.join(''), '🙂'.repeat(120));
});

test('texto grande não perde nada nem muda de ordem', () => {
  const blocos = Array.from({ length: 400 }, (_, i) => `Item ${i}: https://example.invalid/i/${i} texto de apoio ${i}.`);
  const texto = blocos.join('\n');
  for (const max of [1024, 3500, 4000]) {
    const partes = splitMessage(texto, max);
    assert.ok(partes.every((p) => p.length <= max));
    assert.equal(semEspacoDeBorda(partes), texto.replace(/\s+/g, ''));
    assert.equal(partes.join('\n'), texto, 'quebra em linha sem sobra');
  }
});

test('canais não carregam mais o aviso de corte', () => {
  for (const f of ['whatsapp.mjs', 'telegram.mjs', 'slack.mjs']) {
    const src = readFileSync(new URL(`./web/${f}`, import.meta.url), 'utf8');
    assert.ok(src.includes("from './channel-split.mjs'"), `${f} usa o splitter`);
    assert.ok(!/body\.slice\(0, *(?:TG|SLACK|WA)_MAX/.test(src), `${f} ainda corta`);
    assert.ok(!/'\\n\\n\[…resposta muito longa, cortei o resto\]'/.test(src), `${f} ainda cola o aviso`);
  }
});
