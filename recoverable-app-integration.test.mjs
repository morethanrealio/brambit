import { dominioDosApps, urlDoApp } from './web/appshost.mjs';
import { linkDaPagina, marca } from './web/marca.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';import vm from 'node:vm';import zlib from 'node:zlib';import {createHash} from 'node:crypto';
import {ToolRegistry} from './core-proto/core.mjs';
import {filePage} from './core-proto/file-page.mjs';
import {draftRevision,validateDraft,validationPage} from './web/app-draft-validation.mjs';
import {searchAppCode} from './web/app-code-search.mjs';
import {makeConstruirAppTool} from './web/coding-subagent.mjs';
import {makeAppTaskControlTool} from './web/app-task-runner.mjs';
import {appTaskReceipt as detailedReceipt} from './web/app-review-receipt.mjs';
import {rejectedEdit} from './web/coding-effects.mjs';
import { resolverAncora } from './web/app-anchor.mjs';
import { pioraSintaxe } from './web/app-syntax.mjs';
const appTaskReceipt=(build,lang)=>detailedReceipt(build,lang,{technicalDetails:true});
let checks=0;const eq=(a,b)=>{assert.deepEqual(a,b);checks++;};const ok=x=>{assert.ok(x);checks++;};
const b64=s=>Buffer.from(s).toString('base64');
const step=(name,args={},id='x')=>({stop:'tool',toolCalls:[{name,args,id}],usage:{in:100,out:10}});
const end={stop:'end',text:'Parecer estático registrado.',usage:{in:100,out:10}};
const memory=()=>{const records=new Map();return {records,async withTask(k,fn){return fn({id:k,record:structuredClone(records.get(k)||null),save:async r=>records.set(k,structuredClone(r))});}};};
function fixture(caller='A'){
 const content={A:{demo:{'public/a.js':b64('function markerA() {}')},other:{'private.txt':b64('OTHER_APP_PRIVATE')}},B:{demo:{'public/a.js':b64('function markerB() {}')}}};
 let allow=true,shared=false,agent='agent',writes=0,external=0;const reads=[];
 const src=fs.readFileSync('web/hosting.mjs','utf8').replace(/^import[\s\S]*?;\n/gm,'').replace(/^export \{[^\n]+\};?\n/gm,'').replace(/\bexport (?=(?:async )?function|const|let)/g,'');
 const ctx=vm.createContext({Buffer,console,process:{env:{}},Date,Map,Set,URL,zlib,createHash,randomBytes:()=>Buffer.alloc(12),filePage,validateDraft,validationPage,draftRevision,searchAppCode,rejectedEdit,resolverAncora,pioraSintaxe,
 countLines:s=>s.split('\n').length,dominioDosApps,urlDoApp,linkDaPagina,marca,hostingEnabled:()=>true,ctl:async()=>{external++;throw Error('forbidden external');},
 getAppRow:async(u,s)=>content[u]?.[s]?{system:s,agent_id:agent}:null,getAppDraft:async(u,s)=>{reads.push([u,s]);return {...content[u]?.[s]};},getAppSnapshot:async()=>null,
 resolveConnectedUser:async(_,d)=>content[d]?{ok:true,userId:d}:{ok:false},isAppCollaborator:async()=>allow,
 listSharedAppsForCollaborator:async()=>shared&&allow?[{system:'demo',ownerUserId:'B'}]:[],
 listAppDraftSystems:async()=>[],listAppsForUser:async()=>[],listAgents:async()=>[],
 getUserById:async()=>({plan:'pro'}),conferirPermissoes:p=>p,
 ensureUserSubdomain:async()=>{external++;throw Error('forbidden allocation');},putAppDraftFile:async(u,s,p,c)=>{writes++;content[u]??={};content[u][s]??={};content[u][s][p]=c;}});
 vm.runInContext(src+`\nconfigurarPermissoes({bloqueioDeApp:async()=>null,discoDoAppMb:()=>5120});resolveLabel=async()=>({label:'fixture',name:'Fixture'});globalThis.actual=hostingTools(${JSON.stringify(caller)},'agent');`,ctx);
 const tools=new ToolRegistry();for(const t of ctx.actual)tools.add(t);
 return {tools,content,reads,get writes(){return writes;},get external(){return external;},allow:v=>allow=v,shared:v=>shared=v,agent:v=>agent=v};
}
function builder(f,store,provider,sessionKey='fixture',shouldPause){return makeConstruirAppTool({taskStore:store,sessionKey,shouldPause,buildAppContext:async()=>({tools:f.tools,provider})});}
// Actual read-only hosting ACL: explicit collaborators, revocation, other agent.
{
 const f=fixture();let a=await f.tools.run('buscar_codigo_do_app',{nome_do_sistema:'demo',texto:'marker',dono:'B'});ok(a.ok);eq(a.alvo_validacao,'B:demo');ok(a.resultados[0].trecho.includes('markerB'));
 f.allow(false);const before=f.reads.length;a=await f.tools.run('buscar_codigo_do_app',{nome_do_sistema:'demo',texto:'marker',dono:'B'});eq(a.ok,false);eq(f.reads.length,before);
 f.agent('other');a=await f.tools.run('buscar_codigo_do_app',{nome_do_sistema:'demo',texto:'marker'});eq(a.ok,false);eq(f.writes,0);eq(f.external,0);
}
// Parent target wins over malicious child target; no cross-user/app reads.
for(const user of ['A','B']){
 const f=fixture(user),store=memory();let n=0;
 const p={name:'fixture',complete:async({messages})=>{n++;if(n===1)return step('buscar_codigo_do_app',{nome_do_sistema:'other',dono:user==='A'?'B':'A',texto:'marker'});
 if(n===2){const out=JSON.parse(messages.at(-1).content);eq(out.alvo_validacao,user+':demo');ok(out.resultados[0].trecho.includes('marker'+user));return step('registrar_parecer_do_app',{itens:[{assunto:'Declaração',avaliacao:'sem_problema_observado',observacao:'Declaração encontrada no trecho.',evidencias:out.evidencias}]});}return end;}};
 const out=await builder(f,store,p,'session-'+user).run({app:'demo',modo:'revisao',objetivo:'Conferir'});eq(out.app_build.motivo,'review_partial');eq(out.app_build.parecer.length,1);eq(out.app_build.pendencias_revisao,['public/a.js']);ok(f.reads.every(([u,s])=>u===user&&s==='demo'));eq(f.external,0);eq(f.writes,0);
}
// Shared alias automatically resolves to another owner after revocation: never load old history into provider.
{
 const f=fixture('C'),store=memory();f.shared(true);let n=0;
 const p={name:'f',complete:async()=>{n++;return step('ler_arquivo_do_app',{caminho:'public/a.js'});}};
 const b=builder(f,store,p,'shared',async()=>n>=1);
 const first=await b.run({app:'demo',modo:'revisao',objetivo:'Conferir'});eq(first.app_build.motivo,'new_user_input');eq(n,1);
 f.allow(false);const out=await b.run({app:'demo',modo:'revisao',objetivo:'Continue'});eq(out.app_build.motivo,'target_changed');eq(n,1);ok(!JSON.stringify(out).includes('markerB'));
}
// Mid-call revocation blocks the read before execution, including next tool in a batch.
{
 const f=fixture(),store=memory();let n=0;
 const p={name:'f',complete:async()=>{n++;f.allow(false);return step('ler_arquivo_do_app',{caminho:'public/a.js'});}};
 const out=await builder(f,store,p).run({app:'demo',dono:'B',modo:'revisao',objetivo:'Confira'});eq(out.app_build.motivo,'access_denied');eq(n,1);eq(out.app_build.cobertura.length,0);eq(f.writes,0);
}
// New own app can still be created, only in explicit edit mode, with no publication.
{
 const f=fixture(),store=memory();let n=0;const p={name:'f',complete:async()=>++n===1?step('escrever_arquivo_do_app',{caminho:'public/a.js',conteudo:'function newApp() {}'}):end};
 const out=await builder(f,store,p).run({app:'new-app',modo:'edicao',objetivo:'Criar arquivo'});eq(out.app_build.motivo,'edit_validation_pending');eq(out.app_build.validacao,'pendente');eq(f.writes,1);ok(f.content.A['new-app']);eq(f.external,0);eq(out.app_build.publicado,false);
}
// Exact production failure shape: an edit without a path is a proven no-op, so
// the same execution can correct its arguments, write once and validate.
{
 const f=fixture(),store=memory();let n=0;
 const p={name:'f',complete:async({messages})=>{n++;
  if(n===1)return step('editar_arquivo_do_app',{});
  if(n===2){const rejected=JSON.parse(messages.at(-1).content);eq(rejected.effect,{version:1,state:'not_applied',operation:'file_edit'});return step('editar_arquivo_do_app',{caminho:'public/a.js',trecho_antigo:'function markerA() {}',trecho_novo:'function markerA() { return true; }'});}
  if(n===3)return step('validar_rascunho_do_app',{});
  return end;
 }};
 const out=await builder(f,store,p).run({app:'demo',modo:'edicao',objetivo:'Corrigir e validar'});
 eq(f.writes,1);ok(out.app_build.motivo!=='uncertain_action');eq(out.app_build.validacao,'aprovado');eq(f.external,0);
}
// Interrupted review cannot silently become an edit; original state and budget preserved.
{
 const f=fixture(),store=memory();let n=0;const b=builder(f,store,{name:'f',complete:async()=>{n++;return step('ler_arquivo_do_app',{caminho:'public/a.js'});}},'mode',async()=>n>=1);
 await b.run({app:'demo',modo:'revisao',objetivo:'Conferir'});const snapshot=JSON.stringify([...store.records]);const out=await b.run({app:'demo',modo:'edicao',objetivo:'Alterar'});eq(out.app_build.motivo,'mode_conflict');eq(n,1);eq(JSON.stringify([...store.records]),snapshot);eq(f.writes,0);
}
// Concurrent edit after referenced report but before final model response invalidates old findings.
{
 const f=fixture(),store=memory();let n=0;const p={name:'f',complete:async({messages})=>{n++;if(n===1)return step('buscar_codigo_do_app',{texto:'marker'});if(n===2){const x=JSON.parse(messages.at(-1).content);return step('registrar_parecer_do_app',{itens:[{assunto:'Marcador antigo',avaliacao:'sem_problema_observado',observacao:'Declaração observada.',evidencias:x.evidencias}]});}f.content.A.demo['public/a.js']=b64('function changedExternally() {}');return end;}};
 const out=await builder(f,store,p).run({app:'demo',modo:'revisao',objetivo:'Conferir'});eq(out.app_build.motivo,'draft_changed');eq(out.app_build.parecer.length,0);ok(out.app_build.revisao_alterada);ok(!appTaskReceipt(out.app_build).includes('Marcador antigo'));
}
// Search pagination cannot mix revisions from actual hosting reads.
{
 const f=fixture();f.content.A.demo['public/a.js']=b64('marker one\nmarker two\nmarker three');const a=await f.tools.run('buscar_codigo_do_app',{nome_do_sistema:'demo',texto:'marker',limite:1});eq(a.proximo_inicio,1);f.content.A.demo['public/a.js']=b64('marker new');const b=await f.tools.run('buscar_codigo_do_app',{nome_do_sistema:'demo',texto:'marker',inicio:1,revisao_esperada:a.revisao});eq(b.ok,false);eq(f.writes,0);
}
// A caught tool exception after a real fixture mutation must not permit replay.
{
 const f=fixture(),store=memory();let effects=0,n=0;
 f.tools.map.get('escrever_arquivo_do_app').run=async()=>{effects++;throw Error('fixture exception after side effect');};
 const b=builder(f,store,{name:'f',complete:async()=>{n++;return step('escrever_arquivo_do_app',{caminho:'public/a.js',conteudo:'x'});}},'uncertain');
 const args={app:'demo',modo:'edicao',objetivo:'Alterar'};
 let out=await b.run(args);eq(out.app_build.motivo,'uncertain_action');eq(effects,1);eq(n,1);
 out=await b.run({...args,objetivo:'Continue'});eq(out.app_build.motivo,'uncertain_action');eq(effects,1);eq(n,1);
 const c=makeAppTaskControlTool({store,sessionKey:'uncertain',authorize:async()=>({ok:true,alvo_validacao:'A:demo'})});
 eq((await c.run({app:'demo',acao:'cancelar'})).ok,false);eq((await c.run({app:'demo',acao:'renovar_orcamento'})).ok,false);
}
// A controller cannot modify a saved task after its owner alias resolves elsewhere.
{
 const f=fixture(),store=memory();let n=0;
 await builder(f,store,{name:'f',complete:async()=>{n++;return step('ler_arquivo_do_app',{caminho:'public/a.js'});}},'control',async()=>n>=1).run({app:'demo',modo:'revisao',objetivo:'Conferir'});
 const before=JSON.stringify([...store.records]);const c=makeAppTaskControlTool({store,sessionKey:'control',authorize:async()=>({ok:true,alvo_validacao:'B:demo'})});
 eq((await c.run({app:'demo',acao:'cancelar'})).ok,false);eq(JSON.stringify([...store.records]),before);
}
// Fresh evidence from a revised file remains usable, stale references do not.
{
 const f=fixture(),store=memory();let n=0,oldHash;
 const p={name:'f',complete:async({messages})=>{n++;if(n===1)return step('buscar_codigo_do_app',{texto:'marker'});
 if(n===2){oldHash=JSON.parse(messages.at(-1).content).resultados[0].hash;f.content.A.demo['public/a.js']=b64('function newerMarker() {}');return step('buscar_codigo_do_app',{texto:'newerMarker'});}
 if(n===3){const out=JSON.parse(messages.at(-1).content);ok(out.evidencias.length>0);return step('registrar_parecer_do_app',{itens:[{assunto:'Novo marcador',avaliacao:'sem_problema_observado',observacao:'Declaração atual observada.',evidencias:out.evidencias}]});}return end;}};
 const out=await builder(f,store,p).run({app:'demo',modo:'revisao',objetivo:'Confira'});eq(out.app_build.parecer.length,1);eq(out.app_build.parecer[0].assunto,'Novo marcador');ok(!out.app_build.cobertura.some(x=>x.hash===oldHash));
}
// UX: do not claim saved progress on failed access; explicit reason, budget gate, real questions.
for(const language of ['pt-BR','en','es']){
 for(const motivo of ['access_denied','target_changed','draft_changed','task_budget','mode_conflict','uncertain_action']){
  const text=appTaskReceipt({version:2,modo:'revisao',estado:'interrompido',motivo,perguntas:['Qual cor você prefere?']},language);
  ok(text.length>160);ok(!/com progresso salvo|with progress saved|con progreso guardado/.test(text));ok(text.includes('Qual cor você prefere?'));
 }
}
// A second call in the same batch must not erase the pending uncertain action.
{
 const f=fixture(),store=memory();let writes=0,reads=0,n=0;
 f.tools.map.get('escrever_arquivo_do_app').run=async()=>{writes++;throw Error('after effect');};
 f.tools.map.get('ler_arquivo_do_app').run=async()=>{reads++;return {ok:true};};
 const p={name:'f',complete:async()=>{n++;return {stop:'tool',toolCalls:[{id:'one',name:'escrever_arquivo_do_app',args:{caminho:'a',conteudo:'x'}},{id:'two',name:'ler_arquivo_do_app',args:{caminho:'a'}}],usage:{in:10,out:10}};}};
 const out=await builder(f,store,p).run({app:'demo',modo:'edicao',objetivo:'Alterar'});eq(out.app_build.motivo,'uncertain_action');eq(writes,1);eq(reads,0);eq(n,1);ok([...store.records.values()][0].pending.mutating);
}
console.log(`PASS ${checks} real-hosting/task isolation and concurrency checks (offline)`);
