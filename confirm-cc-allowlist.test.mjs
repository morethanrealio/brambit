// Two findings from the confirmation gate (2026-09-17 sweep):
//  1. the gmail_send/hotmail_send card didn't show the cc, so the person
//     authorized a send different from what would actually happen;
//  2. cmdAllowed() only matched the prefix, so "git status && rm -rf /x" passed
//     through the "git status" allowlist and ran without any confirmation.
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
