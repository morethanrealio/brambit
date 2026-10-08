// These cases check the Portuguese texts not yet in the catalogs, on an instance whose default is pt-BR.
process.env.BRAMBIT_DEFAULT_LANGUAGE = 'pt-BR';
import test from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import net from 'node:net';
import tls from 'node:tls';
const denied=()=>{throw Error('EXTERNAL IO FORBIDDEN');};
net.Socket.prototype.connect=denied;tls.connect=denied;globalThis.fetch=denied;
// In-memory Space DB: the test controls the saved note and sees each save.
const fakeDb=`const F=()=>globalThis.__spaceFake;const nada=async()=>({});
export const createSpace=nada,listSpacesForUser=nada,addSpaceEntry=nada,listSpaceEntries=nada,listSpaceMembers=nada,
addSpaceMember=nada,removeSpaceMember=nada,resolveConnectedUser=nada,contatoAmbiguoMsg=()=>'',deleteSpaceEntry=nada,setSpaceMode=nada;
export const resolveSpace=async()=>({space:{id:'space-1',title:'Compras',isOwner:true}});
export const getSpaceEntry=async id=>F().notas[id]?{...F().notas[id]}:null;
export const updateSpaceEntry=async(id,_s,p)=>{F().gravadas.push({id,...p});if(p.body!=null)F().notas[id].body=String(p.body).trim();return {};};`;
registerHooks({resolve(specifier,context,next){
  if(specifier==='./compras.mjs'&&context.parentURL?.endsWith('/web/confirm.mjs'))return {url:'data:text/javascript,export const descreverCarrinho=()=>null;export const plataformaDoCarrinho=()=>null;',shortCircuit:true};
  if(specifier==='./db.mjs'&&context.parentURL?.endsWith('/web/spaces.mjs'))return {url:'data:text/javascript,'+encodeURIComponent(fakeDb),shortCircuit:true};
  return next(specifier,context);
}});
const {confirmationFixture}=await import('./test-support/confirmation-fixture.mjs');
const {createConfirmationSession,withConfirmationSession}=await import('./web/confirmation-session.mjs');
const {handleConfirmation}=await import('./web/confirmation-flow.mjs');
const {gateTool}=await import('./web/confirm.mjs');
const {spacesTools}=await import('./web/spaces.mjs');
const {cartaoEdicaoNota,diffLinhas}=await import('./web/nota-diff.mjs');

const LISTA=['## Lista Atual','','### 🛒 Supermercado','- Leite','- Pão','','### 🧴 Farmácia','- Protetor','','## Histórico','','### 29/09','- Café'].join('\n');
const comLinha=(texto,depoisDe,nova)=>texto.replace(depoisDe,`${depoisDe}\n${nova}`);

test('card lists only the lines that leave and enter, under the section where they change',()=>{
  const depois=comLinha(LISTA,'- Pão','- Cottage').replace('- Protetor','- Protetor FPS 50');
  const t=cartaoEdicaoNota({espaco:'Compras',antes:LISTA,depois,tagAntes:'',tagDepois:null}).confirmationTexts['pt-BR'];
  assert.match(t,/Em "🛒 Supermercado":\n➕ - Cottage/);
  assert.match(t,/Em "🧴 Farmácia":\n➖ - Protetor\n➕ - Protetor FPS 50/);
  for(const igual of ['- Leite','- Pão','- Café','Histórico'])assert.ok(!t.includes(igual),`line that did not change was left out: ${igual}`);
});

test('card stays exact: every changed line appears literally, and removals from the history are labeled as such',()=>{
  const depois=LISTA.replace('\n- Café','');
  const t=cartaoEdicaoNota({espaco:'Compras',antes:LISTA,depois}).confirmationTexts['pt-BR'];
  assert.match(t,/Em "29\/09":\n➖ - Café/);
  const ops=diffLinhas(LISTA,depois);
  assert.deepEqual(ops.filter(o=>o[0]!=='=').map(o=>o.join(' ')),['- - Café']);
});

test('moving the current list to the history shows items leaving their section and entering the new dated one',()=>{
  const depois=LISTA.replace('- Leite\n- Pão','*(vazio)*').replace('## Histórico\n','## Histórico\n\n### 30/09\n- Leite\n- Pão\n');
  const t=cartaoEdicaoNota({espaco:'Compras',antes:LISTA,depois}).confirmationTexts['pt-BR'];
  assert.match(t,/Em "🛒 Supermercado":\n➖ - Leite\n➖ - Pão\n➕ \*\(vazio\)\*\n\nEm "Histórico":\n➕ ### 30\/09\n➕ - Leite\n➕ - Pão$/);
  assert.ok(!t.includes('Café')&&!t.includes('29/09'),'the old week from the history does not appear');
});

test('same heading under different parents stays apart',()=>{
  const antes='## Casa\n### Mercado\n- Leite\n## Escritório\n### Mercado\n- Café';
  const t=cartaoEdicaoNota({espaco:'Compras',antes,depois:antes.replace('- Café','- Café\n- Açúcar')}).confirmationTexts['pt-BR'];
  assert.match(t,/Em "Escritório › Mercado":\n➕ - Açúcar$/);assert.ok(!t.includes('Leite'));
});

test('card handles tag-only, whitespace-only, no-op and empty edits without guessing',()=>{
  assert.match(cartaoEdicaoNota({espaco:'Compras',antes:LISTA,depois:null,tagAntes:'casa',tagDepois:'mercado'}).confirmationTexts['pt-BR'],/mudar a tag .* de "casa" para "mercado"/);
  assert.match(cartaoEdicaoNota({espaco:'Compras',antes:'a\nb',depois:'a\n\nb'}).confirmationTexts['pt-BR'],/só muda o espaçamento/);
  assert.throws(()=>cartaoEdicaoNota({espaco:'Compras',antes:LISTA,depois:`${LISTA}\n`}),/já está exatamente assim/);
  assert.throws(()=>cartaoEdicaoNota({espaco:'Compras',antes:LISTA,depois:null,tagDepois:null}),/novo texto ou a nova tag/);
  const en=cartaoEdicaoNota({espaco:'Compras',antes:'a',depois:'b'}).confirmationTexts.en;
  assert.match(en,/Only these lines change/);assert.match(en,/➖ a\n➕ b/);
});

async function fixture(t){
  const f=await confirmationFixture();t.after(()=>f.db.close());
  globalThis.__spaceFake={notas:{'nota-1':{body:LISTA,tag:'',authorUserId:f.scope.userId},'nota-2':{body:'outra',tag:'',authorUserId:f.scope.userId}},gravadas:[]};
  const tool=()=>spacesTools(f.scope.userId,f.scope.agentId).find(x=>x.name==='editar_nota');
  return {...f,tool,async propose(args){
    const s=await createConfirmationSession(f.store,f.scope);
    const out=await withConfirmationSession(s,()=>gateTool(tool(),f.scope.threadId).run({espaco:'Compras',...args}));
    const s2=await createConfirmationSession(f.store,f.scope);
    return {out,pending:s2.pending()};
  },async approve(numero){
    const pend=(await createConfirmationSession(f.store,f.scope)).pending(),ids=pend.map(r=>r.id);
    if(ids.length)await f.store.present(f.scope,ids);
    const s=await createConfirmationSession(f.store,f.scope);
    return withConfirmationSession(s,()=>handleConfirmation(s,{message:`confirmo pedido ${numero ?? pend.at(-1)?.number}`,resolveTool:async()=>({confirmationTool:tool()})}));
  }};
}

test('a new proposal for the same note supersedes the pending one; other notes keep theirs',async t=>{
  const f=await fixture(t);
  const a=await f.propose({nota_id:'nota-1',nova_nota:comLinha(LISTA,'- Pão','- Cottage')});
  assert.match(a.out,/AÇÃO PENDENTE/);assert.equal(a.pending.length,1);
  const b=await f.propose({nota_id:'nota-1',nova_nota:comLinha(LISTA,'- Pão','- Cottage light')});
  assert.equal(b.pending.length,1,'the previous proposal for the same note left the queue');
  assert.equal(b.pending[0].args.nova_nota.includes('Cottage light'),true);
  const velho=await f.approve(a.pending[0].number);
  assert.match(velho.text,/substituída por uma nova proposta/,velho.text);
  const c=await f.propose({nota_id:'nota-2',nova_nota:'outra coisa'});
  assert.equal(c.pending.length,2,'a different note does not get replaced');
  assert.deepEqual(globalThis.__spaceFake.gravadas,[],'proposing never writes');
});

test('approval writes the confirmed text, and refuses when the note changed after the card was built',async t=>{
  const f=await fixture(t);
  const nova=comLinha(LISTA,'- Pão','- Cottage');
  await f.propose({nota_id:'nota-1',nova_nota:nova});
  globalThis.__spaceFake.notas['nota-1'].body=comLinha(LISTA,'- Leite','- Ovos');
  const r=await f.approve();
  assert.deepEqual(globalThis.__spaceFake.gravadas,[],'nothing written over the version the person never saw');
  assert.match(r.text,/^Não executei/,r.text);
  globalThis.__spaceFake.notas['nota-1'].body=LISTA;
  await f.propose({nota_id:'nota-1',nova_nota:nova});
  const ok=await f.approve();
  assert.match(ok.text,/Anotação atualizada no Space "Compras"/,ok.text);
  assert.deepEqual(globalThis.__spaceFake.gravadas.map(g=>g.body),[nova]);
});
