import { randomUUID } from 'node:crypto';
import { marca } from './marca.mjs';
// Only transport state crosses into persisted execution health, never a raw
// provider error or private message from the secondary notification.
function notificationOutcome(value) {
 if(!['email','telegram','whatsapp'].includes(value?.channel)||!['failed','uncertain'].includes(value?.status))return {};
 return {notification:{channel:value.channel,status:value.status}};
}
// Last-attempt health, not a claim of exactly-once external delivery. No DDL or
// opt-in: config exists on every routine. Token guards prevent stale completion.
export function createRoutineExecutionStore(pool,{leaseMs=180_000}={}) {
 const states=['completed','partial','no_output','failed','uncertain','interrupted'];
 const contentStates=new Set(['complete','partial','no_output','failed','unknown']);
 const deliveryStates=new Set(['accepted','saved','not_attempted','failed','uncertain','unknown']);
 const outcome=(status,value={})=>{
  const fallbackContent=status==='completed'?'complete':status==='partial'?'partial':status==='no_output'?'no_output':status==='failed'?'failed':'unknown';
  return {
   content:{status:contentStates.has(value?.content?.status)?value.content.status:fallbackContent},
   delivery:{
    status:deliveryStates.has(value?.delivery?.status)?value.delivery.status:(status==='no_output'?'not_attempted':'unknown'),
    ...(typeof value?.delivery?.channel==='string'&&value.delivery.channel?{channel:value.delivery.channel.slice(0,40)}:{}),
    ...(typeof value?.delivery?.id==='string'&&value.delivery.id?{id:value.delivery.id.slice(0,1000)}:{}),
    ...notificationOutcome(value?.delivery?.notification),
   },
  };
 };
 return {
  async claim(r,slot,token){
   const {rows}=await pool.query(`UPDATE mtr_harness.routines SET config=jsonb_set(COALESCE(config,'{}'),'{execution}',jsonb_build_object('token',$3::text,'slot',$4::text,'status','running','phase','preparing','startedAt',now(),'leaseUntil',now()+$5*interval '1 millisecond'))
    WHERE id=$1 AND user_id=$2 AND COALESCE(config->'execution'->>'status','')<>'running' AND COALESCE(config->'execution'->>'slot','')<>$4
    AND (left($4,4)<>'day:' OR (enabled AND last_run_day IS DISTINCT FROM substring($4 from 5)))
    AND (left($4,9)<>'interval:' OR (enabled AND next_run IS NOT DISTINCT FROM $6::timestamptz)) RETURNING id`,[r.id,r.user_id,token,slot,leaseMs,r.next_run||null]);
   return rows.length===1;
  },
  async phase(r,token,phase){
   const {rows}=await pool.query(`UPDATE mtr_harness.routines SET config=jsonb_set(config,'{execution}',(config->'execution')||jsonb_build_object('phase',$4::text,'leaseUntil',now()+$5*interval '1 millisecond'))
    WHERE id=$1 AND user_id=$2 AND config->'execution'->>'token'=$3 AND config->'execution'->>'status'='running' RETURNING id`,[r.id,r.user_id,token,phase,leaseMs]);
   return rows.length===1;
  },
  async finish(r,token,status,value={}){
   if(!states.includes(status))throw Error('Invalid execution status');
   const {rows}=await pool.query(`UPDATE mtr_harness.routines SET config=jsonb_set(config,'{execution}',(config->'execution')||$5::jsonb||jsonb_build_object('status',$4::text,'phase','finished','finishedAt',now()))
    WHERE id=$1 AND user_id=$2 AND config->'execution'->>'token'=$3 AND config->'execution'->>'status'='running' RETURNING id`,[r.id,r.user_id,token,status,JSON.stringify(outcome(status,value))]);
   return rows.length===1;
  },
  async recoverExpired(){
   // A dead worker is never re-enqueued: generation itself can have side effects.
   await pool.query(`UPDATE mtr_harness.routines SET config=jsonb_set(config,'{execution}',(config->'execution')||jsonb_build_object('status','interrupted','phase','finished','content',jsonb_build_object('status','unknown'),'delivery',jsonb_build_object('status',CASE WHEN config->'execution'->>'phase'='delivering' THEN 'uncertain' ELSE 'not_attempted' END),'finishedAt',now()))
    WHERE config->'execution'->>'status'='running' AND (config->'execution'->>'leaseUntil')::timestamptz<now()`);
  }
 };
}
export function createRoutineExecutor(store,{heartbeatMs=30_000,log=console}={}) {
 const active=new Set();let closing=false;
 async function execute(r,{slot,prepare=async()=>{},run,deliver}) {
  if(closing)throw Object.assign(Error('Servidor encerrando. A rotina não foi iniciada.'),{code:'ROUTINE_BUSY'});
  const job={r,token:randomUUID(),phase:'preparing',lost:false,contentStatus:'unknown',delivery:{status:'not_attempted'}};
  if(!await store.claim(r,slot,job.token))throw Object.assign(Error('Esta execução já foi iniciada ou está em andamento. Atualize o estado antes de tentar novamente.'),{code:'ROUTINE_BUSY'});
  active.add(job);let heartbeat;
  const step=async phase=>{if(job.lost||!await store.phase(r,job.token,phase))throw Error('Execution ownership lost');job.phase=phase;};
  let contentStatus='unknown',delivery={status:'not_attempted'};
  try {
   if(closing)throw Error('Shutdown before start');
   await prepare();await step('generating');
   heartbeat=setInterval(()=>{store.phase(r,job.token,job.phase).then(ok=>{if(!ok)job.lost=true;}).catch(()=>{job.lost=true;});},heartbeatMs);heartbeat.unref?.();
   const text=await run(r);const typed=text?.type==='flight-monitor-v1'||text?.type==='curation-v1';const body=typed?text.text:text;
   if(body!=null&&typeof body!=='string')throw Error('Invalid routine result');
   const declaredContent=['complete','partial','failed'].includes(text?.contentStatus)
    ? text.contentStatus
    : ({completed:'complete',partial:'partial',failed:'failed'})[text?.executionStatus];
   contentStatus=typeof body==='string'&&body.trim()
    ? (declaredContent||'complete')
    : 'no_output';
   job.contentStatus=contentStatus;
   let status='no_output';
   if(typeof body==='string'&&body.trim()){
    await step('delivering');delivery=await deliver(r,typed?text:body.trim());
    job.delivery=delivery||{status:'uncertain'};
    if(!['accepted','saved'].includes(delivery?.status)){
     throw Object.assign(Error('Delivery not confirmed'),{definitive:delivery?.status==='failed'});
    }
    status=contentStatus==='failed'?'failed':contentStatus==='partial'?'partial':'completed';
   }
   if(!await store.finish(r,job.token,status,{content:{status:contentStatus},delivery}))throw Error('Execution completion not recorded');
   return {text,delivery,status,contentStatus};
  } catch(e) {
   const sending=job.phase==='delivering';
   const status=sending&&e?.definitive!==true?'uncertain':'failed';
   // A provider receipt remains evidence even if persisting completion failed.
   // A deterministic refusal differs from a timeout after sending started.
   const deliveryStatus=['accepted','saved'].includes(delivery?.status)?delivery.status
    : sending?(e?.definitive===true?'failed':'uncertain'):'not_attempted';
   try {await store.finish(r,job.token,status,{content:{status:contentStatus==='no_output'?'unknown':contentStatus},delivery:{...delivery,status:deliveryStatus}});}catch(err){log.error('[routine-health] status persistence failed',err?.message);}
   throw e;
  } finally {clearInterval(heartbeat);active.delete(job);}
 }
 return {execute,recover:()=>store.recoverExpired(),get activeCount(){return active.size;},close(){closing=true;},
  async interrupt(){closing=true;await Promise.allSettled([...active].map(async job=>{
   job.lost=true;
   const delivery=['accepted','saved'].includes(job.delivery?.status)?job.delivery
    : {status:job.phase==='delivering'?'uncertain':'not_attempted'};
   await store.finish(job.r,job.token,'interrupted',{content:{status:job.contentStatus},delivery});
  }));}
 };
}

export function routineExecutionInfo(r) {
 const e=r.config?.execution;if(!e)return null;
 const expired=e.status==='running'&&e.leaseUntil&&Date.parse(e.leaseUntil)<Date.now();
 const status=expired?'interrupted':e.status;
 const legacyContent=status==='completed'?'complete':status==='partial'?'partial':status==='no_output'?'no_output':status==='failed'?'failed':'unknown';
 const legacyDelivery=status==='no_output'?'not_attempted':status==='uncertain'?'uncertain':'unknown';
 return {
  status,
  phase:expired?'finished':e.phase,
  content:{status:e.content?.status||legacyContent},
  delivery:{status:expired?(e.phase==='delivering'?'uncertain':'not_attempted'):(e.delivery?.status||legacyDelivery),...(e.delivery?.channel?{channel:e.delivery.channel}:{}),...notificationOutcome(e.delivery?.notification)},
  startedAt:e.startedAt,finishedAt:e.finishedAt,
 };
}

const CONTENT_LABEL={complete:'completo',partial:'parcial',no_output:'sem conteúdo',failed:'falhou',unknown:'não determinado'};
const DELIVERY_LABEL={
 accepted:'aceita pela plataforma; entrega e leitura finais não são confirmadas',
 saved:'salva no app',not_attempted:'não tentada',failed:'falhou',uncertain:'incerta',
 unknown:'não registrada separadamente nesta tentativa antiga',
};
export function routineExecutionText(r) {
 const e=routineExecutionInfo(r);if(!e)return '';
 if(e.status==='running')return `Execução em andamento (${e.phase||'fase não informada'}).`;
 const channel=e.delivery.channel?` no canal ${e.delivery.channel}`:'';
 const notice=e.delivery.notification;
 const limitation=notice?` Aviso adicional no canal ${notice.channel}: ${notice.status==='failed'?'falhou':'não confirmado'}.`:'';
 return `Conteúdo: ${CONTENT_LABEL[e.content.status]||CONTENT_LABEL.unknown}. Entrega${channel}: ${DELIVERY_LABEL[e.delivery.status]||DELIVERY_LABEL.unknown}.${limitation}`;
}

export function routineChannelText(r) {
 if(r?.channel==='email')return `Entrega automática por e-mail pela plataforma ${marca().nome}${r.email?` para ${r.email}`:''}; não usa o Gmail do usuário, não depende da permissão de envio do Gmail e não cria rascunho`;
 if(r?.channel==='telegram')return `Entrega automática pela plataforma ${marca().nome} no Telegram`;
 if(r?.channel==='whatsapp')return `Entrega automática pela plataforma ${marca().nome} no WhatsApp`;
 return 'Resultado salvo somente no app, sem envio externo';
}
