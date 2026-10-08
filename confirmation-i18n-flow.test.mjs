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
const {handleConfirmation,proposalPresentation,confirmationTargetsInMessage}=await import('./web/confirmation-flow.mjs');
const {setThreadLanguage}=await import('./web/confirm.mjs');

// English and Spanish users reply to the card with the natural forms of their
// language. A "yes" needs to execute; a "never mind" needs to close the
// proposal (before, it stayed pending) and the reply has to come in her language.
async function fixture(t,language){
  const f=await confirmationFixture();t.after(()=>f.db.close());const effects=[];let last='';
  if(language) setThreadLanguage(f.scope.threadId,language);
  const tool={name:'calendar_create',run:async args=>{effects.push(args.title);return {ok:true,id:`event-${args.title}`,agenda:'Work'};}};
  const s=await createConfirmationSession(f.store,f.scope);setOwnerText(f.scope.threadId,'','Create the event');
  await withConfirmationSession(s,async()=>{await gateTool(tool,f.scope.threadId).run({title:'Evento',start:'2026-09-23T13:00:00',end:'2026-09-23T13:30:00'});});
  const rows=s.pending().filter(r=>s.createdIds.has(r.id));last=proposalPresentation(rows);
  await f.store.present(f.scope,rows.map(r=>r.id));
  async function decide(message){
    const d=await createConfirmationSession(f.store,f.scope);d.implicitTargetIds=confirmationTargetsInMessage(d.pending(),last);
    d.implicitTargetId=d.implicitTargetIds.length===1?d.implicitTargetIds[0]:null;
    return withConfirmationSession(d,()=>handleConfirmation(d,{message,resolveTool:async()=>({confirmationTool:tool}),inputId:'in-'+message}));
  }
  return {...f,effects,decide};
}

const SIM=[['en','yeah'],['en','yep'],['en','do it'],['en','yes, send it'],['en','go ahead'],['en','sounds good'],
  ['es','hazlo'],['es','envíalo'],['es','sí, envíalo'],['es','de acuerdo'],['es','me parece bien'],
  ['pt-BR','sim'],['pt-BR','pode'],['pt-BR','manda']];
for(const [lang,text] of SIM) test(`"${text}" (${lang}) executa a ação`,async t=>{
  const f=await fixture(t,lang);await f.decide(text);
  assert.deepEqual(f.effects,['Evento'],text);
  assert.equal((await f.store.list(f.scope))[0].state,'completed');
});

const CANCELA=[['en','never mind',/canceled/],['en',"don't",/canceled/],['en','no thanks',/canceled/],
  ['es','mejor no',/Cancelé/],['es','olvídalo',/Cancelé/],['es','no lo hagas',/Cancelé/],['pt-BR','não',/Cancelei/]];
for(const [lang,text,reply] of CANCELA) test(`"${text}" (${lang}) cancela e responde no idioma`,async t=>{
  const f=await fixture(t,lang);const r=await f.decide(text);
  assert.equal(f.effects.length,0);assert.match(r.text,reply);
  assert.notEqual((await f.store.list(f.scope))[0].state,'pending',text);
});

// Collisions with Portuguese: without an accent, "mandalo/envialo" is not the Spanish
// imperative, and a sentence that only starts out looking similar is not consent.
for(const text of ['envialo','mandalo','o mandaloriano é bom','do it later?','hazlo mañana y después vemos'])
  test(`"${text}" não executa`,async t=>{
    const f=await fixture(t,'es');await f.decide(text);assert.equal(f.effects.length,0,text);
  });
