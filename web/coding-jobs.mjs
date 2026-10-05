import {randomUUID} from 'node:crypto';
import { codingRecovery, codingConsumption } from './coding-recovery-policy.mjs';
const ACTIVE=new Set(['queued','running']);
const REQUEUE=new Set(['execution_window','execution_quantum','workspace_busy']);
const copy=x=>JSON.parse(JSON.stringify(x));
export const codingJobScope=({userId,agentId,threadId})=>JSON.stringify(['coding-job',userId,agentId,threadId]);
function waiting(job){return Array.isArray(job?.queuedInputs)?job.queuedInputs.length:0;}
export function codingJobReceipt(job){
  if(!job)return {ok:false,error:'Nenhuma tarefa de programação registrada nesta conversa.'};
  const queued=waiting(job);
  const recovery=job.state==='paused'?codingRecovery(job.result):null;
  return {ok:true,programming_job:{id:job.id,state:job.state,kind:job.kind,stage:job.stage||null,updatedAt:job.updatedAt,notification:job.notification?.state||null,background:ACTIVE.has(job.state),queued,
      resumeCount:job.resumeCount||0,recovery,consumption:codingConsumption(job.result)},
    text:job.state==='completed'?(job.result?.text||'A execução terminou; consulte as verificações e pendências no resultado.')
      :job.state==='cancelled'?'A tarefa foi interrompida. Alterações já realizadas foram preservadas.'
      :job.state==='paused'?`${job.result?.text||'A tarefa precisa de atenção antes de continuar.'}\n\n${recovery.nextStep}${queued?` As ${queued} solicitações seguintes continuam aguardando.`:''}`
      :job.stage?`O trabalho está em andamento. Última etapa registrada: ${job.stage}.${queued?` Há ${queued} solicitação(ões) na sequência.`:''}`
      :`Vou começar agora e te aviso assim que concluir.${queued?` Há ${queued} solicitação(ões) na sequência.`:''}`};
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
export function createCodingJobs({store,execute,deliver,notify,cancelTask=async()=>{},creditStatus,onSnapshot,now=()=>Date.now(),concurrency=2,onError=()=>{}}){
  const active=new Set(),activeUsers=new Set();let timer=null,scanning=false,closing=false;const drainWaiters=[];
  async function flushMeasurement(record,save){
    if(!onSnapshot||!record?.measurementPending)return;
    await onSnapshot(copy(record));record.measurementPending=false;await save(record);
  }
  async function withJob(scope,run){return store.withTask(scope,async({record,save})=>{
    const measuredSave=async next=>{
      if(onSnapshot){next.measurementVersion=(next.measurementVersion||0)+1;next.measurementPending=true;}
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
      if(job.state==='paused'&&(await store.read('control:'+job.id))?.cancel){
        job.state='cancelled';job.queuedInputs=[];job.result={...job.result,ok:false,text:'Tarefa interrompida; alterações já feitas foram preservadas.'};job.updatedAt=now();await save(job);
      }
      if(ACTIVE.has(job.state)){
        // A queued/resumed job may replace the terminal snapshot while we wait
        // for its lock. Claim the user slot before executing that new state.
        if(!ownsUserSlot){if(activeUsers.has(job.userId))return;activeUsers.add(job.userId);ownsUserSlot=true;}
        const command=await store.read('control:'+job.id);
        if(command?.cancel){job.state='cancelled';job.queuedInputs=[];job.result={...job.result,ok:false,text:'Tarefa interrompida; alterações já feitas foram preservadas.'};}
        else{
          job.state='running';job.lastStartedAt=now();job.runCount=(job.runCount||0)+1;job.updatedAt=now();await save(job);
          let result;
          try{result=await execute(copy(job),{
            shouldStop:async()=>closing||!!(await store.read('control:'+job.id))?.cancel,
            progress:async stage=>{job.stage=String(stage).slice(0,120);job.updatedAt=now();await save(job);},
          });}catch(e){onError(e);result={ok:false,coding_task:{state:'paused',reason:'execution_error'},text:'A execução foi interrompida; o estado está salvo e nenhuma operação incerta será repetida automaticamente.'};}
          const cancelled=!!(await store.read('control:'+job.id))?.cancel;
          const reason=result?.coding_task?.reason||result?.app_build?.motivo;
          job.result=cancelled?{...copy(result||{}),ok:false,text:'A tarefa foi interrompida. Alterações já realizadas foram preservadas.'}:copy(result||{});
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
      // Follow-ups rotate only after the previous result is committed to history.
      if(job.state==='completed'&&job.delivered&&waiting(job)){
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
      const candidates=entries.filter(({scope,record})=>scope.startsWith('["coding-job",')&&record&&((ACTIVE.has(record.state)&&Number(record.nextRunAt||0)<=at)||record.measurementPending||!record.delivered||record.state==='completed'&&waiting(record)>0||record.state==='paused'&&cancellations.has(record.id)||record.state==='cancelled'&&!record.cancellationApplied));
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
      if(alreadySubmitted)return {...codingJobReceipt(job),ok:true,already_submitted:true,text:'Essa continuação já foi recebida. Não iniciei outra execução.'};
      if(job.requestId!==requestId&&!job.queuedInputs?.some(x=>x.requestId===requestId))return {...codingJobReceipt(job),ok:false,text:'A fila desta conversa já tem cinco solicitações. Aguarde uma concluir ou peça para parar.'};
      if(job.requestId!==requestId)return {...codingJobReceipt(job),ok:true,queued_request:true,text:job.state==='paused'
        ? `Registrei a solicitação na fila. A tarefa anterior está pausada: ${codingRecovery(job.result).nextStep}`
        :acceptedFollow?'Recebi a nova solicitação e a coloquei na sequência da tarefa atual. Não interrompi nem misturei os dois escopos.':'Essa solicitação já está na sequência da tarefa atual.'};
      return codingJobReceipt(job);
    },
    async status(identity){
      const receipt=codingJobReceipt(await store.read(codingJobScope(identity)));
      if(receipt.programming_job&&creditStatus){
        try{
          const value=await creditStatus(identity.userId);
          // null = conta sem saldo em créditos (núcleo sem teto): não há o que mostrar.
          if(value===null){receipt.accountCredits=null;return receipt;}
          if(!value||!['remaining','held','available'].every(k=>Number.isFinite(value[k])&&value[k]>=0))throw Error('Credit snapshot unavailable');
          receipt.accountCredits={...value,at:now()};
          receipt.text+=`\n\nSaldo livre da conta: ${value.available.toLocaleString('pt-BR')} créditos; reservados: ${value.held.toLocaleString('pt-BR')}. A reserva da próxima etapa será conferida antes da chamada.`;
        }catch{receipt.accountCredits=null;receipt.text+='\n\nNão consegui consultar o saldo agora; isso não indica saldo esgotado.';}
      }
      return receipt;
    },
    async resume(identity,{policy,requestId=null}={}){
      const scope=codingJobScope(identity),snapshot=await store.read(scope);
      if(!snapshot||snapshot.state!=='paused')return codingJobReceipt(snapshot);
      return withJob(scope,async({record,save,archive})=>{
        if(!record||record.id!==snapshot.id||record.state!=='paused')return codingJobReceipt(record);
        if(record.policy!==policy)return {ok:false,text:'As permissões ou o ambiente mudaram. Confira o escopo antes de retomar.'};
        if((await store.read('control:'+record.id))?.cancel)return {ok:false,text:'O cancelamento dessa tarefa já foi solicitado; não a retomei.'};
        if(requestId&&record.resumeRequests?.some(x=>x.id===requestId))return {...codingJobReceipt(record),replay:true};
        const recovery=codingRecovery(record.result);
        if(!recovery.canResume)return {...codingJobReceipt(record),ok:false};
        if(!record.delivered)return {ok:false,text:'O resultado da pausa ainda está sendo salvo na conversa. Aguarde antes de retomar.'};
        record.resumeCount=(record.resumeCount||0)+1;
        record.resumeRequests=[...(record.resumeRequests||[]).filter(x=>x.at>now()-14*86400_000),...(requestId?[{id:requestId,at:now()}]:[])];
        record.state='queued';record.stage='Retomando do progresso salvo';record.nextRunAt=now();record.updatedAt=now();
        record.delivered=false;record.notification=null;
        await save(record);
        return {...codingJobReceipt(record),text:'Retomada registrada para a mesma tarefa. Vou recuperar o progresso e os resultados já salvos; novas etapas continuam sujeitas ao saldo disponível.'};
      });
    },
    async cancel(identity){
      const scope=codingJobScope(identity),job=await store.read(scope);if(!job)return codingJobReceipt(null);
      if(ACTIVE.has(job.state)||job.state==='paused'){
        await store.withTask('control:'+job.id,async({save})=>save({cancel:true,at:now()}));
      }
      if(job.state==='paused'){
        await withJob(scope,async({record,save,archive})=>{
          if(record?.id!==job.id||!['paused','queued'].includes(record.state))return;
          await cancelTask(copy(record));record.state='cancelled';record.cancellationApplied=true;record.queuedInputs=[];
          record.result={...record.result,ok:false,text:'Tarefa interrompida; alterações já feitas foram preservadas.'};record.updatedAt=now();await save(record);
        }).catch(error=>{if(error?.code!=='TASK_LOCK_BUSY')throw error;});
      }
      const latest=await store.read(scope);
      return {ok:true,text:(ACTIVE.has(job.state)||job.state==='paused'&&latest?.state!=='cancelled')
        ?'Recebi o pedido para parar. Vou interromper na próxima fronteira segura, preservar as alterações e remover as solicitações da fila.'
        :codingJobReceipt(latest).text};
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
  if(/^(retomar|retome|retoma)( (a )?(programacao|tarefa|trabalho))?$/.test(text)
    || /^(continuar|continue) (a )?(programacao|tarefa|trabalho)$/.test(text))return 'resume';
  return null;
}

export function codingPolicySnapshot(agent){return JSON.stringify({category:agent?.category||'pessoal',mode:agent?.perm_mode||'padrao',projectId:agent?.active_project_id||null,model:agent?.model||null,tools:agent?.tool_config||{},allowlist:agent?.cmd_allowlist||[]});}
