// Cookie without Secure ONLY on the same computer (Safari discards a Secure cookie on
// http://localhost). The risk is the opposite: production or a tunnel losing the
// Secure flag. Real http server on loopback; no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { pedidoLocal, prepararResposta } from './web/cookie-local.mjs';

const LOCAL = { BRAMBS_LOCAL: '1' };
const fake = (headers, remoteAddress = '127.0.0.1') => ({ headers, socket: { remoteAddress } });

test('only local with BRAMBS_LOCAL, a loopback address, a loopback Host and no proxy', () => {
  assert.equal(pedidoLocal(fake({ host: 'localhost:8080' }), LOCAL), true);
  assert.equal(pedidoLocal(fake({ host: '[::1]:8080' }, '::1'), LOCAL), true);
  assert.equal(pedidoLocal(fake({ host: 'localhost:8080' }), {}), false);
  assert.equal(pedidoLocal(fake({ host: 'localhost:8080' }, '192.168.0.9'), LOCAL), false);
  assert.equal(pedidoLocal(fake({ host: 'casa.exemplo.com' }), LOCAL), false);
  assert.equal(pedidoLocal(fake({ host: 'localhost:8080', 'x-forwarded-proto': 'https' }), LOCAL), false);
});

test('set-cookie drops Secure on a local request and keeps it on others, via setHeader and via writeHead', async (t) => {
  let env = LOCAL;
  const server = http.createServer((req, res) => {
    prepararResposta(req, res, { 'X-Frame-Options': 'DENY' }, env);
    res.setHeader('Set-Cookie', ['a=1; HttpOnly; Secure; SameSite=Lax; Path=/']);
    res.writeHead(200, { 'set-cookie': 'sid=x; HttpOnly; Secure; SameSite=Lax; Path=/' });
    res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const pede = (host) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: server.address().port, headers: { host } }, (res) => { res.resume(); resolve(res.headers); }).on('error', reject);
  });

  const local = await pede('localhost');
  assert.equal(local['x-frame-options'], 'DENY');
  assert.deepEqual(local['set-cookie'], ['sid=x; HttpOnly; SameSite=Lax; Path=/']);
  for (const h of [await pede('casa.exemplo.com'), (env = {}, await pede('localhost'))])
    assert.deepEqual(h['set-cookie'], ['sid=x; HttpOnly; Secure; SameSite=Lax; Path=/']);
});
