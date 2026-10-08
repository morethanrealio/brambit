import { dominioDosApps, urlDoApp } from '../web/appshost.mjs';
import { linkDaPagina, marca } from '../web/marca.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import { filePage, retainedFilePage } from '../core-proto/file-page.mjs';
import { validateDraft, draftRevision, lintDiagnostics, confirmationFailureContext, validationPage } from '../web/app-draft-validation.mjs';
import { createBuildState, createAppBuildJournal } from '../web/app-build-state.mjs';
import { rejectedEdit } from '../web/coding-effects.mjs';
import { resolverAncora } from '../web/app-anchor.mjs';
import { pioraSintaxe } from '../web/app-syntax.mjs';
import { runAgent, ToolRegistry } from '../core-proto/core.mjs';
import { makeConstruirAppTool, runCodingSubagent } from '../web/coding-subagent.mjs';
let checks=0;const ok=(v,m)=>{assert.ok(v,m);checks++;};const eq=(a,b)=>{assert.deepEqual(a,b);checks++;};
const b64=s=>Buffer.from(s).toString('base64');
const hash=s=>createHash('sha256').update(s).digest('hex').slice(0,12);
for(const content of ['small','x'.repeat(48700),'a'.repeat(5999)+'😀'+'b'.repeat(50000),'\u0001'.repeat(50000),'a\\"\n😀'.repeat(7000)]){
 let inicio=0,copy='',pages=0;
 do { const r=filePage({content,hash:hash(content),arquivo:'public/game.js',bytes:Buffer.byteLength(content),inicio,hash_esperado:pages?hash(content):undefined});
 ok(r.ok);ok(JSON.stringify(r).length<21000);eq(r.hash,hash(content));eq(r.conteudo,content.slice(r.inicio,r.fim));ok(!/[\uD800-\uDBFF]$/.test(r.conteudo));copy+=r.conteudo;inicio=r.proximo_inicio;pages++;eq(JSON.parse(retainedFilePage(JSON.stringify(r))).proximo_inicio,inicio);
 }while(inicio!==null);
 eq(copy,content);
}
for(const args of [{inicio:-1},{inicio:1.5},{limite:0},{inicio:1},{inicio:1,hash_esperado:'old'}])ok(!filePage({content:'abc',hash:'h',arquivo:'a',bytes:3,...args}).ok);
const bad={'public/index.html':b64('<button onclick="launchNow()">Go</button>')};
const good={...bad,'public/main.js':b64('function launchNow() {}')};
eq(validateDraft(bad).validacao,'reprovado');eq(validateDraft(good).validacao,'aprovado');ok(validateDraft(bad).lint_erros.some(e=>e.funcao==='launchNow'));ok(draftRevision(bad)!==draftRevision(good));eq(draftRevision(good),draftRevision(Object.fromEntries(Object.entries(good).reverse())));
const unsafe={lint_erros:[{tipo:'handler_orfao',funcao:'launchNow',referenciado_em:['public/index.html'],token:'do-not-forward'}]};
ok(!JSON.stringify(lintDiagnostics(unsafe)).includes('do-not-forward'));
const note=confirmationFailureContext({name:'publicar_sistema',label:'publicar demo',args:{nome_do_sistema:'demo'}},{ok:false,error:'Lint blocked',...unsafe});
ok(note.includes('launchNow'));ok(note.includes('public/index.html'));ok(note.includes('construir_app'));ok(!note.includes('do-not-forward'));ok(!note.includes('Use ler_arquivo_do_app'));
const many={...validateDraft(bad),lint_erros:Array.from({length:1000},(_,i)=>({tipo:'handler_orfao',funcao:'f'+i,referenciado_em:['public/long-name.js']}))};
let next=0,total=0;do{const p=validationPage(many,{inicio_diagnostico:next,revisao_esperada:many.revisao});ok(JSON.stringify(p).length<20000);total+=p.lint_erros.length;next=p.proximo_diagnostico;}while(next!==null);eq(total,1000);ok(!validationPage(many,{inicio_diagnostico:1}).ok);ok(!validationPage(many,{revisao_esperada:'old'}).ok);
// Load the actual hosting module with only imports stubbed. No real DB/SSH/service.
let writes=0,owner='u1',shared=[],app={system:'demo',agent_id:'agent'},draft={},allowed=false;
const snapshot='gz1:'+zlib.gzipSync(JSON.stringify(good)).toString('base64');
const hostSource=fs.readFileSync('web/hosting.mjs','utf8').replace(/^import[\s\S]*?;\n/gm,'').replace(/^export \{[^\n]+\};?\n/gm,'').replace(/\bexport (?=(?:async )?function|const|let)/g,'');
const ctx=vm.createContext({Buffer,console,process:{env:{}},Date,Map,Set,URL,zlib,createHash,randomBytes:()=>Buffer.alloc(12),filePage,validateDraft,validationPage,draftRevision,rejectedEdit,resolverAncora,pioraSintaxe,
 lintAppB64:()=>{throw Error('publisher not allowed');},countLines:s=>s.split('\n').length,
 dominioDosApps,urlDoApp,linkDaPagina,marca,hostingEnabled:()=>true,ctl:()=>{throw Error('SSH forbidden');},
 getAppRow:async(id,system)=>id===owner&&system==='demo'?app:null,
 getAppDraft:async(id)=>{eq(id,owner);return draft;},getAppSnapshot:async(id)=>{eq(id,owner);return {source_snapshot:snapshot};},
 listSharedAppsForCollaborator:async()=>shared,resolveConnectedUser:async(_id,dono)=>dono==='friend'?{ok:true,userId:'u2'}:{ok:false},isAppCollaborator:async()=>allowed,
 listAppDraftSystems:async()=>[],listAppsForUser:async()=>app?[app]:[],listAgents:async()=>[{id:'other',name:'Other'}],
 ensureUserSubdomain:async()=>{writes++;throw Error('write forbidden');},putAppDraftFile:async()=>{writes++;throw Error('write forbidden');}});
vm.runInContext(hostSource+'\nglobalThis.testTools=hostingTools("u1","agent");',ctx);
const tool=n=>ctx.testTools.find(t=>t.name===n);
let r=await tool('validar_rascunho_do_app').run({nome_do_sistema:'demo'});eq(r.validacao,'aprovado');eq(r.nome_do_sistema,'demo');eq(writes,0);
r=await tool('ler_arquivo_do_app').run({nome_do_sistema:'demo',caminho:'public/index.html'});ok(r.ok);ok(r.conteudo.includes('launchNow'));eq(writes,0);
r=await tool('listar_arquivos_do_app').run({nome_do_sistema:'demo'});eq(r.arquivos.length,2);eq(writes,0);
draft=bad;r=await tool('validar_rascunho_do_app').run({nome_do_sistema:'demo'});eq(r.validacao,'reprovado');eq(writes,0);
app={system:'demo',agent_id:'other'};ok(!(await tool('validar_rascunho_do_app').run({nome_do_sistema:'demo'})).ok);eq(writes,0);
app=null;draft=good;r=await tool('validar_rascunho_do_app').run({nome_do_sistema:'demo'});eq(r.validacao,'aprovado');eq(writes,0);
owner='u2';app={system:'demo',agent_id:'other'};ok(!(await tool('validar_rascunho_do_app').run({nome_do_sistema:'demo',dono:'friend'})).ok);allowed=true;eq((await tool('validar_rascunho_do_app').run({nome_do_sistema:'demo',dono:'friend'})).validacao,'aprovado');
ok(!(await tool('validar_rascunho_do_app').run({nome_do_sistema:'demo',dono:'unknown'})).ok);
shared=[{system:'demo',ownerUserId:'u2'},{system:'demo',ownerUserId:'u3'}];ok(!(await tool('validar_rascunho_do_app').run({nome_do_sistema:'demo'})).ok);eq(writes,0);
// Real core termination, including misleading salvage text.
const fake=(answers)=>({name:'offline',complete:async()=>{ok(answers.length>0);return answers.shift();}});
const empty=new ToolRegistry();
eq((await runAgent({provider:fake([{stop:'end',text:'Done'}]),tools:empty,userInput:'build'})).termination,'completed');
const reg=new ToolRegistry().add({name:'read',parameters:{},run:async()=> 'data'});
r=await runAgent({provider:fake([{stop:'tool',toolCalls:[{id:'1',name:'read',args:{}}]},{stop:'end',text:'Terminei tudo'}]),tools:reg,userInput:'build',maxSteps:1});eq(r.termination,'step_limit');
const protocol={stop:'end',protocolError:{code:'unknown_tool',retryable:true}};
r=await runAgent({provider:fake([protocol,protocol]),tools:empty,userInput:'continue',initialToolLog:[{name:'publicar_sistema',falhou:true}]});ok(!r.text.includes('Nenhuma ferramenta'));ok(r.text.includes('anteriores'));eq(r.termination,'interrupted');
const event=(state,name,out,args={})=>state.event({type:'tool_result',name,out,args});
const validated={...validateDraft(good),alvo_validacao:'u:demo'};
for(const termination of ['step_limit','repeated_calls','empty_end','interrupted']){const s=createBuildState();event(s,'validar_rascunho_do_app',validated);eq(s.finish({termination,text:'Terminei tudo'}).app_build.estado,'interrompido');}
let s=createBuildState();eq(s.finish({termination:'completed',text:'Pronto'}).app_build.estado,'nao_validado');
event(s,'escrever_arquivo_do_app',{ok:true,alvo_validacao:'u:demo'},{caminho:'public/main.js'});event(s,'validar_rascunho_do_app',validated);eq(s.finish({termination:'completed'}).app_build.estado,'consistencia_validada');
event(s,'editar_arquivo_do_app',{ok:false});eq(s.finish({termination:'completed'}).app_build.estado,'nao_validado');event(s,'validar_rascunho_do_app',validated);eq(s.finish({termination:'completed'}).app_build.estado,'consistencia_validada');
s=createBuildState();event(s,'escrever_arquivo_do_app',{ok:true,alvo_validacao:'u:other'});event(s,'validar_rascunho_do_app',validated);eq(s.finish({termination:'completed'}).app_build.estado,'nao_validado');
for(const language of ['pt-BR','en','es'])for(const estado of ['interrompido','nao_validado','requer_correcao','consistencia_validada']){
 const j=createAppBuildJournal({language});j.toolResult({name:'construir_app'},{app_build:{version:1,estado}});ok(!j.finish('Terminei e está rodando em background').includes('Terminei'));eq(!!j.blockPublish(),estado!=='consistencia_validada');
 j.toolResult({name:'publicar_sistema'},'AÇÃO PENDENTE DE CONFIRMAÇÃO');ok(j.finish('Publicado').includes('?'));
}
let j=createAppBuildJournal({failedPublication:true});ok(j.finish('Nenhuma ferramenta foi executada').includes('Tentei publicar'));eq(createAppBuildJournal().finish('Outra resposta'),'Outra resposta');
// Real builder wrapper + actual lint: no LLM/network and no publication available.
const sub=new ToolRegistry().add({name:'validar_rascunho_do_app',parameters:{},run:async()=>validated});
const builder=makeConstruirAppTool({compact:false,buildAppContext:async()=>({tools:sub,provider:fake([{stop:'tool',toolCalls:[{id:'v',name:'validar_rascunho_do_app',args:{}}]},{stop:'end',text:'Tudo finalizado e publicado'}])})});
r=await builder.run({objetivo:'Build fixture',app:'demo'});eq(r.app_build.estado,'consistencia_validada');eq(r.app_build.publicado,false);eq(r.app_build.background,false);
j=createAppBuildJournal();j.toolResult({name:'construir_app'},r);ok(!j.finish(r.resumo_do_modelo).includes('finalizado'));
const legacy=await runCodingSubagent({objetivo:'check',compact:false,tools:empty,provider:fake([{stop:'end',text:'Legacy text'}])});eq(legacy,'Legacy text');
// Wiring assertions catch bypasses in the real server, not only helper behavior.
const server=fs.readFileSync('web/server.mjs','utf8');const set=server.match(/const APP_BUILD_TOOLS = new Set\(\[([\s\S]*?)\]\)/)[1];ok(set.includes("'validar_rascunho_do_app'"));ok(server.includes('initialToolLog:confirmedToolLog'));ok(server.includes('text = appBuildJournal.finish(text, { proposalShown: Boolean(deterministicConfirmation) })'));ok(server.includes('confirmationFailureContext(pend, r)'));ok(server.includes('tools: guardedRegistry'));ok(server.includes('appBuildJournal.blockPublish()'));
// Page navigation survives real in-turn pruning, never a full-file reread.
const long = 'start' + 'x'.repeat(48700) + 'end'; let pageCalls=0;
const pagedTools=new ToolRegistry().add({name:'ler_arquivo_do_app',parameters:{},run:async args=>{pageCalls++;return filePage({content:long,hash:hash(long),arquivo:'game.js',bytes:long.length,...args});}});
r=await runAgent({tools:pagedTools,userInput:'read all',maxSteps:15,provider:{name:'offline',complete:async({messages})=>{
 const last=messages.filter(m=>m.role==='tool').at(-1);const page=last?JSON.parse(last.content):null;
 if(page?.proximo_inicio===null)return {stop:'end',text:'Read'};
 return {stop:'tool',toolCalls:[{id:'p'+pageCalls,name:'ler_arquivo_do_app',args:{inicio:page?.proximo_inicio||0,hash_esperado:hash(long)}}]};
}}});eq(r.termination,'completed');eq(pageCalls,9);const first=JSON.parse(r.messages.find(m=>m.role==='tool').content);eq(first.proximo_inicio,6000);eq(first.hash,hash(long));ok(first.conteudo.includes('recolhido'));
// Existing write hash guard still rejects stale revisions; fixture-only DB writes.
owner='u1';app={system:'demo',agent_id:'agent'};shared=[];draft={...good};
vm.runInContext('resolveLabel = async () => ({label:"fixture",name:"Fixture"});',ctx);
ctx.putAppDraftFile=async(_id,_sys,path,content)=>{writes++;draft[path]=content;};
let before=writes;r=await tool('escrever_arquivo_do_app').run({nome_do_sistema:'demo',caminho:'public/main.js',conteudo:'new code',hash_esperado:'stale'});ok(!r.ok);eq(writes,before);
r=await tool('editar_arquivo_do_app').run({nome_do_sistema:'demo'});eq(r.effect,{version:1,state:'not_applied',operation:'file_edit'});eq(writes,before);
r=await tool('escrever_arquivo_do_app').run({nome_do_sistema:'demo'});eq(r.effect,{version:1,state:'not_applied',operation:'file_edit'});eq(writes,before);
r=await tool('escrever_arquivo_do_app').run({nome_do_sistema:'demo',caminho:'public/main.js',conteudo:'function launchNow() {} // new',hash_esperado:hash('function launchNow() {}')});ok(r.ok);eq(writes,before+1);
// Genuine confirmed gate failure, then protocol exhaustion: attempt not forgotten.
const {gateTool,takePending}=await import('../web/confirm.mjs');let attempts=0;
const gated=gateTool({name:'publicar_sistema',parameters:{},run:async()=>{attempts++;return {ok:false,reentrar:true,error:'lint',...unsafe};}},'fixture-builder-validation');
await gated.run({nome_do_sistema:'demo'});eq(attempts,0);const pending=takePending('fixture-builder-validation');ok(pending);const failure=await pending.run(pending.args);eq(attempts,1);
const reentry=confirmationFailureContext(pending,failure);ok(reentry.includes('launchNow'));
r=await runAgent({tools:empty,provider:fake([protocol,protocol]),userInput:reentry,initialToolLog:[{name:pending.name,falhou:true}]});ok(!r.text.includes('Nenhuma ferramenta'));eq(attempts,1);
const q=createBuildState().finish({termination:'completed',text:'Qual cor você prefere?'});const qj=createAppBuildJournal();qj.toolResult({name:'construir_app'},q);ok(qj.finish('Pronto').includes('Qual cor você prefere?'));
console.log(`PASS ${checks} app-builder checks: real hosting with read-only stubs, pages, lint, core, nested builder, journal; zero external I/O`);
