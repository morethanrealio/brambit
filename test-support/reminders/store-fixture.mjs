import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { createReminderExecutionStore } from '../../web/reminder-execution-store.mjs';

// Only synthetic records in a fresh embedded database. Never import db.mjs,
// server.mjs, environment loaders, or any configured application connection.
export async function createReminderStoreFixture({ beforeSchema } = {}) {
  const db = new PGlite();
  await db.exec(`CREATE SCHEMA mtr_harness;
    CREATE TABLE mtr_harness.users(id uuid PRIMARY KEY,name text,email text,language text,deleted_at timestamptz);
    CREATE TABLE mtr_harness.agents(id uuid PRIMARY KEY,user_id uuid,name text,archived_at timestamptz);
    CREATE TABLE mtr_harness.threads(id uuid PRIMARY KEY,user_id uuid);
    CREATE TABLE mtr_harness.reminders(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid,agent_id uuid,message text,
      run_at timestamptz,channel text,status text DEFAULT 'pending',created_at timestamptz DEFAULT now(),
      sent_at timestamptz,repeat_every_min integer,repeat_until timestamptz);
    CREATE UNIQUE INDEX reminders_dedup_pending_idx
      ON mtr_harness.reminders(user_id,agent_id,message,run_at) WHERE status='pending';`);
  const userId = randomUUID(), agentId = randomUUID(), otherId = randomUUID(), threadId = randomUUID();
  await db.query(`INSERT INTO mtr_harness.users(id,name,email) VALUES ($1,'Synthetic','fixture@example.invalid'),($2,'Other','other@example.invalid')`, [userId, otherId]);
  await db.query(`INSERT INTO mtr_harness.agents(id,user_id,name) VALUES ($1,$2,'Synthetic')`, [agentId, userId]);
  await db.query(`INSERT INTO mtr_harness.threads(id,user_id) VALUES ($1,$2)`, [threadId, userId]);
  // PGlite has one connection. Queue complete transactions, as a size-one pg
  // pool would; the actual SQL still enforces token, state and unique fences.
  let tail = Promise.resolve(), failOnce = null;
  const query = async (...args) => {
    if (failOnce?.test(args[0])) { failOnce = null; throw new Error('Synthetic persistence failure'); }
    return args.length === 1 && args[0].includes(';') ? db.exec(args[0]) : db.query(...args);
  };
  const pool = { query, async connect() {
    const previous = tail;
    let release;
    tail = new Promise(resolve => { release = resolve; });
    await previous;
    return { query, release };
  } };
  const store = createReminderExecutionStore(pool);
  await beforeSchema?.({ db, userId, agentId });
  await store.ensureSchema();
  await store.ensureSchema(); // Repeated application boot is idempotent.
  const parent = async id => (await db.query('SELECT * FROM mtr_harness.reminders WHERE id=$1', [id])).rows[0];
  const create = async (extra = {}) => {
    const made = await store.create({ userId, agentId, message: randomUUID(), channel: 'whatsapp',
      runAt: new Date(Date.now() - 30_000).toISOString(), ...extra });
    return { ...await parent(made.id), duplicate: made.duplicate, occurrence_id: made.occurrence_id };
  };
  return { db, store, userId, agentId, otherId, threadId, create, parent,
    failNext: regex => { failOnce = regex; },
    expired: id => db.query("UPDATE mtr_harness.reminder_occurrences SET lease_until=now()-interval '1 minute' WHERE id=$1", [id]) };
}
