import {randomUUID} from 'node:crypto';
import { codingRecovery, codingConsumption, codingPauseReason } from './coding-recovery-policy.mjs';
import {productI18n} from './i18n.mjs';
import {LEGACY_TEXT_LANGUAGE} from './locale.mjs';
const ACTIVE=new Set(['queued','running']);
const REQUEUE=new Set(['execution_window','execution_quantum','workspace_busy']);
const MEASUREMENT_TRIES=6;
const copy=x=>JSON.parse(JSON.stringify(x));
export const codingJobScope=({userId,agentId,threadId})=>JSON.stringify(['coding-job',userId,agentId,threadId]);
function waiting(job){return Array.isArray(job?.queuedInputs)?job.queuedInputs.length:0;}
// Stages are stored as keys and shown in the account language; a stage saved as
// plain text by an older version is shown as it was.
const STAGES=new Set(['preparing','reading','editing','verifying','running','resuming']);
const stageText=(stage,language)=>stage&&STAGES.has(stage)?productI18n().t(`coding.stage.${stage}`,language):stage||null;
// Every text here reaches the person as is (chat, Telegram, WhatsApp), with no
// model turn to translate it. job.language is set by the worker before delivery.
export function codingJobReceipt(job,language=job?.language||LEGACY_TEXT_LANGUAGE){
  const {t}=productI18n();
  if(!job)return {ok:false,error:t('coding.job.none',language)};
  const queued=waiting(job);
  const recovery=job.state==='paused'?codingRecovery(job.result,language):null;
  const stage=stageText(job.stage,language);
  const next=queued?' '+t('coding.job.queued_next',language,{count:queued}):'';
  return {ok:true,programming_job:{id:job.id,state:job.state,kind:job.kind,stage,updatedAt:job.updatedAt,notification:job.notification?.state||null,background:ACTIVE.has(job.state),queued,
      resumeCount:job.resumeCount||0,recovery,consumption:codingConsumption(job.result)},
    text:job.state==='completed'?(job.result?.text||t('coding.job.completed',language))
      :job.state==='cancelled'?t('coding.job.cancelled',language)
      :job.state==='paused'?`${job.result?.text||t('coding.job.needs_attention',language)}\n\n${recovery.nextStep}${queued?' '+t('coding.job.waiting_after_pause',language,{count:queued}):''}`
      :stage?t('coding.job.in_progress',language,{stage})+next
      :t('coding.job.starting',language)+next};
}
function newJob(identity,input,requestId,at,queuedInputs=[]){
  return {...copy(input),...copy(identity),id:randomUUID(),requestId,state:'queued',stage:null,createdAt:at,updatedAt:at,nextRunAt:at,lastStartedAt:null,runCount:0,delivered:false,queuedInputs};
}
// SQL approval recovery looks back seven days. Preserve accepted continuation
// identities across job rotation for twice that window, atomically with the job.
// An acknowledgement failure cannot enqueue an old approval after another job.
function confirmedSubmissions(job,at){
  const entries=[...(job?.confirmedSubmissions||[])];
  if(job?.requestId?.startsWith('confirmation:'))entries.push({id:job.requestId,at:job.createdAt});
  for(const next of job?.queuedInputs||[])if(next.requestId?.startsWith('confirmation:'))entries.push({id:next.requestId,at:next.enqueuedAt});
  return [...new Map(entries.filter(x=>Number(x.at)>at-14*86400_000).map(x=>[x.id,x])).values()];
}
export function createCodingJobs({store,execute,deliver,notify,cancelTask=async()=>{},taskState,creditStatus,onSnapshot,languageOf=async()=>LEGACY_TEXT_LANGUAGE,now=()=>Date.now(),concurrency=2,onError=()=>{}}){
  const active=new Set(),activeUsers=new Set();let timer=null,scanning=false,closing=false;const drainWaiters=[];
  // Account language of the texts below; a failed lookup never blocks the job.
  const languageFor=async userId=>{try{return await languageOf(userId)||LEGACY_TEXT_LANGUAGE;}catch(e){onError(e);return LEGACY_TEXT_LANGUAGE;}};
  const {t}=productI18n();
  // A failed measurement waits longer after each try and is dropped after a few: it must never
  // take a worker slot every 2 s for good (a job saved without createdAt once did).
  async function flushMeasurement(record,save){
    if(!onSnapshot||!record?.measurementPending)return;
    try{await onSnapshot(copy(record));}catch(e){
      const failures=(record.measurementFailures||0)+1;
      if(failures>=MEASUREMENT_TRIES){record.measurementPending=false;delete record.measurementFailures;delete record.measurementRetryAt;}
      else{record.measurementFailures=failures;record.measurementRetryAt=now()+2000*2**failures;}
      await save(record);throw e;
    }
    record.measurementPending=false;delete record.measurementFailures;delete record.measurementRetryAt;await save(record);
  }
  // gerenciar_tarefa_de_app settles the app task a pause waits on, not the job. The job
  // follows it here: a cancelled task closes the job and lets the requests queued behind it
  // run; an uncertain action the person resolved turns the pause into a resumable one.
  async function settlePause(job){
    if(job?.state!=='paused'||!taskState)return false;
    let state;try{state=await taskState(copy(job));}catch(e){onError(e);return false;}
    if(state==='cancelled'){
      job.state='cancelled';job.cancellationApplied=true;
      job.result={...job.result,ok:false,text:t('coding.job.cancelled',await languageFor(job.userId))};
    }else if(state==='resumable'&&codingPauseReason(job.result)==='uncertain_action'){
      const result=copy(job.result);delete result.text;
      if(result.coding_task?.reason)result.coding_task.reason='pending_resolved';
      else result.app_build={...result.app_build,motivo:'pending_resolved'};
      job.result=result;
    }else return false;
    job.updatedAt=now();return true;
  }
  async function withJob(scope,run){return store.withTask(scope,async({record,save})=>{
    const measuredSave=async next=>{
      if(onSnapshot){next.measurementVersion=(next.measurementVersion||0)+1;next.measurementPending=true;delete next.measurementFailures;delete next.measurementRetryAt;}
      await save(next);
      try{await flushMeasurement(next,save)}catch(e){onError(e)}
    };
    try{await flushMeasurement(record,save)}catch(e){onError(e)}
    return run({record,save:measuredSave,archive:()=>flushMeasurement(record,save)});
  })}
  async function drive(scope){
    if(active.has(scope)||active.size>=concurrency)return;
    const snapshot=await store.read(scope);if(!snapshot)return;
    // Recheck after the async snapshot: tick may have launched several drives
    // in the same microtask, but the global cap still cannot be exceeded.
    if(active.has(scope)||active.size>=concurrency||ACTIVE.has(snapshot.state)&&activeUsers.has(snapshot.userId))return;
    active.add(scope);let ownsUserSlot=ACTIVE.has(snapshot.state);
    if(ownsUserSlot)activeUsers.add(snapshot.userId);
    try{await withJob(scope,async({record:job,save,archive})=>{
      if(!job)return;
      const language=await languageFor(job.userId);
      if(job.state==='paused'&&(await store.read('control:'+job.id))?.cancel){
        job.state='cancelled';job.queuedInputs=[];job.result={...job.result,ok:false,text:t('coding.job.interrupted',language)};job.updatedAt=now();await save(job);
      }
      if(ACTIVE.has(job.state)){
        // A queued/resumed job may replace the terminal snapshot while we wait
        // for its lock. Claim the user slot before executing that new state.
        if(!ownsUserSlot){if(activeUsers.has(job.userId))return;activeUsers.add(job.userId);ownsUserSlot=true;}
        const command=await store.read('control:'+job.id);
        if(command?.cancel){job.state='cancelled';job.queuedInputs=[];job.result={...job.result,ok:false,text:t('coding.job.interrupted',language)};}
        else{
          job.state='running';job.lastStartedAt=now();job.runCount=(job.runCount||0)+1;job.updatedAt=now();await save(job);
          let result;
          try{result=await execute(copy(job),{
            shouldStop:async()=>closing||!!(await store.read('control:'+job.id))?.cancel,
            progress:async stage=>{job.stage=String(stage).slice(0,120);job.updatedAt=now();await save(job);},
          });}catch(e){onError(e);result={ok:false,coding_task:{state:'paused',reason:'execution_error'},text:t('coding.job.execution_error',language)};}
          const cancelled=!!(await store.read('control:'+job.id))?.cancel;
          const reason=result?.coding_task?.reason||result?.app_build?.motivo;
          job.result=cancelled?{...copy(result||{}),ok:false,text:t('coding.job.cancelled',language)}:copy(result||{});
          if(cancelled){job.state='cancelled';job.queuedInputs=[];}
          else if(REQUEUE.has(reason)||closing&&reason==='new_user_input'){job.state='queued';job.nextRunAt=now()+2000;}
          else job.state=result?.coding_task?.state==='completed'||result?.app_build?.motivo==='completed'?'completed':'paused';
        }
        job.updatedAt=now();await save(job);
      }
      if(job.state==='cancelled'&&!job.cancellationApplied){await cancelTask(copy(job));job.cancellationApplied=true;await save(job);}
      if(!ACTIVE.has(job.state)&&!job.delivered){
        // The delivery adapter MUST deduplicate by job ID + resume generation in the same transaction
        // as the history append. Retrying an unknown HTTP send is not allowed.
        job.language=language;
        await deliver(copy(job));
        if(notify&&['telegram','whatsapp'].includes(job.channel)){
          if(job.notification?.state==='dispatching')job.notification={state:'unknown',at:now()};
          else if(!job.notification){
            job.notification={state:'dispatching',at:now()};await save(job);
            try{job.notification={...(await notify(copy(job))),at:now()};}catch(e){onError(e);job.notification={state:'unknown',at:now()};}
          }
        }
        job.delivered=true;await save(job);
      }
      // Follow-ups rotate only after the previous result is committed to history. A stop
      // clears the queue; a cancelled job that kept it was settled by settlePause.
      if(['completed','cancelled'].includes(job.state)&&job.delivered&&waiting(job)){
        await archive();
        const [follow,...rest]=job.queuedInputs;
        const submissions=confirmedSubmissions(job,now());
        job=newJob({userId:job.userId,agentId:job.agentId,threadId:job.threadId},follow.input,follow.requestId,follow.enqueuedAt||now(),rest);
        job.confirmedSubmissions=submissions;
        await save(job);
      }
    });}catch(e){onError(e);}finally{
      active.delete(scope);if(ownsUserSlot)activeUsers.delete(snapshot.userId);
      if(!active.size)for(const resolve of drainWaiters.splice(0))resolve();
    }
  }
  async function tick(){
    if(scanning||closing)return;scanning=true;
    try{
      const at=now();
      const entries=await store.entries();
      const cancellations=new Set(entries.filter(x=>x.scope.startsWith('control:')&&x.record?.cancel).map(x=>x.scope.slice(8)));
      const candidates=entries.filter(({scope,record})=>scope.startsWith('["coding-job",')&&record&&((ACTIVE.has(record.state)&&Number(record.nextRunAt||0)<=at)||record.measurementPending&&Number(record.measurementRetryAt||0)<=at||!record.delivered||['completed','cancelled'].includes(record.state)&&waiting(record)>0||record.state==='paused'&&cancellations.has(record.id)||record.state==='cancelled'&&!record.cancellationApplied));
      candidates.sort((a,b)=>{
        const ad=!a.record.delivered&&!ACTIVE.has(a.record.state),bd=!b.record.delivered&&!ACTIVE.has(b.record.state);if(ad!==bd)return ad?-1:1;
        return Number(a.record.lastStartedAt||0)-Number(b.record.lastStartedAt||0)||Number(a.record.createdAt||a.record.updatedAt||0)-Number(b.record.createdAt||b.record.updatedAt||0);
      });
      for(const {scope,record} of candidates){
        if(active.size>=concurrency)break;
        if(ACTIVE.has(record.state)&&activeUsers.has(record.userId))continue;
        void drive(scope);
      }
    }catch(e){onError(e);}finally{scanning=false;}
  }
  return {
    async submit(identity,input,requestId){
      const scope=codingJobScope(identity);
      if(!requestId||!identity.userId||!identity.agentId||!identity.threadId||!['basic','advanced'].includes(input.kind))throw Error('Invalid coding submission');
      let acceptedFollow=false,alreadySubmitted=false;
      const job=await withJob(scope,async({record,save,archive})=>{
        if(record?.requestId===requestId)return record;
        if(record?.queuedInputs?.some(x=>x.requestId===requestId))return record;
        if(await settlePause(record))await save(record);
        if(record?.state==='cancelled'&&!record.cancellationApplied)throw Error('O cancelamento anterior ainda está sendo salvo. Aguarde antes de iniciar outra tarefa.');
        const submissions=confirmedSubmissions(record,now());
        if(submissions.some(x=>x.id===requestId)){alreadySubmitted=true;return record;}
        const approvedContinuation=record?.state==='paused'&&!!input.confirmationId;
        if(record&&!approvedContinuation&&(ACTIVE.has(record.state)||record.state==='paused'||waiting(record)>0)){
          const queued=[...(record.queuedInputs||[])];
          if(queued.length>=5)return record;
          queued.push({requestId,input:copy(input),enqueuedAt:now()});record.queuedInputs=queued;record.updatedAt=now();record.confirmedSubmissions=confirmedSubmissions({...record,confirmedSubmissions:submissions},now());acceptedFollow=true;await save(record);return record;
        }
        if(record&&!record.delivered)throw Error('Resultado anterior ainda não foi salvo na conversa.');
        await archive();
        const next=newJob(identity,input,requestId,now(),approvedContinuation?record.queuedInputs||[]:[]);next.confirmedSubmissions=confirmedSubmissions({...next,confirmedSubmissions:submissions},now());await save(next);return next;
      });
      const language=await languageFor(identity.userId);
      if(alreadySubmitted)return {...codingJobReceipt(job,language),ok:true,already_submitted:true,text:t('coding.job.already_submitted',language)};
      if(job.requestId!==requestId&&!job.queuedInputs?.some(x=>x.requestId===requestId))return {...codingJobReceipt(job,language),ok:false,text:t('coding.job.queue_full',language)};
      if(job.requestId!==requestId)return {...codingJobReceipt(job,language),ok:true,queued_request:true,text:job.state==='paused'
        ? t('coding.job.queued_behind_pause',language,{next_step:codingRecovery(job.result,language).nextStep})
        :t(acceptedFollow?'coding.job.queued_follow':'coding.job.already_queued',language)};
      return codingJobReceipt(job,language);
    },
    async status(identity){
      const language=await languageFor(identity.userId);
      const receipt=codingJobReceipt(await store.read(codingJobScope(identity)),language);
      if(receipt.programming_job&&creditStatus){
        try{
          const value=await creditStatus(identity.userId);
          // null = account with no credit balance (core with no cap): there's nothing to show.
          if(value===null){receipt.accountCredits=null;return receipt;}
          if(!value||!['remaining','held','available'].every(k=>Number.isFinite(value[k])&&value[k]>=0))throw Error('Credit snapshot unavailable');
          receipt.accountCredits={...value,at:now()};
          receipt.text+='\n\n'+t('coding.job.credit_balance',language,{available:value.available.toLocaleString(language),held:value.held.toLocaleString(language)});
        }catch{receipt.accountCredits=null;receipt.text+='\n\n'+t('coding.job.credit_unknown',language);}
      }
      return receipt;
    },
    async resume(identity,{policy,requestId=null}={}){
      const scope=codingJobScope(identity),snapshot=await store.read(scope);
      const language=await languageFor(identity.userId);
      if(!snapshot||snapshot.state!=='paused')return codingJobReceipt(snapshot,language);
      return withJob(scope,async({record,save,archive})=>{
        if(!record||record.id!==snapshot.id||record.state!=='paused')return codingJobReceipt(record,language);
        if(await settlePause(record)){await save(record);if(record.state!=='paused')return codingJobReceipt(record,language);}
        if(record.policy!==policy)return {ok:false,text:t('coding.job.policy_changed',language)};
        if((await store.read('control:'+record.id))?.cancel)return {ok:false,text:t('coding.job.cancel_already_requested',language)};
        if(requestId&&record.resumeRequests?.some(x=>x.id===requestId))return {...codingJobReceipt(record,language),replay:true};
        const recovery=codingRecovery(record.result,language);
        if(!recovery.canResume)return {...codingJobReceipt(record,language),ok:false};
        if(!record.delivered)return {ok:false,text:t('coding.job.pause_saving',language)};
        record.resumeCount=(record.resumeCount||0)+1;
        record.resumeRequests=[...(record.resumeRequests||[]).filter(x=>x.at>now()-14*86400_000),...(requestId?[{id:requestId,at:now()}]:[])];
        record.state='queued';record.stage='resuming';record.nextRunAt=now();record.updatedAt=now();
        record.delivered=false;record.notification=null;
        await save(record);
        return {...codingJobReceipt(record,language),text:t('coding.job.resumed',language)};
      });
    },
    // Called after gerenciar_tarefa_de_app changes this conversation's app task.
    async settle(identity){
      const scope=codingJobScope(identity);
      if((await store.read(scope))?.state!=='paused')return;
      await withJob(scope,async({record,save})=>{if(await settlePause(record))await save(record);});
    },
    async cancel(identity){
      const scope=codingJobScope(identity),job=await store.read(scope),language=await languageFor(identity.userId);if(!job)return codingJobReceipt(null,language);
      if(ACTIVE.has(job.state)||job.state==='paused'){
        await store.withTask('control:'+job.id,async({save})=>save({cancel:true,at:now()}));
      }
      if(job.state==='paused'){
        await withJob(scope,async({record,save,archive})=>{
          if(record?.id!==job.id||!['paused','queued'].includes(record.state))return;
          await cancelTask(copy(record));record.state='cancelled';record.cancellationApplied=true;record.queuedInputs=[];
          record.result={...record.result,ok:false,text:t('coding.job.interrupted',language)};record.updatedAt=now();await save(record);
        }).catch(error=>{if(error?.code!=='TASK_LOCK_BUSY')throw error;});
      }
      const latest=await store.read(scope);
      return {ok:true,text:(ACTIVE.has(job.state)||job.state==='paused'&&latest?.state!=='cancelled')
        ?t('coding.job.stopping',language)
        :codingJobReceipt(latest,language).text};
    },
    async metrics(){
      const jobs=(await store.entries()).filter(x=>x.scope.startsWith('["coding-job",')&&x.record).map(x=>x.record),at=now();
      const states={},reasons={},notifications={};let queuedFollowups=0,oldestQueuedAgeMs=0,calls=0,tokens=0,resumptions=0,followupsHeldByPause=0;
      for(const job of jobs){
        states[job.state]=(states[job.state]||0)+1;queuedFollowups+=waiting(job);
        resumptions+=job.resumeCount||0;if(job.state==='paused')followupsHeldByPause+=waiting(job);
        const reason=job.result?.coding_task?.reason||job.result?.app_build?.motivo;if(reason)reasons[reason]=(reasons[reason]||0)+1;
        const notification=job.notification?.state;if(notification)notifications[notification]=(notifications[notification]||0)+1;
        if(job.state==='queued')oldestQueuedAgeMs=Math.max(oldestQueuedAgeMs,at-Number(job.createdAt||job.updatedAt||at));
        calls+=Number(job.result?.coding_task?.calls||job.result?.app_build?.orcamento?.chamadas||0);
        tokens+=Number(job.result?.coding_task?.tokens||job.result?.app_build?.orcamento?.tokens_contabilizados||0);
      }
      return {states,reasons,notifications,queuedFollowups,followupsHeldByPause,resumptions,oldestQueuedAgeMs,activeWorkers:active.size,activeUsers:activeUsers.size,concurrency,calls,tokens};
    },
    tick,drive,
    start(){if(timer)return;closing=false;timer=setInterval(()=>void tick(),2000);timer.unref?.();void tick();},
    stop(){closing=true;if(timer)clearInterval(timer);timer=null;return active.size?new Promise(resolve=>drainWaiters.push(resolve)):Promise.resolve();},
  };
}

export function codingControlIntent(message){
  if(typeof message!=='string'||message.length>100)return null;
  const text=message.normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim().toLowerCase().replace(/[.!?]+$/,'').trim();
  if(/^(como (esta|ta|vai)( o (trabalho|projeto|andamento))?|qual (e )?o (status|andamento)|status|andamento)$/.test(text))return 'status';
  if(/^(pare|parar|pode parar|cancele|cancela)( (a tarefa|o trabalho|a programacao))?$/.test(text))return 'cancel';
  // Resume is matched in every product language because the pause notice names the
  // phrase (coding.resume_command) in the account language.
  if(/^(retomar|retome|retoma)( (a )?(programacao|tarefa|trabalho))?$/.test(text)
    || /^(continuar|continue) (a )?(programacao|tarefa|trabalho)$/.test(text)
    || /^resume (the )?(programming|coding|task|work)$/.test(text)
    || /^continue (the )?(programming|coding|task|work)$/.test(text)
    || /^(reanudar|reanuda|reanude)( (la |el )?(programacion|tarea|trabajo))?$/.test(text)
    || /^(continuar|continua|continue) (la |el )?(programacion|tarea|trabajo)$/.test(text))return 'resume';
  return null;
}

export function codingPolicySnapshot(agent){return JSON.stringify({category:agent?.category||'pessoal',mode:agent?.perm_mode||'padrao',projectId:agent?.active_project_id||null,model:agent?.model||null,tools:agent?.tool_config||{},allowlist:agent?.cmd_allowlist||[]});}
