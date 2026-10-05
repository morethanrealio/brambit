import test from 'node:test';import assert from 'node:assert/strict';
import {runAgent,ToolRegistry} from './core-proto/core.mjs';
import {runAppTask,APP_CODING_COMPACT_TOKENS} from './web/app-task-runner.mjs';
import {createCodingContext,visibleCodeCoverage,DEFAULT_CODING_CONTEXT_CHARS} from './web/coding-context.mjs';
import {filePage,retainedFilePage} from './core-proto/file-page.mjs';
import {fixture,memory,step,read,options,hash} from './test-support/coding/context-fixture.mjs';
const full=d=>JSON.parse(d.content).conteudo;
test('default input working set and compaction trigger are doubled for app coding',async()=>{
 assert.equal(DEFAULT_CODING_CONTEXT_CHARS,144000);assert.equal(APP_CODING_COMPACT_TOKENS,48000);
 const f=fixture(),store=memory(),task={id:'doubled-default'},ctx=createCodingContext({store,scope:'doubled',task,persist:async()=>{},currentAccess:f.listing});
 const result=JSON.stringify({ok:true,resultado:'x'.repeat(109557)}),messages=[{role:'tool',name:'resultado_sintetico',content:result}];
 await ctx.prepare({messages,consumedUpTo:1});assert.equal(messages[0].content,result);assert.equal(task.contextStats.archived,0,'the current Naval Strike raw size fits the doubled working set');
 assert.throws(()=>createCodingContext({store,scope:'invalid',task:{id:'invalid'},persist:async()=>{},maxChars:144001,currentAccess:f.listing}),/Invalid coding context bound/);
});
test('coding preserves old file pages below working-set bound instead of removing after four messages',async()=>{
 const f=fixture(),store=memory();let n=0;const provider={complete:async input=>{
  n++;if(n===1)return step([read(f,'server.js',0),read(f,'server.js',6000)],n);
  if(n===2)return step([read(f,'game.js',0),read(f,'game.js',6000),read(f,'game.js',12000)],n);
  if(n===3){const server=input.messages.filter(x=>x.role==='tool'&&x.name==='ler_arquivo_do_app').map(x=>JSON.parse(x.content)).filter(x=>x.arquivo==='server.js');assert.equal(server.length,2);assert.ok(server.every(x=>x.conteudo.startsWith('SERVER')));return step([{name:'editar_arquivo_do_app',args:{caminho:'server.js'}}],n);}
  if(n===4)return step([{name:'validar_rascunho_do_app',args:{}}],n);return {stop:'end',text:'Edited and statically checked; not runtime-tested'};
 }};
 const result=await runAppTask(options(f,store,provider));assert.equal(result.app_build.motivo,'completed');assert.equal(f.writes,1);
});
test('production failure trace: evicted code can be recovered in three distinct windows then edited',async()=>{
 const f=fixture(),store=memory();let n=0,evicted=false;const provider={complete:async input=>{
  n++;if(n===1)return step([read(f,'server.js',0),read(f,'server.js',6000)],n);
  if(n===2)return step([read(f,'game.js',0),read(f,'game.js',6000),read(f,'game.js',12000)],n);
  if(n===3){evicted=input.messages.some(x=>x.role==='tool'&&x.content.includes('contexto_recolhido'));assert.equal(evicted,true);}
  if(n<=5)return step([read(f,'server.js',(n-3)*3000,3000)],n);
  if(n===6)return step([{name:'editar_arquivo_do_app',args:{caminho:'server.js'}}],n);
  if(n===7)return step([{name:'validar_rascunho_do_app',args:{}}],n);return {stop:'end',text:'Edited and checked'};
 }};
 const result=await runAppTask(options(f,store,provider,{limits:{contextChars:12000}}));assert.equal(result.app_build.motivo,'completed');assert.equal(f.writes,1);assert.equal(f.reads,5,'recovered windows come from version-checked private cache');assert.ok(Object.keys((await store.read('fixture')).contextArtifacts).length);
});
test('ordinary parent core retains its existing policy without a coding context owner',async()=>{
 let n=0,saw=false;const f=fixture();await runAgent({tools:f.tools,provider:{complete:async input=>{n++;if(n===1)return step([read(f,'server.js',0),read(f,'server.js',6000)],n);if(n===2)return step([read(f,'game.js',0),read(f,'game.js',6000),read(f,'game.js',12000)],n);saw=input.messages.some(m=>m.role==='tool'&&m.content.includes('recolhido'));return {stop:'end',text:'done'};}},userInput:'read'});assert.equal(saw,true);
});
test('same visible reads still stop a real loop; changing cursor over visible data does not mint progress',async()=>{
 const f=fixture(),store=memory();let n=0;const provider={complete:async()=>{n++;return step([read(f,'server.js',n===1?0:n-2,n===1?6000:3000)],n)}};
 const result=await runAppTask(options(f,store,provider));assert.equal(result.app_build.motivo,'read_coverage_loop');assert.equal(f.writes,0);assert.ok(n<=4);
});
test('legacy paused classifier is migrated once without clearing calls, evidence or unknown effects',async()=>{
 const f=fixture(),store=memory();let n=0;
 await runAppTask(options(f,store,{complete:async()=>{n++;return step([read(f,'server.js',0)],n)}},{shouldPause:async()=>n===1}));
 const old=store.data.get('fixture');old.editReadState.consecutive=3;delete old.editReadState.contextPolicy;old.history=old.history.map(m=>m.role==='tool'&&m.name==='ler_arquivo_do_app'?{...m,content:retainedFilePage(m.content)}:m);old.lastResult.app_build.motivo='read_coverage_loop';const before=old.calls;
 let calls=0;const result=await runAppTask(options(f,store,{complete:async()=>{calls++;return calls===1?step([read(f,'server.js',0)],calls):calls===2?step([{name:'editar_arquivo_do_app',args:{caminho:'server.js'}}],calls):calls===3?step([{name:'validar_rascunho_do_app',args:{}}],calls):{stop:'end',text:'done'};}},{executionId:'resume'}));
 assert.equal(result.app_build.motivo,'completed');assert.equal((await store.read('fixture')).calls,before+4);assert.equal(f.writes,1);
 const blocked=store.data.get('fixture');blocked.status='paused';blocked.pending={mutating:true};blocked.lastExecutionId=null;delete blocked.editReadState.contextPolicy;
 const stop=await runAppTask(options(f,store,{complete:async()=>{throw Error('must not call model')}},{executionId:'unknown'}));assert.equal(stop.app_build.motivo,'uncertain_action');
});
async function archiveFixture(){const f=fixture(),store=memory(),task={id:'private-task'},persist=async()=>{};const ctx=createCodingContext({store,scope:'owner:thread',task,persist,maxChars:4000,currentAccess:f.listing});
 const d=await f.tools.run('ler_arquivo_do_app',{caminho:'server.js'});const messages=[{role:'tool',name:'ler_arquivo_do_app',content:JSON.stringify(d)}];await ctx.prepare({messages,consumedUpTo:1});const ref=JSON.parse(messages[0].content).ref;assert.ok(ref);return {f,store,task,ctx,ref,messages};}
test('archive survives controller recreation and lists references after summary forgot their IDs',async()=>{
 const a=await archiveFixture();const ctx=createCodingContext({store:a.store,scope:'owner:thread',task:structuredClone(a.task),persist:async()=>{},currentAccess:a.f.listing});
 const listing=await ctx.recover({});assert.equal(listing.resultados_arquivados[0].ref,a.ref);const recovered=await ctx.recover({ref:a.ref});assert.equal(recovered.conteudo,a.f.files['server.js'].slice(0,6000));assert.equal(recovered.contexto_recuperado,true);
 const fresh=createCodingContext({store:a.store,scope:'other-owner',task:{id:'other'},persist:async()=>{},currentAccess:a.f.listing});assert.equal((await fresh.recover({ref:a.ref})).ok,false);assert.equal((await fresh.recover({ref:'__proto__'})).ok,false);
});
test('changed file or revoked access never returns archived code as current',async()=>{
 const a=await archiveFixture();a.f.files['server.js']='changed';assert.equal((await a.ctx.recover({ref:a.ref})).ok,false);assert.equal(await a.ctx.cachedRead({caminho:'server.js'},await a.f.listing()),null);
 a.f.revoke();assert.equal((await a.ctx.recover({})).ok,false);
});
test('tampered private artifact fails closed',async()=>{
 const a=await archiveFixture();for(const [key,value] of a.store.data)if(key.startsWith('["coding-context",'))value.text='corrupt';await assert.rejects(()=>a.ctx.recover({ref:a.ref}),/Invalid coding context artifact/);
});
test('visibility excludes compacted markers and respects actual available intervals',()=>{
 const page=filePage({content:'x'.repeat(6000),arquivo:'a',hash:'h',bytes:6000});const query={ok:true,arquivo:'a',hash:'h',inicio:1000,fim:2000};assert.equal(visibleCodeCoverage([{role:'tool',content:JSON.stringify(page)}]).observe(query).novos_chars,0);assert.equal(visibleCodeCoverage([{role:'tool',content:retainedFilePage(JSON.stringify(page))}]).observe(query).novos_chars,1000);
});
test('new results are never archived before first exposure to the model',async()=>{
 const a=await archiveFixture();const fresh=await a.f.tools.run('ler_arquivo_do_app',{caminho:'game.js'});const messages=[{role:'tool',name:'ler_arquivo_do_app',content:JSON.stringify(fresh)}];await a.ctx.prepare({messages,consumedUpTo:0});assert.equal(JSON.parse(messages[0].content).conteudo,fresh.conteudo);
});
test('context thrashing cannot buy unlimited progress by repeatedly evicting and recovering the same code',async()=>{
 const f=fixture(),store=memory();let n=0;const provider={complete:async()=>{n++;return step([read(f,n%2?'server.js':'game.js',0)],n)}};
 const input=options(f,store,provider,{limits:{contextChars:4000}});
 const first=await runAppTask(input);assert.equal(first.app_build.motivo,'execution_quantum');
 const result=await runAppTask(input);
 assert.equal(result.app_build.motivo,'no_progress');assert.ok(n<=80);assert.equal(f.writes,0);assert.equal(f.reads,2);
});
test('cached slices preserve UTF-16 boundaries and still reject a stale expected hash',async()=>{
 const a=await archiveFixture();a.f.files['server.js']='a'.repeat(5999)+'😀'+'b'.repeat(20);const task={id:'utf'},ctx=createCodingContext({store:a.store,scope:'utf',task,persist:async()=>{},maxChars:4000,currentAccess:a.f.listing});
 const page=await a.f.tools.run('ler_arquivo_do_app',{caminho:'server.js'}),messages=[{role:'tool',name:'ler_arquivo_do_app',content:JSON.stringify(page)}];await ctx.prepare({messages,consumedUpTo:1});
 const out=await ctx.cachedRead({caminho:'server.js',limite:6000},await a.f.listing());assert.equal(out.fim,6001);assert.ok(out.conteudo.endsWith('😀'));
 assert.equal(await ctx.cachedRead({caminho:'server.js',hash_esperado:'wrong'},await a.f.listing()),null);
 assert.equal(await ctx.cachedRead({caminho:'server.js',inicio:6000,hash_esperado:hash(a.f.files['server.js']),limite:1},await a.f.listing()),null);
});
test('read recovery hook cannot exempt a mutating tool from the core replay guard',async()=>{
 let writes=0,calls=0;const tools=new ToolRegistry().add({name:'escrever_arquivo_do_app',run:async()=>{writes++;return {ok:true}}});
 const r=await runAgent({tools,userInput:'edit',salvage:false,control:{isContextRecovery:()=>true},provider:{complete:async()=>{calls++;return step([{name:'escrever_arquivo_do_app',args:{caminho:'a',conteudo:'x'}}],calls)}}});assert.equal(writes,2);assert.ok(calls<=3);assert.notEqual(r.termination,'completed');
});
test('large executed write arguments are archived without changing call IDs or provider metadata, and recovered only as historical pages',async()=>{
 const a=await archiveFixture(),value='code'.repeat(15000);const call={id:'fixed',name:'escrever_arquivo_do_app',args:{caminho:'a',conteudo:value},meta:{thoughtSignature:'provider-signature'}};
 const messages=[{role:'assistant',toolCalls:[call],content:''},{role:'tool',name:call.name,toolCallId:call.id,content:'{"ok":true}'}];await a.ctx.prepare({messages,consumedUpTo:2});
 assert.equal(call.id,'fixed');assert.equal(call.meta.thoughtSignature,'provider-signature');assert.ok(call.args.conteudo.length<400);const ref=call.args.conteudo.match(/ref=([a-f0-9]{64})/)[1];
 const first=await a.ctx.recover({ref}),second=await a.ctx.recover({ref,inicio:first.proximo_inicio});assert.equal(first.contexto_historico,true);assert.equal(first.trecho,value.slice(0,12000));assert.equal(second.trecho,value.slice(12000,24000));assert.equal(a.f.writes,0);
});
test('unchanged cached file may be restored after another file changes, with current app revision',async()=>{
 const a=await archiveFixture();a.f.files['game.js']+='\nchanged';const r=await a.ctx.recover({ref:a.ref});assert.equal(r.ok,true);assert.equal(r.revisao,a.f.revision());assert.equal(r.conteudo,a.f.files['server.js'].slice(0,6000));
});
