import {ToolRegistry} from '../core-proto/core.mjs';
import {makeConstruirAppTool,makeCodarTool} from './coding-subagent.mjs';
import {makeAppTaskControlTool} from './app-task-runner.mjs';
import {createAppBuildJournal} from './app-build-state.mjs';
import {createCodingApprovals} from './coding-approvals.mjs';
import {codingPolicySnapshot} from './coding-jobs.mjs';
import {codingExecutionId} from './coding-recovery-policy.mjs';
// Server-bound adapter composition. Dependency injection lets the complete
// lifecycle run against isolated accounts/transports, never production fixtures.
export function createProgrammingRuntime(deps){
const {confirmationStore,getAgentOwned,getThreadOwned,getUserLocale,hasProviderExecution,withProviderExecution,gasto,DEEPSEEK_AGENT_MODEL,isDeepSeekTurn,withDeepSeek,makeOfficialDeepSeek,GEMINI_COMPARISON_ID,isGeminiComparison,withGeminiComparison,recordUsages,makeHeavyProvider,primaryIsGeminiOverride,makeGeminiPrimary,makePrimaryProvider,hostingTools,APP_SUB_TOOLS,appTaskStore,getProject,userHasSshKey,runnerOnline,runnerBoundAgentId,livreTools,sshTools,codingTools,validProviderToken}=deps;
async function runProgrammingJob(job,control){
  const {userId,agentId,threadId}=job;
  const agent=await getAgentOwned(agentId,userId),thread=await getThreadOwned(threadId,userId);
  if(!agent||!thread||thread.agent_id!==agentId||codingPolicySnapshot(agent)!==job.policy)return {ok:false,text:'O acesso à conversa ou ao assistente mudou; a tarefa não foi executada.'};
  const approvalValid=async()=>!job.confirmationId || !!(await confirmationStore?.isContinuationAllowed({userId,agentId,threadId},job.confirmationId));
  if(!await approvalValid())return {ok:false,text:'Esta continuação foi cancelada ou perdeu a autorização; não iniciei outra execução.'};
  const identity=JSON.stringify([userId,agentId,threadId]),language=(await getUserLocale(userId))?.language||'pt-BR';
  if(!hasProviderExecution(identity))return withProviderExecution((provider,input,options,policy={})=>{
    const bound=gasto.vincular({provider,userId,agentId,threadId,kind:'coding',language,...policy});
    return options===null?bound.complete(input):bound.completeDurable(input,options);
  },()=>runProgrammingJob(job,control),identity);
  if(agent.model===DEEPSEEK_AGENT_MODEL&&!isDeepSeekTurn())return withDeepSeek(max=>makeOfficialDeepSeek(max,{userId,agentId,threadId,kind:'coding',language}),()=>runProgrammingJob(job,control));
  if(agent.model===GEMINI_COMPARISON_ID&&!isGeminiComparison())return withGeminiComparison(()=>runProgrammingJob(job,control));
  let stage='Preparando o ambiente';
  const onEvent=e=>{if(e?.type==='tool_call')stage=/^(ler|listar|buscar)/.test(e.name)?'Lendo o código':/^(editar|escrever|iniciar)/.test(e.name)?'Aplicando alterações':/^validar/.test(e.name)?'Verificando alterações':'Executando uma etapa no ambiente autorizado';};
  const shouldPause=async()=>{await control.progress(stage);return await control.shouldStop() || !await approvalValid();};
  const onUsage=async e=>recordUsages([e],{userId,agentId,threadId,turnId:job.id,kind:e.kind||'subagent'},{noBill:e.kind==='compact'&&e.noBill===true,eventId:e.executionCallId,strict:true});
  const makeProvider=()=>makeHeavyProvider(job.kind==='basic'?'app':'codar',{maxOut:32768});
  if(job.kind==='basic'){
    const buildAppContext=async()=>{const registry=new ToolRegistry();for(const t of hostingTools(userId,agentId))if(APP_SUB_TOOLS.has(t.name))registry.add({...t,run:async args=>{const current=await getAgentOwned(agentId,userId);if(!current||codingPolicySnapshot(current)!==job.policy||!await approvalValid())return {ok:false,error:'Permissões do assistente alteradas; operação não executada.'};return t.run(args);}});return {tools:registry,provider:makeProvider()};};
    const tool=makeConstruirAppTool({buildAppContext,executionId:codingExecutionId(job),sessionKey:`${userId}:${agentId}:${threadId}:app`,taskStore:appTaskStore,userRequest:job.userRequest,onUsage,onEvent,shouldPause});
    const result=await tool.run(job.args);
    const journal=createAppBuildJournal({language,userRequest:job.userRequest});journal.toolResult({name:'construir_app'},result);
    return {...(typeof result==='object'?result:{ok:false}),text:journal.finish(typeof result==='string'?result:'')};
  }
  const expected=job.environment;
  if(!expected)return {ok:false,text:'Faltou a identidade autorizada do ambiente; nenhuma operação executada.'};
  const authorize=async()=>{
    const a=await getAgentOwned(agentId,userId);
    if(!await approvalValid()||!a||codingPolicySnapshot(a)!==job.policy||(a.perm_mode||'padrao')!==expected.mode||(a.category||'pessoal')!==expected.category||(a.active_project_id||null)!==expected.projectId)return false;
    if(expected.projectId&&!await getProject(expected.projectId,userId))return false;
    if(expected.ssh&&!await userHasSshKey(userId))return false;
    if(expected.runner&&(!runnerOnline(userId)||(runnerBoundAgentId(userId)&&runnerBoundAgentId(userId)!==agentId)))return false;
    return a.category!=='grupo';
  };
  if(!await authorize())return {ok:false,text:'O ambiente ou suas permissões mudaram; não executei a tarefa.'};
  const project=expected.projectId?await getProject(expected.projectId,userId):null;
  const buildCodingContext=async()=>{
    const registry=new ToolRegistry();
    if(expected.livre){for(const t of livreTools(userId,threadId,expected.runner,expected.sshLivre))registry.add(t);}
    else {
      if(!project)for(const t of sshTools(userId))registry.add(t);
      for(const t of codingTools(userId,{project:project?{ownerUserId:userId,nome:project.nome}:null,getGithubToken:()=>validProviderToken(userId,'github')}))registry.add(t);
    }
    return {tools:registry,provider:makeProvider()};
  };
  return appTaskStore.withTask(JSON.stringify(['coding-workspace','advanced',userId,expected.projectId||'personal']),()=>
    makeCodarTool({buildCodingContext,executionId:codingExecutionId(job),sessionKey:`${userId}:${agentId}:${threadId}`,taskStore:appTaskStore,targetIdentity:JSON.stringify(expected),authorize,onUsage,onEvent,shouldPause}).run({objetivo:job.args.objetivo})
  ).catch(error=>{if(error?.code==='TASK_LOCK_BUSY')return {ok:false,coding_task:{state:'paused',reason:'workspace_busy'},text:'Aguardando outra execução liberar este ambiente.'};throw error;});
}
async function recoverCodingApprovals(jobs){
  for(const {scope,record} of await appTaskStore.entries()){
    if(!scope.startsWith('["coding-approval",')||record?.state!=='approved'||!record.context?.identity)continue;
    const {identity,policy}=record.context;
    const expectedScope=JSON.stringify(['coding-approval',JSON.stringify([identity.userId,identity.agentId,identity.threadId])]);
    if(scope!==expectedScope)continue;
    const agent=await getAgentOwned(identity.agentId,identity.userId);
    if(!agent||codingPolicySnapshot(agent)!==policy)continue;
    const approvals=createCodingApprovals({store:appTaskStore,scope:JSON.stringify([identity.userId,identity.agentId,identity.threadId])});
    const host=hostingTools(identity.userId,identity.agentId);
    const tool=makeAppTaskControlTool({store:appTaskStore,sessionKey:`${identity.userId}:${identity.agentId}:${identity.threadId}:app`,authorize:async(app,dono)=>host.find(t=>t.name==='listar_arquivos_do_app')?.run({nome_do_sistema:app,dono})});
    const result=await approvals.resolve(record.id,true,p=>tool.restoreConfirmation(p.args,p.binding).run());
    if(result?.ok&&result.continuation){
      const queued=await jobs.submit(identity,{kind:'basic',args:result.continuation,userRequest:result.continuation.objetivo,policy,channel:record.context.channel||'chat'},'approval:'+record.id);
      if(queued.ok===true&&queued.programming_job)await approvals.acknowledge(record.id);
    }
  }
}
async function cancelTask(job){
  const session=`${job.userId}:${job.agentId}:${job.threadId}`;
  const scope=job.kind==='basic'?JSON.stringify([session+':app',String(job.args?.app||'').trim(),job.args?.dono||''])
    :JSON.stringify(['advanced',session,JSON.stringify(job.environment)]);
  await appTaskStore.withTask(scope,async({record,save})=>{
    const owner=record?.executionOwner||record?.lastExecutionId;
    if(!record||typeof owner!=='string'||!(owner===job.id||owner.startsWith(job.id+':resume:')))return;
    record.status='cancelled';record.cancelledAt=Date.now();
    // Proven unused/read-only state can end here. Unknown dispatched calls and
    // mutations remain visible and block a fresh task from bypassing recovery.
    if(!record.pending?.mutating)record.pending=null;
    if(record.modelCall&&(record.modelCall.accounted||record.modelCall.state==='prepared'))record.modelCall=null;
    await save(record);
  });
}
return {execute:runProgrammingJob,recoverApprovals:recoverCodingApprovals,cancelTask};
}
