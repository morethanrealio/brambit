// Audit 11: the raw e-mail (body, attachments) was kept forever, even after the
// account was deleted. Now an answered e-mail goes with the account and a
// discarded one (non-user, forged From) is deleted after 7 days.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { createEmailQueue } from '../web/email-queue.mjs';

// Same tables db.mjs creates; the module adds user_id on init.
async function banco(t, antes = '') {
  const db = new PGlite(); t.after(() => db.close());
  await db.exec(`CREATE SCHEMA mtr_harness;
    CREATE TABLE mtr_harness.users(id uuid PRIMARY KEY);
    CREATE TABLE mtr_harness.email_seen(message_id text PRIMARY KEY, user_id uuid REFERENCES mtr_harness.users(id) ON DELETE SET NULL, seen_at timestamptz DEFAULT now());
    CREATE TABLE mtr_harness.email_queue(id bigserial PRIMARY KEY, source bytea NOT NULL, status text NOT NULL DEFAULT 'pending',
      attempts int NOT NULL DEFAULT 0, last_error text, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());`);
  const pool = { query: (sql, values) => values ? db.query(sql, values) : db.exec(sql) };
  await db.exec(antes);
  const q = createEmailQueue(pool);
  await q.init(); await q.init();
  const status = async () => (await db.query('SELECT status, user_id FROM mtr_harness.email_queue ORDER BY id')).rows;
  return { db, q, status };
}

test('an answered e-mail stays while the account exists and goes with its final purge', async (t) => {
  const { db, q, status } = await banco(t);
  const u = randomUUID();
  await db.query('INSERT INTO mtr_harness.users VALUES ($1)', [u]);
  await q.enqueueEmail(Buffer.from('From: a@x\r\n\r\ncorpo'));
  const [row] = await q.claimPendingEmails(10);
  await q.settleEmail(row.id, 'done', null, u);
  await db.query(`UPDATE mtr_harness.email_queue SET updated_at = now() - interval '400 days'`);
  await q.purgeDiscarded();
  assert.deepEqual(await status(), [{ status: 'done', user_id: u }]);
  await db.query('DELETE FROM mtr_harness.users WHERE id = $1', [u]); // hardDeleteUser
  assert.deepEqual(await status(), []);
});

test('an answered e-mail from before the change goes with its account; one with no owner is purged', async (t) => {
  // Answered before user_id existed: one traceable to its account (email_seen), one not.
  const dono = '00000000-0000-4000-8000-000000000001';
  const { db, q, status } = await banco(t, `INSERT INTO mtr_harness.users VALUES ('${dono}');
    INSERT INTO mtr_harness.email_seen VALUES ('<antigo@gmail.com>', '${dono}');
    INSERT INTO mtr_harness.email_queue (source, status) VALUES
      (convert_to(E'From: a@gmail.com\\r\\nMessage-ID: <antigo@gmail.com>\\r\\n\\r\\nx', 'UTF8'), 'done'),
      (convert_to(E'From: b@gmail.com\\r\\nMessage-ID: <sumiu@gmail.com>\\r\\n\\r\\nx', 'UTF8'), 'done');`);
  assert.deepEqual(await status(), [{ status: 'done', user_id: dono }, { status: 'done', user_id: null }]);
  await db.query('DELETE FROM mtr_harness.users WHERE id = $1', [dono]);
  await db.query(`UPDATE mtr_harness.email_queue SET updated_at = now() - interval '8 days'`);
  await q.purgeDiscarded();
  assert.deepEqual(await status(), []);
});

test('a discarded e-mail is deleted after 7 days, not before', async (t) => {
  const { db, q, status } = await banco(t);
  for (let i = 0; i < 3; i++) await q.enqueueEmail(Buffer.from(`m${i}`));
  const rows = await q.claimPendingEmails(10);
  await q.settleEmail(rows[0].id, 'skipped');
  await q.settleEmail(rows[1].id, 'failed', 'x');
  await q.settleEmail(rows[2].id, 'skipped');
  await db.query(`UPDATE mtr_harness.email_queue SET updated_at = now() - interval '8 days' WHERE id <> $1`, [rows[2].id]);
  assert.equal(await q.purgeDiscarded(), 2);
  assert.deepEqual((await status()).map((r) => r.status), ['skipped']);
});

test('the queue links the e-mail to the account the From resolved to', async (t) => {
  const settled = [];
  const env = { EMAIL_ADDRESS: 'assistente@brambs.test', EMAIL_APP_PASSWORD: 'x', EMAIL_IMAP_HOST: '127.0.0.1', EMAIL_IMAP_PORT: '1', EMAIL_POLL_MS: '600000' };
  const antes = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  t.after(() => { for (const [k, v] of Object.entries(antes)) if (v === undefined) delete process.env[k]; else process.env[k] = v; });
  const { createEmailPoller } = await import('../web/email.mjs');
  const fonte = ['From: Ana <ana@gmail.com>', 'To: assistente@brambs.test', 'Subject: oi', 'Message-ID: <m1@gmail.com>',
    'Authentication-Results: mx.google.com; dkim=pass header.i=@gmail.com; spf=pass smtp.mailfrom=ana@gmail.com; dmarc=pass header.from=gmail.com',
    '', 'me lembra de pagar a conta'].join('\r\n');
  let fim;
  const pronto = new Promise((r) => { fim = r; });
  const poller = createEmailPoller({
    claimPendingEmails: async () => (settled.length ? [] : [{ id: 7, source: Buffer.from(fonte), attempts: 1 }]),
    settleEmail: async (...a) => { settled.push(a); fim(); },
    unclaimEmail: async () => {},
    enqueueEmail: async () => {},
    emailSeen: async () => false,
    markEmailSeen: async () => {},
    getUserByEmail: async (e) => (e === 'ana@gmail.com' ? { id: 'u-ana' } : null),
    listAgents: async () => [{ id: 'a1', name: 'Bia' }],
    runConversation: async () => '', // no reply: settles without SMTP
  });
  // The poller's guard timers (minutes long) would keep the test process alive.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  poller.start();
  t.after(() => poller.stop());
  await pronto;
  assert.deepEqual(settled[0], [7, 'skipped', null, 'u-ana']);
});
