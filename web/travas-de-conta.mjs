// Travas da conta de uma pessoa e de uma empresa (advisory lock do Postgres, por
// transação). Quem mexe em QUAL conta paga o consumo de alguém (entrar, criar e
// sair de empresa, em empresa.mjs) e quem grava consumo (conta-pagadora.mjs)
// pegam as mesmas travas, nesta ordem SEMPRE: pessoa, depois empresa. Nunca
// segurar a conexão durante chamada HTTP.
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
