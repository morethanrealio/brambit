import { PGlite } from '@electric-sql/pglite';
import { randomUUID, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { createConfirmationStore } from '../web/confirmation-store.mjs';

export async function confirmationFixture({dataDir,scope:existingScope} = {}) {
  const db = new PGlite(dataDir);
  await db.exec(`CREATE SCHEMA IF NOT EXISTS mtr_harness;
    CREATE TABLE IF NOT EXISTS mtr_harness.users(id uuid PRIMARY KEY,deleted_at timestamptz);
    CREATE TABLE IF NOT EXISTS mtr_harness.agents(id uuid PRIMARY KEY,user_id uuid,archived_at timestamptz);
    CREATE TABLE IF NOT EXISTS mtr_harness.threads(id uuid PRIMARY KEY,user_id uuid,agent_id uuid,deleted_at timestamptz,webhook_skill text);`);
  const scope = existingScope || { userId:randomUUID(), agentId:randomUUID(), threadId:randomUUID() };
  await db.query('INSERT INTO mtr_harness.users(id) VALUES ($1) ON CONFLICT DO NOTHING', [scope.userId]);
  await db.query('INSERT INTO mtr_harness.agents(id,user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [scope.agentId,scope.userId]);
  await db.query('INSERT INTO mtr_harness.threads(id,user_id,agent_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [scope.threadId,scope.userId,scope.agentId]);
  const key = Buffer.alloc(32, 41); // synthetic test key, never environment data
  const seal = text => {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm',key,iv);
    const ct = Buffer.concat([c.update(text,'utf8'),c.final()]);
    return Buffer.concat([iv,c.getAuthTag(),ct]).toString('base64');
  };
  const open = text => {
    const data=Buffer.from(text,'base64'),c=createDecipheriv('aes-256-gcm',key,data.subarray(0,12));
    c.setAuthTag(data.subarray(12,28));return Buffer.concat([c.update(data.subarray(28)),c.final()]).toString('utf8');
  };
  let tail = Promise.resolve(), fail = null;
  const query = (...args) => {
    if (fail?.test(args[0])) { fail=null; throw Error('synthetic database failure'); }
    return args.length===1 && args[0].includes(';') ? db.exec(args[0]) : db.query(...args);
  };
  const pool = { query, async connect() {
    const old=tail;let release;tail=new Promise(resolve=>release=resolve);await old;return {query,release};
  } };
  const store = createConfirmationStore(pool,{seal,open});
  await store.ensureSchema();await store.ensureSchema();
  return { db,pool,store,scope,seal,open,failNext:regex=>{fail=regex;} };
}
