// maskSecrets: senha em texto comum (pt/es/en) vira ***, só o valor. Chave Pix,
// CPF e "clave" passam intactos. Offline, valores sintéticos.
import test from 'node:test';
import assert from 'node:assert/strict';
import { maskSecrets } from './web/ssh.mjs';

const prose = (s) => maskSecrets(s, { prose: true });

test('senha rotulada em pt/es/en mascara só o valor', () => {
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

test('texto comum sobre senha e dado financeiro passam intactos', () => {
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

test('rótulo sem valor na mesma linha não come a linha seguinte', () => {
  assert.equal(prose('A senha:\nok, conectado'), 'A senha:\nok, conectado');
  assert.equal(maskSecrets('senha=abc123\nDB_PASSWORD=x'), 'senha=***\nDB_PASSWORD=***');
});
