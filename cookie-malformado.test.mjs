// Achado #21: cookie com percent-encoding inválido derrubava o PROCESSO inteiro.
// O caminho: readCookie chama decodeURIComponent sem proteção, e quem lê cookie
// está dentro do handler async do http.createServer, que não tinha catch nenhum,
// então o URIError virava rejeição não tratada e o Node morria.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const { readCookie, readSid } = await import('./web/auth.mjs');

const req = (cookie, extra = {}) => ({ headers: { cookie, ...extra } });

test('cookie com percent-encoding quebrado não lança', () => {
  for (const ruim of ['idioma=%', 'idioma=%zz', 'idioma=100%', 'idioma=a%E0b']) {
    assert.doesNotThrow(() => readCookie(req(ruim), 'idioma'));
  }
});

test('valor estragado volta cru, não vira exceção nem some', () => {
  assert.equal(readCookie(req('idioma=100%'), 'idioma'), '100%');
  assert.equal(readCookie(req('idioma=%zz'), 'idioma'), '%zz');
});

test('cookie normal segue decodificando igual', () => {
  assert.equal(readCookie(req('idioma=pt-BR'), 'idioma'), 'pt-BR');
  assert.equal(readCookie(req('nome=Jo%C3%A3o'), 'nome'), 'João');
  assert.equal(readCookie(req('a=1; b=2'), 'b'), '2');
  assert.equal(readCookie(req('a=1'), 'nao-existe'), null);
});

test('um cookie quebrado no meio não impede ler os outros', () => {
  assert.equal(readCookie(req('lixo=%; sid=abc'), 'sid'), 'abc');
});

test('readSid sobrevive a um sid malformado (não derruba o login)', () => {
  assert.doesNotThrow(() => readSid(req('sid=%E0%A4%A')));
});

test('o handler do servidor não pode mais ser async solto', () => {
  const src = fs.readFileSync(new URL('./web/server.mjs', import.meta.url), 'utf8');
  assert.ok(!/http\.createServer\(async /.test(src), 'callback async sem catch mata o processo');
  // O callback síncrono pode registrar listeners antes (ex.: req.on('error')),
  // mas a primeira coisa assíncrona dele tem que ser atenderRequest(...).catch(.
  const ini = src.search(/http\.createServer\(\(req, res\) => \{/);
  assert.ok(ini >= 0, 'createServer com callback síncrono');
  const corpo = src.slice(ini, src.indexOf('atenderRequest(req, res)', ini));
  assert.ok(corpo.length < 600 && !/\bawait\b|\basync\b/.test(corpo.replace(/\/\/.*$/gm, "")), 'nada assíncrono antes do atenderRequest');
  assert.match(src.slice(ini), /^[^]*?atenderRequest\(req, res\)\.catch\(/);
  assert.match(src, /res\.writeHead\(500/);
});
