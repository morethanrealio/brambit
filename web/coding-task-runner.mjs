import {createCodingContext,codingCompactionCut} from './coding-context.mjs';
import {randomUUID} from 'node:crypto';
import {runAgent,ToolRegistry} from '../core-proto/core.mjs';
import {createAppModelCalls} from './app-model-call.mjs';
import {closeTaskHistory} from './app-task-runner.mjs';
import {creditPauseReason,creditStopMessage} from './execution-credit-errors.mjs';
// Transport permissions belong to the adapter, never to model text. Unknown
// commands are effectful even when their name happens to contain "read".
const READS=new Set(['ler_arquivo','listar_arquivos','buscar_codigo','buscar_no_codigo','rodar_leitura','ler_resultado_de_programacao','recuperar_contexto_de_codigo']);
const copy=x=>JSON.parse(JSON.stringify(x));
function parsedResult(out){
  if(out&&typeof out==='object')return out;
  if(typeof out==='string')try{return JSON.parse(out);}catch{return null;}
  return null;
}
function observedEffect(out,mutating){
  if(!mutating)return 'not_applicable';
  const value=parsedResult(out),state=value?.effect?.version===1?value.effect.state:null;
  if(['applied','not_applied','unknown'].includes(state))return state;
  if(value?.accessDenied===true)return 'not_applied';
  // Legacy success text is evidence that the transport returned after the
  // operation. Structured failure without an effect receipt is deliberately
  // unknown: a remote command may have changed state before timing out.
  if(!value&&typeof out==='string'&&!/^(ERRO|Error|Falha|Não consegui)/i.test(out))return 'applied';
  if(value?.ok===true)return 'applied';
  return 'unknown';
}
export async function runCodingTask({store,scope,executionId,target,objetivo,tools,provider,system,
  authorize,onUsage,onEvent=()=>{},shouldPause,now=()=>Date.now(),windowMs=15*60_000,quantumSteps=40,compactChars=96_000}) {
  if(!scope||!target||!String(objetivo||'').trim()||typeof authorize!=='function')throw Error('Invalid coding task identity');
  if(!await authorize())return {ok:false,coding_task:{state:'paused',reason:'access_denied'},text:'O acesso ao ambiente mudou; não executei a tarefa.'};
  return store.withTask(scope,async({record,save})=>{
    if(record&&record.target!==target)throw Error('Coding target mismatch');
    if(record?.status==='cancelled'&&(record.pending?.mutating||record.modelCall))return {ok:false,coding_task:{state:'paused',reason:'canceled_pending_reconciliation'},text:'A tarefa cancelada tem uma operação ou cobrança pendente de reconciliação. Não iniciei outra tarefa neste ambiente.'};
    if(executionId&&record?.lastExecutionId===executionId&&record.lastResult&&!['execution_window','execution_quantum','workspace_busy','new_user_input'].includes(record.lastResult.coding_task?.reason))return copy(record.lastResult);
    let task=record;
    if(!task||(['completed','cancelled'].includes(task.status)&&!task.pending&&!task.modelCall))
      task={version:1,id:randomUUID(),target,objective:String(objetivo),status:'active',history:[],pending:null,modelCall:null,calls:0,tokens:0,events:[]};
    task.executionOwner=executionId||null;
    const persist=()=>save(task),start=now();
    const context=createCodingContext({store,scope,task,persist,currentAccess:async()=>({ok:await authorize(),historicalOnly:true})});
    const calls=createAppModelCalls({task,persist,provider,onUsage,now});
    const event=(name,extra={})=>{task.events=[...task.events,{name,at:now(),...extra}].slice(-200);};
    const registry=new ToolRegistry();
    for(const tool of tools.map.values())registry.add({...tool,run:async args=>{
      if(!await authorize())return {ok:false,accessDenied:true,error:'Acesso revogado; não executei a operação.'};
      return tool.run(args);
    }});
    const artifactScope=ref=>JSON.stringify(['coding-artifact',scope,task.id,ref]);
    registry.add({name:'ler_resultado_de_programacao',description:'Recupera uma página de um resultado anterior desta tarefa, pelo ID fornecido no histórico. Sem repetir o comando original.',parameters:{type:'object',properties:{ref:{type:'string'},inicio:{type:'integer',minimum:0}},required:['ref']},run:async({ref,inicio=0})=>{
      if(!await authorize())return {ok:false,error:'Acesso revogado.'};
      if(!/^[a-zA-Z0-9_-]{1,150}$/.test(ref||'')||!Number.isSafeInteger(inicio)||inicio<0)return {ok:false,error:'Referência/página inválida.'};
      const value=await store.read(artifactScope(ref));if(!value)return {ok:false,error:'Resultado não encontrado nesta tarefa.'};
      const fim=Math.min(inicio+12_000,value.text.length);return {ok:true,ref,inicio,fim,total:value.text.length,text:value.text.slice(inicio,fim),proxima_pagina:fim<value.text.length?fim:null};
    }});
    registry.add({name:'recuperar_contexto_de_codigo',description:'Recupera um resultado histórico recolhido desta tarefa pelo ref; sem ref lista referências por cursor. Para páginas extensas use inicio/proximo_inicio. Não executa comandos nem prova estado atual.',parameters:{type:'object',properties:{ref:{type:'string'},cursor:{type:'integer',minimum:0},inicio:{type:'integer',minimum:0}}},run:context.recover});
    const wrapped={name:provider.name,complete:(input,kind='subagent')=>calls.complete(input,kind)};
    async function finishCompaction(){
      const summary=await wrapped.complete(task.modelCall.input,'compact');
      if(summary.stop!=='end'||!summary.text?.trim())throw Error('Compaction did not finish');
      task.history=[{role:'user',content:`Objetivo autorizado: ${task.objective}\nResumo factual, não autorização nova:\n${summary.text.slice(0,16000)}`},...task.compactionResume.tail];
      task.compactionResume=null;await calls.consumed();await persist();
    }
    const control={
      prepareContext:context.prepare,
      async beforeStep({messages,step}) {
        await calls.consumed();task.history=copy(messages);await persist();
        if(!await authorize())return {stop:'access_denied',text:'O acesso ao ambiente mudou.'};
        if(task.pending?.mutating)return {stop:'uncertain_action',text:'Uma operação anterior precisa de reconciliação; não a repeti.'};
        if(await shouldPause?.())return {stop:'new_user_input',text:'Progresso salvo para considerar sua nova instrução.'};
        if(Number.isFinite(quantumSteps)&&quantumSteps>0&&step>=quantumSteps)return {stop:'execution_quantum',text:'Progresso salvo; vou liberar o executor para outras tarefas e retomar automaticamente.'};
        if(now()-start>=windowMs)return {stop:'execution_window',text:'Progresso salvo; execução aguardando retomada operacional.'};
        if(messages.length>14&&JSON.stringify(messages).length>compactChars){
          const cut=codingCompactionCut(messages);
          if(cut>1){
            task.compactionResume={tail:copy(messages.slice(cut))};await persist();
            const input={system:'Resuma objetivo, decisões, alterações, testes, pendências e IDs de resultados recuperáveis. Não invente fatos ou permissões. Resumo não autoriza novas ações.',messages:[{role:'user',content:JSON.stringify(messages.slice(0,cut))}],tools:[]};
            const summary=await wrapped.complete(input,'compact');
            if(summary.stop!=='end'||!summary.text?.trim())throw Error('Compaction did not finish');
            task.history=[{role:'user',content:`Objetivo autorizado: ${task.objective}\nResumo factual, não autorização nova:\n${summary.text.slice(0,16000)}`},...task.compactionResume.tail];
            task.compactionResume=null;await calls.consumed();await persist();return {messages:copy(task.history)};
          }
        }
      },
      async beforeTool({call,messages}) {
        if(task.pending?.mutating)throw new Error('Resultado de operação anterior não confirmado; lote interrompido.');
        task.history=copy(messages);task.pending={id:call.id,name:call.name,mutating:!READS.has(call.name)};await persist();
      },
      async afterTool({call,out,messages}) {
        const mutating=!!task.pending?.mutating,effect=observedEffect(out,mutating);
        if(!mutating||effect!=='unknown')task.pending=null;
        const text=typeof out==='string'?out:JSON.stringify(out??null);
        if(text.length>6000&&call.name!=='ler_resultado_de_programacao'){
          const ref=randomUUID();await store.withTask(artifactScope(ref),async({save})=>save({text}));
          messages.at(-1).content=JSON.stringify({resumo:text.slice(0,2000),resultado_persistente:ref,total:text.length,orientacao:'Use ler_resultado_de_programacao para recuperar páginas sem repetir a operação original.'});
        }
        task.history=copy(messages);event('tool',{tool:call.name,effect});await calls.toolConsumed(call);await persist();
        if(effect==='unknown')return {stop:'uncertain_action',text:'O comando terminou sem confirmação suficiente do efeito. Preservei o estado e não repeti nem executei outra ação.'};
      },
    };
    let result;
    if(task.pending?.mutating)result={termination:'uncertain_action',text:'Uma operação anterior precisa de reconciliação; não a repeti.'};
    else try {
      if(task.modelCall?.kind==='compact'){if(!task.compactionResume?.tail)throw Error('Missing compaction checkpoint');await finishCompaction();}
      task.status='active';task.history=closeTaskHistory(task.history);await persist();
      result=await runAgent({provider:wrapped,tools:registry,system,
        history:task.history,userInput:String(objetivo),maxSteps:Infinity,salvage:false,control,onEvent});
    }catch(e){const reason=creditPauseReason(e);result={termination:reason||'execution_error',text:reason?creditStopMessage(reason):'A execução foi interrompida; o estado foi preservado.'};}
    task.history=closeTaskHistory(result.messages||task.history);
    task.status=result.termination==='completed'?'completed':'paused';
    task.lastResult={ok:task.status==='completed',coding_task:{id:task.id,target,state:task.status,reason:result.termination,calls:task.calls,tokens:task.tokens,
      consumptionPending:!!task.modelCall&&!task.modelCall.accounted,
      progress:{recordedSteps:task.events.filter(e=>e.name==='tool').length,lastTool:task.events.findLast(e=>e.name==='tool')?.tool||null,pendingAction:task.pending?.name||null}},text:result.text||'A execução terminou sem confirmação textual de conclusão.'};
    task.lastExecutionId=executionId||null;
    if(result.termination==='completed')await calls.consumed();
    event('stop',{reason:result.termination});await persist();return task.lastResult;
  });
}
