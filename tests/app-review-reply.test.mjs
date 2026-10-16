import test from 'node:test';import assert from 'node:assert/strict';
import {appTaskReceipt} from '../web/app-review-receipt.mjs';
import {createAppBuildJournal} from '../web/app-build-state.mjs';
import {validateAppReport,plainReviewExplanation} from '../web/app-report-validation.mjs';
import {runAppTask} from '../web/app-task-runner.mjs';import {ToolRegistry} from '../core-proto/core.mjs';
const ref={arquivo:'server.js',hash:'abc',inicio:0,fim:30,total_chars:30},evidence=new Map([['r',ref]]);
const explanation='Os jogadores entram na mesma sala, mas o código analisado não mostra troca de informações da partida entre eles.';
const item={assunto:'Sincronização',avaliacao:'problema_observado',observacao:'O trecho define salas locais.',explicacao_usuario:explanation,evidencias:['r']};
const accepted=()=>validateAppReport({itens:[item]},evidence).accepted;
const build={version:2,modo:'revisao',estado:'interrompido',motivo:'read_coverage_loop',validacao:'pendente',parecer:accepted(),parecer_resultado:{status:'accepted'},pendencias_revisao:['server.js'],revisao:'a'.repeat(64),publicado:false,background:false};
for(const lang of ['pt-BR','en','es'])test(`review diagnosis ${lang}: bounded, one clue, incomplete, never a publication offer`,()=>{
 const many={...build,parecer:Array.from({length:11},(_,i)=>({...accepted()[0],assunto:'Technical '+i})),cobertura_resumo:[{arquivo:'PRIVATE_FILE',chars_consultados:9,total_chars:10}]};const before=structuredClone(many);const text=appTaskReceipt(many,lang);assert.ok(text.length<650);assert.equal(text.split(explanation).length-1,1);assert.ok(!text.includes('Technical'));assert.ok(!text.includes('PRIVATE_FILE'));assert.ok(!/boot|runtime|validação estática|hash|server\.js|Quer publicar/.test(text));assert.deepEqual(many,before);if(lang==='pt-BR'){assert.ok(text.includes('incompleta'));assert.ok(text.includes('Parei'));assert.ok(text.includes('preciso completar'));}
});
test('legacy reports never dump technical observations to fill the missing plain summary',()=>{
 const old=accepted().map(({explicacao_usuario,...x})=>({...x,observacao:'PRIVATE_RAW_CODE'}));const text=appTaskReceipt({...build,parecer:old});assert.ok(text.length<350);assert.ok(text.includes('pontos que podem explicar'));assert.ok(!text.includes('PRIVATE_RAW_CODE'));
});
test('optional explanation cannot invalidate findings or trigger report repair',()=>{
 for(const bad of ['x'.repeat(221),'publiquei tudo','<script>x</script>','server.js offset 123','https://bad.invalid','a\nb','`code`']){const v=validateAppReport({itens:[{...item,explicacao_usuario:bad}]},evidence);assert.equal(v.accepted.length,1);assert.deepEqual(v.diagnostics,[]);assert.equal(v.accepted[0].explicacao_usuario,undefined);assert.equal(plainReviewExplanation(bad),null);}
});
test('an explanation never waives original evidence and finding validation',()=>{
 for(const patch of [{evidencias:['made-up']},{observacao:'publiquei o app'},{avaliacao:'problema_observado',evidencias:[]}])assert.equal(validateAppReport({itens:[{...item,...patch}]},evidence).accepted.length,0);
});
test('technical report remains explicit and read-only',()=>{
 const j=createAppBuildJournal({userRequest:'Mostre os detalhes técnicos'});j.toolResult({name:'construir_app'},{app_build:build});const text=j.finish('Tudo funciona!');assert.ok(text.includes('Revisão estática'));assert.ok(text.includes('Sincronização'));assert.ok(!text.includes('Tudo funciona!'));assert.ok(j.blockPublish());
});
test('no stale clue on access loss or changed draft',()=>{
 for(const motivo of ['access_denied','target_changed','draft_changed']){const text=appTaskReceipt({...build,motivo});assert.ok(!text.includes(explanation));assert.ok(!text.includes('proposta de correção'));}
});
test('completed review with issues suggests a proposal, not automatic edits or publication',()=>{
 const b={...build,estado:'consistencia_validada',motivo:'completed',pendencias_revisao:[]};const j=createAppBuildJournal();j.toolResult({name:'construir_app'},{app_build:b});const text=j.finish('Corrigi tudo e publiquei');assert.ok(text.includes('Posso preparar uma proposta de correção?'));assert.ok(!text.includes('Corrigi'));assert.ok(!text.includes('Quer publicar'));assert.equal(j.blockPublish(),null); // existing gate policy unchanged
 for(const patch of [{pendencias_revisao:['missing']},{parecer_resultado:{status:'partial'}},{estado:'interrompido'}])assert.ok(appTaskReceipt({...b,...patch}).includes('incompleta'));
});
test('not verified is not a diagnosis; clean review is not functional acceptance',()=>{
 const unknown={...accepted()[0],avaliacao:'nao_verificado',evidencias:[]};assert.ok(!appTaskReceipt({...build,parecer:[unknown]}).includes(explanation));
 const text=appTaskReceipt({...build,estado:'consistencia_validada',motivo:'completed',pendencias_revisao:[],parecer:[{...accepted()[0],avaliacao:'sem_problema_observado'}]});assert.ok(text.includes('não comprova o funcionamento'));
});
test('credit/service failures remain distinct and actual publication status is preserved',()=>{
 for(const [motivo,part] of [['account_credit_exhausted','saldo de créditos acabou'],['credit_control_unavailable','não significa'],['credit_reconciliation_required','não repetir a cobrança'],['provider_failure','falha no serviço']])assert.ok(appTaskReceipt({...build,motivo}).includes(part));
 const j=createAppBuildJournal();j.toolResult({name:'construir_app'},{app_build:build});j.toolResult({name:'publicar_sistema'},'AÇÃO PENDENTE DE CONFIRMAÇÃO');assert.equal((j.finish('').match(/\?/g)||[]).length,1);j.toolResult({name:'publicar_sistema'},{ok:false});assert.ok(j.finish('').includes('não foi concluída'));j.toolResult({name:'publicar_sistema'},{ok:true});assert.equal(j.finish('Recibo real'),'Recibo real');
});
test('real runner accepts plain finding in existing report call without extra model requests',async()=>{
 let record=null,n=0;const store={withTask:async(_,fn)=>fn({id:'storage',record:structuredClone(record),save:async r=>{record=structuredClone(r);}})};const tools=new ToolRegistry();tools.add({name:'listar_arquivos_do_app',parameters:{},run:async()=>({ok:true,alvo_validacao:'owner',arquivos:[{caminho:'server.js',hash:'abc'}]})});tools.add({name:'ler_arquivo_do_app',parameters:{},run:async()=>({ok:true,...ref,conteudo:'const rooms = new Map();'})});
 const provider={complete:async input=>{n++;assert.ok(!input.tools.some(x=>x.name==='escrever_arquivo_do_app'));if(n===1)return {stop:'tool',toolCalls:[{id:'read',name:'ler_arquivo_do_app',args:{caminho:'server.js'}}],usage:{in:2,out:1}};if(n===2){const ids=JSON.parse(input.messages.at(-1).content).evidencias;return {stop:'tool',toolCalls:[{id:'report',name:'registrar_parecer_do_app',args:{itens:[{...item,evidencias:ids}]}}],usage:{in:2,out:1}};}return {stop:'end',text:'finished',usage:{in:2,out:1}};}};
 const out=await runAppTask({store,scope:'owner-app',objetivo:'Diagnosticar',mode:'revisao',tools,provider,system:'synthetic'});assert.equal(n,3);assert.equal(record.calls,3);assert.equal(record.tokens,9);assert.equal(out.app_build.parecer[0].explicacao_usuario,explanation);const j=createAppBuildJournal();j.toolResult({name:'construir_app'},out);assert.ok(j.finish('').includes(explanation));assert.ok(!j.finish('').includes('server.js'));
});
