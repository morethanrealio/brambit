import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { createChecklistStore, checklistTools } from '../web/checklists.mjs';

test('grocery and parts lists: isolation, continuity, partial purchase, repetition and recovery in SQL', async t => {
  const db = new PGlite(); t.after(() => db.close());
  await db.exec('CREATE SCHEMA mtr_harness; CREATE TABLE mtr_harness.users(id uuid PRIMARY KEY);');
  const user = randomUUID(), other = randomUUID();
  await db.query('INSERT INTO mtr_harness.users VALUES($1),($2)',[user,other]);
  let tail = Promise.resolve();
  const query = (sql, values) => values ? db.query(sql,values) : db.exec(sql);
  const pool = { query, async connect() { const previous=tail; let release; tail=new Promise(r=>{release=r}); await previous; return {query,release}; } };
  const store = createChecklistStore(pool); await store.init(); await store.init();
  const mercado = (await store.create(user,'Mercado')).lista;
  const pecas = (await store.create(user,'Peças')).lista;
  assert.equal((await store.create(user,'  MÉRCADO ')).lista.id,mercado.id);
  const change = (list, version, operations, rest={}) => store.edit(user,{lista:list.id,versao:version,operacoes:operations,requestKey:randomUUID(),...rest});
  const original = {lista:mercado.id,versao:0,requestKey:'entrada-1',operacoes:[{tipo:'adicionar',nome:'Leite',quantidade:3,unidade:'litro'},{tipo:'adicionar',nome:'Maçã',quantidade:2,unidade:'kg'}]};
  const first = await store.edit(user,original);
  assert.equal(first.lista.itens.length,2);
  assert.equal((await store.edit(user,original)).repetido,true);
  assert.equal((await change(mercado,1,[{tipo:'adicionar',nome:'Leite',quantidade:3,unidade:'litro'}])).sem_alteracao,true);
  assert.equal((await change(mercado,1,[{tipo:'adicionar',nome:'Leite',quantidade:3,unidade:'L'}])).sem_alteracao,true);
  assert.equal((await store.list(other,mercado.id)).ok,false);
  assert.equal((await store.edit(other,original)).ok,false);
  const item=first.lista.itens[0], apple=first.lista.itens[1];
  // Two conversations edited the same version. One must re-read before applying.
  const racing=await Promise.all([
    change(mercado,1,[{tipo:'atualizar',id:item.id,quantidade:1}]),
    change(mercado,1,[{tipo:'atualizar',id:apple.id,concluido:true}]),
  ]);
  assert.equal(racing.filter(r=>r.ok).length,1);
  assert.equal(racing.filter(r=>r.code==='CONFLICT').length,1);
  const bought=await change(mercado,2,[{tipo:'atualizar',id:apple.id,concluido:true}]);
  assert.equal(bought.lista.pendentes,1);
  assert.equal(bought.lista.itens.find(i=>i.id===item.id).quantidade,1);
  // Items with different units don't merge and absolute quantity doesn't accumulate.
  const units=await change(mercado,3,[{tipo:'adicionar',nome:'Maçã',quantidade:1,unidade:'un'}]);
  assert.equal(units.lista.total,3);
  const parts=await change(pecas,0,[{tipo:'adicionar',nome:'Cabo USB-A/USB-C'}]);
  await assert.rejects(change(mercado,4,[{tipo:'remover',id:parts.lista.itens[0].id}]),/nesta lista/);
  // A failure on the second item doesn't leave the first partially saved.
  await assert.rejects(change(mercado,4,[{tipo:'remover',id:item.id},{tipo:'adicionar',nome:'Inválido',quantidade:-2}]),/Quantidade/);
  assert.equal((await store.list(user,mercado.id)).lista.versao,4);
  assert.equal((await store.list(user,'Mer')).ok,false);
  const cleared=await change(mercado,4,undefined,{acao:'zerar'});
  assert.equal(cleared.lista.total,0);
  assert.equal((await store.list(user,pecas.id)).lista.total,1);
  const restored=await change(mercado,5,undefined,{acao:'desfazer'});
  assert.deepEqual(restored.lista.itens,units.lista.itens);
  // New instance = another conversation/process. The state doesn't live in the model's context.
  assert.deepEqual((await createChecklistStore(pool).list(user,mercado.id)).lista,restored.lista);
  assert.equal((await store.edit(user,original)).repetido,true);
  assert.deepEqual((await store.list(user,mercado.id)).lista,restored.lista);
  const tools=checklistTools({store,userId:user,requestId:'synthetic-turn',findExisting:async()=>({tipo:'app',nome:'Controle antigo'})});
  const create=tools.find(x=>x.name==='criar_lista');
  assert.equal(JSON.parse(await create.run({nome:'Controle antigo'})).code,'EXISTING_SOURCE');
  assert.equal(JSON.parse(await create.run({nome:'Mercado'})).lista.total,3);
  const edit=tools.find(x=>x.name==='editar_lista');
  const args={lista:mercado.id,versao:6,acao:'itens',operacoes:[{tipo:'atualizar',id:item.id,concluido:true}]};
  assert.equal(JSON.parse(await edit.run(args)).lista.pendentes,1);
  assert.equal(JSON.parse(await edit.run(args)).repetido,true);
  const undo=await change(mercado,7,undefined,{acao:'desfazer'});
  assert.equal(undo.lista.itens.find(i=>i.id===item.id).concluido,false);
  const undoEarlier=await change(mercado,8,undefined,{acao:'desfazer'});
  assert.equal(undoEarlier.lista.total,2); // doesn't redo the undone reset
  assert.equal((await store.list(user,pecas.id)).lista.total,1);
});

test('finalizing closes the list and the next purchase with the same name is a new list', async t => {
  // Prod 2026-09-25: "Finalize the list" changed nothing in the database; two days later the
  // items from the new purchase entered the old list and the two got mixed up.
  const db = new PGlite(); t.after(() => db.close());
  await db.exec('CREATE SCHEMA mtr_harness; CREATE TABLE mtr_harness.users(id uuid PRIMARY KEY);');
  const user = randomUUID();
  await db.query('INSERT INTO mtr_harness.users VALUES($1)',[user]);
  const query = (sql, values) => values ? db.query(sql,values) : db.exec(sql);
  let tail = Promise.resolve();
  const pool = { query, async connect() { const previous=tail; let release; tail=new Promise(r=>{release=r}); await previous; return {query,release}; } };
  const store = createChecklistStore(pool); await store.init();
  const ed = (lista, versao, rest) => store.edit(user,{lista,versao,requestKey:randomUUID(),...rest});
  const velha = (await store.create(user,'Supermercado')).lista;
  await ed(velha.id,0,{operacoes:[{tipo:'adicionar',nome:'Mamão'},{tipo:'adicionar',nome:'Laranja'}]});
  const fim = await ed(velha.id,1,{acao:'finalizar'});
  assert.equal(fim.ok,true); assert.equal(fim.finalizada,true); assert.ok(fim.lista.finalizada_em);
  assert.equal(fim.lista.total,2);
  // Disappears from the active ones, appears in the finalized ones; free-form name.
  const todas = await store.list(user);
  assert.equal(todas.listas.length,0);
  assert.equal(todas.finalizadas_recentes[0].id,velha.id);
  assert.equal((await store.list(user,'Supermercado')).ok,false);
  // Doesn't receive a new item.
  const bloq = await ed(velha.id,2,{operacoes:[{tipo:'adicionar',nome:'Pimentão'}]});
  assert.equal(bloq.code,'LIST_FINALIZED');
  // Same name = new, empty list; the old one stays intact.
  const tools = checklistTools({store,userId:user,requestId:'t',findExisting:async()=>null});
  const nova = JSON.parse(await tools.find(x=>x.name==='criar_lista').run({nome:'Supermercado'}));
  assert.equal(nova.criada,true); assert.notEqual(nova.lista.id,velha.id); assert.equal(nova.lista.total,0);
  assert.equal((await store.list(user,velha.id)).lista.total,2);
  // Reopening with another active list of the same name is refused; without it, it reverts to the name.
  assert.equal((await ed(velha.id,2,{acao:'reabrir'})).code,'NAME_IN_USE');
  const outra = (await store.create(user,'Feira')).lista;
  await ed(outra.id,0,{acao:'finalizar'});
  const volta = await ed(outra.id,1,{acao:'reabrir'});
  assert.equal(volta.reaberta,true); assert.equal(volta.lista.finalizada_em,undefined);
  assert.equal((await store.list(user,'Feira')).lista.id,outra.id);
  // Finalizing again is idempotent.
  const f1 = await ed(velha.id,2,{acao:'finalizar'});
  assert.equal(f1.sem_alteracao,true);
});
