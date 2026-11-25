// maskSecrets: a password in plain text (pt/es/en) turns into ***, only the value. Pix key,
// CPF, and "clave" pass through intact. Offline, synthetic values.
import test from 'node:test';
import assert from 'node:assert/strict';
import { maskSecrets } from '../web/ssh.mjs';

const prose = (s) => maskSecrets(s, { prose: true });

test('a labeled password in pt/es/en masks only the value', () => {
  const casos = [
    ['senha: casa2026', 'senha: ***'],
    ['Senha: casa2026.', 'Senha: ***.'],
    ['A senha é casa2026.', 'A senha é ***.'],
    ['a senha do wifi é casa2026', 'a senha do wifi é ***'],
    ['A senha do Wi-Fi da casa: casa2026, anota aí.', 'A senha do Wi-Fi da casa: ***, anota aí.'],
    ['senha nova: Xy!9abc', 'senha nova: ***'],
    ['Senha: **casa2026**', 'Senha: ***'],
    ['senha: `casa2026`', 'senha: `***`'],
    ['contraseña: casa2026', 'contraseña: ***'],
    ['La contraseña del wifi es casa2026', 'La contraseña del wifi es ***'],
    ['password: hunter2', 'password: ***'],
    ['The password is hunter2', 'The password is ***'],
    ['pwd=abc123', 'pwd=***'],
    ['PASSWORD: segredo', 'PASSWORD: ***'],
  ];
  for (const [entrada, esperado] of casos) assert.equal(prose(entrada), esperado, entrada);
});

test('ordinary text about password and financial data passes through intact', () => {
  for (const texto of [
    'A senha é obrigatória para entrar.',
    'Sua senha é pessoal, não compartilhe.',
    'Chave Pix: 000.000.000-00',
    'A chave pix da Ana é ana@example.invalid',
    'La clave Pix es 000.000.000-00',
    'clave: 12345',
    'CPF: 000.000.000-00',
    'Senha: não informada',
    'Troque a senha amanhã.',
    'passo: abrir o app',
  ]) assert.equal(prose(texto), texto, texto);
});

test('a label with no value on the same line does not eat the next line', () => {
  assert.equal(prose('A senha:\nok, conectado'), 'A senha:\nok, conectado');
  assert.equal(maskSecrets('senha=abc123\nDB_PASSWORD=x'), 'senha=***\nDB_PASSWORD=***');
});

// The login of the owner's own app, handed over by the platform to be passed on.
test('a password the platform handed over comes out as written; any other value stays masked', () => {
  const keep = new Set(['Ab3xK9pQ2z']);
  const reply = (s) => maskSecrets(s, { prose: true, keep });
  for (const text of [
    'Senha: Ab3xK9pQ2z',
    'Senha: `Ab3xK9pQ2z`',
    'Senha: **Ab3xK9pQ2z**',
    'A senha do app é Ab3xK9pQ2z.',
    'The password is "Ab3xK9pQ2z".',
    'PASSWORD: Ab3xK9pQ2z',
    'senha=Ab3xK9pQ2z',
  ]) assert.equal(reply(text), text, text);
  assert.equal(reply('Senha: Ab3xK9pQ2x'), 'Senha: ***');
  assert.equal(reply('Senha: Ab3xK9pQ2z, e a senha do wifi é casa2026'), 'Senha: Ab3xK9pQ2z, e a senha do wifi é ***');
  assert.equal(maskSecrets('Senha: Ab3xK9pQ2z', { prose: true, keep: new Set() }), 'Senha: ***');
});
