// Finding #23: ctl() wrote to ssh's stdin without an 'error' listener. EPIPE on a
// stream arrives ASYNCHRONOUSLY, so the try/catch around the write protected
// nothing: the stream threw the exception outside the try/catch and killed the process.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';

const { escreverNoStdin } = await import('./web/appshost.mjs');

// Fake pipe: accepts write/end and lets us fire the EPIPE afterward, the way the
// operating system would.
function cano({ lancaNoWrite = null } = {}) {
  const s = new EventEmitter();
  s.escrito = [];
  s.fechado = false;
  s.write = (t) => { if (lancaNoWrite) throw lancaNoWrite; s.escrito.push(t); return true; };
  s.end = () => { s.fechado = true; };
  return s;
}

test('happy path: writes, closes and reports no failure', () => {
  const s = cano();
  assert.equal(escreverNoStdin(s, '{"verb":"ping"}'), null);
  assert.deepEqual(s.escrito, ['{"verb":"ping"}']);
  assert.equal(s.fechado, true);
});

test('async EPIPE after the write does not crash anything', () => {
  const s = cano();
  escreverNoStdin(s, 'x');
  const epipe = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
  // Without the listener installed, this emit alone would be an unhandled throw.
  assert.doesNotThrow(() => s.emit('error', epipe));
});

test('the error listener is installed BEFORE the write', () => {
  const s = cano({ lancaNoWrite: Object.assign(new Error('cano morto'), { code: 'EPIPE' }) });
  const e = escreverNoStdin(s, 'x');
  assert.equal(e?.message, 'cano morto', 'synchronous failure goes back to the caller');
  // even having failed on write, the stream is already protected
  assert.doesNotThrow(() => s.emit('error', new Error('tardio')));
});

test('ctl uses the helper and does not write to stdin by hand', () => {
  const src = fs.readFileSync(new URL('./web/appshost.mjs', import.meta.url), 'utf8');
  assert.match(src, /const falhaStdin = escreverNoStdin\(p\.stdin,/);
  assert.ok(!/p\.stdin\.write\(/.test(src), 'no direct write to ssh stdin');
  assert.match(src, /stdin\.on\('error', \(\) => \{\}\)/);
});

test('the app task lock also protects the child stdin', () => {
  const src = fs.readFileSync(new URL('./web/app-task-store.mjs', import.meta.url), 'utf8');
  assert.match(src, /child\.stdin\.on\('error',\(\)=>\{\}\)/);
  // and the protection comes before any destroy/end of stdin
  assert.ok(src.indexOf("child.stdin.on('error'") < src.indexOf('child.stdin.destroy()'));
});
