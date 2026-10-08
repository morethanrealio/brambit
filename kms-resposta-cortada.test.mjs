// Finding #22: imds()/kmsCall() read the response body without an 'error' listener.
// If the connection drops AFTER the headers, the stream emits 'error'; an EventEmitter without
// an 'error' listener throws the exception, which outside try/catch turns into an
// uncaughtException and kills the process (the harness has no global handler).
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
  // Proof of the mechanism: an EventEmitter without an 'error' listener turns the event
  // into a throw. In the HTTP client this happens inside the socket's callback, outside of
  // any try/catch, i.e., it brings down the process.
  assert.throws(() => nu.emit('error', new Error('boom')), /boom/);
});

test('imds e kmsCall passam pelo lerCorpo (ninguém lê corpo no braço)', () => {
  const src = fs.readFileSync(new URL('./web/kms.mjs', import.meta.url), 'utf8');
  const leituras = src.match(/res\.on\('data'/g) || [];
  assert.equal(leituras.length, 1, 'só o lerCorpo pode acumular corpo');
  assert.equal((src.match(/lerCorpo\(res\)\.then\(/g) || []).length, 2, 'imds e kmsCall');
  assert.match(src, /res\.on\('error', reject\)/);
});
