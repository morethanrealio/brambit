import test from 'node:test';
import assert from 'node:assert/strict';
import { avaliarReducao } from '../web/app-shrink-guard.mjs';

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const pad = (n) => '// ' + 'x'.repeat(n) + '\n';
const rotas = ['/api/toque', '/api/historico', '/api/moradores'];
const servidorGrande = rotas.map((r) => `if (pathname === '${r}') handle();\n`).join('') + pad(6000);

test('rewrite from an old version (file shrinks, nothing new) stays blocked', () => {
  const prev = { 'server.js': b64(servidorGrande), 'public/index.html': b64(pad(3000)) };
  const files = { 'server.js': b64(rotas.map((r) => `'${r}'`).join('\n') + pad(500)), 'public/index.html': b64(pad(3000)) };
  const r = avaliarReducao(prev, files);
  assert.equal(r.bloquear, true);
  assert.equal(r.reorganizacao, false);
});

test('reorganization into modules (25/09 case) passes', () => {
  const prev = { 'server.js': b64(servidorGrande), 'public/index.html': b64(pad(3000)) };
  const files = {
    'server.js': b64("require('./lib/routes/chamadas');\n" + pad(2000)),
    'lib/routes/chamadas.js': b64(servidorGrande + "if (pathname === '/api/visita') novo();\n"),
    'public/index.html': b64(pad(4000)),
  };
  const r = avaliarReducao(prev, files);
  assert.equal(r.reorganizacao, true);
  assert.equal(r.bloquear, false);
});

test('reorganization that loses a server route stays blocked', () => {
  const prev = { 'server.js': b64(servidorGrande) };
  const files = {
    'server.js': b64(pad(2000)),
    'lib/routes.js': b64("'/api/toque' '/api/historico'\n" + pad(9000)),
  };
  const r = avaliarReducao(prev, files);
  assert.equal(r.bloquear, true);
  assert.deepEqual(r.rotasSumidas, ['/api/moradores']);
});

test('app that shrank overall stays blocked', () => {
  const prev = { 'server.js': b64(servidorGrande), 'public/app.js': b64(pad(8000)) };
  const files = { 'server.js': b64(servidorGrande), 'public/app.js': b64(pad(500)) };
  assert.equal(avaliarReducao(prev, files).bloquear, true);
});
