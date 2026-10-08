// Locks on a person's account and a company's (Postgres advisory lock, per
// transaction). Whoever changes WHICH account pays for someone's usage (joining, creating and
// leaving a company, in empresa.mjs) and whoever records usage (conta-pagadora.mjs)
// take the same locks, ALWAYS in this order: person, then company. Never
// hold the connection during an HTTP call.
const LOCK_SQL='SELECT pg_advisory_xact_lock(hashtextextended($1, 0))';
export const creditUserLockKey=userId=>'execution-credit:'+userId;
export const creditOrgLockKey=orgId=>'execution-credit:org:'+orgId;
export const lockCreditUser=(client,userId)=>client.query(LOCK_SQL,[creditUserLockKey(userId)]);
export const lockCreditOrg=(client,orgId)=>client.query(LOCK_SQL,[creditOrgLockKey(orgId)]);
// run(client) dentro de BEGIN/COMMIT; ROLLBACK em erro.
export async function emTransacao(pool,run){
 const client=await pool.connect();
 try{
  await client.query('BEGIN');
  const result=await run(client);await client.query('COMMIT');return result;
 }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}
 finally{client.release();}
}
