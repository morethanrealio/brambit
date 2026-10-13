import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { createEmailSuppressionStore, normalizeAddress } from '../web/email-suppression.mjs';
import { sendEmail } from '../web/mailer.mjs';

const MIGRATION = new URL('../migrations/2026-10-13-email-suppressions.sql', import.meta.url);

async function pglitePool(t, { migrate = true } = {}) {
  const db = new PGlite(); t.after(() => db.close());
  await db.exec('CREATE SCHEMA mtr_harness;');
  if (migrate) await db.exec(readFileSync(MIGRATION, 'utf8'));
  return { query: (sql, values) => db.query(sql, values) };
}

test('an address is suppressed, found under any spelling and lifted again', async (t) => {
  const store = createEmailSuppressionStore(await pglitePool(t));
  assert.equal(await store.lookup('gone@privaterelay.appleid.com'), null);
  assert.equal(await store.suppress('Gone@PrivateRelay.AppleID.com', { source: 'bounce', reason: '5.1.1' }), true);
  assert.deepEqual(await store.lookup('Someone <GONE@privaterelay.appleid.com>'), { source: 'bounce', reason: '5.1.1' });
  // A later notice replaces the entry instead of failing on the key.
  assert.equal(await store.suppress('gone@privaterelay.appleid.com', { source: 'apple', reason: 'email-disabled' }), true);
  assert.deepEqual(await store.lookup('gone@privaterelay.appleid.com'), { source: 'apple', reason: 'email-disabled' });
  assert.equal(await store.lift('gone@privaterelay.appleid.com'), true);
  assert.equal(await store.lookup('gone@privaterelay.appleid.com'), null);
  assert.equal(await store.lift('gone@privaterelay.appleid.com'), false);
  assert.equal(normalizeAddress('not an address'), null);
});

test('without the migration nothing is suppressed and nothing throws', async (t) => {
  const store = createEmailSuppressionStore(await pglitePool(t, { migrate: false }));
  t.mock.method(console, 'warn', () => {});
  assert.equal(await store.lookup('a@example.com'), null);
  assert.equal(await store.suppress('a@example.com', { source: 'bounce', reason: '5.1.1' }), false);
  assert.equal(await store.lift('a@example.com'), false);
});

test('sendEmail skips a suppressed recipient and sends to everyone else', async (t) => {
  const env = { ...process.env };
  t.after(() => { process.env = env; });
  for (const k of ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS']) delete process.env[k];
  Object.assign(process.env, { RESEND_API_KEY: 'test-key', MAIL_FROM: 'oi@example.com' });
  const sent = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    sent.push(JSON.parse(init.body).to[0]);
    return { ok: true, json: async () => ({ id: 'msg-1' }) };
  });
  t.mock.method(console, 'log', () => {});
  const suppressions = { lookup: async (to) => (to === 'gone@example.com' ? { source: 'bounce', reason: '5.1.1' } : null) };

  const blocked = await sendEmail({ to: 'gone@example.com', subject: 's', text: 't' }, { suppressions });
  assert.deepEqual(blocked, { skipped: true, suppressed: true, reason: '5.1.1' });
  assert.deepEqual(await sendEmail({ to: 'ok@example.com', subject: 's', text: 't' }, { suppressions }), { ok: true, id: 'msg-1' });
  assert.deepEqual(sent, ['ok@example.com']);
});
