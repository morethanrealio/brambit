// OFFLINE tests and dry-run. Does not import server.mjs; extracts only pure
// orchestration functions. Never connects DB/API/channels and never reads customer data.
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
const { turnSearchCoverage, preserveSearchCoverageWarning } = await import('../web/turn-search-coverage.mjs');
const {throwIfCreditFailure}=await import('../web/execution-credit-errors.mjs');
const { generateMessageDraft, DraftUnavailableError } = await import('../web/message-draft.mjs');
const { deferIncomingWhileConfirmationPending, peekPending } = await import('../web/confirm.mjs');
const { createEmailAnswerReviewState } = await import('../web/email-answer-review.mjs');
const { HEALTH_GUARDRAIL } = await import('../web/health-guardrail.mjs');
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
 const h=harness({credit}); await rejects(()=>generateMessageDraft(h.args)); eq(h.calls,['credit'],'no model/context/usage when blocked');
}
for (const task of ['', '  ', null, 7]) { const h=harness(); await rejects(()=>generateMessageDraft({...h.args,task}));eq(h.calls,[]); }
{
 const usage={model:'mock',input:10,output:2}; const h=harness({response:{stop:'end',text:'  Texto final  ',usage}});
 eq(await generateMessageDraft(h.args),'Texto final');eq(h.calls.slice(0,3),['credit','context','factory']);
 eq(h.calls[3].input,{system:'SYSTEM',messages:[{role:'user',content:h.args.task}],tools:[]});eq(h.calls[4],{usage});eq(h.calls.length,5);
}
for (const response of [null,{}, {stop:'end',text:''},{stop:'end',text:5},{stop:'tool',text:'quase'}, {stop:'end',text:'não disponível',unavailable:true}, {stop:'end',text:'feito',toolCalls:[{name:'enviar_mensagem'}]}, {stop:'tool',toolCalls:[{name:'voltar_versao'}],usage:{model:'mock'}}]) {
 const h=harness({response});await rejects(()=>generateMessageDraft(h.args));eq(h.calls.filter(c=>c?.input).length,1,'no second step/tool-loop');
}
{const h=harness({failure:true});await rejects(()=>generateMessageDraft(h.args));eq(h.calls.length,4);}
for (const dep of ['readCredit','readContext','makeProvider']) {
 const h=harness();h.args[dep]=()=>{throw Error('MOCK_DEPENDENCY_FAILURE');};await rejects(()=>generateMessageDraft(h.args));eq(h.calls.filter(c=>c?.input).length,0);
}
// The production functions, with all the real effect dependencies forbidden.
const source=readFileSync(new URL('../web/server.mjs',import.meta.url),'utf8');
function fnText(name) {
 const start=source.search(new RegExp('(?:async )?function '+name+'\\('));const end=source.indexOf('\n}\n',start)+2;
 assert.ok(start>=0 && end>start);return source.slice(start,end);
}
const wrappers=['isolatedAgentDraft','runAgentMessageDraft','isListishText','whatsappProse','runConversationTurn','withFallback'];
let credit={over:false}, response={stop:'end',text:'Parágrafo reformulado',usage:{model:'mock'}}, failure=false, missingAgent=false;
let providerCalls=0, ledger=[], input, reads=[], geminiOpts=null, forced=null;
// Only the names referenced by the isolated path are provided. Access to
// tool assembly, chat credits, confirmation, memory, or delivery fails.
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
 // Module constant that the isolated path started reading when Together
 // became the primary. Fake here: this test exercises the default provider and the
 // Gemini branch, and makeTogetherFlashPrimary is not a dependency of this slice.
 primaryIsTogetherFlash:false,
 // Real function from confirm.mjs, without I/O: the isolated turn started wrapping the
 // new-message poll in it before the draft guard.
 deferIncomingWhileConfirmationPending, peekPending,
 // Dependencies that started being touched BEFORE the draft guard. None of
 // this is exercised by the isolated path; they're inert stubs just for the slice to
 // run. If any of them actually starts being used, the test breaks.
 // Pure email-reply-review state, created at the start of the turn
 // (before the draft guard). Real function, without I/O.
 createEmailAnswerReviewState,
 HEALTH_GUARDRAIL,
 createCodingApprovals:()=>({}), appTaskStore:{}, GEMINI_COMPARISON_ID:'gemini-comparison-mock',
};
// Getter for the flag allows testing the Gemini branch without reimporting the server.
const build = flag => new Function(...Object.keys(deps),'primaryIsGeminiOverride','PRIMARY_TEXT_MODEL','PRIMARY_MAX_OUT',wrappers.map(fnText).join('\n')+'\nreturn {'+wrappers.join(',')+'};')(...Object.values(deps),flag,'gemini-mock',8192);
let api=build(false);const target={agent_id:'a-mock',user_id:'u-mock'};
const original='*Rotina sintética*\n\n• Pagar R$ 42,50 às 09:00\n• Visitar https://example.invalid/x?y=1';
credit={over:true};
eq(await api.whatsappProse(target,original),original,'blocked credit preserves original byte for byte');eq(providerCalls,0);eq(ledger,[]);eq(reads.map(r=>r[0]),['agent','credit']);
// The panel preview (runBroadcastFor, in the cloud) only assembles the request and calls this one.
await rejects(()=>api.runAgentMessageDraft(target,'Mensagem para revisão'));eq(providerCalls,0,'blocked preview is an error, not billing text');
credit={over:false};reads=[];
eq(await api.whatsappProse(target,original),'Parágrafo reformulado');eq(providerCalls,1);eq(input.tools,[]);eq(input.messages.length,1);ok(input.messages[0].content.includes(original));
ok(input.system.includes('Preferência sintética'));ok(input.system.includes('INTERNAL DRAFT MODE'));eq(ledger.length,1);eq(ledger[0][1].threadId,null);eq(ledger[0][1].kind,'broadcast');
ok(!JSON.stringify(ledger).includes('RASCUNHO'),'ledger does not receive prompt/text');eq(reads.map(r=>r[0]),['agent','credit','wiki']);
for (const invalid of [{stop:'end',text:''},{stop:'end',text:'cobrança sintética',unavailable:true},{stop:'tool',toolCalls:[{name:'voltar_versao'}]}, {stop:'end',text:'feito',toolCalls:[{name:'enviar_mensagem'}]}]) {
 response=invalid;eq(await api.whatsappProse(target,original),original,'error/action does not become delivery content');
}
failure=true;eq(await api.whatsappProse(target,original),original);failure=false;
missingAgent=true;eq(await api.whatsappProse(target,original),original);missingAgent=false;
const before=providerCalls;
eq(await api.whatsappProse(target,'Texto simples'),'Texto simples');eq(await api.whatsappProse({},original),original);eq(providerCalls,before);
response={stop:'end',text:'Rascunho seguro'};
// A sentence that used to activate recovery, and textual confirmation, do not access
// any chat dependency: a direct pass through the ephemeral+noTools guard.
for (const task of ['RASCUNHO: meu app quebrou.','sim','pode enviar','RASCUNHO: sistema fora do ar']) {
 eq(await api.runConversationTurn({id:'a-mock',name:'Mock'}, {id:'NAO_USAR',history:[{role:'user',content:'PRIVADO'}]}, 'u-mock',task,{ephemeral:true,noTools:true}),{text:'Rascunho seguro',attachments:[]});
 eq(input.messages,[{role:'user',content:task}]);ok(!JSON.stringify(input).includes('PRIVADO'));
}
api=build(true);await api.runAgentMessageDraft(target,'reformate');eq(geminiOpts,{model:'gemini-mock',search:false,maxOutputTokens:8192});
// Provider failure without a fallback stays friendly in the chat, but is a typed error
// for the draft (never replaces the original message with the friendly error).
const unavailable=api.withFallback({name:'mock',complete:async()=>{throw Error('mock');}},null,'test');
const failResult=await unavailable.complete({});eq(failResult.unavailable,true);eq(failResult.stop,'end');
const h=harness({response:failResult});await rejects(()=>generateMessageDraft(h.args));
// Guard does not capture onboarding that still has tools (ephemeral without noTools).
const turn=fnText('runConversationTurn');ok(turn.indexOf('if (ephemeral && noTools)')<turn.indexOf('getCreditStatus'));ok(turn.indexOf('if (ephemeral && noTools)')<turn.indexOf('getUserMediaPrefs'));
ok(!fnText('runAgentMessageDraft').includes('getOrCreateThread'));ok(!fnText('isolatedAgentDraft').includes('runConversationInThread'));
console.log(`OK: ${checks} verificações. Dry-run isolado: zero DB/canais/HTTP reais; falhas preservam original; nenhum rascunho alcança o runner conversacional.`);
