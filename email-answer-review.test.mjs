import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmailAnswerReviewState, EMAIL_REVIEW_SYSTEM } from './web/email-answer-review.mjs';
import { EMAIL_ANSWER_CONTRACT } from './web/email-answer-contract.mjs';
import { turnSearchCoverage } from './web/turn-search-coverage.mjs';

// All completions are local functions: no model, connector, server or database.
const sourceUrl = 'https://mail.google.com/mail/?authuser=work%40example.invalid#all/message-1';
const trackingUrl = 'https://tracking.example.invalid/order/one';
const evidence = () => ({
  conta:'work@example.invalid',
  consulta:{status:'sucesso_com_resultados',partial:true,observed_messages:2},
  sources:[{id:'message-1',account:'work@example.invalid',url:sourceUrl,subject:'Paula respondeu'}],
  available_links:[{url:trackingUrl,source:'message-1',account:'work@example.invalid'}],
  trechos_verificados:[{id:'message-1',field:'body',quote:'Ainda não aprovei. Vou responder em 24/09.'}],
  fallback_sources:[{id:'message-2',account:'work@example.invalid',fields:[{field:'body',text:'Outro candidato válido, apesar de uma referência inválida.'}]}],
  extraction:{status:'partial',refs_rejected:1},
});
const draft = 'Rascunho preservado, com informação encontrada.';
const context = {kind:'chat',toolCounts:{google:1},termination:'completed',messages:[{role:'assistant',content:draft}]};
function state() { const s=createEmailAnswerReviewState(); s.observe(evidence()); return s; }
const completion = answer => ({stop:'end',text:JSON.stringify({issues:[],answer}),usage:{in:20,out:10}});
const review = (s, result, extra={}) => s.review({provider:{complete:async()=>result},text:draft,request:'A Paula respondeu?',...extra});

test('eligibility: explicit human channels with email reading, no routine, actions or interjection', () => {
  assert.equal(createEmailAnswerReviewState().eligible(context), false);
  const s=state(); assert.equal(s.eligible(context),true);
  assert.equal(s.eligible({...context,messages:[{role:'user',meta:'interject',content:'Mensagem de um turno anterior'},...context.messages]}),true);
  assert.equal(s.eligible({...context,toolCounts:{microsoft:1}}),true);
  assert.equal(s.eligible({...context,toolCounts:{google:2,microsoft:1}}),true);
  for (const kind of ['chat','email','whatsapp','telegram','slack','device']) {
    assert.equal(s.eligible({...context,kind}),true,kind);
    for (const extra of [
      {nativeSearch:true}, {ephemeral:true}, {toolCounts:{}}, {toolCounts:undefined},
      {toolCounts:{google:1,gmail_send:1}}, {toolCounts:{google:1,criar_evento:1}},
      {toolCounts:{google:1,buscar_web:1}}, {toolCounts:{google:1,drive_search:1}},
      {toolCounts:{google:1,os_action:1}},
      {termination:undefined}, {termination:'interrupted'}, {termination:'max_steps'},
      {termination:'credit_reconciliation_required'},
      {messages:[...context.messages,{role:'user',meta:'interject',raw:'Agora faça outra coisa.',content:'Agora faça outra coisa.'}]},
    ]) assert.equal(s.eligible({...context,kind,...extra}),false,kind+': '+JSON.stringify(extra));
  }
  for (const kind of ['routine','onboard','webhook','unknown','CHAT','',undefined,null]) {
    assert.equal(s.eligible({...context,kind}),false,String(kind));
  }
});

test('mixed worker usage disables review even with bundles before or after', () => {
  for (const reverse of [false,true]) {
    const s=createEmailAnswerReviewState();
    for (const bundle of reverse?[{unsupported:true},evidence()]:[evidence(),{unsupported:true}]) s.observe(bundle);
    assert.equal(s.eligible(context),false);
  }
  const a=state(),b=createEmailAnswerReviewState();
  assert.equal(a.eligible(context),true); assert.equal(b.eligible(context),false);
});

test('preserved data, account statuses, language and contract reach the reviewer with no tools', async () => {
  const s=state();
  const row={account:'personal@example.invalid',status:'failed'};
  const coverage=turnSearchCoverage();coverage.observeAccountCoverage(row);
  const warnings=coverage.emailWarnings('es');
  s.observeAccount(row); row.status='consulted';
  const answer=`Paula respondió, pero todavía no aprobó. Prometió responder el 24/09. [Correo](${sourceUrl})`;
  let calls=0;
  const out=await s.review({provider:{complete:async input=>{
    calls++; assert.deepEqual(input.tools,[]);
    assert.equal(input.system,EMAIL_REVIEW_SYSTEM); assert.ok(input.system.includes(EMAIL_ANSWER_CONTRACT));
    assert.equal(input.messages.length,1); assert.equal(input.messages[0].role,'user');
    const data=JSON.parse(input.messages[0].content);
    assert.equal(data.idioma,'es'); assert.equal(data.pedido,'¿Paula respondió?');
    assert.equal(data.data_contexto,'2026-09-22; America/Sao_Paulo'); assert.equal(data.rascunho,draft);
    assert.deepEqual(data.contas,[{account:'personal@example.invalid',status:'failed'}]);
    assert.deepEqual(data.achados_por_conta,[evidence()]);
    assert.deepEqual(data.avisos_obrigatorios,warnings);
    return {...completion(answer),text:JSON.stringify({issues:['Repetição removida'],answer:'  '+answer+'  '})};
  }},text:draft,request:'¿Paula respondió?',language:'es',nowContext:'2026-09-22; America/Sao_Paulo',warnings});
  assert.equal(calls,1); assert.equal(out.text,answer); assert.equal(out.status,'reviewed');
  assert.deepEqual(out.usage,{in:20,out:10}); assert.deepEqual(out.issues,['Repetição removida']);
});

test('a warning given to the reviewer appears once; omission or failure keeps the deterministic safeguard', async () => {
  const coverage=turnSearchCoverage();
  coverage.observeEmailCoverage([{account:'work@example.invalid',tool:'gmail_search',status:'complete',returned:1}]);
  coverage.observeAccountCoverage({account:'personal@example.invalid',status:'failed'});
  const warnings=coverage.emailWarnings('pt-BR');
  assert.equal(warnings.length,1);
  const answer=`Paula respondeu, mas ainda não aprovou. [Resposta](${sourceUrl})`;
  for (const mode of ['respects','omits','throws','invalid']) {
    const s=state();
    const out=await s.review({provider:{complete:async input=>{
      const data=JSON.parse(input.messages[0].content);
      assert.deepEqual(data.avisos_obrigatorios,warnings);
      if(mode==='throws')throw Error('UNAVAILABLE');
      if(mode==='invalid')return {stop:'end',text:'{"answer":'};
      return completion(mode==='respects' ? [answer,...data.avisos_obrigatorios].join('\n\n') : answer);
    }},text:answer,request:'Paula respondeu nas minhas contas?',warnings});
    const final=coverage.finish(out.text,'pt-BR');
    assert.equal(final,[answer,...warnings].join('\n\n'),mode);
    assert.equal(final.split(warnings[0]).length,2,mode);
    assert.equal(coverage.finishEmail(final,'pt-BR'),final,mode);
    assert.equal(coverage.finish(final,'pt-BR'),final,mode);
  }
});

test('existing sources and links are accepted, including two distinct accounts', async () => {
  const s=state(),personalUrl='https://mail.google.com/mail/?authuser=personal%40example.invalid#all/message-3';
  s.observe({...evidence(),conta:'personal@example.invalid',sources:[{id:'message-3',url:personalUrl}]});
  const answer=`Duas compras possíveis: [trabalho](${sourceUrl}), [pessoal](${personalUrl}). [Acompanhamento informado](${trackingUrl}).`;
  assert.equal((await review(s,completion(answer))).text,answer);
  assert.equal((await review(s,completion(draft))).status,'reviewed');
});

test('failure, interrupted credit, truncated protocol and unexpected tools preserve the draft', async () => {
  const s=state();
  const thrown=await s.review({provider:{complete:async()=>{throw Error('PRIVATE_PROVIDER_ERROR');}},text:draft,request:'Pergunta'});
  assert.deepEqual(thrown,{text:draft,status:'unavailable'});
  for (const overrides of [
    {creditStop:'insufficient_credits'}, {creditStop:'credit_reconciliation_required'},
    {unavailable:true}, {protocolError:{code:'output_truncated'}}, {truncated:true},
    {stop:'length'}, {stop:'tool'}, {toolCalls:[{name:'gmail_send',args:{}}]},
  ]) {
    const out=await review(s,{...completion('Texto substituto'),...overrides});
    assert.equal(out.text,draft); assert.equal(out.status,'unavailable'); assert.deepEqual(out.usage,{in:20,out:10});
  }
  assert.equal((await review(s,null)).status,'unavailable');
});

test('invalid JSON, unexpected fields or an empty response never replace the draft', async () => {
  for (const text of [
    'Resposta sem JSON', '{"answer":', 'null', '[]', '{}',
    '{"issues":[],"answer":""}', '{"issues":[],"answer":"  "}',
    '{"issues":[],"answer":42}', '{"issues":"ok","answer":"Resposta"}',
    '{"issues":[{"message":"objeto"}],"answer":"Resposta"}',
  ]) {
    const out=await review(state(),{stop:'end',text,usage:{out:2}});
    assert.equal(out.status,'invalid_response',text); assert.equal(out.text,draft); assert.deepEqual(out.usage,{out:2});
  }
});

test('unobserved links are rejected even alongside a valid source or without an HTTP prefix', async () => {
  for (const unknown of [
    'https://invented.example.invalid/path', '[link](https://invented.example.invalid/path)',
    '[link](javascript:alert(1))', '[link](mailto:invented@example.invalid)', '[link](/invented)',
    '[link][ref]\n[ref]: https://invented.example.invalid/path',
    'HTTPS://INVENTED.EXAMPLE.INVALID/path',
  ]) {
    const out=await review(state(),completion(`[Fonte válida](${sourceUrl}). ${unknown}`));
    assert.equal(out.status,'invalid_source',unknown); assert.equal(out.text,draft); assert.deepEqual(out.usage,{in:20,out:10});
  }
});

test('JSON format in a code block is accepted and does not expose issues in the response', async () => {
  const answer=`Ainda não aprovou. [Resposta de Paula](${sourceUrl})`;
  const out=await review(state(),{stop:'end',text:'```json\n'+JSON.stringify({issues:['corrigido'],answer})+'\n```'});
  assert.equal(out.status,'reviewed'); assert.equal(out.text,answer); assert.ok(!out.text.includes('corrigido'));
});


test('loss in the handoff propagates a limitation without erasing sources; citation errors with no loss do not create a partial',()=>{
 const rows=[];const s=createEmailAnswerReviewState({onIncomplete:r=>rows.push(r)});
 const preserved=evidence();s.observe(preserved);assert.equal(rows.length,0);
 s.observe({...preserved,extraction:{...preserved.extraction,output_truncated:true}});
 assert.deepEqual(rows,[{account:preserved.conta,tool:'email_evidence',status:'partial',reason:'evidence_limited'}]);
 assert.equal(s.eligible(context),true);
});
