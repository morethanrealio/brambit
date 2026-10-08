// These cases check the Portuguese texts not yet in the catalogs, on an instance whose default is pt-BR.
process.env.BRAMBIT_DEFAULT_LANGUAGE = 'pt-BR';
import test from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import net from 'node:net';
import tls from 'node:tls';
net.Socket.prototype.connect=tls.connect=()=>{throw Error('External IO forbidden');};
registerHooks({resolve(specifier,context,next){
  if(specifier==='./compras.mjs'&&context.parentURL?.endsWith('/web/confirm.mjs'))return {url:'data:text/javascript,export const descreverCarrinho=()=>null;export const plataformaDoCarrinho=()=>null;',shortCircuit:true};
  return next(specifier,context);
}});
const {googleTools}=await import('./web/connectors.mjs');
const {gateTool,describe,renderConfirmed,setOwnerText}=await import('./web/confirm.mjs');
const {confirmationFixture}=await import('./test-support/confirmation-fixture.mjs');
const {createConfirmationSession,withConfirmationSession}=await import('./web/confirmation-session.mjs');
const {handleConfirmation,proposalCard}=await import('./web/confirmation-flow.mjs');
const reply=(body,status=200)=>({ok:status<400,status,json:async()=>body,text:async()=>JSON.stringify(body)});
function backend(t){
  const old=globalThis.fetch;t.after(()=>{globalThis.fetch=old;});
  const state={account:'owner@work.invalid',events:[],calls:[],partial:false,nextEvent:1,
    calendars:[{id:'owner@work.invalid',summary:'Principal Work',primary:true,accessRole:'owner'},
      {id:'shared',summary:'Geral Work',primary:false,accessRole:'writer'}],
    event:{id:'event-A',etag:'"version-1"',summary:'Teste Qualidade A',start:{dateTime:'2026-09-23T13:00:00-03:00',timeZone:'America/Sao_Paulo'},end:{dateTime:'2026-09-23T13:30:00-03:00'},attendees:[]}};
  globalThis.fetch=async(url,options={})=>{
    const u=new URL(url),method=options.method||'GET';state.calls.push({url:u,method,body:options.body,headers:options.headers});
    if(u.pathname.endsWith('/calendarList'))return reply({items:state.calendars,...(state.partial?{nextPageToken:'unread'}:{})});
    if(method==='POST'&&u.pathname.endsWith('/events')){const event={...JSON.parse(options.body),id:`event-${state.nextEvent++}`,etag:'"version-1"'};state.events.push(event);return reply({id:event.id,htmlLink:'https://calendar.google.com/calendar/event?eid=synthetic'});}
    const eventId=u.pathname.match(/\/events\/([^/]+)$/)?.[1];
    const event=state.events.find(e=>e.id===eventId) || (state.event.id===eventId?state.event:null);
    if(method==='GET'&&eventId)return reply(event || {},event?200:404);
    if(method==='PATCH'&&event)return reply({...event,...JSON.parse(options.body)});
    if(method==='DELETE'&&event){state.events=state.events.filter(e=>e.id!==event.id);return reply(null,204);}
    throw Error(`Unexpected offline URL ${method} ${u.pathname}`);
  };
  const tools=()=>googleTools({token:async()=>'synthetic',account:()=>state.account,caps:{calendar:{read:true,write:true}}});
  return {state,tool:name=>tools().find(tool=>tool.name===name)};
}
const eventArgs={title:'Teste Qualidade A',start:'2026-09-23T13:00:00',end:'2026-09-23T13:30:00',timezone:'America/Sao_Paulo',attendees:[]};

test('ambiguous calendar is resolved before creating a pending confirmation, with no write',async t=>{
  const b=backend(t),f=await confirmationFixture();t.after(()=>f.db.close());const s=await createConfirmationSession(f.store,f.scope);
  const result=await withConfirmationSession(s,()=>gateTool(b.tool('calendar_create'),f.scope.threadId).run({...eventArgs,agenda:'Work'}));
  assert.match(result,/NÃO registrei/);assert.match(result,/mais de uma agenda/);assert.equal(s.pending().length,0);
  assert.ok(b.state.calls.every(call=>call.method==='GET'));assert.equal(b.state.events.length,0);
});

test('calendar card includes the real agenda, account, local interval and guests before approval',async t=>{
  const b=backend(t),f=await confirmationFixture();t.after(()=>f.db.close());let s=await createConfirmationSession(f.store,f.scope);
  await withConfirmationSession(s,()=>gateTool(b.tool('calendar_create'),f.scope.threadId).run(eventArgs));
  const row=s.pending()[0];assert.ok(row.binding);const card=proposalCard(row);
  for(const detail of ['23/09/2026','13:00','13:30','Sem convidados','Principal Work','owner@work.invalid','America/Sao_Paulo'])assert.ok(card.includes(detail),detail);
  assert.equal(b.state.events.length,0);await f.store.present(f.scope,[row.id]);
  s=await createConfirmationSession(f.store,f.scope);s.implicitTargetId=row.id;
  await withConfirmationSession(s,()=>handleConfirmation(s,{message:'pode',inputId:'approve',resolveTool:async()=>({confirmationTool:b.tool('calendar_create')})}));
  assert.equal(b.state.events.length,1);assert.equal(b.state.events[0].end.dateTime,'2026-09-23T13:30:00');
  assert.ok(b.state.calls.find(call=>call.method==='POST').url.pathname.includes('owner%40work.invalid'));
});

test('account switch, partial calendar catalog and changed event block confirmation without writes',async t=>{
  const b=backend(t);
  const create=b.tool('calendar_create'),prepared=await create.prepareConfirmation(eventArgs);
  b.state.account='different@personal.invalid';await assert.rejects(create.restoreConfirmation(eventArgs,prepared.descriptor),/conta Google mudou/);
  b.state.account='owner@work.invalid';b.state.partial=true;await assert.rejects(create.prepareConfirmation(eventArgs),/conferir todas/);
  b.state.partial=false;
  const deletion=b.tool('calendar_delete'),args={id:'event-A',agenda:'Principal Work'};
  const before=await deletion.prepareConfirmation(args);assert.match(before.labels['pt-BR'],/Teste Qualidade A/);assert.match(before.labels['pt-BR'],/13:00/);
  b.state.event={...b.state.event,summary:'Changed event'};
  await assert.rejects(deletion.restoreConfirmation(args,before.descriptor),/evento ou a agenda mudou/);
  assert.ok(b.state.calls.every(call=>call.method==='GET'));
});

test('prepared recurring events retain recurrence and end conditions in the approval',async t=>{
  const b=backend(t),prepared=await b.tool('calendar_create').prepareConfirmation({...eventArgs,recorrencia:{frequencia:'semanal',quantidade:3}});
  assert.match(prepared.labels['pt-BR'],/Recorrência/);assert.match(prepared.labels['pt-BR'],/3 ocorrências/);
  assert.match(prepared.labels.en,/3 occurrences/);assert.equal(b.state.events.length,0);
});

test('an explicit empty invitee list really removes guests instead of showing a false preview',async t=>{
  const b=backend(t);b.state.event.attendees=[{email:'guest@example.invalid'}];
  const prepared=await b.tool('calendar_update').prepareConfirmation({id:'event-A',agenda:'Principal Work',attendees:[]});
  assert.match(prepared.labels['pt-BR'],/Sem convidados/);await prepared.run();
  const write=b.state.calls.find(call=>call.method==='PATCH');assert.deepEqual(JSON.parse(write.body).attendees,[]);assert.equal(write.url.searchParams.get('sendUpdates'),'all');
  assert.equal(write.headers['If-Match'],'"version-1"');
});

test('T4 end to end: approve two real connector proposals together, then remove only A and preserve B',async t=>{
  const b=backend(t),f=await confirmationFixture();t.after(()=>f.db.close());let session=await createConfirmationSession(f.store,f.scope);
  setOwnerText(f.scope.threadId,'','Crie os dois eventos de teste, sem convidados');
  await withConfirmationSession(session,async()=>{
    const gate=gateTool(b.tool('calendar_create'),f.scope.threadId);
    await gate.run({...eventArgs,agenda:'Principal Work'});
    await gate.run({...eventArgs,title:'Teste Qualidade B',start:'2026-09-23T13:30:00',end:'2026-09-23T14:00:00',agenda:'Principal Work'});
  });
  const rows=session.pending();await f.store.present(f.scope,rows.map(r=>r.id));
  session=await createConfirmationSession(f.store,f.scope);session.implicitTargetIds=rows.map(r=>r.id);
  const resolveTool=async row=>({confirmationTool:b.tool(row.name)});
  await withConfirmationSession(session,()=>handleConfirmation(session,{message:'confirmo os dois',inputId:'create-both',resolveTool}));
  assert.deepEqual(b.state.events.map(e=>e.summary),['Teste Qualidade A','Teste Qualidade B']);
  session=await createConfirmationSession(f.store,f.scope);setOwnerText(f.scope.threadId,'','Exclua somente o Teste Qualidade A');
  await withConfirmationSession(session,()=>gateTool(b.tool('calendar_delete'),f.scope.threadId).run({id:'event-1',agenda:'Principal Work'}));
  const removal=session.pending()[0];assert.match(proposalCard(removal),/Teste Qualidade A/);assert.doesNotMatch(proposalCard(removal),/Teste Qualidade B/);
  await f.store.present(f.scope,[removal.id]);session=await createConfirmationSession(f.store,f.scope);session.implicitTargetId=removal.id;
  await withConfirmationSession(session,()=>handleConfirmation(session,{message:'pode',inputId:'delete-only-a',resolveTool}));
  assert.deepEqual(b.state.events.map(e=>e.summary),['Teste Qualidade B']);
  assert.equal(b.state.calls.filter(call=>call.method==='DELETE').length,1);
});

test('routine preview discloses immediate delivery and an updated file receipt preserves the same link',()=>{
  assert.match(describe('editar_rotina',{titulo:'Curadoria',testar_agora:true}),/testar agora, com entrega no canal configurado/);
  assert.match(describe('editar_rotina',{titulo:'Curadoria',testar_agora:true},'en'),/test now, delivering/);
  assert.match(describe('docs_create',{name:'Report',overwrite:true}),/atualizar no mesmo link/);
  const text=renderConfirmed({name:'enviar_para_drive',args:{nome:'Report.docx'}},{ok:true,id:'existing-file',name:'Report.docx',atualizado:true,link:'https://drive.google.com/file/d/existing-file/view'});
  assert.match(text,/Atualizei.*mesmo arquivo/);assert.match(text,/existing-file/);
  const unproven=renderConfirmed({name:'enviar_para_drive',args:{nome:'Report.docx'}},{ok:true,atualizado:true});assert.doesNotMatch(unproven,/Atualizei/);
});
