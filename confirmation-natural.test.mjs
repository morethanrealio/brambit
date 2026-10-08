import test from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import net from 'node:net';
import tls from 'node:tls';
const denied=()=>{throw Error('External IO forbidden');};
net.Socket.prototype.connect=tls.connect=denied;globalThis.fetch=denied;
registerHooks({resolve(specifier,context,next){
  if(specifier==='./compras.mjs'&&context.parentURL?.endsWith('/web/confirm.mjs')) return {url:'data:text/javascript,export const descreverCarrinho=()=>null;export const plataformaDoCarrinho=()=>null;',shortCircuit:true};
  return next(specifier,context);
}});
const {confirmationFixture}=await import('./test-support/confirmation-fixture.mjs');
const {createConfirmationSession,withConfirmationSession}=await import('./web/confirmation-session.mjs');
const {gateTool,setOwnerText}=await import('./web/confirm.mjs');
const {handleConfirmation,selectConfirmation,proposalPresentation,confirmationTargetsInMessage}=await import('./web/confirmation-flow.mjs');
const {withConfirmationReceipt}=await import('./web/channel-confirmation.mjs');

async function fixture(t){
  const f=await confirmationFixture();t.after(()=>f.db.close());const effects=[];let last='';
  const tool={name:'calendar_create',run:async args=>{effects.push(args.title);return {ok:true,id:`event-${args.title}`,agenda:'Work'};}};
  async function propose(titles=['Teste Qualidade A','Teste Qualidade B'], ownerText='Crie os dois eventos de teste'){
    const s=await createConfirmationSession(f.store,f.scope);setOwnerText(f.scope.threadId,'',ownerText);
    await withConfirmationSession(s,async()=>{for(const [i,title] of titles.entries()) await gateTool(tool,f.scope.threadId).run({title,start:`2026-09-23T13:${i?'30':'00'}:00`,end:`2026-09-23T${i?'14:00':'13:30'}:00`});});
    const rows=s.pending().filter(r=>s.createdIds.has(r.id));last=proposalPresentation(rows);
    await f.store.present(f.scope,rows.map(r=>r.id));await s.refresh();return {rows:s.rows.filter(r=>rows.some(old=>old.id===r.id)),session:s,text:last};
  }
  async function decide(message,extra={}){
    const s=await createConfirmationSession(f.store,f.scope);s.implicitTargetIds=confirmationTargetsInMessage(s.pending(),last);
    s.implicitTargetId=s.implicitTargetIds.length===1?s.implicitTargetIds[0]:null;
    const r=await withConfirmationSession(s,()=>handleConfirmation(s,{message,resolveTool:async()=>({confirmationTool:tool}),...extra}));
    last=r?.text||'Outra resposta';return r;
  }
  return {...f,effects,tool,propose,decide};
}

test('T4 confirms the two presented events in one message, preserves separate receipts and replays once',async t=>{
  const f=await fixture(t);const {rows,text}=await f.propose();
  assert.doesNotMatch(text,/Pedido \d|confirmo pedido/);assert.equal((text.match(/Posso realizar/g)||[]).length,1);
  assert.deepEqual(confirmationTargetsInMessage(rows,text),rows.map(r=>r.id));
  await f.decide('confirmo os dois',{inputId:'owner-message'});
  assert.deepEqual(f.effects,['Teste Qualidade A','Teste Qualidade B']);
  const done=await f.store.list(f.scope);assert.ok(done.every(r=>r.state==='completed'));
  assert.ok(done[0].decisionGroup);assert.equal(done[0].decisionGroup,done[1].decisionGroup);
  assert.equal(done.filter(r=>r.decisionKey==='owner-message').length,1);
  const replay=await f.decide('confirmo os dois',{inputId:'owner-message'});assert.equal(replay.replay,true);
  assert.match(replay.text,/Teste Qualidade A/);assert.match(replay.text,/Teste Qualidade B/);assert.equal(f.effects.length,2);
  await f.propose(['Outro evento']);await f.decide('pode',{inputId:'owner-message'});assert.equal(f.effects.length,2);
});

test('T8 a new sole proposal accepts fresh plain consent, but a leftover without presentation does not',async t=>{
  const f=await fixture(t);await f.propose(['Primeiro']);await f.decide('confirmo',{inputId:'one'});
  await f.propose(['Segundo']);await f.decide('confirmo',{inputId:'two'});assert.deepEqual(f.effects,['Primeiro','Segundo']);
  await f.propose();await f.decide('confirmo 1',{inputId:'three'});assert.equal(f.effects.at(-1),'Teste Qualidade A');
  await f.decide('pode',{inputId:'four'});assert.equal(f.effects.length,3,'the remaining event was not presented by the success receipt');
});

test('names, ordinals and times select the exact proposal without command IDs',async t=>{
  const f=await fixture(t);const {rows}=await f.propose();const ids=rows.map(r=>r.id);
  for(const [text,index] of [['confirmo 1',0],['confirmo o segundo',1],['pode criar o Teste Qualidade A',0],['confirmo o das 13h30',1],['confirmo só o B',1]]){
    const selected=selectConfirmation(rows,text,undefined,false,null,null,ids);
    assert.equal(selected.kind,'confirm',text);assert.equal(selected.row.id,rows[index].id,text);assert.equal(selected.rows,undefined,text);
  }
  for(const text of ['confirmo 9','confirmo Teste Qualidade C','confirmo os dois sem convidados','confirmo os dois menos o B','se der, confirmo os dois','confirmo pedido 1 sem convidados','confirmo o Teste Qualidade A amanhã','confirmei ontem o Teste Qualidade A','confirmo o Teste Qualidade A às 15h','confirmo 9 o Teste Qualidade A']){
    assert.notEqual(selectConfirmation(rows,text,undefined,false,null,null,ids).kind,'confirm',text);
  }
  const sameText=[rows[0],{...rows[0],id:rows[1].id,number:2,args:{...rows[0].args,agenda:'Other'}}];
  assert.deepEqual(confirmationTargetsInMessage(sameText,proposalPresentation([sameText[0]])),[],'one identical card must not authorize two different payloads');
  assert.equal(selectConfirmation(sameText,'confirmo o das 13h',undefined,false,null,null,ids).kind,'ambiguous','a shared time cannot select both events');
  const quoted=rows.map((row,index)=>({...row,messageRefs:[{channel:'whatsapp',messageId:String(index)}]}));
  assert.notEqual(selectConfirmation(quoted,'confirmo o Teste Qualidade B',{channel:'whatsapp',messageId:'0'}).kind,'confirm','natural name and quoted reference must agree');
  assert.notEqual(selectConfirmation(quoted,'confirmo sem convidados',{channel:'whatsapp',messageId:'0'}).kind,'confirm','extra conditions cannot authorize the unchanged proposal');
});

test('one delivered summary binds the visible set; quoted partial consent narrows it',async t=>{
  const f=await fixture(t);const {session,text,rows}=await f.propose();
  const response=await withConfirmationSession(session,()=>withConfirmationReceipt(f.scope.threadId,{text}));
  assert.equal(response.confirmationCards.length,1);
  await response.confirmationCards[0].onReplySent({channel:'whatsapp',messageIds:['summary']});
  const bound=await f.store.list(f.scope);assert.ok(bound.every(r=>r.messageRefs.some(ref=>ref.messageId==='summary')));
  await f.decide('confirmo o das 13h',{inputId:'quoted',target:{channel:'whatsapp',messageId:'summary'}});
  assert.deepEqual(f.effects,['Teste Qualidade A']);assert.equal((await f.store.list(f.scope)).find(r=>r.id===rows[1].id).state,'pending');
});

test('concurrent batch approvals and failed member revalidation never cause duplicate or partial authorization',async t=>{
  const f=await fixture(t);await f.propose();
  await Promise.all([f.decide('confirmo os dois',{inputId:'batch-a'}),f.decide('confirmo os dois',{inputId:'batch-b'})]);
  assert.equal(f.effects.length,2);
  await f.propose(['Third A','Third B']);
  const result=await f.decide('confirmo os dois',{inputId:'failed-preflight',resolveTool:async row=>({confirmationTool:row.args.title==='Third B'?{...f.tool,preflight:async()=>({erro:'Changed target'})}:f.tool})});
  assert.match(result.text,/Não iniciei/);assert.equal(f.effects.length,2);
  const rows=await f.store.list(f.scope);assert.equal(rows.find(r=>r.args.title==='Third A').state,'pending');
});

test('an interrupted claimed set becomes uncertain after restart and never retries',async t=>{
  const f=await fixture(t);const {rows}=await f.propose();
  const claims=await f.store.claimMany(f.scope,rows.map(r=>({id:r.id,fingerprint:r.fingerprint})),'interrupted');assert.equal(claims.length,2);
  await f.db.query("UPDATE mtr_harness.confirmation_requests SET lease_until=now()-interval '1 minute' WHERE state='executing'");
  const replay=await f.decide('confirmo os dois',{inputId:'interrupted'});assert.match(replay.text,/resultado incerto/);assert.equal(f.effects.length,0);
  assert.ok((await f.store.list(f.scope)).every(r=>r.state==='uncertain'));
});

test('batch cancellation closes only the displayed set and preserves an unrelated older proposal',async t=>{
  const f=await fixture(t);await f.propose(['Older'],'Pedido anterior');const {rows}=await f.propose();
  await f.decide('cancela os dois',{inputId:'cancel-batch'});
  const result=await f.store.list(f.scope);assert.equal(result.find(r=>r.args.title==='Older').state,'pending');
  assert.ok(rows.every(row=>result.find(r=>r.id===row.id).state==='canceled'));assert.equal(f.effects.length,0);
});

test('consent followed by more text stays with the model: it may carry a condition no word list catches (Avon, 01/10)',async t=>{
  const f=await fixture(t);const {rows}=await f.propose(['Roteiro Live']);const ids=rows.map(r=>r.id);
  for(const text of ['Pode. É de extrema importância de que vc esteja seguro que os claims dos produtos foram "puxados" do site AVON.',
    'Pode seguir, sim. Daí, depois disso, é só eu gravar um áudio curto la e mandar, certo?'])
    assert.notEqual(selectConfirmation(rows,text,undefined,false,null,ids[0],ids).kind,'confirm',text);
  assert.deepEqual(f.effects,[]);
});

test('the owner approves the card in his own words: verb of the card, "as duas", start of the card (case of 03/10)',()=>{
  const rows=[
    {id:'r1',number:1,name:'criar_rotina',state:'pending',presented:true,confirmationText:'criar a rotina "Radar diário de contas" que roda todo dia às 07h',args:{nome:'Radar diário de contas'},source:{ownerText:'A'}},
    {id:'r2',number:2,name:'enviar_para_drive',state:'pending',presented:true,confirmationText:'salvar o arquivo "Controle Financeiro.xlsx" no seu Google Drive',args:{},source:{ownerText:'A'}},
  ];
  const ids=rows.map(r=>r.id);
  for(const text of ['pode realizar sim','pode ser as duas','sim, as duas','as duas']){
    const s=selectConfirmation(rows,text,undefined,false,null,null,ids);
    assert.equal(s.kind,'confirm',text);assert.deepEqual(s.rows.map(r=>r.id),ids,text);
  }
  for(const [text,id] of [['salvar o arquivo','r2'],['pode criar a rotina','r1'],['agora pode criar a rotina','r1'],['cria a rotina','r1']]){
    const s=selectConfirmation(rows,text,undefined,false,null,null,ids);
    assert.equal(s.kind,'confirm',text);assert.equal(s.row.id,id,text);assert.equal(s.rows,undefined,text);
  }
  // Outside the visible list, only with a word of yes; and nothing that adds a condition.
  assert.equal(selectConfirmation(rows,'agora pode criar a rotina',undefined,false,null,null,[]).row?.id,'r1');
  assert.notEqual(selectConfirmation(rows,'salvar o arquivo',undefined,false,null,null,[]).kind,'confirm');
  for(const text of ['pode criar a rotina às 8h','pode criar a rotina?','se der, cria a rotina','pode ser as duas menos a rotina','as duas sem o drive','não precisa criar a rotina','criar a rotina outra vez'])
    assert.notEqual(selectConfirmation(rows,text,undefined,false,null,null,ids).kind,'confirm',text);
});

test('the same natural approval works in English and Spanish',()=>{
  const cards={
    en:['create the routine "Daily bills radar", running every day at 07:00','save the file "Budget.xlsx" in your Google Drive'],
    es:['crear la rutina "Radar diario de cuentas", que corre todos los días a las 07:00','guardar el archivo "Presupuesto.xlsx" en tu Google Drive'],
  };
  const yes={
    en:{both:['yes, both','both','both please','yes do both','sure, go ahead with both'],r1:['create the routine','yes, create the routine'],r2:['go ahead and save the file']},
    es:{both:['sí, las dos','ambas','puedes hacerlo','sí, por favor'],r1:['crea la rutina'],r2:['sí, guarda el archivo']},
  };
  const no={
    en:['create the routine at 10am','both except the drive','both?','can you create the routine?'],
    es:['crear la rutina a las 10','las dos menos el drive','¿las dos?'],
  };
  for(const lang of ['en','es']){
    const rows=cards[lang].map((confirmationText,i)=>({id:`r${i+1}`,number:i+1,name:i?'enviar_para_drive':'criar_rotina',state:'pending',presented:true,confirmationText,args:{},source:{ownerText:'A'}}));
    const ids=rows.map(r=>r.id);
    for(const text of yes[lang].both){
      const s=selectConfirmation(rows,text,undefined,false,null,null,ids);
      assert.equal(s.kind,'confirm',text);assert.deepEqual(s.rows.map(r=>r.id),ids,text);
    }
    for(const id of ['r1','r2']) for(const text of yes[lang][id]){
      const s=selectConfirmation(rows,text,undefined,false,null,null,ids);
      assert.equal(s.kind,'confirm',text);assert.equal(s.row.id,id,text);
    }
    for(const text of no[lang]) assert.notEqual(selectConfirmation(rows,text,undefined,false,null,null,ids).kind,'confirm',text);
  }
});
