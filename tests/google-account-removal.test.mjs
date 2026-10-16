// Audit 12: a removed Google account came back on the next restart, because the
// boot copies the old google_tokens table into google_accounts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { createGoogleAccountRemoval } from '../web/google-account-removal.mjs';

const dono = '00000000-0000-4000-8000-000000000001';

test('a removed login-e-mail account does not come back on restart, and the other one becomes primary', async (t) => {
  const db = new PGlite(); t.after(() => db.close());
  // Same tables db.mjs creates, reduced to the columns involved.
  await db.exec(`CREATE SCHEMA mtr_harness;
    CREATE TABLE mtr_harness.users(id uuid PRIMARY KEY, email text);
    CREATE TABLE mtr_harness.agents(id serial PRIMARY KEY, user_id uuid, google_email text);
    CREATE TABLE mtr_harness.google_tokens(user_id uuid PRIMARY KEY REFERENCES mtr_harness.users(id) ON DELETE CASCADE,
      access_token text, refresh_token text, scope text DEFAULT '', expiry timestamptz, updated_at timestamptz DEFAULT now());
    CREATE TABLE mtr_harness.google_accounts(user_id uuid REFERENCES mtr_harness.users(id) ON DELETE CASCADE, google_email text NOT NULL,
      access_token text, refresh_token text, scope text DEFAULT '', expiry timestamptz, is_primary boolean NOT NULL DEFAULT false,
      updated_at timestamptz DEFAULT now(), PRIMARY KEY (user_id, google_email));
    INSERT INTO mtr_harness.users VALUES ('${dono}', 'Ana@Gmail.com');
    INSERT INTO mtr_harness.google_tokens(user_id, refresh_token, scope, updated_at) VALUES ('${dono}', 'rt-antigo', 'gmail', now() - interval '90 days');
    INSERT INTO mtr_harness.google_accounts(user_id, google_email, refresh_token) VALUES ('${dono}', 'ana@trabalho.com', 'rt-trabalho');
    INSERT INTO mtr_harness.agents(user_id, google_email) VALUES ('${dono}', 'ana@gmail.com');`);
  const pool = { query: (sql, values) => db.query(sql, values) };
  const g = createGoogleAccountRemoval(pool);
  const contas = async () => (await db.query('SELECT google_email, is_primary FROM mtr_harness.google_accounts ORDER BY google_email')).rows;

  await g.backfillLegacy(); // boot
  assert.deepEqual(await contas(), [
    { google_email: 'ana@gmail.com', is_primary: true },
    { google_email: 'ana@trabalho.com', is_primary: false },
  ]);

  assert.equal(await g.removeGoogleAccount(dono, 'ANA@gmail.com'), true);
  await g.backfillLegacy(); // next restart
  assert.deepEqual(await contas(), [{ google_email: 'ana@trabalho.com', is_primary: true }]);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM mtr_harness.google_tokens')).rows[0].n, 0);
  assert.deepEqual((await db.query('SELECT google_email FROM mtr_harness.agents')).rows, [{ google_email: null }]);
});
