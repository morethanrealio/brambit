import { isDeepStrictEqual } from 'node:util';
// Preserve append-only arrivals while a model worked on an older snapshot.
// A divergent history is not safe to overwrite or to replay actions against.
export function mergeThreadHistory(base, current, completed) {
  if (!Array.isArray(base) || !Array.isArray(current) || !Array.isArray(completed)) throw new Error('THREAD_HISTORY_INVALID');
  if (current.length < base.length || !base.every((m,i)=>isDeepStrictEqual(m,current[i]))) throw new Error('THREAD_HISTORY_CONFLICT: histórico mudou; não repetir ações automaticamente');
  if (current.slice(base.length).some(m => m?.role !== 'assistant')) throw new Error('THREAD_HISTORY_CONFLICT: outro turno alterou o histórico; não repetir ações automaticamente');
  return [...completed,...current.slice(base.length)];
}
export async function appendThreadMessage(pool, schema, {threadId,userId,text,clean,deliveryKey,attachments}) {
  const c=await pool.connect();
  try {
    await c.query('BEGIN');
    const {rows}=await c.query(`SELECT id,agent_id,history FROM ${schema}.threads WHERE id=$1 AND user_id=$2 FOR UPDATE`,[threadId,userId]);
    if(!rows.length){await c.query('ROLLBACK');return false;}
    const t=rows[0]; if(!Array.isArray(t.history))throw new Error('THREAD_HISTORY_INVALID');
    if(deliveryKey){
      if(typeof deliveryKey!=='string'||deliveryKey.length>200)throw Error('Invalid delivery key');
      const claim=await c.query(`INSERT INTO ${schema}.thread_delivery_receipts(thread_id,delivery_key) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING delivery_key`,[threadId,deliveryKey]);
      if(!claim.rows.length){await c.query('COMMIT');return true;}
    }
    const content=clean(String(text||''));
    await c.query(`UPDATE ${schema}.threads SET history=history || $2::jsonb,updated_at=now() WHERE id=$1`,[threadId,JSON.stringify([{role:'assistant',content}])]);
    // Anexo fica só na linha do assistente, igual ao turno normal de conversa.
    const att=Array.isArray(attachments)&&attachments.length?JSON.stringify(attachments):null;
    await c.query(`INSERT INTO ${schema}.messages(agent_id,thread_id,role,content,attachments) VALUES($1,$2,'assistant',$3,$4)`,[t.agent_id,threadId,content,att]);
    await c.query('COMMIT');return true;
  } catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}
}
