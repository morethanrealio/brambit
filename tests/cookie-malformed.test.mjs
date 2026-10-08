// Finding #21: a cookie with invalid percent-encoding brought down the whole PROCESS.
// The path: readCookie calls decodeURIComponent without protection, and whoever reads the cookie
// is inside the async handler of http.createServer, which had no catch at all,
// so the URIError turned into an unhandled rejection and Node died.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const { readCookie, readSid } = await import('../web/auth.mjs');

const req = (cookie, extra = {}) => ({ headers: { cookie, ...extra } });

test('cookie with broken percent-encoding does not throw', () => {
  for (const ruim of ['idioma=%', 'idioma=%zz', 'idioma=100%', 'idioma=a%E0b']) {
    assert.doesNotThrow(() => readCookie(req(ruim), 'idioma'));
  }
});

test('a corrupted value comes back raw, it does not become an exception or disappear', () => {
  assert.equal(readCookie(req('idioma=100%'), 'idioma'), '100%');
  assert.equal(readCookie(req('idioma=%zz'), 'idioma'), '%zz');
});

test('a normal cookie still decodes the same way', () => {
  assert.equal(readCookie(req('idioma=pt-BR'), 'idioma'), 'pt-BR');
  assert.equal(readCookie(req('nome=Jo%C3%A3o'), 'nome'), 'João');
  assert.equal(readCookie(req('a=1; b=2'), 'b'), '2');
  assert.equal(readCookie(req('a=1'), 'nao-existe'), null);
});

test('a broken cookie in the middle does not prevent reading the others', () => {
  assert.equal(readCookie(req('lixo=%; sid=abc'), 'sid'), 'abc');
});

test('readSid survives a malformed sid (it does not bring down the login)', () => {
  assert.doesNotThrow(() => readSid(req('sid=%E0%A4%A')));
});

test("the server's handler can no longer be a loose async", () => {
  const src = fs.readFileSync(new URL('../web/server.mjs', import.meta.url), 'utf8');
  assert.ok(!/http\.createServer\(async /.test(src), 'an async callback with no catch kills the process');
  // The synchronous callback may register listeners beforehand (e.g.: req.on('error')),
  // but its first asynchronous thing has to be atenderRequest(...).catch(.
  const ini = src.search(/http\.createServer\(\(req, res\) => \{/);
  assert.ok(ini >= 0, 'createServer with a synchronous callback');
  const corpo = src.slice(ini, src.indexOf('atenderRequest(req, res)', ini));
  assert.ok(corpo.length < 600 && !/\bawait\b|\basync\b/.test(corpo.replace(/\/\/.*$/gm, "")), 'nothing asynchronous before atenderRequest');
  assert.match(src.slice(ini), /^[^]*?atenderRequest\(req, res\)\.catch\(/);
  assert.match(src, /res\.writeHead\(500/);
});
