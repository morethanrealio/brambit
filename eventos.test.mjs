import test from 'node:test';
import assert from 'node:assert/strict';
import {createEventos,ligarCicloDeVida} from './web/eventos.mjs';

test('inscrito que falha não derruba quem emitiu nem os outros inscritos', async()=>{
 const logs=[],vistos=[];
 const ev=createEventos({log:(...a)=>logs.push(a.join(' '))});
 ligarCicloDeVida(ev,{inscricoes:{primeira_mensagem:[()=>{throw Error('sync')},async()=>{throw Error('async')},d=>vistos.push(d.userId)]}});
 await ev.emitir('primeira_mensagem',{userId:'u1'});
 assert.deepEqual(vistos,['u1']);
 assert.equal(logs.length,2);
 await ev.emitir('nao_existe',{});
 assert.match(logs[2],/desconhecido/);
});

test('evento desconhecido na inscrição falha no boot', ()=>{
 assert.throws(()=>ligarCicloDeVida(createEventos(),{inscricoes:{primeira_msg:()=>{}}}),/desconhecido/);
});
