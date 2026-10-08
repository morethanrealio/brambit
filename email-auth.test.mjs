import assert from 'node:assert/strict';
import test from 'node:test';
import {emailAuth, passesEmailAuth} from './web/email.mjs';

// Builds the minimal parsed object that emailAuth() consumes: only the header lines.
const parsedCom = (...ars) => ({headerLines: ars.map((line) => ({key: 'authentication-results', line: 'Authentication-Results: ' + line}))});
const AR_GOOGLE = 'mx.google.com; dkim=pass header.i=@gmail.com header.s=20230601; spf=pass smtp.mailfrom=alice@gmail.com; dmarc=pass header.from=gmail.com';

test('forged authserv-id is not accepted as our MX stamp', () => {
  // The attacker writes their own A-R into the email itself and cites mx.google.com in a
  // PROPERTY. Before, the filter by textual occurrence swallowed this as strong.
  const p = parsedCom('evil.example; dkim=pass header.d=mx.google.com; dmarc=pass header.from=vitima.example');
  assert.equal(emailAuth(p).trusted, false);
  assert.equal(passesEmailAuth(p, 'vitima@vitima.example').strong, false);
});

test('dkim=pass from a third-party domain does not prove the From', () => {
  const p = parsedCom('mx.google.com; dkim=pass header.i=@atacante.example; spf=pass smtp.mailfrom=atacante.example; dmarc=none header.from=vitima.example');
  const r = passesEmailAuth(p, 'alvo@vitima.example');
  assert.equal(r.ok, false);
  assert.match(r.reason, /não alinhado/);
});

test('dkim=pass aligned with the From is strong identity', () => {
  const r = passesEmailAuth(parsedCom('mx.google.com; dkim=pass header.i=@empresa.com.br; dmarc=none header.from=empresa.com.br'), 'joao@empresa.com.br');
  assert.deepEqual([r.ok, r.strong], [true, true]);
});

test('a subdomain of the signing domain counts as aligned (relaxed)', () => {
  const r = passesEmailAuth(parsedCom('mx.google.com; dkim=pass header.d=empresa.com.br; dmarc=none header.from=mail.empresa.com.br'), 'joao@mail.empresa.com.br');
  assert.equal(r.strong, true);
});

test('aligned spf covers the case with no dkim', () => {
  const r = passesEmailAuth(parsedCom('mx.google.com; dkim=none; spf=pass smtp.mailfrom=joao@empresa.com.br; dmarc=none'), 'joao@empresa.com.br');
  assert.deepEqual([r.ok, r.strong], [true, true]);
});

test('happy path and domain-spoof-with-policy path still hold', () => {
  assert.deepEqual(((r) => [r.ok, r.strong])(passesEmailAuth(parsedCom(AR_GOOGLE), 'alice@gmail.com')), [true, true]);
  assert.equal(passesEmailAuth(parsedCom('mx.google.com; dkim=fail; spf=fail; dmarc=fail header.from=gmail.com'), 'alice@gmail.com').ok, false);
});

test('with no trustworthy authentication-results, stays fail-open with a caveat', () => {
  const r = passesEmailAuth({headerLines: []}, 'alice@gmail.com');
  assert.deepEqual([r.ok, r.strong], [true, false]);
});
