// .env.example guard: each rule catches the defect it should catch, with synthetic input.
import test from 'node:test';
import assert from 'node:assert/strict';
import { check, envReads, isProductionSource, parseExample } from './test-support/env-example-guard.mjs';

const reads = new Set(['HOST', 'PGPASSWORD', 'SANDBOX_URL']);
const ok = 'HOST=127.0.0.1\nPGPASSWORD=\n# SANDBOX_URL=\n';

test('exemplo completo, sem segredo e sem IP interno passa', () => {
  assert.deepEqual(check({ example: ok, reads }), []);
});

test('variável lida pelo código e ausente do exemplo reprova; a da lista de exceções não', () => {
  assert.match(check({ example: ok, reads: new Set([...reads, 'NOVA_CHAVE']) }).join('\n'), /NOVA_CHAVE é lida pelo código/);
  assert.deepEqual(check({ example: ok, reads: new Set([...reads, 'TSC_PATH']) }), []);
});

test('variável que ninguém lê mais reprova', () => {
  assert.match(check({ example: ok + '# CODING_MODEL=\n', reads }).join('\n'), /CODING_MODEL está no .env.example mas nenhum/);
});

test('segredo com valor reprova, ativo ou comentado', () => {
  assert.match(check({ example: ok.replace('PGPASSWORD=', 'PGPASSWORD=hunter2'), reads }).join('\n'), /PGPASSWORD .* tem valor/);
  const r = new Set([...reads, 'WA_TOKEN']);
  assert.match(check({ example: ok + '# WA_TOKEN=abc\n', reads: r }).join('\n'), /WA_TOKEN .* tem valor/);
});

test('IP de rede interna e host da nossa infra reprovam; loopback passa', () => {
  const ip = check({ example: ok.replace('# SANDBOX_URL=', '# SANDBOX_URL=http://172.31.2.152:9000'), reads }).join('\n');
  assert.match(ip, /IP 172\.31\.2\.152/);
  const host = check({ example: ok.replace('# SANDBOX_URL=', '# SANDBOX_URL=https://dev.mara.mtr.center'), reads }).join('\n');
  assert.match(host, /nossa infra/);
  assert.match(check({ example: ok + '# DONO=x # oi@brambs.com.br\n', reads: new Set([...reads, 'DONO']) }).join('\n'), /nossa infra/);
});

test('variável repetida reprova', () => {
  assert.match(check({ example: ok + '# HOST=0.0.0.0\n', reads }).join('\n'), /HOST aparece duas vezes/);
});

test('leitura e recorte: process.env.X e process.env["X"]; fora teste, ops e navegador', () => {
  assert.deepEqual([...envReads('a=process.env.FOO||1; b=process.env["BAR"]; c=process.env.lower')].sort(), ['BAR', 'FOO']);
  assert.deepEqual(parseExample('# A=1\nB=\n#  comentário\nC').map((e) => [e.name, e.active]), [['A', false], ['B', true]]);
  assert.ok(isProductionSource('web/modulo-sintetico.mjs'));
  for (const f of ['web/x.test.mjs', 'ops/script-sintetico.mjs', 'test-support/a.mjs', 'web/public/app.js', 'README.md']) assert.equal(isProductionSource(f), false, f);
});
