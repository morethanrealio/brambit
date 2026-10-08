import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';
import { readFileSync } from 'node:fs';
import { trackEmailPagination } from './web/email-pagination.mjs';
import { turnSearchCoverage } from './web/turn-search-coverage.mjs';
import { createActionJournal } from './web/action-evidence.mjs';
net.Socket.prototype.connect=tls.connect=()=>{throw Error('Rede real proibida');};
const {googleTools}=await import('./web/connectors.mjs');
const {microsoftTools}=await import('./web/connectors-ext.mjs');
const json=body=>({ok:true,json:async()=>body});
const find=(tools,name)=>tools.find(t=>t.name===name);

test('Gmail sources survive synthesis, the second page and the account switch', async () => {
  let account='pessoal@example.invalid';
  const calls=[];
  globalThis.fetch=async url=>{
    url=String(url);calls.push(url);
    if (url.includes('/messages?')) return json(url.includes('pageToken')?{messages:[{id:'two'}]}:{messages:[{id:'one'}],nextPageToken:'page-two'});
    if (url.includes('/messages/')) return json({id:url.includes('/two')?'two':'one',snippet:'Contrato sintético',payload:{mimeType:'text/plain',headers:[{name:'From',value:'source@example.invalid'},{name:'Subject',value:'Contrato'},{name:'Date',value:'2026-09-14'}],body:{data:Buffer.from('Valor informado no contrato sintético: 42.').toString('base64url')}}});
    throw Error('URL inesperada '+url);
  };
  const raw=googleTools({token:async()=> 'fixture',account:()=>account,caps:{gmail:{read:true}}});
  const tracked=trackEmailPagination(raw), coverage=turnSearchCoverage();
  const search=find(tracked.tools,'gmail_search'), read=find(tracked.tools,'gmail_read');
  const first=JSON.parse(await search.run({query:'subject:contrato'}));
  await search.run({query:'subject:contrato',cursor:first.next_cursor});
  const full=JSON.parse(await read.run({id:'two'}));
  assert.equal(full.id,'two'); assert.equal(full.account,account);
  assert.match(full.link,/authuser=pessoal%40example.invalid/);
  const worker=tracked.finish('Síntese do modelo sem citar a fonte');
  assert.match(worker,/Valor informado no contrato sintético: 42/);
  assert.match(worker,/"read":true/);
  coverage.observeEmail(tracked.evidence());
  assert.match(coverage.finish('Resposta sem link','pt-BR'),/\[Contrato\]\(https:\/\/mail.google.com\/mail\//);
  assert.equal(tracked.hasPartial(),false);
  account='trabalho@example.invalid'; const count=calls.length;
  await assert.rejects(search.run({query:'subject:contrato',cursor:first.next_cursor}),/Cursor/);
  assert.equal(calls.length,count); // refuses BEFORE querying the other account
  const second=JSON.parse(await search.run({query:'subject:contrato'}));
  assert.equal(second.messages[0].account,account);
  assert.equal(tracked.evidence().filter(r=>r.id==='one').length,2);
  const fresh=turnSearchCoverage();assert.equal(fresh.finish('Outra pessoa'),'Outra pessoa');
});

test('Outlook preserves the link and declares the body cut-off; access failure is not an empty inbox', async () => {
  globalThis.fetch=async()=>json({id:'ms-one',subject:'Contrato sintético',webLink:'https://outlook.office.com/mail/id/synthetic',body:{contentType:'Text',content:'x'.repeat(7000)}});
  const tracked=trackEmailPagination(microsoftTools({token:async()=> 'fixture'}));
  const m=JSON.parse(await find(tracked.tools,'hotmail_read').run({id:'ms-one'}));
  assert.equal(m.truncated,true); assert.equal(m.corpo.length,6000);
  assert.equal(tracked.hasPartial(),true); assert.match(tracked.finish('Resumo'),/outlook.office.com/);
  globalThis.fetch=async()=>({ok:false,status:401,text:async()=> 'expired synthetic'});
  await assert.rejects(find(tracked.tools,'hotmail_search').run({q:'contrato'}));
  assert.equal(tracked.hasPartial(),true);
});

test('Google fetches the requested historical window and propagates unread calendar pages', async () => {
  const calls=[];
  globalThis.fetch=async url=>{
    const u=new URL(url);calls.push(u);
    if (u.pathname.includes('calendarList')) return json({items:[{id:'primary',summary:'Pessoal',primary:true,accessRole:'owner'}]});
    if (u.pathname.endsWith('/events')) return json({items:[{id:'occurrence',recurringEventId:'series',summary:'Consulta sintética',start:{dateTime:'2025-08-01T10:00:00-03:00'},end:{dateTime:'2025-08-01T11:00:00-03:00'}}],nextPageToken:'not-read'});
    throw Error('URL inesperada');
  };
  const tracked=trackEmailPagination(googleTools({token:async()=> 'fixture',caps:{calendar:{read:true}}}));
  const tool=find(tracked.tools,'calendar_list');
  assert.ok(tool.parameters.properties.inicio);
  const r=JSON.parse(await tool.run({inicio:'2025-08-01',fim:'2025-08-02',fuso:'America/Sao_Paulo'}));
  const request=calls.find(u=>u.pathname.endsWith('/events'));
  assert.equal(request.searchParams.get('timeMin'),'2025-08-01T03:00:00.000Z');
  assert.equal(request.searchParams.get('timeMax'),'2025-08-02T03:00:00.000Z');
  assert.equal(r.eventos[0].serie_id,'series'); assert.equal(r.partial,true); assert.equal(tracked.hasPartial(),true);
});

test('an explicitly chosen account does not fall back to the primary one when disconnected/removed', async () => {
  const source=readFileSync('web/server.mjs','utf8'), a=source.indexOf('async function googleAccountFor('), b=source.indexOf('\n}',a)+2;
  let primaryCalls=0;
  const fn=new Function('getGoogleAccount','getPrimaryGoogleAccount',source.slice(a,b)+';return googleAccountFor;')(async()=>null,async()=>{primaryCalls++;return {google_email:'wrong@example.invalid'};});
  assert.equal(await fn('synthetic','removed@example.invalid'),null);assert.equal(primaryCalls,0);
  assert.equal((await fn('synthetic')).google_email,'wrong@example.invalid');assert.equal(primaryCalls,1);
});

test('a checked checklist does not become a conclusion to confirm or prove another item', () => {
  const journal=createActionJournal();
  journal.toolResult({name:'consultar_listas',args:{}},JSON.stringify({ok:true,lista:{itens:[{nome:'Leite',quantidade:1,unidade:'litro',concluido:true},{nome:'Maçã',concluido:false}]}}));
  const out=journal.finish('- [x] Leite\n- [x] Maçã');
  assert.match(out,/\[x\] Leite\n/); assert.match(out,/\[ \] Maçã/);
  const other=createActionJournal(); assert.match(other.finish('- [x] Leite'),/\[ \] Leite/);
  const writing=createActionJournal();
  writing.toolResult({name:'criar_lista',args:{nome:'Mercado'}},JSON.stringify({ok:true,lista:{id:'list-fixture',nome:'Mercado',versao:0,itens:[]}}));
  writing.toolResult({name:'editar_lista',args:{lista:'list-fixture'}},JSON.stringify({ok:true,lista:{id:'list-fixture',nome:'Mercado',versao:1,itens:[]}}));
  assert.equal(writing.finish('Salvei a lista.'),'Lista "Mercado" salva.');
});
