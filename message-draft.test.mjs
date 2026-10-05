// Testes e dry-run OFFLINE. Não importa server.mjs; extrai só funções puras de
// orquestração. Nunca conecta DB/API/canais e nunca lê dados de clientes.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import net from 'node:net';
import tls from 'node:tls';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const denied = () => { throw Error('REAL I/O FORBIDDEN'); };
net.Socket.prototype.connect = denied; tls.connect = denied;
for (const n of ['exec', 'execSync', 'execFile', 'execFileSync', 'spawn', 'spawnSync', 'fork']) childProcess[n] = denied;
syncBuiltinESMExports(); globalThis.fetch = denied;
const { turnSearchCoverage, preserveSearchCoverageWarning } = await import('./web/turn-search-coverage.mjs');
const {throwIfCreditFailure}=await import('./web/execution-credit-errors.mjs');
const { generateMessageDraft, DraftUnavailableError } = await import('./web/message-draft.mjs');
const { deferIncomingWhileConfirmationPending, peekPending } = await import('./web/confirm.mjs');
const { createEmailAnswerReviewState } = await import('./web/email-answer-review.mjs');
const { HEALTH_GUARDRAIL } = await import('./web/health-guardrail.mjs');
let checks = 0;
const eq = (a,b,label) => { assert.deepEqual(a,b,label); checks++; };
const ok = (a,label) => { assert.ok(a,label); checks++; };
const rejects = async fn => { await assert.rejects(fn); checks++; };
function harness({ credit = { over: false }, response = { stop: 'end', text: 'Texto final' }, failure } = {}) {
 const calls = [];
 return { calls, args: {
  task: 'RASCUNHO: texto sintético',
  readCredit: async () => { calls.push('credit'); return credit; },
  readContext: async () => { calls.push('context'); return 'SYSTEM'; },
  makeProvider: () => { calls.push('factory'); return { complete: async input => {
   calls.push({ input }); if (failure) throw Error('MOCK_PROVIDER_ERROR'); return response;
  } }; },
  recordUsage: async usage => { calls.push({ usage }); },
 } };
}
for (const credit of [{over:true},null,{}, {over:0}]) {
 const h=harness({credit}); await rejects(()=>generateMessageDraft(h.args)); eq(h.calls,['credit'],'sem modelo/contexto/uso quando bloqueado');
}
for (const task of ['', '  ', null, 7]) { const h=harness(); await rejects(()=>generateMessageDraft({...h.args,task}));eq(h.calls,[]); }
{
 const usage={model:'mock',input:10,output:2}; const h=harness({response:{stop:'end',text:'  Texto final  ',usage}});
 eq(await generateMessageDraft(h.args),'Texto final');eq(h.calls.slice(0,3),['credit','context','factory']);
 eq(h.calls[3].input,{system:'SYSTEM',messages:[{role:'user',content:h.args.task}],tools:[]});eq(h.calls[4],{usage});eq(h.calls.length,5);
}
for (const response of [null,{}, {stop:'end',text:''},{stop:'end',text:5},{stop:'tool',text:'quase'}, {stop:'end',text:'não disponível',unavailable:true}, {stop:'end',text:'feito',toolCalls:[{name:'enviar_mensagem'}]}, {stop:'tool',toolCalls:[{name:'voltar_versao'}],usage:{model:'mock'}}]) {
 const h=harness({response});await rejects(()=>generateMessageDraft(h.args));eq(h.calls.filter(c=>c?.input).length,1,'nenhum segundo passo/tool-loop');
}
{const h=harness({failure:true});await rejects(()=>generateMessageDraft(h.args));eq(h.calls.length,4);}
for (const dep of ['readCredit','readContext','makeProvider']) {
 const h=harness();h.args[dep]=()=>{throw Error('MOCK_DEPENDENCY_FAILURE');};await rejects(()=>generateMessageDraft(h.args));eq(h.calls.filter(c=>c?.input).length,0);
}
// As funções de produção, com todas as dependências reais de efeitos proibidas.
const source=readFileSync(new URL('./web/server.mjs',import.meta.url),'utf8');
function fnText(name) {
 const start=source.search(new RegExp('(?:async )?function '+name+'\\('));const end=source.indexOf('\n}\n',start)+2;
 assert.ok(start>=0 && end>start);return source.slice(start,end);
}
const wrappers=['isolatedAgentDraft','runAgentMessageDraft','isListishText','whatsappProse','runConversationTurn','withFallback'];
let credit={over:false}, response={stop:'end',text:'Parágrafo reformulado',usage:{model:'mock'}}, failure=false, missingAgent=false;
let providerCalls=0, ledger=[], input, reads=[], geminiOpts=null, forced=null;
// Só os nomes referenciados pelo caminho isolado são fornecidos. Acesso a
// montagem de tools, créditos do chat, confirmação, memória ou delivery falha.
const deps={
 DEEPSEEK_AGENT_MODEL: 'deepseek41flash', selectedDeepSeek:()=>null, configurado:()=>null, modelosCfg:null, hasProviderExecution:()=>true,isDeepSeekTurn:()=>false,gasto:{vincular:({provider})=>provider},
 turnSearchCoverage, preserveSearchCoverageWarning, throwIfCreditFailure,
 generateMessageDraft, getAgentOwned:async(a,u)=>{reads.push(['agent',a,u]);return missingAgent?null:{id:a,name:'BetoMock',owner:'PessoaMock',system_prompt:'voz pessoal'};},
 getCreditStatus:async u=>{reads.push(['credit',u]);return credit;},
 getUserLocale:async()=>({language:'pt-BR'}),getWikiPage:async(u,slug)=>{reads.push(['wiki',u,slug]);return {body:'Preferência sintética'};},
 comIdioma:(s,l)=>s+'\nIDIOMA='+l,
 forcedAgentProvider:()=>forced,
 makePrimaryProvider:()=>({complete:async args=>{providerCalls++;input=args;if(failure)throw Error('MOCK_PROVIDER_ERROR');return response;}}),
 geminiEnabled:()=>true, makeGemini:opts=>{geminiOpts=opts;return deps.makePrimaryProvider();},
 recordUsages:async(...args)=>ledger.push(args),randomUUID:()=> 'mock-turn',
 STOP:{END:'end'},console:{error:()=>{}},
 // Constante de módulo que o caminho isolado passou a ler quando o Together
 // virou primário. Falsa aqui: este teste exercita o provider padrão e o ramo
 // Gemini, e makeTogetherFlashPrimary não é dependência deste recorte.
 primaryIsTogetherFlash:false,
 // Função real de confirm.mjs, sem I/O: o turno isolado passou a envolver o
 // poll de mensagem nova nela antes do guard de rascunho.
 deferIncomingWhileConfirmationPending, peekPending,
 // Dependências que passaram a ser tocadas ANTES do guard de rascunho. Nada
 // aqui é exercitado pelo caminho isolado; são stubs inertes só para o recorte
 // executar. Se alguma delas passar a ser usada de fato, o teste quebra.
 // Estado puro de revisão de resposta de e-mail, criado no início do turno
 // (antes do guard de rascunho). Função real, sem I/O.
 createEmailAnswerReviewState,
 HEALTH_GUARDRAIL,
 createCodingApprovals:()=>({}), appTaskStore:{}, GEMINI_COMPARISON_ID:'gemini-comparison-mock',
};
// Getter para flag permite testar o ramo Gemini sem reimportar servidor.
const build = flag => new Function(...Object.keys(deps),'primaryIsGeminiOverride','PRIMARY_TEXT_MODEL','PRIMARY_MAX_OUT',wrappers.map(fnText).join('\n')+'\nreturn {'+wrappers.join(',')+'};')(...Object.values(deps),flag,'gemini-mock',8192);
let api=build(false);const target={agent_id:'a-mock',user_id:'u-mock'};
const original='*Rotina sintética*\n\n• Pagar R$ 42,50 às 09:00\n• Visitar https://example.invalid/x?y=1';
credit={over:true};
eq(await api.whatsappProse(target,original),original,'crédito bloqueado preserva original byte a byte');eq(providerCalls,0);eq(ledger,[]);eq(reads.map(r=>r[0]),['agent','credit']);
// O preview do painel (runBroadcastFor, na nuvem) só monta o pedido e chama este.
await rejects(()=>api.runAgentMessageDraft(target,'Mensagem para revisão'));eq(providerCalls,0,'preview bloqueado é erro, não texto de cobrança');
credit={over:false};reads=[];
eq(await api.whatsappProse(target,original),'Parágrafo reformulado');eq(providerCalls,1);eq(input.tools,[]);eq(input.messages.length,1);ok(input.messages[0].content.includes(original));
ok(input.system.includes('Preferência sintética'));ok(input.system.includes('MODO RASCUNHO INTERNO'));eq(ledger.length,1);eq(ledger[0][1].threadId,null);eq(ledger[0][1].kind,'broadcast');
ok(!JSON.stringify(ledger).includes('RASCUNHO'),'ledger não recebe prompt/texto');eq(reads.map(r=>r[0]),['agent','credit','wiki']);
for (const invalid of [{stop:'end',text:''},{stop:'end',text:'cobrança sintética',unavailable:true},{stop:'tool',toolCalls:[{name:'voltar_versao'}]}, {stop:'end',text:'feito',toolCalls:[{name:'enviar_mensagem'}]}]) {
 response=invalid;eq(await api.whatsappProse(target,original),original,'erro/ação não vira conteúdo de entrega');
}
failure=true;eq(await api.whatsappProse(target,original),original);failure=false;
missingAgent=true;eq(await api.whatsappProse(target,original),original);missingAgent=false;
const before=providerCalls;
eq(await api.whatsappProse(target,'Texto simples'),'Texto simples');eq(await api.whatsappProse({},original),original);eq(providerCalls,before);
response={stop:'end',text:'Rascunho seguro'};
// Frase que antes ativava recuperação, e confirmação por texto, não acessam
// nenhuma dependência do chat: passagem direta pelo guard de ephemeral+noTools.
for (const task of ['RASCUNHO: meu app quebrou.','sim','pode enviar','RASCUNHO: sistema fora do ar']) {
 eq(await api.runConversationTurn({id:'a-mock',name:'Mock'}, {id:'NAO_USAR',history:[{role:'user',content:'PRIVADO'}]}, 'u-mock',task,{ephemeral:true,noTools:true}),{text:'Rascunho seguro',attachments:[]});
 eq(input.messages,[{role:'user',content:task}]);ok(!JSON.stringify(input).includes('PRIVADO'));
}
api=build(true);await api.runAgentMessageDraft(target,'reformate');eq(geminiOpts,{model:'gemini-mock',search:false,maxOutputTokens:8192});
// Falha do provider sem fallback continua amigável no chat, mas é erro tipado
// para o rascunho (nunca substitui a mensagem original pelo erro amigável).
const unavailable=api.withFallback({name:'mock',complete:async()=>{throw Error('mock');}},null,'test');
const failResult=await unavailable.complete({});eq(failResult.unavailable,true);eq(failResult.stop,'end');
const h=harness({response:failResult});await rejects(()=>generateMessageDraft(h.args));
// Guard não captura onboarding que continua tendo tools (ephemeral sem noTools).
const turn=fnText('runConversationTurn');ok(turn.indexOf('if (ephemeral && noTools)')<turn.indexOf('getCreditStatus'));ok(turn.indexOf('if (ephemeral && noTools)')<turn.indexOf('getUserMediaPrefs'));
ok(!fnText('runAgentMessageDraft').includes('getOrCreateThread'));ok(!fnText('isolatedAgentDraft').includes('runConversationInThread'));
console.log(`OK: ${checks} verificações. Dry-run isolado: zero DB/canais/HTTP reais; falhas preservam original; nenhum rascunho alcança o runner conversacional.`);
