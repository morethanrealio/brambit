// Extensions (web/extensions.mjs): which ones run per usage profile, the ports
// they open for plugins, and the single answerer for contacts without an
// account (web/guest-contacts.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readExtensions, extensionPorts, loadExtensions } from '../web/extensions.mjs';
import { juntarPortas } from '../web/plugins.mjs';
import { createGuestContacts } from '../web/guest-contacts.mjs';

const registry = {
  alpha: { load: async () => ({ default: { nome: 'alpha' } }), pluginPorts: ['alphaPort'] },
  beta: { load: async () => ({ default: { nome: 'other' } }) },
};
const rules = {
  complete: { defaults: ['alpha'], requires: [], forbids: [] },
  personal: { defaults: [], requires: [], forbids: ['alpha'] },
  'public-support': { defaults: ['alpha'], requires: ['alpha'], forbids: [] },
};
const read = (value, profile) => readExtensions(value, { profile, registry, rules });

test('readExtensions: profile default when unset, explicit list otherwise', () => {
  assert.deepEqual(read(undefined, 'complete'), ['alpha']);
  assert.deepEqual(read('', 'personal'), []);
  assert.deepEqual(read(' Alpha, alpha ', 'complete'), ['alpha']);
  assert.deepEqual(read('none', 'complete'), []);
});

test('readExtensions: unknown names and lists that contradict the profile fail', () => {
  assert.throws(() => read('gamma', 'complete'), /unknown extension "gamma"/);
  assert.throws(() => read('none', 'public-support'), /needs the alpha extension/);
  assert.throws(() => read('alpha', 'personal'), /runs without the alpha extension/);
});

test('loadExtensions: the extension has to carry its own name', async () => {
  assert.deepEqual((await loadExtensions(['alpha'], registry)).map((e) => e.nome), ['alpha']);
  await assert.rejects(loadExtensions(['beta'], registry), /nome has to be "beta"/);
});

test('a plugin can fill a port an extension opens, even with the extension off', () => {
  const plugin = { nome: 'p', portas: () => ({ alphaPort: 1 }) };
  assert.throws(() => juntarPortas([plugin], {}), /alphaPort/);
  assert.deepEqual(juntarPortas([plugin], {}, extensionPorts(registry)), { alphaPort: 1 });
});

test('guest contacts: nobody answers until one extension registers, and only one can', async () => {
  const g = createGuestContacts();
  assert.equal(await g.whatsapp.atende(), false);
  g.register({ whatsapp: { atende: async () => true, turno: async ({ mensagem }) => `re: ${mensagem}` } }, 'first');
  assert.equal(await g.whatsapp.atende(), true);
  assert.equal(await g.whatsapp.turno({ mensagem: 'hi' }), 're: hi');
  assert.throws(() => g.register({ whatsapp: { atende: async () => true, turno: async () => '' } }, 'second'), /already answered by first/);
});
