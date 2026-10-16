import assert from 'node:assert/strict';
import test from 'node:test';
import {simpleParser} from 'mailparser';

process.env.EMAIL_ADDRESS = 'assistant@example.com';
const {addressedToAssistantDomain} = await import('../web/email.mjs');

const mail = (headers) => simpleParser(`${headers}\r\nFrom: Ana <ana@corp.example>\r\nSubject: Hi\r\n\r\nbody\r\n`);

test('any address of the mailbox domain in To or Cc is addressed to the assistant', async () => {
  assert.equal(addressedToAssistantDomain(await mail('To: kim@example.com')), true);
  assert.equal(addressedToAssistantDomain(await mail('To: client@other.example\r\nCc: Kim <KIM@Example.com>')), true);
});

test('a copy forwarded from another domain without any assistant-domain recipient is not', async () => {
  // Real case (09/10/2026): reply-all to a client; a recipient of another domain
  // forwarded unknown addresses to the assistant mailbox.
  const p = await mail('X-Gm-Original-To: typo@corp.example\r\nTo: client@other.example\r\nCc: ana@corp.example, typo@corp.example');
  assert.equal(addressedToAssistantDomain(p), false);
});

test('the original-recipient stamp counts (blind copy to the catch-all)', async () => {
  assert.equal(addressedToAssistantDomain(await mail('X-Gm-Original-To: kim@example.com\r\nTo: client@other.example')), true);
});

test('a lookalike domain does not count', async () => {
  assert.equal(addressedToAssistantDomain(await mail('To: kim@notexample.com')), false);
});
