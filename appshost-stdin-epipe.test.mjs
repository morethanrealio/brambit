// Achado #23: ctl() escrevia no stdin do ssh sem listener de 'error'. EPIPE em
// stream chega ASSÍNCRONO, então o try/catch em volta do write não protegia
// nada: o stream jogava a exceção fora de try/catch e matava o processo.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';

const { escreverNoStdin } = await import('./web/appshost.mjs');

// Cano falso: aceita write/end e deixa a gente disparar o EPIPE depois, como o
// sistema operacional faria.
function cano({ lancaNoWrite = null } = {}) {
  const s = new EventEmitter();
  s.escrito = [];
  s.fechado = false;
  s.write = (t) => { if (lancaNoWrite) throw lancaNoWrite; s.escrito.push(t); return true; };
  s.end = () => { s.fechado = true; };
  return s;
}

test('caminho feliz: escreve, fecha e não reporta falha', () => {
  const s = cano();
  assert.equal(escreverNoStdin(s, '{"verb":"ping"}'), null);
  assert.deepEqual(s.escrito, ['{"verb":"ping"}']);
  assert.equal(s.fechado, true);
});

test('EPIPE assíncrono depois do write não derruba nada', () => {
  const s = cano();
  escreverNoStdin(s, 'x');
  const epipe = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
  // Sem o listener instalado, este emit sozinho seria um throw não tratado.
  assert.doesNotThrow(() => s.emit('error', epipe));
});

test('o listener de error é instalado ANTES do write', () => {
  const s = cano({ lancaNoWrite: Object.assign(new Error('cano morto'), { code: 'EPIPE' }) });
  const e = escreverNoStdin(s, 'x');
  assert.equal(e?.message, 'cano morto', 'falha síncrona volta pra quem chamou');
  // mesmo tendo falhado no write, o stream já está protegido
  assert.doesNotThrow(() => s.emit('error', new Error('tardio')));
});

test('ctl usa o helper e não escreve no stdin no braço', () => {
  const src = fs.readFileSync(new URL('./web/appshost.mjs', import.meta.url), 'utf8');
  assert.match(src, /const falhaStdin = escreverNoStdin\(p\.stdin,/);
  assert.ok(!/p\.stdin\.write\(/.test(src), 'nada de write direto no stdin do ssh');
  assert.match(src, /stdin\.on\('error', \(\) => \{\}\)/);
});

test('o lock de tarefa de app também protege o stdin do filho', () => {
  const src = fs.readFileSync(new URL('./web/app-task-store.mjs', import.meta.url), 'utf8');
  assert.match(src, /child\.stdin\.on\('error',\(\)=>\{\}\)/);
  // e a proteção vem antes de qualquer destroy/end do stdin
  assert.ok(src.indexOf("child.stdin.on('error'") < src.indexOf('child.stdin.destroy()'));
});
