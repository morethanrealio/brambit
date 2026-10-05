// Dois achados do portão de confirmação (varredura 17/09):
//  1. o cartão de gmail_send/hotmail_send não mostrava o cc, então a pessoa
//     autorizava um envio diferente do que ia acontecer;
//  2. cmdAllowed() casava só o prefixo, então "git status && rm -rf /x" passava
//     pela allowlist de "git status" e rodava sem confirmação nenhuma.
import test from 'node:test';
import assert from 'node:assert/strict';
import { describe, describeDone, cmdAllowed } from './web/confirm.mjs';

test('cartão de e-mail mostra o cc (pt/en/es)', () => {
  const args = { to: 'a@x.com', subject: 'Oi', cc: 'chefe@y.com' };
  assert.match(describe('gmail_send', args), /cópia para chefe@y\.com/);
  assert.match(describeDone('gmail_send', args), /cópia para chefe@y\.com/);
  assert.match(describe('hotmail_send', args), /cópia para chefe@y\.com/);
  assert.match(describe('gmail_send', args, 'en'), /copy to chefe@y\.com/);
  assert.match(describeDone('gmail_send', args, 'es'), /copia a chefe@y\.com/);
});

test('sem cc o texto não muda', () => {
  const t = describe('gmail_send', { to: 'a@x.com', subject: 'Oi' });
  assert.equal(t, 'enviar um e-mail para a@x.com com o assunto "Oi"');
  assert.ok(!/cópia/.test(t));
});

test('allowlist libera o comando autorizado', () => {
  assert.equal(cmdAllowed('git status', ['git status']), true);
  assert.equal(cmdAllowed('git status --short', ['git status']), true);
  assert.equal(cmdAllowed('github-cli', ['git']), false, 'prefixo respeita fronteira de palavra');
});

test('allowlist NÃO libera comando encadeado', () => {
  for (const c of [
    'git status && rm -rf /pasta',
    'git status; rm -rf /pasta',
    'git status | sh',
    'git status `rm -rf /pasta`',
    'git status $(rm -rf /pasta)',
    'git status > /etc/crontab',
    'git status\nrm -rf /pasta',
  ]) {
    assert.equal(cmdAllowed(c, ['git status']), false, c);
  }
});
