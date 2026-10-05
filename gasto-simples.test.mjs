import test from 'node:test';
import assert from 'node:assert/strict';
import {createGastoSimples} from './web/gasto-simples.mjs';

test('sem teto nunca bloqueia; com teto bloqueia ao atingir o valor do mês', async()=>{
 const livre=createGastoSimples({gravarUso:async()=>{}});
 assert.equal((await livre.status('u')).over,false);
 let gasto=4.99;
 const teto=createGastoSimples({tetoUsd:5,gastoDoMes:async()=>gasto,gravarUso:async()=>{}});
 assert.equal((await teto.status('u')).over,false);
 gasto=5;
 assert.equal((await teto.status('u')).over,true);
});

test('registrar grava uma vez por callId e devolve recibo liquidado', async()=>{
 const linhas=[];
 const g=createGastoSimples({gravarUso:async r=>linhas.push(r)});
 const args={userId:'u',callId:'c1',usage:{model:'m',in:10,out:2},charge:{cost:0.01,billCredits:7},dimensions:{agentId:'a'}};
 const [r1,r2]=await Promise.all([g.registrar(args),g.registrar(args)]);
 assert.equal(linhas.length,1);
 assert.equal(linhas[0].billCredits,0);
 assert.deepEqual(r1,r2);
 assert.equal(r1.settled,true);
});
