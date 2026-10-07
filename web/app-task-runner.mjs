import {createCodingContext,visibleCodeCoverage,codingCompactionCut,DEFAULT_CODING_CONTEXT_CHARS} from './coding-context.mjs';
import {effectState} from './coding-effects.mjs';
import {reviewRequestNeedsClarification,editRequestNeedsClarification,scopeConflict,validScopeChange} from './app-task-scope.mjs';
import {createAppModelCalls} from './app-model-call.mjs';
import {creditPauseReason} from './execution-credit-errors.mjs';
import { APP_REPORT_PARAMETERS, validateAppReport, reportAudit, reportDiagnosticHelp } from './app-report-validation.mjs';
import { closeAppReport } from './app-report-closing.mjs';
import { createReadCoverage } from './app-read-coverage.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { runAgent, ToolRegistry } from '../core-proto/core.mjs';
import { executionSignature } from '../core-proto/turn-recovery.mjs';
import { createBuildState } from './app-build-state.mjs';
const EDITS=new Set(['escrever_arquivo_do_app','editar_arquivo_do_app','iniciar_estrutura_do_app','definir_segredo','listar_segredos','ver_logs_sistema','ver_diff','ver_historico','chamar_sistema']);
const INSPECTIONS=new Set(['listar_segredos','ver_logs_sistema','ver_diff','ver_historico']);
const READS=new Set(['listar_arquivos_do_app','ler_arquivo_do_app','buscar_codigo_do_app','validar_rascunho_do_app','recuperar_contexto_de_codigo']);
// Gravações de arquivo: quando uma delas é RECUSADA (nada gravado), reler o arquivo
// é o conserto pedido pela própria tool, não teimosia. Perdão limitado por época.
const FILE_WRITES=new Set(['editar_arquivo_do_app','escrever_arquivo_do_app']);
const PARDONS_AFTER_REJECT=3;
const digest=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const copy=x=>JSON.parse(JSON.stringify(x));
const estimate=x=>Math.ceil(JSON.stringify(x).length/3);
function reconcileKnownNoopPending(task) {
  const pending=task?.pending;
  if(!pending?.mutating||!pending.sig||!Array.isArray(task.history))return null;
  for(let i=task.history.length-1;i>=0;i--){
    const message=task.history[i];
    if(message?.role!=='assistant'||!Array.isArray(message.toolCalls))continue;
    for(const call of message.toolCalls){
      if(digest(executionSignature(call))!==pending.sig)continue;
      let result=null;
      for(let j=i+1;j<task.history.length&&task.history[j]?.role==='tool';j++)
        if(task.history[j].toolCallId===call.id){result=task.history[j];break;}
      if(!result)return null;
      let out;try{out=typeof result.content==='string'?JSON.parse(result.content):result.content;}catch{return null;}
      if(effectState(call,out)!=='not_applied')return null;
      task.pending=null;
      task.signatures=(task.signatures||[]).filter(x=>x!==pending.sig);
      return {name:call.name,signature:pending.sig};
    }
  }
  return null;
}
export const APP_CODING_COMPACT_TOKENS=48000;
const MS=15*60_000;
// Consumed calls/tokens and elapsed-time metrics survive continuation. The
// execution time window is operational and restarts only on an explicit invocation.
// Limits are admission bounds, not claims of exact provider pricing/token accounting.
export function closeTaskHistory(history) {
  const out=[];
  for(let i=0;i<history.length;i++) {
    const m=copy(history[i]);if(m.role==='tool')continue;out.push(m);
    if(m.role==='assistant'&&m.toolCalls?.length) {
      const results=new Map();let j=i+1;
      while(j<history.length&&history[j].role==='tool'){results.set(history[j].toolCallId,history[j]);j++;}
      for(const c of m.toolCalls)out.push(copy(results.get(c.id)||{role:'tool',toolCallId:c.id,name:c.name,content:'ERRO: não executada; execução anterior interrompida. Confira o checkpoint antes de continuar.'}));
      i=j-1;
    }
  }
  return out;
}
export async function runAppTask({store,scope,executionId,objetivo,mode='revisao',reviewFiles,userRequest='',tools,provider,system,onUsage,onEvent,shouldPause,now=()=>Date.now(),limits={}}) {
  if(!['revisao','edicao'].includes(mode))throw new Error('Modo de tarefa inválido.');
  // Only explicit caller-supplied bounds exist (test/authorized task policy).
  // Account admission is owned by the trusted production provider, not this
  // accumulated telemetry. No default 1M/120 and no budget reset on resume.
  const cap={calls:limits.calls??Infinity,tokens:limits.tokens??Infinity,ms:Math.min(limits.ms??MS,MS)};
  const access=tools.map.has('listar_arquivos_do_app')?await tools.run('listar_arquivos_do_app',{}):null;
  if(access?.ok!==true)return {ok:false,app_build:{version:2,modo:mode,estado:'interrompido',motivo:'access_denied',publicado:false,background:false},instrucao:'Não consegui confirmar acesso atual ao app; nenhum histórico foi carregado nem ação executada.'};
  const targetIdentity=access.alvo_validacao||scope;
  if(reviewFiles!==undefined&&(!Array.isArray(reviewFiles)||!reviewFiles.length||reviewFiles.length>50||reviewFiles.some(x=>typeof x!=='string'||!x||x.length>300||x.includes('..')||x.startsWith('/'))))throw Error('Escopo de revisão inválido.');
  const stopped=motivo=>({ok:false,app_build:{version:2,modo:mode,estado:'interrompido',motivo,publicado:false,background:false}});
  return store.withTask(JSON.stringify(['coding-workspace','app',targetIdentity]),()=>store.withTask(scope,async({record,save,id})=>{
    if(record&&record.targetIdentity!==targetIdentity)return stopped('target_changed');
    if(record?.status==='cancelled'&&(record.pending?.mutating||record.modelCall))return stopped('canceled_pending_reconciliation');
    if(executionId&&record?.lastExecutionId===executionId&&record.lastResult&&!['execution_window','execution_quantum','workspace_busy','new_user_input','uncertain_action'].includes(record.lastResult.app_build?.motivo))return copy(record.lastResult);
    // Completed tasks start a fresh request; paused tasks NEVER silently reset budgets.
    let task=record&&!['completed','cancelled'].includes(record.status)?record:null;
    if(record?.pending?.mutating)task=record;
    if(task&&task.mode!==mode)return scopeConflict(task.mode,'mode_conflict',task.id);
    if(task&&reviewFiles!==undefined&&digest([...new Set(reviewFiles)].sort())!==digest([...(task.reviewFiles||[])].sort()))return scopeConflict(task.mode,'scope_clarification',task.id);
    if(mode==='edicao'&&editRequestNeedsClarification(userRequest))return scopeConflict(mode,'scope_clarification',task?.id);
    if(mode==='revisao'&&reviewRequestNeedsClarification(userRequest))return scopeConflict(mode,'scope_clarification',task?.id);
    task??={id:randomUUID(),targetIdentity,mode,reviewFiles:reviewFiles?[...new Set(reviewFiles)]:null,objective:String(objetivo).slice(0,12000),status:'active',history:[],calls:0,tokens:0,elapsed:0,journal:[],evidence:[],report:[],signatures:[],progress:[],pending:null};
    task.executionOwner=executionId||null;
    const started=now(),elapsedBefore=Number.isFinite(task.elapsed)?task.elapsed:0;
    const persist=async()=>{task.elapsed=elapsedBefore+Math.max(0,now()-started);await save(task);};
    const reconciledPending=reconcileKnownNoopPending(task);
    if(reconciledPending){task.journal??=[];task.journal.push({event:'pending_reconciled_not_applied',name:reconciledPending.name,signature:reconciledPending.signature,at:now()});task.journal=task.journal.slice(-1500);await persist();}
    // A new instruction is not silently replaced by the original task objective.
    // Recover in-flight identity/uncertain effects FIRST; no dispatch is discarded.
    const currentObjective=String(objetivo).slice(0,12000);
    if(!task.modelCall&&!task.pending&&!task.compactionResume){
      task.currentInstruction=currentObjective;
      task.latestUserRequest=String(userRequest||'').slice(0,12000);
    }
    // PR33 did not persist the candidate or validation reason. Do not invent it.
    if(!task.reportOutcome&&task.journal?.findLast(x=>x.event==='report_close')?.ok===false)task.reportOutcome={status:'rejected',accepted:0,diagnostics:[{field:'report',code:'legacy_reason_unavailable'}]};
    // Legacy extraBudget is retained as historical data, never minted/spent.
    const reportReserve=Number.isFinite(cap.tokens)&&cap.calls>=4&&cap.tokens>=100_000?65000:0;
    if(task.report?.length)task.previousReports=[...(task.previousReports||[]),task.report].slice(-5);
    const priorReport=task.report||[];task.report=[];
    const state=createBuildState();
    // A previous validated result is not reused: permissions and current revision
    // must be checked again through hosting tools on every invocation.
    const context=createCodingContext({store,scope,task,persist,maxChars:limits.contextChars??DEFAULT_CODING_CONTEXT_CHARS,currentAccess:async()=>{const x=await tools.run('listar_arquivos_do_app',{});return x?.ok&&(x.alvo_validacao||scope)===targetIdentity?x:{ok:false};}});
    let availableBeforeRead=null;
    const registry=new ToolRegistry();
    for(const t of tools.map.values())if(READS.has(t.name)||(mode==='edicao'&&EDITS.has(t.name)))registry.add({...t,run:async args=>{
      const current=await tools.run('listar_arquivos_do_app',{});
      if(current?.ok!==true||(current.alvo_validacao||scope)!==targetIdentity){interruptedReason='access_denied';throw new Error('APP_ACCESS_CHANGED');}
      if(t.name==='ler_arquivo_do_app'){const cached=await context.cachedRead(args,current);if(cached)return cached;}
      return t.run(args);
    }});
    registry.add({name:'recuperar_contexto_de_codigo',description:'Recovers code or a result collapsed out of this task\'s context by the given ref. Without ref, lists references with a cursor. A long historical result uses inicio/proximo_inicio. Does not re-run the original operation. Requires current access and version; an archived reference is not visible code.',parameters:{type:'object',properties:{ref:{type:'string'},cursor:{type:'integer',minimum:0},inicio:{type:'integer',minimum:0}}},run:context.recover});
    const evidence=new Map(); // Current reads or saved reads with currently verified hashes.
    const fileHashes=new Map((access.arquivos||[]).map(f=>[f.caminho,f.hash]));
    for(const [id,ref] of task.evidence||[])if(fileHashes.get(ref.arquivo)===ref.hash)evidence.set(id,ref);
    task.report=priorReport.filter(x=>x.evidencias?.every(ref=>fileHashes.get(ref.arquivo)===ref.hash));
    const coverageTracker=createReadCoverage((task.readCoverage||[]).filter(x=>fileHashes.get(x.arquivo)===x.hash));
    // Legacy checkpoints had reference spans, not a union of covered intervals.
    for(const ref of evidence.values())coverageTracker.add(ref);
    task.readSamples=(task.readSamples||[]).filter(m=>{try{const d=JSON.parse(m.content);return d.arquivo?fileHashes.get(d.arquivo)===d.hash:d.resultados?.every(x=>fileHashes.get(x.arquivo)===x.hash);}catch{return false;}});
    let lowProgressReads=0;
    // Historical review coverage is evidence, not editing-phase progress. Persist
    // the editing epoch across Continue; only scope/revision/context changes reset it.
    const editScope=digest([task.id,task.mode,task.objective,task.scopeHistory||[]]);
    let editReads=null;
    const editingEpoch=revision=>{
      if(mode!=='edicao')return;
      if(task.editReadState?.version!==1||task.editReadState.scope!==editScope||task.editReadState.revision!==revision)
        task.editReadState={version:1,scope:editScope,revision,coverage:[],consecutive:0};
      editReads=createReadCoverage(task.editReadState.coverage);
      // Upgrade only the obsolete anti-loop classifier, never calls/credits/effects.
      if(task.editReadState.contextPolicy!==2){task.editReadState.consecutive=0;task.editReadState.contextPolicy=2;}
      lowProgressReads=task.editReadState.consecutive||0;
    };
    editingEpoch(access.revisao||null);
    let currentRevision=access.revisao||null,revisionChanged=false;
    const facts=new Set(task.progress),seen=new Set(task.signatures);
    let reportPhase='incremental';
    if(mode==='revisao')registry.add({name:'registrar_parecer_do_app',description:'Records an incremental STATIC REVIEW, not a functional conclusion. Record it when you finish each file. Include a simple, short explicacao_usuario about the same finding, without jargon/code and without increasing the certainty of the evidence. From 1 to 12 items; assunto up to 120 characters, observacao from 1 to 400 characters, without HTML/full URLs/line breaks/action confirmations; technical paths like api/sala/{codigo} are allowed. At most 8 evidence IDs per item. problema_observado and sem_problema_observado require a current reference; nao_verificado may use an empty list. Valid items are preserved when another one fails; fix only the fields pointed out by the diagnostic codes.',
      parameters:APP_REPORT_PARAMETERS,
      async run(args) {
        const validation=validateAppReport(args,evidence),{accepted,diagnostics}=validation;
        const status=accepted.length?(diagnostics.length?'partial':'accepted'):'rejected';
        const previous={report:task.report,reportAudits:task.reportAudits,reportOutcome:task.reportOutcome};
        task.reportAudits=[...(task.reportAudits||[]),reportAudit({args,validation,phase:reportPhase,at:now()})].slice(-3);
        task.reportOutcome={status,accepted:accepted.length,diagnostics};
        const bySubject=new Map(task.report.map(x=>[x.assunto,x]));for(const x of accepted)bySubject.set(x.assunto,x);
        task.report=[...bySubject.values()].slice(-12);if(accepted.length)lowProgressReads=0;
        try{await persist();}catch(e){Object.assign(task,previous);throw e;}
        return {ok:accepted.length>0,status,itens:accepted.length,diagnostics,orientacao:reportDiagnosticHelp(diagnostics),
          ...(diagnostics.length?{error:'Um ou mais itens foram recusados. Corrija somente os campos indicados; não remova a exigência de evidências nem invente referências.'}:{}),
          obs:'Somente itens válidos foram registrados; não comprova comportamento em runtime.'};
      }});
    let interruptedReason=null;
    const modelCalls=createAppModelCalls({task,persist,provider,onUsage,now,onAdvance:(input,kind)=>wrappedProvider.complete(input,kind)});
    const wrappedProvider={name:provider.name,async complete(input,kind='subagent') {
      if(!modelCalls.recovering)await modelCalls.consumed();
      const reservation=estimate(input)+32768;
      if(now()-started>=cap.ms){interruptedReason='execution_window';throw new Error('EXECUTION_WINDOW');}
      if(!modelCalls.recovering&&(task.calls>=cap.calls||(kind!=='app_report'&&reportReserve&&task.calls>=cap.calls-1)||task.tokens+reservation+(kind==='app_report'?0:reportReserve)>cap.tokens)){interruptedReason='task_budget';throw new Error('TASK_BUDGET');}
      try {
        const res=await modelCalls.complete(input,kind);
        appendJournal({event:'model',kind,call:task.calls,callId:modelCalls.pending?.id,tokens:res.usage?Math.max(0,res.usage.in||0)+Math.max(0,res.usage.out||0):null,stop:res.stop,protocol:res.protocolError?.code||null,at:now()});
        await persist();return res;
      }catch(e){
        const reason=creditPauseReason(e);if(reason)interruptedReason=reason;
        await persist();throw e;
      }
    }};
    let quantumProgress=facts.size,nextQuantum=40,compactedAt=0;
    const appendJournal=entry=>{task.journal.push(entry);task.journal=task.journal.slice(-1500);};
    const control={
      isContextRecovery:context.isRecovery,
      async prepareContext(input){await context.prepare(input);
        const last=task.editReadState?.lastRead;
        if(mode==='edicao'&&lowProgressReads>=3&&last&&visibleCodeCoverage(input.messages).observe({ok:true,...last})?.novos_chars>0){lowProgressReads=0;task.editReadState.consecutive=0;}
      },
      async beforeStep({messages,step}) {
        await modelCalls.consumed();
        task.history=copy(messages);await persist();
        const current=await tools.run('listar_arquivos_do_app',{});
        if(current?.ok!==true||(current.alvo_validacao||scope)!==targetIdentity)return {stop:'access_denied',text:'O acesso ao app mudou; não continuei a tarefa.'};
        if(current.revisao&&currentRevision&&current.revisao!==currentRevision){revisionChanged=true;task.report=[];evidence.clear();currentRevision=current.revisao;editingEpoch(current.revisao);}
        if(await shouldPause?.())return {stop:'new_user_input',text:'Pausei para considerar sua nova mensagem. O progresso está salvo.'};
        if(task.pending?.mutating)return {stop:'uncertain_action',text:'Uma ação anterior ficou sem resultado confirmado. Não a repeti; é preciso conferir o rascunho antes de continuar.'};
        if(lowProgressReads>=3)return {stop:'read_coverage_loop',text:mode==='revisao'?'A leitura repetiu conteúdo já consultado; vou fechar o parecer com os achados disponíveis.':'As consultas repetiram conteúdo sem progresso nesta etapa de edição. Pausei; não substituí a implementação por uma revisão.'};
        if(step>=nextQuantum){if(facts.size<=quantumProgress)return {stop:'no_progress',text:'Pausei porque não há progresso suficiente para ampliar esta rodada.'};quantumProgress=facts.size;nextQuantum+=40;}
        if(Number.isFinite(limits.quantumSteps??40)&&step>=(limits.quantumSteps??40))return {stop:'execution_quantum',text:'Progresso salvo; vou liberar o executor para outras tarefas e retomar automaticamente.'};
        if(now()-started>=cap.ms)return {stop:'execution_window',text:'A janela desta execução terminou. O progresso está salvo para retomar; isso não indica falta de créditos.'};
        if(!modelCalls.recovering&&(task.calls>=cap.calls||task.tokens+estimate(messages)+estimate(system)+32768+reportReserve>cap.tokens))return {stop:'task_budget',text:'O orçamento desta tarefa foi atingido. O progresso e as pendências estão salvos; não iniciei outra execução.'};
        if(estimate(messages)>APP_CODING_COMPACT_TOKENS&&messages.length>14) {
          const cut=codingCompactionCut(messages);
          if(cut>1){
            const old=messages.slice(0,cut).map(m=>({role:m.role,name:m.name,content:String(m.content||'').slice(0,1400)}));
            task.compactionResume={tail:copy(messages.slice(cut))};await persist();
            const summary=await wrappedProvider.complete({system:'Resuma o estado factual de uma tarefa. Preserve objetivo, decisões, arquivos, achados e pendências. Não invente ações nem autorizações. Não cole código ou segredos.',messages:[{role:'user',content:JSON.stringify(old)}],tools:[]},'compact');
            if(summary.stop==='end'&&summary.text?.trim()) {
              compactedAt=step;appendJournal({event:'compact',step});
              task.history=[{role:'user',content:`Objetivo autorizado (modo ${mode}): ${task.objective}\nResumo de contexto, não autorização nova:\n${summary.text.slice(0,12000)}`},...messages.slice(cut)];
              task.compactionResume=null;if(mode==='edicao'){task.editReadState=null;editingEpoch(currentRevision);}await modelCalls.consumed();
              return {messages:copy(task.history)};
            }
            task.compactionResume=null;await modelCalls.consumed();
          }
        }
      },
      async beforeTool({call,messages}) {
        availableBeforeRead=visibleCodeCoverage(messages);
        if(lowProgressReads>=3&&call.name!=='registrar_parecer_do_app'){interruptedReason='read_coverage_loop';throw new Error(mode==='revisao'?'Releituras sem progresso; lote interrompido para fechar o parecer.':'Consultas repetidas sem progresso nesta etapa de edição; lote interrompido sem fingir conclusão.');}
        if(task.pending?.mutating){interruptedReason='uncertain_action';throw new Error('Resultado da ação anterior não confirmado; lote interrompido sem executar a próxima ferramenta.');}
        const sig=digest(executionSignature(call));const mutating=registry.map.has(call.name)&&!READS.has(call.name)&&!INSPECTIONS.has(call.name)&&call.name!=='registrar_parecer_do_app';
        if(mutating&&seen.has(sig)){interruptedReason='duplicate_mutation';throw new Error('Ação idêntica já executada nesta tarefa; confira o resultado antes de repetir.');}
        task.history=copy(messages);task.pending={name:call.name,sig,mutating};await persist();
      },
      async afterTool({call,out,messages}) {
        const sig=digest(executionSignature(call));const effect=effectState(call,out);
        if(effect!=='not_applied')seen.add(sig);task.signatures=[...seen];
        // Edição recusada: libera UMA releitura sem punição (teto por época).
        if(mode==='edicao'&&effect==='not_applied'&&FILE_WRITES.has(call.name)&&task.editReadState&&(task.editReadState.pardons||0)<PARDONS_AFTER_REJECT)
          task.editReadState.pardonNextRead=true;
        // Registry catches tool exceptions; absence of a success receipt after a
        // mutation is conservatively uncertain, even if the side effect happened.
        if(!(task.pending?.mutating&&effect==='unknown'&&interruptedReason!=='access_denied'))task.pending=null;
        task.history=copy(messages);
        appendJournal({event:'tool',name:call.name,signature:sig,ok:out?.ok===true,at:now(),revision:out?.revisao||null,arquivo:typeof call.args?.caminho==='string'?call.args.caminho.slice(0,300):null,inicio:Number.isSafeInteger(call.args?.inicio)?call.args.inicio:null,fim:Number.isSafeInteger(out?.fim)?out.fim:null,hash:typeof out?.hash==='string'?out.hash:null,contextRecovered:out?.contexto_recuperado===true,outputChars:JSON.stringify(out??null).length});
        // No payload, credentials or raw source in the operational journal.
        if(out?.ok===true&&READS.has(call.name)) {
          if(mode==='edicao')editingEpoch(out.revisao||currentRevision);
          const measured=coverageTracker.observe(out);
          const editMeasured=editReads?.observe(out);
          const availability=availableBeforeRead?.observe(out);
          if(measured){
            out.cobertura_leitura=measured;
            const noProgress=mode==='edicao'
              ?editMeasured?.chars_solicitados>0&&editMeasured.novos_chars===0&&availability?.novos_chars===0
              :measured.chars_solicitados>0&&measured.novos_chars<128&&measured.novos_chars<measured.chars_solicitados*.1;
            // A releitura que vem logo depois de uma edição recusada é trabalho
            // legítimo (achar o texto exato); não avança o freio anti-loop.
            const pardoned=mode==='edicao'&&task.editReadState?.pardonNextRead===true;
            lowProgressReads=noProgress?(pardoned?lowProgressReads:lowProgressReads+1):0;
            if(pardoned){task.editReadState.pardonNextRead=false;if(noProgress)task.editReadState.pardons=(task.editReadState.pardons||0)+1;}
            if(mode==='edicao'){task.editReadState.coverage=editReads.snapshot();task.editReadState.consecutive=lowProgressReads;if(out.arquivo)task.editReadState.lastRead={arquivo:out.arquivo,hash:out.hash,inicio:out.inicio,fim:out.fim};}
            if(measured.novos_chars>0||(mode==='edicao'&&editMeasured?.novos_chars>0)){
              task.readSamples.push({role:'tool',name:call.name,content:JSON.stringify(out)});
              while(task.readSamples.length>30||task.readSamples.reduce((n,m)=>n+m.content.length,0)>65000)task.readSamples.shift();
            }
            if(mode==='revisao'&&measured.ja_consultado){
              if('conteudo' in out)out.conteudo='[trecho já lido nesta versão; use as evidências e registre seus achados antes de buscar mais]';
              if(Array.isArray(out.resultados))out.resultados=out.resultados.map(({trecho,...ref})=>ref);
              out.proximo_trecho_nao_consultado=coverageTracker.summary().find(x=>x.arquivo===out.arquivo&&x.hash===out.hash)?.completo===true?'Arquivo já consultado integralmente. Registre seus achados e passe ao próximo arquivo.':'Consulte intervalos ainda não cobertos, em vez de repetir esta página.';
              out.obs='Intervalo já coberto, mesmo com outro cursor/tamanho. Não é progresso novo. Registre o parecer parcial; se não lembra um detalhe, marque não verificado.';
            }
            task.readCoverage=coverageTracker.snapshot();
          }
          if(out.revisao){if(currentRevision&&currentRevision!==out.revisao){revisionChanged=true;task.report=[];evidence.clear();}currentRevision=out.revisao;}
          const refs=out.arquivo?[{arquivo:out.arquivo,hash:out.hash,inicio:out.inicio,fim:out.fim,total_chars:out.total_chars}]:Array.isArray(out.resultados)?out.resultados.map(x=>({arquivo:x.arquivo,hash:x.hash,inicio:x.inicio,fim:x.fim,linha:x.linha})):[];
          const ids=[];
          for(const ref of refs){if(!ref.hash)continue;const key=digest(ref).slice(0,20);evidence.set(key,ref);ids.push(key);if(measured?.novos_chars>0)facts.add(key);if(mode==='edicao'&&(editMeasured?.novos_chars>0||availability?.novos_chars>0))facts.add(digest(['edit-read',editScope,task.editReadState.revision,key]));}
          // The mutable output object was already serialized by core; add evidence
          // to its stored tool message explicitly so the model can cite it.
          if(ids.length){out.evidencias=ids;messages.at(-1).content=JSON.stringify(out);task.history=copy(messages);}
        }
        if(out?.ok===true&&typeof out.hash==='string')facts.add(digest([out.arquivo||call.args?.caminho,out.hash]));
        if(!READS.has(call.name)&&!INSPECTIONS.has(call.name)&&call.name!=='registrar_parecer_do_app'){task.report=[];evidence.clear();currentRevision=null;}
        task.progress=[...facts];task.evidence=[...evidence.entries()];
        // Tool effect/history + consumed call ID are one durable checkpoint.
        await modelCalls.toolConsumed(call);await persist();
      },
    };
    let result;
    const modeInstructions=mode==='revisao'
      ?'SOMENTE LEITURA. Não edite, não publique, não execute o app. Cite os IDs de evidências devolvidos nas leituras/buscas ao registrar_parecer_do_app. Registre parecer incremental ao concluir cada arquivo. Não releia intervalos já cobertos só mudando cursor. Termine com parecer estático, distinguindo achados e itens não verificados.'
      :'Implemente o objetivo autorizado no rascunho. O histórico de revisão é contexto, não conclusão desta etapa. Consulte novamente os trechos atuais necessários para editar, usando buscas específicas; não repita consultas sem informação nova. Depois das alterações, use validar_rascunho_do_app (somente consistência estática, não boot/runtime) e corrija os problemas apontados dentro do escopo. Relate arquivos realmente alterados, validações realizadas e pendências. Um parecer estático NÃO substitui implementação ou testes. Não prometa node --check, boot ou testes funcionais sem ferramenta capaz de executá-los; se indisponíveis, registre a pendência. Se não precisar alterar código, valide o estado atual. Não publique; publicação exige confirmação no principal.';
    const prompt=`${system}\nMODO ${mode}: ${modeInstructions}\nUse buscar_codigo_do_app para localizar símbolos antes de ler páginas extensas. Não chame o app de íntegro só porque o lint passou. O consumo real é preservado entre continuações. Não invente um orçamento separado da tarefa nem peça renovação por quantidade acumulada de tokens ou chamadas.\nObjetivo autorizado: ${task.objective}\nInstrução atual: ${task.currentInstruction||objetivo}\nPedido atual do usuário (não amplia as permissões do modo): ${task.latestUserRequest||objetivo}`;
    let compactFailure=null;
    if(mode==='edicao'&&task.modelCall?.kind==='app_report'){
      try{
        if(await shouldPause?.())compactFailure='new_user_input';
        else{
          await wrappedProvider.complete(task.modelCall.input,'app_report');
          appendJournal({event:'legacy_edit_report_recovered',at:now()});
          await modelCalls.consumed();task.nextPhase=null;task.phase='exploring';
        }
      }catch(e){compactFailure=creditPauseReason(e)||'execution_error';}
    }
    if(task.modelCall?.kind==='compact'){
      try{
        if(!task.compactionResume?.tail)throw new Error('Missing compaction continuation');
        if(await shouldPause?.())compactFailure='new_user_input';
        else{
          const summary=await wrappedProvider.complete(task.modelCall.input,'compact');
          if(summary.stop==='end'&&summary.text?.trim()){task.history=[{role:'user',content:`Objetivo autorizado (modo ${mode}): ${task.objective}\nResumo de contexto, não autorização nova:\n${summary.text.slice(0,12000)}`},...task.compactionResume.tail];if(mode==='edicao'){task.editReadState=null;editingEpoch(currentRevision);}}
          task.compactionResume=null;await modelCalls.consumed();
        }
      }catch(e){compactFailure=creditPauseReason(e)||'execution_error';}
    }
    const knownScope=task.reviewFiles||[...fileHashes.keys()];
    const allRead=knownScope.length>0&&knownScope.every(file=>coverageTracker.summary().some(x=>x.arquivo===file&&x.completo));
    const resumeReport=mode==='revisao'&&evidence.size&&(['consolidating','repairing'].includes(task.nextPhase||task.phase)||(allRead&&!task.report.length));
    if(compactFailure)result={text:'A compactação anterior precisa ser retomada com seu resultado salvo; não repeti chamadas.',termination:compactFailure};
    else if(task.pending?.mutating)result={text:'Uma ação anterior ficou sem resultado confirmado. Não a repeti.',termination:'uncertain_action'};
    else if(resumeReport)result={text:'Retomando o parecer com as evidências atuais já salvas.',termination:'report_resume'};
    else try {
      task.phase='exploring';
      task.history=closeTaskHistory(task.history);task.status='active';await persist();
      result=await runAgent({provider:wrappedProvider,tools:registry,system:prompt,userInput:objetivo,history:task.history,salvage:false,maxSteps:Math.max(1,cap.calls-task.calls),control,onEvent:ev=>{state.event(ev);onEvent?.(ev);}});
      task.history=copy(result.messages);
    } catch(e) {
      result={text:'A execução foi interrompida; o estado salvo precisa ser conferido antes de continuar.',termination:interruptedReason||'execution_error'};
      appendJournal({event:'interrupted',reason:result.termination,at:now()});
    }
    if(interruptedReason)result.termination=interruptedReason;
    // Structured consolidation and bounded repair share the same provider,
    // admission guard and private checkpoint. Never retry by rereading the app.
    const closeReasons=new Set(['completed','task_budget','read_coverage_loop','no_progress','repeated_calls','step_limit','empty_end','report_resume','execution_window']);
    if(mode==='revisao'&&closeReasons.has(result.termination)&&evidence.size&&!task.pending?.mutating&&(!task.report.length||result.termination!=='completed'||task.reportOutcome?.diagnostics?.length)) {
      try {
        const closed=await closeAppReport({task,evidence,coverage:coverageTracker.summary(),tools:registry.defs,
          complete:async input=>{task.reportAttemptCall=task.calls+1;await persist();return wrappedProvider.complete(input,'app_report');},
          shouldPause,persist,
          canCall:input=>{
            if(now()-started>=cap.ms){interruptedReason='execution_window';return false;}
            return modelCalls.recovering||(task.calls<cap.calls&&task.tokens+estimate(input)+32768<=cap.tokens);
          },
          checkAccess:async()=>{
            const a=await tools.run('listar_arquivos_do_app',{});
            if(a?.ok!==true||(a.alvo_validacao||scope)!==targetIdentity)return 'access_denied';
            if(currentRevision&&a.revisao&&currentRevision!==a.revisao)return 'draft_changed';
            return true;
          },
          accept:async(final,phase)=>{
            const calls=final.toolCalls||[];
            if(calls.length!==1||calls[0].name!=='registrar_parecer_do_app'){
              task.reportOutcome={status:'rejected',accepted:0,diagnostics:[{field:'response',code:'report_call_required'}]};
              task.reportAudits=[...(task.reportAudits||[]),reportAudit({args:{text:final.text,toolCalls:calls},validation:{accepted:[],diagnostics:task.reportOutcome.diagnostics},phase,at:now()})].slice(-3);
            }else{
              reportPhase=phase;
              const registered=await registry.run(calls[0].name,calls[0].args);
              reportPhase='incremental';
              if(!registered||typeof registered!=='object')task.reportOutcome={status:'unavailable',accepted:0,diagnostics:[{field:'report',code:'report_storage_error'}]};
            }
            appendJournal({event:'report_close',ok:task.reportOutcome?.status==='accepted',status:task.reportOutcome?.status,diagnostics:task.reportOutcome?.diagnostics||[],at:now()});
            return task.reportOutcome;
          }});
        if(['access_denied','draft_changed','new_user_input'].includes(closed.reason))result.termination=closed.reason;
        else if(closed.reason==='admission_pending'&&interruptedReason)result.termination=interruptedReason;
      }catch(error){
        const reason=creditPauseReason(error);
        if(reason){result.termination=reason;result.text='A admissão ou contabilização de crédito interrompeu esta fase. O trabalho anterior está preservado; consulte o motivo específico. Nada continua em background.';}
        else task.reportOutcome={status:'unavailable',accepted:0,diagnostics:[{field:'response',code:'report_generation_failed'}]};
        appendJournal({event:'report_close',ok:false,diagnostics:task.reportOutcome?.diagnostics||[],reason:reason||'report_generation_failed',at:now()});
      }
    }
    const finalAccess=await tools.run('listar_arquivos_do_app',{});
    if(finalAccess?.ok!==true||(finalAccess.alvo_validacao||scope)!==targetIdentity){task.report=[];evidence.clear();result.termination='access_denied';}
    else if(finalAccess.revisao&&currentRevision&&finalAccess.revisao!==currentRevision){revisionChanged=true;task.report=[];evidence.clear();result.termination='draft_changed';}
    // END is a model-turn event, not proof that every file in the review scope
    // has been assessed. Unspecified scope conservatively means current app files.
    const reviewScope=task.reviewFiles||[...fileHashes.keys()];
    const summaries=coverageTracker.summary();
    const reviewPending=mode==='revisao'?reviewScope.filter(file=>!summaries.some(x=>x.arquivo===file&&x.completo)||!task.report.some(item=>item.evidencias?.some(ref=>ref.arquivo===file))):[];
    const explorationReason=result.termination;
    if(mode==='revisao'&&closeReasons.has(result.termination)&&result.termination!=='execution_window'&&['rejected','partial','unavailable'].includes(task.reportOutcome?.status))result.termination=task.reportOutcome.status==='partial'?'report_partial':task.reportOutcome.status==='rejected'?'report_rejected':'report_unavailable';
    if(['report_rejected','report_partial','report_unavailable'].includes(result.termination))result.text='O parecer teve itens recusados ou não pôde ser registrado. Use parecer_resultado para o diagnóstico; não atribua essa falha a falta de créditos. Nada está rodando em background.';
    if(['completed','report_resume'].includes(result.termination)&&reviewPending.length)result.termination='review_partial';
    else if(result.termination==='report_resume'&&task.reportOutcome?.status==='accepted')result.termination='completed';
    const creditPaused=['account_credit_exhausted','account_credit_reserved','credit_reservation_unavailable','credit_quote_unavailable','credit_reconciliation_required','credit_control_unavailable','provider_failure','provider_unavailable'].includes(result.termination);
    const resumableReportPhase=['consolidating','repairing'].includes(task.phase)?task.phase:['consolidating','repairing'].includes(task.nextPhase)?task.nextPhase:null;
    task.nextPhase=(creditPaused||['execution_window','execution_quantum','new_user_input'].includes(result.termination))&&resumableReportPhase?resumableReportPhase:['report_rejected','report_partial','report_unavailable'].includes(result.termination)?'repairing':result.termination==='review_partial'?'exploring':null;
    const out=state.finish(result);
    out.app_build.motivo_exploracao=explorationReason;
    out.app_build.pendencias_revisao=['access_denied','target_changed'].includes(result.termination)?[]:reviewPending;
    if(mode==='revisao'&&task.reportOutcome)out.app_build.parecer_resultado=task.reportOutcome;
    if(finalAccess?.revisao&&out.app_build.revisao&&finalAccess.revisao!==out.app_build.revisao){
      out.ok=false;out.app_build.validacao='pendente';out.app_build.revisao=null;
      if(out.app_build.estado!=='interrompido')out.app_build.estado='nao_validado';
    }
    const coverage=[...evidence.values()];
    out.app_build.version=2;out.app_build.modo=mode;out.app_build.tarefa=id;out.app_build.objetivo=String(objetivo||task.objective||'').slice(0,2000);out.app_build.parecer=mode==='revisao'?task.report:[];
    out.app_build.cobertura=coverage;out.app_build.cobertura_resumo=['access_denied','draft_changed'].includes(result.termination)?[]:coverageTracker.summary();out.app_build.revisao_alterada=revisionChanged;
    out.app_build.consumo_pendente=!!task.modelCall&&!task.modelCall.accounted;
    out.app_build.orcamento={chamadas:task.calls,tokens_contabilizados:task.tokens,limite_chamadas:Number.isFinite(cap.calls)?cap.calls:null,limite_tokens:Number.isFinite(cap.tokens)?cap.tokens:null};
    if(mode==='edicao'&&result.termination==='completed'&&!out.ok){
      result.termination='edit_validation_pending';out.app_build.motivo='edit_validation_pending';out.app_build.estado='interrompido';
    }
    // ── Prova de vida (Fase 2 do item 3 das frustrações de 16/09) ──────────────
    // Consistência estática prova que o código FECHA, não que ele SOBE: o erro de
    // Tipo 2 (o nome existe, o VALOR é que está errado, `/api/pign` por `/api/ping`)
    // só aparece quando roda. Aqui, no fim da edição já validada, o HOST (nunca o
    // modelo) sobe o rascunho num container descartável e anexa o que observou.
    //
    // Portão que INFORMA, nunca que bloqueia: o veredito é anexado ao recibo e não
    // muda `out.ok`, `task.status` nem `result.termination`. Se a prova não roda,
    // o que se registra é exatamente isso (`prova:'nao_rodou'`), nunca um aprovado
    // nem um reprovado inventado.
    if(mode==='edicao'&&result.termination==='completed'&&out.app_build.estado==='consistencia_validada'&&tools.map.has('provar_app')){
      let prova;
      try{ prova=await tools.run('provar_app',{}); }
      catch(e){ prova={ok:false,prova:'nao_rodou',error:String(e?.message||e).slice(0,300)}; }
      // ToolRegistry.run devolve string `ERRO: ...` quando a tool estoura; normaliza
      // pro mesmo contrato pra quem lê o recibo não precisar saber disso.
      if(typeof prova==='string')prova={ok:false,prova:'nao_rodou',error:prova.slice(0,300)};
      if(prova&&typeof prova==='object')out.app_build.prova_de_vida=prova;
      appendJournal({event:'prova_de_vida',ok:prova?.ok===true,prova:prova?.prova||null,veredito:prova?.veredito||null,at:now()});
    }
    // A completed model turn is not a functional acceptance or a complete review.
    task.status=result.termination==='completed'?'completed':'paused';task.lastResult=out;task.lastExecutionId=executionId||null;
    if(!creditPaused&&result.termination!=='execution_error')await modelCalls.consumed();
    await persist();
    return out;
  })).catch(error=>{if(error?.code==='TASK_LOCK_BUSY')return stopped('workspace_busy');throw error;});
}

// Parent-only lifecycle operation. Production MUST wrap this tool in its existing
// human-confirmation gate; the child executor never receives it.
export function makeAppTaskControlTool({store,sessionKey,authorize}) {
  const scopeFor=({app,dono})=>JSON.stringify([sessionKey,app,dono||'']);
  const sameScope=record=>digest({id:record.id,target:record.targetIdentity,mode:record.mode,objective:record.objective,reviewFiles:record.reviewFiles||null,scopeChanges:record.scopeHistory||[]});
  const valid=args=>/^[a-z0-9][a-z0-9_-]{0,62}$/.test(args?.app||'')&&['cancelar','atualizar_escopo'].includes(args?.acao)&&(args.acao!=='atualizar_escopo'||validScopeChange(args));
  const accessOK=a=>a===true||a?.ok===true;
  const unavailable=(record,access)=>{
    if(record&&access?.alvo_validacao&&record.targetIdentity!==access.alvo_validacao)return 'O dono do app mudou; a tarefa anterior não foi alterada.';
    if(!record||['completed','cancelled'].includes(record.status))return 'Não há tarefa pausada para essa ação.';
    if(record.pending?.mutating)return 'Uma ação ficou sem resultado confirmado. Reconcilie o efeito antes de alterar a tarefa; não a repeti.';
  };
  async function execute(args,binding){
    const {app,dono,acao,modo,objetivo,arquivos_revisao}=args||{};
    if(acao==='renovar_orcamento')return {ok:false,background:false,error:'Não é necessário renovar orçamento de tarefa. Use construir_app para retomar o mesmo trabalho; a execução respeita os créditos reais disponíveis.'};
    if(!valid(args))return {ok:false,error:'Informe app, ação, modo e objetivo completo (até2000caracteres) válidos.'};
    if(acao==='atualizar_escopo'&&!binding)return {ok:false,error:'A mudança de escopo precisa de confirmação vinculada pelo servidor; nenhum identificador informado pelo modelo autoriza a mudança.'};
    const access=await authorize(app,dono);if(!accessOK(access))return {ok:false,error:'Acesso atual ao app não confirmado.'};
    return store.withTask(scopeFor(args),async({record,save})=>{
      if(binding?.operationId&&record?.controlReceipts?.[binding.operationId])return copy(record.controlReceipts[binding.operationId]);
      const error=unavailable(record,access);if(error)return {ok:false,error};
      if(binding&&(scopeFor(args)!==binding.scope||sameScope(record)!==binding.generation))return {ok:false,error:'A tarefa ou seu escopo mudou depois da proposta; solicite nova confirmação.'};
      if(acao==='atualizar_escopo'){
        if(record.modelCall||record.compactionResume||record.pending)return {ok:false,error:'Há chamada ou ação pendente de reconciliação; o escopo não foi alterado.'};
        record.scopeHistory=[...(record.scopeHistory||[]),{mode:record.mode,objective:record.objective,reviewFiles:record.reviewFiles,reportOutcome:record.reportOutcome,at:Date.now()}].slice(-10);
        record.mode=modo;record.objective=objetivo.trim();record.reviewFiles=arquivos_revisao?[...new Set(arquivos_revisao)]:null;
        record.latestUserRequest='';record.currentInstruction='';record.reportOutcome=null;record.reportAudits=[];record.lastResult=null;record.nextPhase=null;record.phase='exploring';record.status='paused';
        record.journal.push({event:'user_confirmed_control',action:acao,at:Date.now()});
        const result={ok:true,estado:'paused',acao,background:false,
          continuation:{app,...(dono?{dono}:{}),modo,objetivo:record.objective,...(record.reviewFiles?{arquivos_revisao:record.reviewFiles}:{})},
          obs:'Escopo atualizado; progresso e consumo preservados. A execução deve prosseguir com esse escopo, sem nova autorização para a mesma edição. Publicação não autorizada.'};
        if(binding?.operationId)record.controlReceipts={...(record.controlReceipts||{}),[binding.operationId]:copy(result)};
        await save(record);return result;
      }
      record.status='cancelled';record.journal.push({event:'user_confirmed_control',action:acao,at:Date.now()});
      const result={ok:true,estado:record.status,acao,background:false,obs:'Tarefa cancelada; rascunho preservado.'};
      if(binding?.operationId)record.controlReceipts={...(record.controlReceipts||{}),[binding.operationId]:result};
      await save(record);return result;
    });
  }
  return {name:'gerenciar_tarefa_de_app',description:'Cancels or updates the mode/scope of this app\'s current task in this conversation upon human confirmation. The server resolves and binds the task BEFORE asking for confirmation; there is no need to look up/copy identifiers. Preserves progress and usage. Does not publish nor change files. Confirming the new scope authorizes starting the corresponding continuation, with no other request to continue; publishing remains separate.',
    parameters:{type:'object',properties:{app:{type:'string'},dono:{type:'string'},acao:{type:'string',enum:['cancelar','atualizar_escopo']},tarefa_id:{type:'string',description:'Optional, compatibility with old history. Does not authorize the operation; the server resolves the current task by app/dono/conversation.'},modo:{type:'string',enum:['revisao','edicao']},objetivo:{type:'string',maxLength:2000,description:'Complete scope to confirm, without hidden instructions; at most 2000 characters.'},arquivos_revisao:{type:'array',items:{type:'string'}}},required:['app','acao']},
    async preflight(args){
      if(!valid(args))return {erro:'Informe app, ação, modo e objetivo completo (até2000caracteres) válidos.'};
      return args.acao==='atualizar_escopo'?{aviso:args.arquivos_revisao?`Arquivos da revisão: ${args.arquivos_revisao.join(', ')}`:'Revisão sem restrição a arquivos específicos. Publicação não autorizada.'}:undefined;
    },
    async prepareConfirmation(input){
      // Both public storage IDs in old receipts and UUID generation hints are
      // accepted only as lookup hints BEFORE confirmation, never as authority.
      const args=copy(input);if(!valid(args))throw Error('Parâmetros de escopo inválidos.');
      const access=await authorize(args.app,args.dono);if(!accessOK(access))throw Error('Acesso atual ao app não confirmado.');
      const scope=scopeFor(args);
      const binding=await store.withTask(scope,async({record,id})=>{
        const error=unavailable(record,access);if(error)throw Error(error);
        if(args.tarefa_id!==undefined&&args.tarefa_id!==record.id&&args.tarefa_id!==id)throw Error('O identificador informado não corresponde à tarefa atual deste app/conversa.');
        if(args.acao==='atualizar_escopo'&&(record.modelCall||record.compactionResume||record.pending))throw Error('Há chamada ou ação pendente de reconciliação; não propus mudança de escopo.');
        return {version:1,scope,generation:sameScope(record),operationId:randomUUID()};
      });
      let consumed=false;
      return {descriptor:binding,run:async()=>{
        if(consumed)return {ok:false,error:'Esta confirmação já foi consumida; não repeti a ação.'};
        consumed=true;return execute(args,binding);
      }};
    },
    restoreConfirmation(args,binding){
      if(binding?.version!==1||typeof binding.operationId!=='string'||binding.scope!==scopeFor(args))throw Error('Vínculo de confirmação inválido.');
      return {run:()=>execute(copy(args),copy(binding))};
    },
    run:args=>execute(args,null),
  };
}
