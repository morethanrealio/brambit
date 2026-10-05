import assert from 'node:assert/strict';
import test from 'node:test';
import {createCreditSpend,ferramentaConsultarGasto,porCategoria,validarPeriodo,categoriaDe} from './web/credit-spend.mjs';

test('categorias agrupam canais e ordenam do maior pro menor', () => {
  assert.deepEqual(porCategoria([{kind:'whatsapp',creditos:68},{kind:'search',creditos:240},{kind:'subagent',creditos:12},{kind:'telegram',creditos:2},{kind:'x',creditos:0}]),
    [{categoria:'buscas na web',creditos:240},{categoria:'conversa (raciocínio do assistente)',creditos:70},{categoria:'pesquisas e tarefas delegadas',creditos:12}]);
  assert.equal(categoriaDe('nao-existe'),'outros');
});

test('periodo invalido nao consulta o banco', async () => {
  assert.match(validarPeriodo('2026-09-20','2026-09-10'),/depois/);
  assert.match(validarPeriodo('15/09','2026-09-10'),/AAAA-MM-DD/);
  assert.match(validarPeriodo('2025-01-01','2026-09-10'),/366/);
  assert.equal(validarPeriodo('2026-09-27','2026-09-27'),null);
  const s=createCreditSpend({query:async()=>{throw new Error('não devia consultar');}});
  assert.ok((await s.porPeriodo({userId:'u',de:'x',ate:'y'})).erro);
});

test('periodo de varios dias traz total, categorias e dias com gasto', async () => {
  const calls=[];
  const s=createCreditSpend({query:async(sql,p)=>{calls.push(p);return {rows:[
    {dia:'2026-09-26',kind:'chat',creditos:10},{dia:'2026-09-27',kind:'search',creditos:40},{dia:'2026-09-27',kind:'chat',creditos:5}]};}});
  const r=await s.porPeriodo({userId:'u',de:'2026-09-26',ate:'2026-09-27'});
  assert.equal(r.total_creditos,55);
  assert.deepEqual(r.por_dia,[{dia:'2026-09-26',creditos:10},{dia:'2026-09-27',creditos:45}]);
  assert.deepEqual(calls[0].slice(0,3),['u','2026-09-26','2026-09-27']);
});

test('um dia so nao traz quebra por dia', async () => {
  const s=createCreditSpend({query:async()=>({rows:[{dia:'2026-09-27',kind:'chat',creditos:3}]})});
  const r=await s.porPeriodo({userId:'u',de:'2026-09-27',ate:'2026-09-27'});
  assert.equal(r.total_creditos,3);assert.equal(r.por_dia,undefined);
});

test('ultimas respostas exclui o turno atual, limita N e soma a janela de cada resposta', async () => {
  const calls=[];
  const pool={query:async(sql,p)=>{calls.push({sql,p});
    if(sql.includes('task_measurements'))return {rows:[{id:'t2',thread_id:'th',started_at:'2026-09-27T20:06:33Z',finished_at:'2026-09-27T20:13:09Z'}]};
    return {rows:[{kind:'whatsapp',creditos:68},{kind:'search',creditos:240}]};}};
  const r=await createCreditSpend(pool).ultimasRespostas({userId:'u',agentId:'a',n:99,excluirTurnoId:'t-atual'});
  assert.deepEqual(calls[0].p,['u','a','t-atual',20]);
  assert.equal(r.respostas.length,1);
  assert.equal(r.respostas[0].creditos,308);assert.equal(r.respostas[0].canal,'WhatsApp');
  assert.equal(r.respostas[0].onde_foi[0].categoria,'buscas na web');
  assert.equal(r.total_creditos,308);
  assert.deepEqual(calls[1].p.slice(0,4),['u','th','2026-09-27T20:06:33Z','2026-09-27T20:13:09Z']);
});

test('resultado orienta a responder so o total por padrao', async () => {
  const s=createCreditSpend({query:async(sql)=>sql.includes('task_measurements')
    ?{rows:[{id:'t',thread_id:'th',started_at:'2026-09-27T20:00:00Z',finished_at:'2026-09-27T20:01:00Z'}]}
    :{rows:[{dia:'2026-09-27',kind:'chat',creditos:3}]}});
  const p=await s.porPeriodo({userId:'u',de:'2026-09-27',ate:'2026-09-27'});
  const r=await s.ultimasRespostas({userId:'u',agentId:'a',n:1});
  for(const x of [p,r]){assert.match(x.orientacao,/só com o total/);assert.match(x.orientacao,/pergunte em que foi gasto/);}
  assert.ok(p.onde_foi.length);assert.ok(r.respostas[0].onde_foi.length);
});

test('unidade usd soma o custo real, arredonda em 4 casas e fala em US$', async () => {
  const sqls=[];
  const s=createCreditSpend({query:async(sql)=>{sqls.push(sql);return {rows:[
    {dia:'2026-09-26',kind:'chat',usd:0.01234},{dia:'2026-09-27',kind:'search',usd:0.1},{dia:'2026-09-27',kind:'chat',usd:0.00001}]};}},{unidade:'usd'});
  const r=await s.porPeriodo({userId:'u',de:'2026-09-26',ate:'2026-09-27'});
  assert.match(sqls[0],/sum\(cost_usd\)/);assert.doesNotMatch(sqls[0],/bill_credits/);
  assert.equal(r.total_usd,0.1124);assert.equal(r.total_creditos,undefined);
  assert.deepEqual(r.por_dia,[{dia:'2026-09-26',usd:0.0123},{dia:'2026-09-27',usd:0.1}]);
  assert.deepEqual(r.onde_foi[0],{categoria:'buscas na web',usd:0.1});
  assert.match(r.orientacao,/total em US\$/);
  assert.match(ferramentaConsultarGasto({spend:s,unidade:'usd'}).description,/US\$/);
  assert.throws(()=>createCreditSpend({},{unidade:'reais'}),/desconhecida/);
});
