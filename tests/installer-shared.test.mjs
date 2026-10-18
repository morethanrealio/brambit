// Brambit on your own computer shared with the household (installer/shared.mjs):
// the risk is an address that would put a login cookie or a link on plain http,
// on this computer's own name, or with a path the server does not serve; and the
// invite text still pointing at the neutral brand's localhost.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sharedUrlOf } from '../installer/shared.mjs';
import { createInstallationPlugin } from '../installer/plugin/index.mjs';
import { definirMarca, hostDaMarca } from '../web/brand.mjs';

test('the shared address is an https origin other devices open', () => {
  assert.deepEqual(sharedUrlOf(''), {});
  assert.deepEqual(sharedUrlOf(undefined), {});
  assert.deepEqual(sharedUrlOf(' home.tailnet-example.ts.net '), { url: 'https://home.tailnet-example.ts.net' });
  assert.deepEqual(sharedUrlOf('https://home.tailnet-example.ts.net/'), { url: 'https://home.tailnet-example.ts.net' });
  for (const bad of ['http://home.tailnet-example.ts.net', 'https://home.tailnet-example.ts.net/app', 'https://home.tailnet-example.ts.net/?a=1',
    'https://user:pw@home.tailnet-example.ts.net', 'https://localhost', 'https://127.0.0.1:8080', 'https://[::1]', 'not an address']) {
    assert.ok(sharedUrlOf(bad).error, bad);
  }
});

test('shared, the texts that send someone to the app name the shared address', () => {
  const server = { rotas: { registrar() {} }, send() {}, sendHtml() {} };
  try {
    createInstallationPlugin({ info: { url: 'http://127.0.0.1:8080' } }).ligar(server);
    assert.equal(hostDaMarca(), 'localhost:8080');
    createInstallationPlugin({ info: { url: 'http://127.0.0.1:8080', shared: 'https://home.tailnet-example.ts.net' } }).ligar(server);
    assert.equal(hostDaMarca(), 'home.tailnet-example.ts.net');
  } finally { definirMarca(); }
});
