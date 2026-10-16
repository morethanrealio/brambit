import {createHash,randomUUID} from 'node:crypto';

export const WA_INBOX_SCHEMA=`
CREATE TABLE IF NOT EXISTS mtr_harness.whatsapp_inbox (
 id bigserial PRIMARY KEY, phone_id text NOT NULL, wamid text NOT NULL,
 sender_key text NOT NULL, message_enc text, prepared_enc text,
 user_id uuid REFERENCES mtr_harness.users(id) ON DELETE CASCADE,
 agent_id uuid REFERENCES mtr_harness.agents(id) ON DELETE SET NULL,
 state text NOT NULL DEFAULT 'received' CHECK(state IN ('received','preparing','buffered','running','completed','uncertain','ignored')),
 worker_id uuid, reason text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(phone_id,wamid));
CREATE INDEX IF NOT EXISTS whatsapp_inbox_pending_idx ON mtr_harness.whatsapp_inbox(state,id);
`;
const interrupted=()=>Object.assign(Error('WhatsApp inbox ownership or state changed'),{code:'WA_INBOX_CONFLICT'});
export function createWaInbox(pool,{seal,open,lookupRecipient}){
 let owner=null,lease=null,lostListener=null,releaseLease=null;
 const encode=value=>seal(JSON.stringify(value));
 const decode=value=>JSON.parse(open(value));
 const requireOwner=()=>{if(!owner||!lease)throw interrupted();return owner;};
 async function tx(fn){const c=await pool.connect();try{await c.query('BEGIN');const result=await fn(c);await c.query('COMMIT');return result;}catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}}
 async function transition(ids,from,to,{reason='',prepared=null,userId=null,agentId=null}={}){
  if(!ids.length)return;const worker=requireOwner();
  return tx(async c=>{
   const rows=(await c.query(`UPDATE mtr_harness.whatsapp_inbox SET state=$3,reason=$4,updated_at=now(),
    prepared_enc=COALESCE($5,prepared_enc),user_id=COALESCE($6::uuid,user_id),agent_id=COALESCE($7::uuid,agent_id)
    WHERE id=ANY($1::bigint[]) AND worker_id=$2 AND state=ANY($8::text[]) RETURNING id`,[ids,worker,to,reason,prepared,userId,agentId,from])).rows;
   if(rows.length!==new Set(ids.map(String)).size)throw interrupted();
  });
 }
 return {
  init:()=>pool.query(WA_INBOX_SCHEMA),
  async acquire(){
   if(lease)return;
   const c=await pool.connect();let freed=false;const free=discard=>{if(!freed){freed=true;c.release(discard);}};
   try{
    const locked=(await c.query("SELECT pg_try_advisory_lock(728194,212026) AS locked")).rows[0].locked;
    if(!locked)throw Error('WA_INBOX_WORKER_ALREADY_ACTIVE');
    lease=c;releaseLease=free;owner=randomUUID();lostListener=()=>{if(lease===c){owner=null;lease=null;free(true);}};c.once?.('error',lostListener);
    // Only the owner of the session lock may recover a departed process.
    await c.query('BEGIN');
    await c.query("UPDATE mtr_harness.whatsapp_inbox SET state='uncertain',reason='process_interrupted',updated_at=now() WHERE state IN ('preparing','running')");
    await c.query("UPDATE mtr_harness.whatsapp_inbox SET worker_id=$1 WHERE state='buffered'",[owner]);
    await c.query('COMMIT');
   }catch(e){if(lostListener)c.off?.('error',lostListener);await c.query('ROLLBACK').catch(()=>{});await c.query('SELECT pg_advisory_unlock(728194,212026)').catch(()=>{});free(true);owner=null;lease=null;throw e;}
  },
  async release(){const c=lease;owner=null;lease=null;if(c){c.off?.('error',lostListener);try{await c.query('SELECT pg_advisory_unlock(728194,212026)');}finally{releaseLease?.();}}},
  isOwner:()=>!!owner&&!!lease,
  async accept(payload,phoneId){
   if(!phoneId)throw Error('WA_INBOX_NUMBER_UNAVAILABLE');
   const entries=[],recipients=new Map();
   for(const entry of payload.entry||[])for(const change of entry.changes||[]){
    const value=change.value||{};
    // Never admit inbound belonging to another business number.
    if(value.messages?.length&&!value.metadata?.phone_number_id)throw Object.assign(Error('Inbound destination is required'),{status:400});
    if(value.metadata?.phone_number_id!==phoneId)continue;
    for(const msg of value.messages||[]){
     if(typeof msg.id!=='string'||!msg.id||msg.id.length>500||typeof msg.from!=='string'||!/^\d{5,20}$/.test(msg.from))throw Object.assign(Error('Invalid inbound message'),{status:400});
     const message={id:msg.id,from:msg.from,type:msg.type,timestamp:msg.timestamp,
      ...Object.fromEntries(['text','context','reaction','interactive','audio','voice','image','document'].filter(k=>msg[k]!==undefined).map(k=>[k,msg[k]]))};
     if(!recipients.has(message.from)){const link=await lookupRecipient(message.from);recipients.set(message.from,link?.enabled?link.user_id:null);}
     entries.push({message,encoded:encode(message),userId:recipients.get(message.from)});
    }
   }
   return tx(async c=>{
    let inserted=0;
    for(const {message,encoded,userId} of entries){
     const result=await c.query(`INSERT INTO mtr_harness.whatsapp_inbox(phone_id,wamid,sender_key,message_enc,user_id)
      SELECT $1,$2,$3,$4,$5 WHERE NOT EXISTS (SELECT 1 FROM mtr_harness.whatsapp_seen WHERE wamid=$2)
      ON CONFLICT(phone_id,wamid) DO NOTHING`,[phoneId,message.id,createHash('sha256').update(message.from).digest('hex'),encoded,userId]);inserted+=result.rowCount;
     if(result.rowCount)await c.query('INSERT INTO mtr_harness.whatsapp_seen(wamid) VALUES($1) ON CONFLICT DO NOTHING',[message.id]);
    }
    return {received:entries.length,inserted};
   });
  },
  async claim(phoneId=null){const worker=requireOwner();return tx(async c=>{
   const row=(await c.query(`UPDATE mtr_harness.whatsapp_inbox SET state='preparing',worker_id=$1,updated_at=now()
    WHERE id=(SELECT id FROM mtr_harness.whatsapp_inbox WHERE state='received' AND ($2::text IS NULL OR phone_id=$2) ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`,[worker,phoneId])).rows[0];
   if(!row)return null;
   try{return {id:String(row.id),message:decode(row.message_enc),recipient:row.user_id};}catch{await c.query("UPDATE mtr_harness.whatsapp_inbox SET state='uncertain',reason='payload_unreadable',updated_at=now() WHERE id=$1",[row.id]);return {id:String(row.id),unreadable:true};}
  });},
  async buffered(phoneId=null,loadedIds=[]){
   const worker=requireOwner(),out=[];
   for(const row of (await pool.query("SELECT id,prepared_enc FROM mtr_harness.whatsapp_inbox WHERE state='buffered' AND worker_id=$1 AND ($2::text IS NULL OR phone_id=$2) AND NOT(id=ANY($3::bigint[])) ORDER BY id",[worker,phoneId,loadedIds])).rows){
    try{out.push({id:String(row.id),prepared:decode(row.prepared_enc)});}
    catch{await transition([String(row.id)],['buffered'],'uncertain',{reason:'payload_unreadable'});}
   }
   return out;
  },
  async prepare(id,prepared){await transition([id],['preparing'],'buffered',{prepared:encode(prepared),userId:prepared.userId,agentId:prepared.agentId});},
  begin:ids=>transition(ids,['buffered'],'running'),
  async assertRunning(ids){const worker=requireOwner();const n=(await pool.query("SELECT count(*)::int n FROM mtr_harness.whatsapp_inbox WHERE id=ANY($1::bigint[]) AND worker_id=$2 AND state='running'",[ids,worker])).rows[0].n;if(n!==new Set(ids.map(String)).size)throw interrupted();},
  async reconcile(loadedIds){await pool.query("UPDATE mtr_harness.whatsapp_inbox SET state='uncertain',reason='settlement_unavailable',updated_at=now() WHERE worker_id=$1 AND state IN ('preparing','running') AND NOT(id=ANY($2::bigint[]))",[requireOwner(),loadedIds]);},
  complete:ids=>transition(ids,['preparing','running'],'completed'),
  uncertain:(ids,reason='processing_failed')=>transition(ids,['preparing','running'],'uncertain',{reason}),
  ignore:(ids,reason)=>transition(ids,['preparing','buffered'],'ignored',{reason}),
  async report(){
   const rows=(await pool.query('SELECT state,count(*)::int total,min(created_at) oldest FROM mtr_harness.whatsapp_inbox GROUP BY state')).rows;
   const attention=(await pool.query("SELECT id,wamid,user_id,agent_id,reason,created_at,updated_at FROM mtr_harness.whatsapp_inbox WHERE state='uncertain' ORDER BY id DESC LIMIT 30")).rows;
   return {rows,attention,workerActive:!!owner&&!!lease};
  },
  async prune(){
   await pool.query("UPDATE mtr_harness.whatsapp_inbox SET message_enc=NULL,prepared_enc=NULL WHERE state IN ('completed','ignored') AND updated_at<now()-interval '7 days' AND message_enc IS NOT NULL");
   await pool.query("DELETE FROM mtr_harness.whatsapp_inbox WHERE state IN ('completed','ignored') AND updated_at<now()-interval '90 days'");
  },
 };
}
