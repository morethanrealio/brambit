// Anti DNS rebinding: the connection has to go to the validated IP, not to whatever the
// DNS returns at connection time.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { ipPrivado, resolverPublico, fetchFixado } from './web/net-pin.mjs';

test('reconhece faixas internas', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '169.254.169.254', '172.16.5.10',
    '192.168.0.1', '100.64.0.1', '::1', 'fd00::1', 'fe80::1', '::ffff:169.254.169.254']) {
    assert.equal(ipPrivado(ip), true, ip);
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700::1111']) assert.equal(ipPrivado(ip), false, ip);
});

test('IP interno literal é recusado antes de conectar', async () => {
  await assert.rejects(() => resolverPublico('169.254.169.254'), /interno/);
  await assert.rejects(() => fetchFixado('http://169.254.169.254/latest/meta-data/'), /interno/);
});

test('a conexão vai para o IP fixado, com o Host original preservado', async () => {
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(`host=${req.headers.host}`);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const porta = srv.address().port;
  try {
    // The resolver returns an already-validated address; the hostname doesn't even exist in DNS.
    const r = await fetchFixado(`http://rebind.invalido.example:${porta}/x`, {
      resolver: async () => [{ address: '127.0.0.1', family: 4 }],
    });
    assert.equal(r.status, 200);
    assert.equal(await r.text(), `host=rebind.invalido.example:${porta}`);
  } finally { srv.close(); }
});

test('corpo acima do teto é cortado', async () => {
  const srv = http.createServer((req, res) => { res.writeHead(200); res.end(Buffer.alloc(50_000)); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const porta = srv.address().port;
  try {
    await assert.rejects(() => fetchFixado(`http://x.example:${porta}/`, {
      resolver: async () => [{ address: '127.0.0.1', family: 4 }], maxBytes: 1000,
    }));
  } finally { srv.close(); }
});

test('protocolo fora de http/https é recusado', async () => {
  await assert.rejects(() => fetchFixado('file:///etc/passwd'), /protocolo/);
});

test('status fora de 200..599 vira erro da chamada, sem derrubar o processo', async () => {
  // LinkedIn responds 999 to bots; Node's Response does not accept that status.
  const srv = http.createServer((req, res) => { res.writeHead(999, 'Request denied'); res.end('x'); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const porta = srv.address().port;
  try {
    await assert.rejects(() => fetchFixado(`http://x.example:${porta}/`, {
      resolver: async () => [{ address: '127.0.0.1', family: 4 }],
    }), /fora do padrão \(999\)/);
  } finally { srv.close(); }
});
