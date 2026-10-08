// These cases check the Portuguese texts not yet in the catalogs, on an instance whose default is pt-BR.
process.env.BRAMBIT_DEFAULT_LANGUAGE = 'pt-BR';
// Two findings from the confirmation gate (2026-09-17 sweep):
//  1. the gmail_send/hotmail_send card didn't show the cc, so the person
//     authorized a send different from what would actually happen;
//  2. cmdAllowed() only matched the prefix, so "git status && rm -rf /x" passed
//     through the "git status" allowlist and ran without any confirmation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { describe, describeDone, cmdAllowed } from '../web/confirm.mjs';

test('the email card shows the cc (pt/en/es)', () => {
  const args = { to: 'a@x.com', subject: 'Oi', cc: 'chefe@y.com' };
  assert.match(describe('gmail_send', args), /cópia para chefe@y\.com/);
  assert.match(describeDone('gmail_send', args), /cópia para chefe@y\.com/);
  assert.match(describe('hotmail_send', args), /cópia para chefe@y\.com/);
  assert.match(describe('gmail_send', args, 'en'), /copy to chefe@y\.com/);
  assert.match(describeDone('gmail_send', args, 'es'), /copia a chefe@y\.com/);
});

test('with no cc the text doesn\'t change', () => {
  const t = describe('gmail_send', { to: 'a@x.com', subject: 'Oi' });
  assert.equal(t, 'enviar um e-mail para a@x.com com o assunto "Oi"');
  assert.ok(!/cópia/.test(t));
});

test('the allowlist lets the authorized command through', () => {
  assert.equal(cmdAllowed('git status', ['git status']), true);
  assert.equal(cmdAllowed('git status --short', ['git status']), true);
  assert.equal(cmdAllowed('github-cli', ['git']), false, 'a prefix respects word boundaries');
});

test('the allowlist does NOT let a chained command through', () => {
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
