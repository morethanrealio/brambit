// Audit 13: the library must only ever hand out an anonymized copy of an app's code,
// the owner's own code must stay as it is, and if the code could not be checked the
// app does not go public.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { createPublicSnapshots } from '../web/public-snapshot.mjs';

const dono = '00000000-0000-4000-8000-000000000001';

async function setup(t) {
  const db = new PGlite(); t.after(() => db.close());
  // Same table db.mjs creates, reduced to the columns involved.
  await db.exec(`CREATE SCHEMA mtr_harness;
    CREATE TABLE mtr_harness.users(id uuid PRIMARY KEY, name text);
    CREATE TABLE mtr_harness.apps(user_id uuid, label text, system text, runtime text, url text,
      visibility text DEFAULT 'private', description text, source_snapshot text, snapshot_at timestamptz,
      updated_at timestamptz DEFAULT now(), PRIMARY KEY (user_id, system));
    INSERT INTO mtr_harness.users VALUES ('${dono}', 'Ana');
    INSERT INTO mtr_harness.apps(user_id, label, system, description) VALUES ('${dono}', 'ana', 'loja', 'Loja de exemplo');`);
  const pool = { query: (sql, values) => db.query(sql, values) };
  // Fake anonymizer: 'down' simulates no key / model error / unreadable reply.
  const anon = { down: false };
  const anonymize = async (blob) => anon.down
    ? { ok: false, blob, changed: false, applied: 0, error: 'model down' }
    : { ok: true, blob: blob.replace('Ana', 'Cliente'), changed: blob.includes('Ana'), applied: 1 };
  const ps = createPublicSnapshots(pool, { anonymize, log: () => {} });
  await ps.init();
  const dono_ = async () => (await db.query(`SELECT source_snapshot FROM mtr_harness.apps WHERE system='loja'`)).rows[0].source_snapshot;
  // setAppSnapshot refreshes the public copy in the background: waits for it to land.
  const until = async (fn) => { for (let i = 0; i < 200; i++) { if (await fn()) return; await new Promise((r) => setTimeout(r, 5)); } assert.fail('timed out'); };
  return { db, ps, anon, dono_, until };
}

test('the library gets the anonymized copy, the owner keeps their code, new versions follow', async (t) => {
  const { ps, anon, dono_, until } = await setup(t);
  await ps.setAppSnapshot(dono, 'loja', 'v1 Ana');

  assert.deepEqual(await ps.setLibraryVisibility(dono, 'loja', true, null), { ok: true, replicavel: true, anonimizado: true });
  assert.equal(await dono_(), 'v1 Ana');
  assert.equal((await ps.getPublicApp('ana', 'loja')).source_snapshot, 'v1 Cliente');
  assert.equal((await ps.listPublicApps({ q: 'loja' })).length, 1);

  await ps.setAppSnapshot(dono, 'loja', 'v2 Ana'); // owner republishes
  await until(async () => (await ps.getPublicApp('ana', 'loja')).source_snapshot === 'v2 Cliente');
  assert.equal(await dono_(), 'v2 Ana');

  anon.down = true;
  await ps.setAppSnapshot(dono, 'loja', 'v3 Ana'); // can't be checked: keeps the last checked copy
  await new Promise((r) => setTimeout(r, 50));
  assert.equal((await ps.getPublicApp('ana', 'loja')).source_snapshot, 'v2 Cliente');

  anon.down = false; // next boot catches it up
  assert.deepEqual(await ps.catchUp(), { pending: 1, done: 1 });
  assert.equal((await ps.getPublicApp('ana', 'loja')).source_snapshot, 'v3 Cliente');

  assert.deepEqual(await ps.setLibraryVisibility(dono, 'loja', false, null), { ok: true });
  assert.equal(await ps.getPublicApp('ana', 'loja'), null);
  assert.deepEqual(await ps.catchUp(), { pending: 0, done: 0 });
});

test('if the code cannot be checked, the app does not go public; apps already public before this fix enter only once checked', async (t) => {
  const { db, ps, anon } = await setup(t);
  await ps.setAppSnapshot(dono, 'loja', 'v1 Ana');

  anon.down = true;
  assert.deepEqual(await ps.setLibraryVisibility(dono, 'loja', true, null), { ok: false, reason: 'anonymize_failed' });
  assert.equal((await db.query(`SELECT visibility FROM mtr_harness.apps`)).rows[0].visibility, 'private');
  assert.equal(await ps.getPublicApp('ana', 'loja'), null);

  // Public before this change: has code, no public copy yet.
  await db.query(`UPDATE mtr_harness.apps SET visibility='public'`);
  assert.equal(await ps.getPublicApp('ana', 'loja'), null);
  assert.deepEqual(await ps.listPublicApps(), []);
  assert.deepEqual(await ps.catchUp(), { pending: 1, done: 0 });
  assert.equal(await ps.getPublicApp('ana', 'loja'), null);
  anon.down = false;
  assert.deepEqual(await ps.catchUp(), { pending: 1, done: 1 });
  assert.equal((await ps.getPublicApp('ana', 'loja')).source_snapshot, 'v1 Cliente');
});
