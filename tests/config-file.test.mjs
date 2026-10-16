// Config file read and watched by the server (web/config-file.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  configValues, formatValue, parseConfig, updateConfigText,
  startConfigFile, stopConfigFile, writeConfig, onConfigChange, status,
} from '../web/config-file.mjs';
import { initVault } from '../web/vault.mjs';

// One vault key for the whole file: the vault module keeps the first key it loads.
const VAULT_KEY = crypto.randomBytes(32).toString('base64');
const seal = (plain) => {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', Buffer.from(VAULT_KEY, 'base64'), iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return 'vault:v1:' + Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
};

const quiet = { log() {}, warn() {}, error() {} };
const tmpFile = (text) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brambit-config-'));
  const file = path.join(dir, '.env');
  fs.writeFileSync(file, text, { mode: 0o600 });
  return file;
};
const until = async (cond, ms = 3000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 20))) if (cond()) return;
  assert.fail('condition not met in time');
};

// First: needs the vault with no key loaded yet.
test('an encrypted value waits for the vault and never reaches the env as ciphertext', async (t) => {
  const blob = seal('sk-late');
  const file = tmpFile(`API_KEY=${blob}\n`);
  // systemd already loaded the same file: the ciphertext is in the env at start.
  const env = { BRAMBIT_CONFIG_FILE: file, API_KEY: blob };
  t.after(stopConfigFile);
  startConfigFile({ env, watchMs: 0, log: quiet });
  assert.equal('API_KEY' in env, false);
  assert.deepEqual(status().waitingForVault, ['API_KEY']);
  process.env.VAULT_KEY = VAULT_KEY;
  await initVault();
  await until(() => env.API_KEY === 'sk-late');
});

test('reads values the way systemd does', () => {
  const v = configValues([
    '# comment', '  ; also a comment', 'A=plain', 'B = spaced  ', "C='single $HOME \\n'",
    'D="double \\"q\\" \\\\ $x"', 'E=a\\ b', "F='multi", "line'", 'G=x # y', "H='kept '  ", 'export I=1', '',
  ].join('\n'));
  assert.deepEqual(v, {
    A: 'plain', B: 'spaced', C: 'single $HOME \\n', D: 'double "q" \\ $x', E: 'a b',
    F: 'multi\nline', G: 'x # y', H: 'kept ', I: '1',
  });
  const { errors } = parseConfig('G=x # y\nnot a line\nJ="open');
  assert.deepEqual(errors.map((e) => e.line), [1, 2, 3]);
});

test('writes only safe forms and refuses the rest', () => {
  assert.equal(formatValue('sk-abc_1.2:3/4@x+y=z'), 'sk-abc_1.2:3/4@x+y=z');
  assert.equal(formatValue('a b $c "d"'), `'a b $c "d"'`);
  assert.throws(() => formatValue("it's"), /single quote/);
  assert.throws(() => formatValue('a\nb'), /line break/);
  for (const v of ['plain', 'a b $c "d" #e \\f', '']) {
    assert.equal(configValues(updateConfigText('', { K: v })).K, v);
  }
});

test('an update keeps comments, order and the other lines', () => {
  const before = '# head\r\nA=1\r\n# B=default\r\nC=\'x\r\ny\'\r\nD=4\r\n';
  const after = updateConfigText(before, { A: '9', B: 'new', C: null, E: 'end' });
  assert.equal(after, '# head\r\nA=9\r\n# B=default\r\nB=new\r\nD=4\r\nE=end\r\n');
  assert.equal(updateConfigText('A=1\nA=2\n', { A: '3' }), 'A=3\n');
});

test('applies the file, follows hand edits and restores what it removes', async (t) => {
  const file = tmpFile('KEEP=file\nFROM_FILE=1\nPINNED=file\n');
  const env = { BRAMBIT_CONFIG_FILE: file, BRAMBIT_CONFIG_PINNED: 'PINNED', KEEP: 'shell', FROM_FILE: '1', PINNED: 'launcher' };
  t.after(stopConfigFile);
  startConfigFile({ env, watchMs: 20, log: quiet });
  assert.equal(env.KEEP, 'file');
  assert.equal(env.PINNED, 'launcher');
  const seen = [];
  onConfigChange((keys) => seen.push(...keys));

  fs.writeFileSync(file, 'NEW=yes\nPINNED=other\n');
  await until(() => env.NEW === 'yes');
  // KEEP came from the shell: back to it. FROM_FILE only existed because of the file: gone.
  assert.equal(env.KEEP, 'shell');
  assert.equal('FROM_FILE' in env, false);
  assert.equal(env.PINNED, 'launcher');
  assert.deepEqual(seen.sort(), ['FROM_FILE', 'KEEP', 'NEW']);
});

test('the screen writes encrypted, in place, with the same permissions', async (t) => {
  process.env.VAULT_KEY = VAULT_KEY;
  const file = tmpFile('# API_KEY=\nOTHER=1\n');
  const env = { BRAMBIT_CONFIG_FILE: file };
  t.after(stopConfigFile);
  startConfigFile({ env, watchMs: 0, log: quiet });
  writeConfig({ API_KEY: 'sk-secret', OTHER: null }, { encrypt: ['API_KEY'] });
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /^# API_KEY=\nAPI_KEY=vault:v1:[A-Za-z0-9+/=]+\n$/);
  assert.equal(env.API_KEY, 'sk-secret');
  assert.equal('OTHER' in env, false);
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});
