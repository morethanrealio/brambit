import { dominioDosApps, urlDoApp } from '../web/appshost.mjs';
import { linkDaPagina, marca } from '../web/marca.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';import vm from 'node:vm';import zlib from 'node:zlib';import {createHash} from 'node:crypto';
import {runAgent,ToolRegistry} from '../core-proto/core.mjs';
import {callSignature} from '../core-proto/repetition.mjs';
import {filePage} from '../core-proto/file-page.mjs';
import {draftRevision,validateDraft,validationPage} from '../web/app-draft-validation.mjs';
import {buildQuestions} from '../web/build-feedback.mjs';
import {createBuildState,createAppBuildJournal} from '../web/app-build-state.mjs';
import {rejectedEdit} from '../web/coding-effects.mjs';
import { resolverAncora } from '../web/app-anchor.mjs';
import { pioraSintaxe } from '../web/app-syntax.mjs';
import {makeConstruirAppTool} from '../web/coding-subagent.mjs';
import {gateTool,takePending} from '../web/confirm.mjs';
let checks=0;const ok=(x,m)=>{assert.ok(x,m);checks++;};const eq=(a,b)=>{assert.deepEqual(a,b);checks++;};
const b64=s=>Buffer.from(s).toString('base64');
const call=(name,args={},id='x')=>({name,args,id});
const step=(...calls)=>({stop:'tool',toolCalls:calls});
const provider=seq=>({name:'offline',complete:async()=>{ok(seq.length>0);return seq.shift();}});
const end={stop:'end',text:'Finished fixture, not published.'};
const protocol={stop:'end',protocolError:{code:'unknown_tool',retryable:true}};
// Actual hosting functions in a VM; only DB/control-plane imports replaced.
function fixture(owner='u',system='demo'){
 let files={'public/a.js':b64('function a() {}')},writes=0,reads=0,external=0;let app={system,agent_id:'agent'},allow=false;
 const source=fs.readFileSync('web/hosting.mjs','utf8').replace(/^import[\s\S]*?;\n/gm,'').replace(/^export \{[^\n]+\};?\n/gm,'').replace(/\bexport (?=(?:async )?function|const|let)/g,'');
 const context=vm.createContext({Buffer,console,process:{env:{}},Date,Map,Set,URL,zlib,createHash,randomBytes:()=>Buffer.alloc(12),filePage,validateDraft,validationPage,draftRevision,rejectedEdit,resolverAncora,pioraSintaxe,
  countLines:s=>s.split('\n').length,dominioDosApps,urlDoApp,linkDaPagina,marca,hostingEnabled:()=>true,ctl:async()=>{external++;throw Error('forbidden');},
  getAppRow:async(id,sys)=>id===owner&&sys===system?app:null,getAppDraft:async(id)=>{eq(id,owner);reads++;return {...files};},getAppSnapshot:async()=>({source_snapshot:'gz1:'+zlib.gzipSync(JSON.stringify(files)).toString('base64')}),
  listSharedAppsForCollaborator:async()=>[],resolveConnectedUser:async()=>({ok:true,userId:'other'}),isAppCollaborator:async()=>allow,
  listAppDraftSystems:async()=>[system],listAppsForUser:async()=>app?[app]:[],listAgents:async()=>[],
  ensureUserSubdomain:async()=>{external++;throw Error('allocation forbidden');},putAppDraftFile:async(id,sys,path,content)=>{eq(id,owner);eq(sys,system);writes++;files[path]=content;}});
 vm.runInContext(source+`\nresolveLabel=async()=>({label:'fixture',name:'Fixture'});globalThis.actualTools=hostingTools(${JSON.stringify(owner)},'agent');`,context);
 const registry=new ToolRegistry();for(const t of context.actualTools)registry.add(t);
 return {registry,get files(){return files;},get writes(){return writes;},get reads(){return reads;},get external(){return external;},setApp(v){app=v;}};
}
const write=(n,system='demo')=>call('escrever_arquivo_do_app',{nome_do_sistema:system,caminho:'public/a.js',conteudo:`function a() {} // ${n}`},'w'+n);
const validate=(system='demo')=>call('validar_rascunho_do_app',{nome_do_sistema:system},'v');
// Former false positive: edit/validate three times, across steps AND same batch.
for(const owner of ['fixture-A','fixture-B'])for(const batch of [false,true]){
 const f=fixture(owner);const seq=[];for(let n=1;n<=4;n++)batch?seq.push(step(write(n),validate())):seq.push(step(write(n)),step(validate()));seq.push(end);
 const events=[];const r=await runAgent({tools:f.registry,provider:provider(seq),userInput:'Fixture edit and validate',maxSteps:40,onEvent:e=>events.push(e)});
 eq(r.termination,'completed');eq(f.writes,4);eq(events.filter(e=>e.type==='tool_result'&&e.name==='validar_rascunho_do_app').length,4);eq(f.external,0);ok(!events.some(e=>e.type==='loop_break'));
}
// Stable content, failed write and no-op write are NOT progress.
for(const mode of ['same','noop','failed']){
 const f=fixture();const seq=[step(validate()),step(validate())];
 if(mode==='noop')seq.push(step(call('escrever_arquivo_do_app',{nome_do_sistema:'demo',caminho:'public/a.js',conteudo:'function a() {}'})));
 if(mode==='failed')seq.push(step(call('escrever_arquivo_do_app',{nome_do_sistema:'demo',caminho:'public/a.js',conteudo:'changed',hash_esperado:'stale'})));
 seq.push(step(validate()),end);const events=[];
 const r=await runAgent({tools:f.registry,provider:provider(seq),userInput:'fixture',onEvent:e=>events.push(e)});
 eq(r.termination,'repeated_calls');eq(events.filter(e=>e.type==='tool_result'&&e.name==='validar_rascunho_do_app').length,2);
 const ev=events.find(e=>e.type==='loop_break');eq(ev.tool,'validar_rascunho_do_app');eq(ev.reason,'unchanged_revision');eq(ev.args,'');eq(f.external,0);
}
// Actual read hook keys: same file stable, other file edits do not reset reads,
// whole-draft validator changes, and new owner changes scope.
{
 const f=fixture('u1'),g=fixture('u2');const args={nome_do_sistema:'demo',caminho:'public/a.js'};
 const k=await f.registry.repetitionKey('ler_arquivo_do_app',args);const v=await f.registry.repetitionKey('validar_rascunho_do_app',args);
 ok(k!==await g.registry.repetitionKey('ler_arquivo_do_app',args));
 await f.registry.run('escrever_arquivo_do_app',{nome_do_sistema:'demo',caminho:'ESPEC.md',conteudo:'Changed docs'});
 eq(k,await f.registry.repetitionKey('ler_arquivo_do_app',args));ok(v!==await f.registry.repetitionKey('validar_rascunho_do_app',args));
 eq(await f.registry.repetitionKey('ler_arquivo_do_app',{...args,dono:'unknown'}),null);
 f.setApp({system:'demo',agent_id:'other'});eq(await f.registry.repetitionKey('ler_arquivo_do_app',args),null);eq(f.external,0);
 ok(!JSON.stringify(f.registry.defs).includes('repeatRevision'));
}
// Mutating/unknown tools cannot opt out via a revision hook.
for(const name of ['escrever_arquivo_do_app','chamar_sistema','publicar_sistema','anything']){
 let runs=0,probes=0;const reg=new ToolRegistry().add({name,parameters:{},repeatRevision:async()=>{probes++;return String(probes).padStart(64,'0');},run:async()=>{runs++;return {ok:true};}});
 const r=await runAgent({tools:reg,provider:provider([step(call(name)),step(call(name)),step(call(name)),end]),userInput:'fixture'});eq(runs,2);eq(probes,0);eq(r.termination,'repeated_calls');
}
// Fingerprint unavailable after previous success must fail closed, not reset count.
{
 let runs=0,probes=0;const reg=new ToolRegistry().add({name:'validar_rascunho_do_app',parameters:{},repeatRevision:async()=>{if(++probes>2)throw Error('private');return 'a'.repeat(64);},run:async()=>{runs++;return {ok:true};}});
 const events=[];const r=await runAgent({tools:reg,provider:provider([step(validate()),step(validate()),step(validate()),end]),userInput:'fixture',onEvent:e=>events.push(e)});eq(runs,2);eq(r.termination,'repeated_calls');eq(events.find(e=>e.type==='loop_break').reason,'revision_unavailable');ok(!r.text.includes('private'));
}
// Same-batch block preserves earlier real writes and closes all tool-call pairs.
{
 const f=fixture();const read=call('ler_arquivo_do_app',{nome_do_sistema:'demo',caminho:'public/a.js'});
 const r=await runAgent({tools:f.registry,provider:provider([step(read),step({...read,id:'r2'}),step(call('escrever_arquivo_do_app',{nome_do_sistema:'demo',caminho:'ESPEC.md',conteudo:'doc'},'doc'),{...read,id:'blocked'},write(99)),end]),userInput:'fixture'});
 eq(r.termination,'repeated_calls');eq(f.writes,1);ok(f.files['ESPEC.md']);eq(Buffer.from(f.files['public/a.js'],'base64').toString(),'function a() {}');
 const ids=r.messages.filter(m=>m.role==='tool').map(m=>m.toolCallId);ok(ids.includes('blocked'));ok(ids.includes('w99'));ok(r.messages.some(m=>m.toolCallId==='w99'&&m.content.includes('não executada')));
}
// Protocol recovery allows fresh read states, not replay of writes or same state.
for(const changed of [true,false]){
 const f=fixture();const seq=[step(validate()),protocol];if(changed)seq.push(step(write(1),validate()));else seq.push(step(validate()));seq.push(end);
 // unchanged case ends before the final provider call; that's intentional.
 const r=await runAgent({tools:f.registry,provider:provider(seq),userInput:'fixture'});
 eq(r.termination,changed?'completed':'interrupted');eq(f.writes,changed?1:0);
}
{
 const f=fixture();const r=await runAgent({tools:f.registry,provider:provider([step(write(1)),protocol,step(write(1))]),userInput:'fixture'});eq(f.writes,1);ok(r.text.includes('Bloqueei'));
}
// New revisions do not raise the turn ceiling.
{
 const f=fixture();const r=await runAgent({tools:f.registry,provider:provider([step(write(1),validate()),step(write(2),validate()),end]),userInput:'fixture',maxSteps:2});eq(r.termination,'step_limit');eq(f.writes,2);
}
// Full canonical signatures distinguish long argument tails and normalize keys.
eq(callSignature(call('x',{a:1,b:2})),callSignature(call('x',{b:2,a:1})));
ok(callSignature(call('x',{v:'x'.repeat(500)+'A'}))!==callSignature(call('x',{v:'x'.repeat(500)+'B'})));
// Actual regression: JS ternary is never an end-user question, even from legacy state.
const code='```js\nconst codigoParam = partes[2] ? decodeURIComponent(partes[2]) : null;\n```';
for(const text of ['```text\nQual cor você prefere?\n```',code,code.replace(/```js/,'~~~js').replace(/```$/,'~~~'),'const codigoParam = partes[2] ?','```js\nconst x = a ?','`const x = a ?`','return a ? b : c;','obj?.method()','a ?? b','{ "question": "Qual cor?" }'])eq(buildQuestions(text),[]);
for(const [q,expected] of [['Qual cor você prefere?','Qual cor você prefere?'],['What color do you prefer?','What color do you prefer?'],['¿Qué color prefieres?','¿Qué color prefieres?'],['Qual arquivo: `server.js`?','Qual arquivo: ?']])eq(buildQuestions(code+'\n'+q),[expected]);
eq(buildQuestions('Posso publicar?'),[]);eq(buildQuestions('Qual cor? Qual tamanho?'),['Qual cor?','Qual tamanho?']);
for(const language of ['pt-BR','en','es']){
 const state=createBuildState();state.event({type:'tool_result',name:'escrever_arquivo_do_app',args:{caminho:'a.js'},out:{ok:true,alvo_validacao:'u:demo'}});
 state.event({type:'loop_break',tool:'validar_rascunho_do_app',reason:'unchanged_revision',repeatCount:3,revisionAware:true,args:'PRIVATE'});
 const result=state.finish({termination:'repeated_calls',text:code});eq(result.app_build.perguntas,[]);ok(!JSON.stringify(result.app_build).includes('PRIVATE'));eq(result.app_build.interrupcao.ferramenta,'validar_rascunho_do_app');
 const j=createAppBuildJournal({language});j.toolResult({name:'construir_app'},result);const text=j.finish('Finished!');ok(text.includes('1'));ok(!text.includes('codigoParam'));ok(j.blockPublish());
 j.toolResult({name:'construir_app'},{app_build:{version:1,estado:'interrompido',perguntas:['const codigoParam = partes[2] ?']}});ok(!j.finish('anything').includes('codigoParam'));
}
// Real nested builder + actual hosting read hooks, then real confirmation gate.
{
 const f=fixture();const seq=[step(write(1),validate()),step(write(2),validate()),step(write(3),validate()),end];
 const b=makeConstruirAppTool({compact:false,buildAppContext:async()=>({tools:f.registry,provider:provider(seq)})});
 const result=await b.run({app:'demo',objetivo:'Synthetic edit and validate'});eq(result.app_build.estado,'consistencia_validada');eq(f.writes,3);eq(f.external,0);
 const j=createAppBuildJournal();j.toolResult({name:'construir_app'},result);eq(j.blockPublish(),null);let published=0;
 const gate=gateTool({name:'publicar_sistema',parameters:{},run:async()=>{published++;return {ok:true};}},'fixture-revision-gate');
 const out=await gate.run({nome_do_sistema:'demo',runtime:'node'});j.toolResult({name:'publicar_sistema'},out);eq(published,0);ok(takePending('fixture-revision-gate'));ok(j.finish('Done').includes('aguarda sua confirmação'));
}
// Full signatures matter in the real loop, not just the hash helper.
{
 let writes=0;const reg=new ToolRegistry().add({name:'write',parameters:{},run:async()=>{writes++;return 'ok';}});
 const seq=['A','B','C'].map(v=>step(call('write',{content:'x'.repeat(600)+v})));seq.push(end);
 eq((await runAgent({tools:reg,provider:provider(seq),userInput:'fixture'})).termination,'completed');eq(writes,3);
}
// Repeated mutations in one batch are blocked BEFORE any side effect.
{
 let writes=0;const reg=new ToolRegistry().add({name:'write',parameters:{},run:async()=>{writes++;return 'ok';}});
 const r=await runAgent({tools:reg,provider:provider([step(call('write',{},'1'),call('write',{},'2'),call('write',{},'3')),end]),userInput:'fixture'});
 eq(writes,0);eq(r.termination,'repeated_calls');
}
// Successful scaffolding reports real file count without source/file-path leakage.
{
 const state=createBuildState();state.event({type:'tool_result',name:'iniciar_estrutura_do_app',out:{ok:true,alvo_validacao:'u:demo',arquivos_criados:['server.js','public/a.js']}});
 const out=state.finish({termination:'step_limit',text:'Não terminei'});const j=createAppBuildJournal();j.toolResult({name:'construir_app'},out);
 ok(j.finish('Done').includes('2 arquivo'));ok(!j.finish('Done').includes('server.js'));
}
for(const q of ['Você prefere o app público ou privado?','Pode confirmar se prefere azul ou verde?','Do you want a public or private app?']) eq(buildQuestions(q),[q]);
console.log(`PASS ${checks} revision/feedback checks: real hosting/core/builder/gate, synthetic state, no customer app/DB/network execution`);
