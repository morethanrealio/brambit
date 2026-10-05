// Achado #22: imds()/kmsCall() liam o corpo da resposta sem listener de 'error'.
// Se a conexão cai DEPOIS dos headers, o stream emite 'error'; EventEmitter sem
// listener de 'error' joga a exceção, que fora de try/catch vira
// uncaughtException e mata o processo (o harness não tem handler global).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';

const { lerCorpo } = await import('./web/kms.mjs');

test('corpo inteiro é lido normalmente', async () => {
  const fake = new EventEmitter();
  const p = lerCorpo(fake);
  fake.emit('data', 'ab');
  fake.emit('data', 'cd');
  fake.emit('end');
  assert.equal(await p, 'abcd');
});

test('erro no meio do corpo vira rejeição, não exceção solta', async () => {
  const fake = new EventEmitter();
  const p = lerCorpo(fake);
  fake.emit('data', 'parcial');
  // Sem o listener de 'error' esta linha SOZINHA derrubaria o processo.
  assert.doesNotThrow(() => fake.emit('error', new Error('ECONNRESET')));
  await assert.rejects(p, /ECONNRESET/);
});

test('sem listener de error o emit JOGA a exceção (é o mecanismo do bug)', () => {
  const nu = new EventEmitter();
  // Prova do mecanismo: EventEmitter sem listener de 'error' transforma o evento
  // em throw. No cliente HTTP isso acontece dentro do callback do socket, fora de
  // qualquer try/catch, ou seja, derruba o processo.
  assert.throws(() => nu.emit('error', new Error('boom')), /boom/);
});

test('imds e kmsCall passam pelo lerCorpo (ninguém lê corpo no braço)', () => {
  const src = fs.readFileSync(new URL('./web/kms.mjs', import.meta.url), 'utf8');
  const leituras = src.match(/res\.on\('data'/g) || [];
  assert.equal(leituras.length, 1, 'só o lerCorpo pode acumular corpo');
  assert.equal((src.match(/lerCorpo\(res\)\.then\(/g) || []).length, 2, 'imds e kmsCall');
  assert.match(src, /res\.on\('error', reject\)/);
});
