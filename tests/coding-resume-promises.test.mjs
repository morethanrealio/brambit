// Synthetic/offline. Exact observed final sentence with fictional app context.
import assert from 'node:assert/strict';
import { codingPromise, codingTurnContext } from '../core-proto/turn-recovery.mjs';
import { runAgent, ToolRegistry } from '../core-proto/core.mjs';
import { makeConstruirAppTool } from '../web/coding-subagent.mjs';
import { createAppBuildJournal } from '../web/app-build-state.mjs';
import { validateDraft } from '../web/app-draft-validation.mjs';
import { gateTool, takePending } from '../web/confirm.mjs';
let checks=0;const ok=(x,m)=>{assert.ok(x,m);checks++;};const eq=(a,b)=>{assert.deepEqual(a,b);checks++;};
const literal='Vou retomar essa verificação agora e já te digo o resultado.';
const context='O rascunho do app demo precisa de validação; pode retomar. Não publique.';
const defs=[{name:'construir_app'}];
const positives=[literal,'Vou validar o rascunho agora.','Já estou verificando o app.','Estou retomando essa verificação.','Vou reconferir o código agora.','Vou continuar essa validação agora.','Retomo essa verificação agora.','Reconfiro o rascunho agora.','Vou verificar o app agora e, se passar, te peço confirmação.','A validação do rascunho está em andamento.','A verificação do app segue rodando.','Vou testar o app agora.','Vou retomar de onde parei agora.'];
for(const s of positives)ok(codingPromise(s,defs,context),s);
for(const s of positives)eq(codingPromise(s,[],context),false);
const negatives=['O código está válido agora.','Um rascunho válido agora não prova funcionamento.','Ele disse que vou validar o app agora.','Você disse que a validação do app está em andamento.','Posso retomar essa verificação agora?','Você quer que eu valide o app?','Se você quiser, vou retomar essa verificação agora.','Quando você autorizar, vou validar o rascunho agora.','Assim que você autorizar, vou verificar o app agora.','Vou validar o rascunho depois da confirmação.','Vou verificar o app amanhã.','Já verifiquei o rascunho ontem.','Não estou validando o app.','Nunca vou retomar essa verificação agora.','A validação do rascunho não está rodando.','> '+literal,'"'+literal+'"','“'+literal+'”','```text\n'+literal+'\n```','Exemplo:\n'+literal,'Rascunho: '+literal,'Texto sugerido: '+literal,'Plano: depois vamos validar o rascunho.','O rascunho foi validado. Posso publicar?','Faltou o nome do app: qual devo verificar?'];
for(const s of negatives)eq(codingPromise(s,defs,context),false);
for(const s of ['Vou verificar a previsão agora.','Vou retomar minhas férias agora.','Vou validar seu CPF agora.','Estou conferindo o calendário.'])eq(codingPromise(s,defs,context),false);
eq(codingPromise(literal,[{name:'abrir_ferramentas'}]),false); // No coding context or explicit code target.
eq(codingPromise('O rascunho do app está salvo.\n'+literal,[{name:'abrir_ferramentas'}]),true);
ok(!codingTurnContext([{role:'tool',content:'private code/app payload'},{role:'user',content:'Oi'}]).includes('private'));
const fake=answers=>({name:'offline',complete:async()=>{ok(answers.length>0);return answers.shift();}});
const call=(name='construir_app',args={app:'demo',objetivo:'Verificar o rascunho, preservar preferências; não publicar.'},id='b')=>({stop:'tool',toolCalls:[{name,args,id}]});
// Pre-delivery repair once, under unchanged limit, for both accounts/providers.
for(const account of ['fixture-A','fixture-B'])for(const first of [literal,'Vou validar o rascunho agora.']){
 let builds=0,calls=0;const events=[];
 const reg=new ToolRegistry().add({name:'construir_app',parameters:{},run:async args=>{builds++;ok(args.objetivo.includes('não publicar'));return {ok:false,app_build:{version:1,estado:'nao_validado'}};}});
 const j=createAppBuildJournal();
 const r=await runAgent({tools:reg,userInput:'Vamos tentar de novo?',history:[{role:'assistant',content:context}],system:account,maxSteps:5,transformToolResult:(c,o)=>j.toolResult(c,o),onEvent:e=>events.push(e),provider:{name:'offline',complete:async({messages,system})=>{
 calls++;if(calls===1)return {stop:'end',text:first};if(calls===2){ok(system.includes('answer NOT sent yet'));ok(messages.some(m=>m.content.includes('Não publique')));return call();}return {stop:'end',text:'Ainda não validei o rascunho.'};}}});
 eq(builds,1);eq(calls,3);ok(!events.some(e=>['assistant','end'].includes(e.type)&&e.text===first));ok(!r.messages.some(m=>m.content===first));ok(j.finish(r.text).includes('Ainda não consegui validar'));
}
// Unavailable builder can disclose once, without an extra workflow or paid retry.
{
 const reg=new ToolRegistry();let opened=0,built=0;
 reg.add({name:'abrir_ferramentas',parameters:{},run:async()=>{opened++;reg.add({name:'construir_app',parameters:{},run:async()=>{built++;return 'Checked';}});return 'codigo disponível';}});
 const r=await runAgent({tools:reg,userInput:context,provider:fake([{stop:'end',text:literal},call('abrir_ferramentas',{grupo:'codigo'},'open'),call(),{stop:'end',text:'Verificação encerrada.'}])});eq(opened,1);eq(built,1);eq(r.termination,'completed');
}
// Repeated promise, step exhaustion and salvage cannot resurrect background work.
for(const maxSteps of [1,2,12]){
 let calls=0,builds=0;
 const r=await runAgent({tools:new ToolRegistry().add({name:'construir_app',parameters:{},run:async()=>{builds++;}}),userInput:context,maxSteps,provider:{name:'offline',complete:async()=>{calls++;return {stop:'end',text:literal};}}});
 eq(calls,Math.min(maxSteps,2));eq(builds,0);ok(r.text.includes('Não iniciei'));eq(r.messages.at(-1).content,r.text);
}
{
 let builds=0;const reg=new ToolRegistry().add({name:'construir_app',parameters:{},run:async()=>{builds++;return 'ERRO: sem acesso';}});
 const r=await runAgent({tools:reg,userInput:context,maxSteps:1,provider:fake([call(),{stop:'end',text:literal}])});eq(builds,1);ok(r.text.includes('chamada de programação'));ok(!r.text.includes('já te digo'));
}
// Provider failing during repair retains metering and does not retry service.
{
 let calls=0;const r=await runAgent({tools:new ToolRegistry().add({name:'construir_app',parameters:{},run:async()=>{throw Error('must not execute');}}),userInput:context,provider:{name:'offline',complete:async()=>{calls++;if(calls===1)return {stop:'end',text:literal,usage:{inputTokens:10}};throw Error('private');}}});eq(calls,2);eq(r.usages.length,1);ok(!r.text.includes('private'));ok(r.text.includes('falhou'));
}
// Late cancellation wins before repair; clarification consumes no extra call.
{
 let polls=0,calls=0,builds=0;const reg=new ToolRegistry().add({name:'construir_app',parameters:{},run:async()=>{builds++;}});
 const r=await runAgent({tools:reg,userInput:context,pollNewUserMsg:async()=>++polls===2?'Cancele. Não altere nada.':null,provider:{name:'offline',complete:async({messages})=>{calls++;if(calls===1)return {stop:'end',text:literal};ok(messages.some(m=>m.raw?.includes('Cancele')));return {stop:'end',text:'Cancelado. Nenhuma alteração iniciada.'};}}});eq(builds,0);eq(calls,2);ok(r.text.includes('Cancelado'));
}
for(const text of negatives){let n=0;const r=await runAgent({tools:new ToolRegistry().add({name:'construir_app',parameters:{},run:async()=>{throw Error('must not execute');}}),userInput:context,provider:{name:'offline',complete:async()=>{n++;return {stop:'end',text};}}});eq(n,1);eq(r.text,text);}
// Actual nested builder validates, actual publication gate still does not publish.
{
 let validations=0,publishes=0;
 const validation=validateDraft({'public/index.html':Buffer.from('<p>Fixture</p>').toString('base64')});
 const sub=new ToolRegistry().add({name:'validar_rascunho_do_app',parameters:{},run:async()=>{validations++;return validation;}});
 const builder=makeConstruirAppTool({compact:false,buildAppContext:async()=>({tools:sub,provider:fake([call('validar_rascunho_do_app',{nome_do_sistema:'demo'},'v'),{stop:'end',text:'Consistência validada; não publicado.'}])})});
 const reg=new ToolRegistry().add(builder).add(gateTool({name:'publicar_sistema',parameters:{},run:async()=>{publishes++;return {ok:true};}},'fixture-resume-gate'));
 const j=createAppBuildJournal();const guarded={get defs(){return reg.defs;},run:(name,args)=>(name==='publicar_sistema'?j.blockPublish():null)||reg.run(name,args)};
 const r=await runAgent({tools:guarded,userInput:context,transformToolResult:(c,o)=>j.toolResult(c,o),provider:fake([{stop:'end',text:literal},call(),call('publicar_sistema',{nome_do_sistema:'demo',runtime:'node'},'p'),{stop:'end',text:'Posso publicar?'}])});
 eq(validations,1);eq(publishes,0);ok(takePending('fixture-resume-gate'));ok(j.finish(r.text).includes('aguarda sua confirmação'));ok(j.finish(r.text).includes('consistência'));
}
console.log(`PASS ${checks} resume checks: exact promise, contextual scope, core recovery, limits, cancellation, real nested validator and publication gate; offline only`);
