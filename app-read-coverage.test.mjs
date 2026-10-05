import assert from 'node:assert/strict';import fs from 'node:fs';import {createHash} from 'node:crypto';
import {ToolRegistry} from './core-proto/core.mjs';import {filePage} from './core-proto/file-page.mjs';
import {createReadCoverage,closingContext} from './web/app-read-coverage.mjs';import {runAppTask} from './web/app-task-runner.mjs';import {appTaskReceipt as detailedReceipt} from './web/app-review-receipt.mjs';
const appTaskReceipt=(build,lang)=>detailedReceipt(build,lang,{technicalDetails:true});
let checks=0;const eq=(a,b)=>{assert.deepEqual(a,b);checks++;};const ok=(x,msg)=>{assert.ok(x,msg);checks++;};
const hash=s=>createHash('sha256').update(s).digest('hex').slice(0,12);
const memory=()=>{const records=new Map();return {records,async withTask(k,f){return f({id:k,record:structuredClone(records.get(k)||null),save:async r=>records.set(k,structuredClone(r))});}};};
const step=(name,args={},id='x')=>({stop:'tool',toolCalls:[{name,args,id}],usage:{in:100,out:10}});
const end={stop:'end',text:'Parecer estático.',usage:{in:100,out:10}};
function fixture(files){let reads=0,writes=0,allowed=true;const r=new ToolRegistry();r.add({name:'listar_arquivos_do_app',parameters:{},run:async()=>allowed?{ok:true,alvo_validacao:'owner:demo',arquivos:Object.entries(files).map(([caminho,s])=>({caminho,hash:hash(s)}))}:{ok:false}});
 r.add({name:'ler_arquivo_do_app',parameters:{},run:async args=>{reads++;const s=files[args.caminho];return filePage({content:s,arquivo:args.caminho,hash:hash(s),bytes:s.length,inicio:args.inicio||0,limite:args.limite||6000,hash_esperado:args.hash_esperado});}});
 for(const name of ['escrever_arquivo_do_app','publicar_sistema','chamar_sistema'])r.add({name,parameters:{},run:async()=>{writes++;return {ok:true};}});
 return {r,files,get reads(){return reads;},get writes(){return writes;},deny(){allowed=false;}};
}
function report(input,extra=[]){eq(input.tools.map(x=>x.name),['registrar_parecer_do_app']);const d=JSON.parse(input.messages[0].content);ok(d.evidencias.length);ok(input.messages[0].content.length<=54000);return step('registrar_parecer_do_app',{itens:[{assunto:'Trecho consultado',avaliacao:'nao_verificado',observacao:'Comportamento em navegador não verificado nesta análise estática.',evidencias:[d.evidencias[0].id]},...extra]});}
const args=(f,store,provider,limits={})=>({store,scope:'scope',objetivo:'Revisão estática sem alterações',mode:'revisao',tools:f.r,provider,system:'fixture',limits});
// Union counts bytes once, regardless of overlapping cursors; hash change is new content.
{
 const c=createReadCoverage();const read=(inicio,fim,h='h')=>c.observe({ok:true,arquivo:'a',hash:h,inicio,fim,total_chars:100});
 eq(read(0,60).novos_chars,60);eq(read(20,40).novos_chars,0);eq(read(40,90).novos_chars,30);eq(read(90,100).novos_chars,10);eq(c.summary()[0].chars_consultados,100);ok(c.summary()[0].completo);
 eq(read(0,10,'changed').novos_chars,10);eq(c.summary().length,1);eq(c.summary()[0].chars_consultados,10);
 const resumed=createReadCoverage(c.snapshot());eq(resumed.observe({ok:true,arquivo:'a',hash:'changed',inicio:2,fim:8}).novos_chars,0);
 eq(c.observe({ok:false,arquivo:'a',hash:'x',inicio:0,fim:99}),null);
 eq(c.add({arquivo:'a',hash:'x',inicio:-1,fim:10}),0);
}
// Reproduce the actual 57 distinct page requests on SYNTHETIC source, not user code.
{
 const pages=JSON.parse(fs.readFileSync('test-fixtures/app-review-overlapping-reads.json','utf8'));eq(pages.length,57);
 const files=Object.fromEntries(pages.map(x=>[x.arquivo,('// synthetic marker\n'+'x'.repeat(x.total_chars)).slice(0,x.total_chars)]));const f=fixture(files),store=memory();let main=0,closing=0,duplicateReceipts=0;const charged=[];
 const p={name:'f',complete:async input=>{if(input.system.startsWith('Você está FECHANDO')){closing++;return report(input);}
  for(const m of input.messages.slice(-2))if(m.role==='tool'){try{const d=JSON.parse(m.content);if(d.cobertura_leitura?.ja_consultado){ok(d.conteudo.startsWith('[trecho já lido'));duplicateReceipts++;}}catch(e){if(e instanceof assert.AssertionError)throw e;}}
  ok(main<pages.length);const x=pages[main++];return step('ler_arquivo_do_app',{caminho:x.arquivo,inicio:x.inicio,limite:x.fim-x.inicio,hash_esperado:hash(files[x.arquivo])},String(main));}};
 const out=await runAppTask({...args(f,store,p),onUsage:u=>charged.push(u)});
 eq(out.app_build.motivo,'read_coverage_loop');ok(main<57);eq(closing,1);ok(duplicateReceipts>0);eq(out.app_build.parecer.length,1);eq(f.writes,0);eq(out.app_build.publicado,false);eq(charged.filter(x=>x.kind==='app_report').length,1);eq(charged.at(-1).noBill,false);
 const server=out.app_build.cobertura_resumo.find(x=>x.arquivo==='server.js');eq(server.chars_consultados,12024);ok(appTaskReceipt(out.app_build).includes('Trecho consultado'));
 console.log('Observed-pattern main calls='+main+' closing='+closing+' versus 57 page requests in the failed run');
}
// Reserve closing within existing task tokens/calls, not a larger allowance.
{
 const files=Object.fromEntries(Array.from({length:40},(_,i)=>['f'+i,'function marker() {}']));const f=fixture(files),store=memory();let n=0,closing=0;const p={name:'f',complete:async input=>{if(input.system.startsWith('Você está FECHANDO')){closing++;return report(input);}const x=step('ler_arquivo_do_app',{caminho:'f'+n++});x.usage={in:20000,out:10000};return x;}};
 const out=await runAppTask(args(f,store,p,{tokens:250000,calls:20}));eq(out.app_build.motivo,'task_budget');eq(closing,1);eq(out.app_build.parecer.length,1);ok(out.app_build.orcamento.tokens_contabilizados<=250000);ok(out.app_build.orcamento.chamadas<=20);eq(store.records.get('scope').extraBudget,undefined);ok(250000-n*30000>=65000,'Exploration must leave the reporting reserve intact');
}
// Legacy paused checkpoint (956893 tokens): close from saved evidence without new reads/model work or reset.
{
 const f=fixture({'a.js':'function marker() {}'}),store=memory();let n=0;
 await runAppTask({...args(f,store,{name:'f',complete:async()=>{n++;return step('ler_arquivo_do_app',{caminho:'a.js'});}}),shouldPause:async()=>n>=1});
 const t=store.records.get('scope');t.calls=58;t.tokens=956893;delete t.readCoverage;delete t.readSamples;t.report=[];let main=0,closing=0;
 const out=await runAppTask(args(f,store,{name:'f',complete:async input=>{if(input.system.startsWith('Você está FECHANDO')){closing++;return report(input);}main++;throw Error('No exploration budget remains');}}));
 eq(main,0);eq(closing,1);eq(out.app_build.orcamento.chamadas,59);ok(out.app_build.orcamento.tokens_contabilizados>=956893);ok(out.app_build.orcamento.tokens_contabilizados<=1000000);eq(out.app_build.parecer.length,1);eq(f.reads,1);
}
// An explicitly configured task bound is still honored; it is not a default account policy.
{
 const f=fixture({'a.js':'x'}),store=memory();let n=0;await runAppTask({...args(f,store,{name:'f',complete:async()=>{n++;return step('ler_arquivo_do_app',{caminho:'a.js'});}}),shouldPause:async()=>n>=1});
 store.records.get('scope').tokens=1000000;let billed=0;const out=await runAppTask(args(f,store,{name:'f',complete:async()=>{billed++;return end;}},{tokens:1000000}));eq(billed,0);eq(out.app_build.orcamento.tokens_contabilizados,1000000);
}
// Incremental findings merge; final phase cannot invoke app tools or publish.
{
 const f=fixture({'a.js':'function marker() {}'}),store=memory();let n=0,closing=0;
 const out=await runAppTask(args(f,store,{name:'f',complete:async input=>{if(input.system.startsWith('Você está FECHANDO')){closing++;return step('escrever_arquivo_do_app',{caminho:'a.js',conteudo:'attack'});}n++;return n===1?step('ler_arquivo_do_app',{caminho:'a.js'}):end;}}));
 eq(closing,3);eq(f.writes,0);eq(out.app_build.parecer.length,0);ok(!appTaskReceipt(out.app_build).includes('attack'));
}
// Revocation or incoming message excludes all closing calls.
for(const mode of ['revoke','new_input']){
 const f=fixture({'a.js':'x'}),store=memory();let n=0,closing=0;const out=await runAppTask({...args(f,store,{name:'f',complete:async input=>{if(input.system.startsWith('Você está FECHANDO')){closing++;return report(input);}n++;if(n===2&&mode==='revoke')f.deny();return n===1?step('ler_arquivo_do_app',{caminho:'a.js'}):end;}}),shouldPause:async()=>mode==='new_input'&&n>=1});
 eq(closing,0);eq(f.writes,0);if(mode==='revoke')eq(out.app_build.cobertura_resumo.length,0);
}
// Bounded closing context must distinguish visible excerpts from prior read references.
{
 const evidence=new Map(Array.from({length:150},(_,i)=>['e'+i,{arquivo:'a.js',hash:'h',inicio:i*100,fim:i*100+100}]));
 const content=closingContext({objective:'x',evidence,report:[],coverage:[],messages:[{role:'tool',name:'ler_arquivo_do_app',content:JSON.stringify({ok:true,arquivo:'a.js',hash:'h',inicio:0,fim:100,conteudo:'x'.repeat(100)})}],maxChars:6000});ok(content.length<=6000);const d=JSON.parse(content);ok(d.evidencias.length>0);ok(d.regra.includes('não prova semântica'));
}
// Repeated intervals in a single batch stop before the following tool can run.
{
 const f=fixture({'a.js':'x'.repeat(6000)}),store=memory();let main=0,closing=0;
 const p={name:'f',complete:async input=>{if(input.system.startsWith('Você está FECHANDO')){closing++;return report(input);}main++;return {stop:'tool',usage:{in:100,out:10},toolCalls:Array.from({length:6},(_,i)=>({id:String(i),name:'ler_arquivo_do_app',args:{caminho:'a.js',inicio:i*10,limite:6000-i*10,hash_esperado:hash(f.files['a.js'])}}))};}};
 const out=await runAppTask(args(f,store,p));eq(main,1);eq(closing,1);eq(f.reads,4);eq(out.app_build.motivo,'read_coverage_loop');eq(out.app_build.parecer.length,1);
}
// Incremental report entries survive subsequent report calls and normal completion.
{
 const f=fixture({'a.js':'marker'}),store=memory();let n=0,id;
 const p={name:'f',complete:async input=>{n++;if(n===1)return step('ler_arquivo_do_app',{caminho:'a.js'});if(n===2)id=JSON.parse(input.messages.at(-1).content).evidencias[0];if(n<=3)return step('registrar_parecer_do_app',{itens:[{assunto:'Parte '+n,avaliacao:'nao_verificado',observacao:'Avaliação parcial.',evidencias:[id]}]});return end;}};
 const out=await runAppTask(args(f,store,p));eq(out.app_build.parecer.length,2);eq(n,4);eq(out.app_build.motivo,'completed');
}
// A pruned history marker must not hide the same real excerpt kept in the bounded cache.
{
 const ref={arquivo:'a.js',hash:'h',inicio:0,fim:6,total_chars:6};const evidence=new Map([['e',ref]]);
 const full={role:'tool',name:'ler_arquivo_do_app',content:JSON.stringify({ok:true,...ref,conteudo:'marker'})};
 const pruned={...full,content:JSON.stringify({ok:true,...ref,conteudo:'[trecho já lido, recolhido para poupar contexto]'})};
 const d=JSON.parse(closingContext({objective:'x',evidence,report:[],coverage:[],messages:[full,pruned]}));eq(d.trechos.length,1);eq(d.trechos[0].trecho,'marker');
}
console.log(`PASS ${checks} coverage, saved evidence and reserved reporting checks (offline)`);
