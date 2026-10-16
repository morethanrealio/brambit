// Factory only: doesn't open a connection nor create a table on import.
import { createHash } from 'node:crypto';
import { curationArticleKey } from './curation-policy.mjs';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function scope(a){if(!UUID.test(a?.userId||'')||!UUID.test(a?.routineId||''))throw Error('Escopo de curadoria inválido.');}
export function createCurationStore(pool) {
  const table='mtr_harness.curation_deliveries';
  return {
    async appReceipt(r,e) {
      scope({userId:r.user_id,routineId:r.id});
      if(!UUID.test(e.appThreadId||''))throw Error('Conversa de entrega inválida.');
      const {rows}=await pool.query(`SELECT m.id FROM mtr_harness.messages m JOIN mtr_harness.threads t ON t.id=m.thread_id JOIN mtr_harness.routines r ON r.user_id=t.user_id AND r.agent_id=t.agent_id WHERE r.id=$1 AND r.user_id=$2 AND t.id=$3 AND m.role='assistant' AND m.content=$4 ORDER BY m.id DESC LIMIT 1`,[r.id,r.user_id,e.appThreadId,e.text]);
      if(!rows.length)throw Error('Curadoria não está salva na conversa do usuário.');
      return {ok:true,id:'app-message:'+rows[0].id};
    },
    async history(a) {
      scope(a);
      const owner=await pool.query('SELECT id FROM mtr_harness.routines WHERE id=$1 AND user_id=$2',[a.routineId,a.userId]);
      if(!owner.rows.length)throw Error('Rotina não pertence ao usuário.');
      const {rows}=await pool.query(`SELECT status,article_keys FROM ${table} WHERE user_id=$1 AND routine_id=$2 ORDER BY created_at DESC LIMIT 1001`,[a.userId,a.routineId]);
      // Without silently truncating the set of already-sent articles.
      if(rows.length>1000||rows.some(r=>r.status!=='confirmed'))throw Error('Histórico de entrega incompleto ou incerto; revisão necessária.');
      const delivered=rows.flatMap(r=>r.article_keys.map(url=>({userId:a.userId,routineId:a.routineId,url,confirmed:true})));
      if(delivered.length>10000)throw Error('Histórico excede o limite seguro.');
      return delivered;
    },
    async reserve(a) {
      scope(a);if(!UUID.test(a.editionId||'')||typeof a.text!=='string'||!a.text.trim()||!Array.isArray(a.urls)||!a.urls.length||a.urls.length>8)throw Error('Edição inválida.');
      const keys=a.urls.map(curationArticleKey);if(keys.some(k=>!k)||new Set(keys).size!==keys.length)throw Error('Artigos inválidos/repetidos.');
      const c=await pool.connect();
      try {
        await c.query('BEGIN');
        // Trava por rotina serializa reservas concorrentes sem alterar a rotina.
        const own=a.configSnapshot ? await c.query(`SELECT id FROM mtr_harness.routines WHERE id=$1 AND user_id=$2 AND (config-'execution')=($3::jsonb-'execution') FOR UPDATE`,[a.routineId,a.userId,JSON.stringify(a.configSnapshot)]) : await c.query('SELECT id FROM mtr_harness.routines WHERE id=$1 AND user_id=$2 FOR UPDATE',[a.routineId,a.userId]);
        if(!own.rows.length)throw Error('Rotina não pertence ao usuário.');
        const existing=await c.query(`SELECT id FROM ${table} WHERE user_id=$1 AND routine_id=$2 AND (status<>'confirmed' OR article_keys && $3::text[]) LIMIT 1`,[a.userId,a.routineId,keys]);
        if(existing.rows.length)throw Error('Entrega pendente/incerta ou artigo já enviado. Não reenviar.');
        await c.query(`INSERT INTO ${table}(id,user_id,routine_id,status,article_keys,body_sha256) VALUES($1,$2,$3,'reserved',$4,$5)`,[a.editionId,a.userId,a.routineId,keys,createHash('sha256').update(a.text).digest('hex')]);
        await c.query('COMMIT');
      } catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;} finally{c.release();}
    },
    async confirm(a,receipt) {
      scope(a);if(!UUID.test(a.editionId||'')||receipt?.ok!==true||typeof receipt.id!=='string'||!receipt.id.trim()||receipt.id.length>1000||receipt.skipped)throw Error('Entrega sem comprovante do provedor.');
      const r=await pool.query(`UPDATE ${table} SET status='confirmed',provider_id=$4,confirmed_at=now() WHERE id=$1 AND user_id=$2 AND routine_id=$3 AND status='reserved' RETURNING id`,[a.editionId,a.userId,a.routineId,receipt.id]);
      if(r.rows.length!==1)throw Error('Reserva não confirmada; não reenviar.');
    },
    async uncertain(a) {
      scope(a);if(!UUID.test(a.editionId||''))throw Error('Edição inválida.');
      await pool.query(`UPDATE ${table} SET status='uncertain' WHERE id=$1 AND user_id=$2 AND routine_id=$3 AND status='reserved'`,[a.editionId,a.userId,a.routineId]);
    },
  };
}
export async function deliverCurationEdition(edition,{store,send,persist=async()=>{}}) {
  if(edition?.type!=='curation-v1'||!['email','whatsapp','telegram','none','app'].includes(edition.channel))throw Error('Entrega de curadoria inválida.');
  // No articles: an honest failure/partial notice, doesn't become an item history.
  if(!edition.urls.length){const receipt=await send(edition.text);if(receipt?.ok!==true||receipt.skipped||!receipt.id)throw Error('Aviso não entregue.');await persist(edition.text);return;}
  await store.reserve(edition); // error before sending: no effect on the channel
  let receipt;
  try {
    receipt=await send(edition.text);
    if(receipt?.ok!==true||receipt.skipped||typeof receipt.id!=='string'||!receipt.id.trim())throw Error('Envio não confirmado.');
  } catch(e){await store.uncertain(edition).catch(()=>{});throw e;}
  // If SMTP accepted but writing failed, the reservation blocks the next run.
  // Never try to resend to "fix" the history.
  await store.confirm(edition,receipt);
  await persist(edition.text);
}
