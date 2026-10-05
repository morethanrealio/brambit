import assert from 'node:assert/strict';
import test from 'node:test';
import {emailAuth, passesEmailAuth} from './web/email.mjs';

// Monta o parsed mínimo que emailAuth() consome: só as linhas de cabeçalho.
const parsedCom = (...ars) => ({headerLines: ars.map((line) => ({key: 'authentication-results', line: 'Authentication-Results: ' + line}))});
const AR_GOOGLE = 'mx.google.com; dkim=pass header.i=@gmail.com header.s=20230601; spf=pass smtp.mailfrom=alice@gmail.com; dmarc=pass header.from=gmail.com';

test('authserv-id forjado não é aceito como carimbo do nosso MX', () => {
  // O atacante escreve o A-R dele no próprio e-mail e cita mx.google.com numa
  // PROPRIEDADE. Antes, o filtro por ocorrência textual engolia isso como forte.
  const p = parsedCom('evil.example; dkim=pass header.d=mx.google.com; dmarc=pass header.from=vitima.example');
  assert.equal(emailAuth(p).trusted, false);
  assert.equal(passesEmailAuth(p, 'vitima@vitima.example').strong, false);
});

test('dkim=pass de domínio de terceiro não prova o From', () => {
  const p = parsedCom('mx.google.com; dkim=pass header.i=@atacante.example; spf=pass smtp.mailfrom=atacante.example; dmarc=none header.from=vitima.example');
  const r = passesEmailAuth(p, 'alvo@vitima.example');
  assert.equal(r.ok, false);
  assert.match(r.reason, /não alinhado/);
});

test('dkim=pass alinhado com o From é identidade forte', () => {
  const r = passesEmailAuth(parsedCom('mx.google.com; dkim=pass header.i=@empresa.com.br; dmarc=none header.from=empresa.com.br'), 'joao@empresa.com.br');
  assert.deepEqual([r.ok, r.strong], [true, true]);
});

test('subdomínio do domínio assinante conta como alinhado (relaxado)', () => {
  const r = passesEmailAuth(parsedCom('mx.google.com; dkim=pass header.d=empresa.com.br; dmarc=none header.from=mail.empresa.com.br'), 'joao@mail.empresa.com.br');
  assert.equal(r.strong, true);
});

test('spf alinhado segura o caso sem dkim', () => {
  const r = passesEmailAuth(parsedCom('mx.google.com; dkim=none; spf=pass smtp.mailfrom=joao@empresa.com.br; dmarc=none'), 'joao@empresa.com.br');
  assert.deepEqual([r.ok, r.strong], [true, true]);
});

test('caminho feliz e caminho de spoof de domínio com política seguem valendo', () => {
  assert.deepEqual(((r) => [r.ok, r.strong])(passesEmailAuth(parsedCom(AR_GOOGLE), 'alice@gmail.com')), [true, true]);
  assert.equal(passesEmailAuth(parsedCom('mx.google.com; dkim=fail; spf=fail; dmarc=fail header.from=gmail.com'), 'alice@gmail.com').ok, false);
});

test('sem authentication-results confiável segue fail-open com ressalva', () => {
  const r = passesEmailAuth({headerLines: []}, 'alice@gmail.com');
  assert.deepEqual([r.ok, r.strong], [true, false]);
});
