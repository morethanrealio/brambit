// Vault: saving a secret has to FAIL CLOSED.
// Bug: vaultEnabled() only looked at the env's VAULT_KEY, so on an installation with
// a key via KMS (VAULT_KEY_ENC) — or when the KMS unwrap fails at boot —
// encMaybe() returned the secret in PLAIN TEXT and it was saved that way in the DB.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ENV_KEYS = ['VAULT_KEY', 'VAULT_KEY_ENC', 'BRAMBS_LOCAL', 'VAULT_KEY_FILE'];
let n = 0;
// vault.mjs caches the key in the module; each scenario needs a fresh instance.
async function loadVault(env) {
  const saved = {};
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  Object.assign(process.env, env);
  const mod = await import(`../web/vault.mjs?caso=${++n}`);
  return { mod, restore() { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } } };
}

const KEY32 = Buffer.alloc(32, 7).toString('base64');

test('no key at all: initVault flags it and writing refuses plain text', async () => {
  const { mod, restore } = await loadVault({});
  try {
    assert.equal(mod.vaultConfigured(), false);
    assert.equal(mod.vaultEnabled(), false);
    assert.throws(() => mod.encMaybe('segredo'), /texto puro/);
    assert.equal(mod.encMaybe(null), null);
    await assert.rejects(mod.initVault(), (e) => e.code === 'VAULT_BOOT' && /BRAMBS_LOCAL/.test(e.message));
  } finally { restore(); }
});

// The plan's bug (phase B item 4): a malformed VAULT_KEY counted as "no vault"
// and the secret went to the DB in the clear, with the server up and running.
for (const [nome, valor] of [['curta demais', 'abc'], ['hex no lugar de base64', 'a'.repeat(64)], ['lixo', 'não é base64 nenhum!!']]) {
  test(`malformed VAULT_KEY (${nome}): initVault flags it and nothing goes out in plain text`, async () => {
    const { mod, restore } = await loadVault({ VAULT_KEY: valor });
    try {
      assert.equal(mod.vaultConfigured(), true, 'malformed = vault configured and broken');
      assert.equal(mod.vaultEnabled(), false);
      assert.throws(() => mod.encMaybe('segredo'), /texto puro/);
      await assert.rejects(mod.initVault(), (e) => e.code === 'VAULT_BOOT' && /32/.test(e.message));
      assert.ok(!(await mod.initVault().catch((e) => e.message)).includes(valor), 'message does not echo the key');
    } finally { restore(); }
  });
}

// A bad key doesn't bring down the server: boot (initVaultNoBoot) continues in
// degraded mode, only with the alarm in the log, and saving a secret keeps refusing.
for (const [nome, env] of [['sem chave', {}], ['VAULT_KEY malformada', { VAULT_KEY: 'abc' }]]) {
  test(`boot with ${nome}: server stays up, alarm in the log, secret refused`, async () => {
    const { mod, restore } = await loadVault(env);
    const logs = [];
    try {
      const r = await mod.initVaultNoBoot({ error: (...a) => logs.push(a.join(' ')) });
      assert.equal(r.ok, false);
      assert.match(logs.join('\n'), /ALERTA.*modo degradado/);
      assert.throws(() => mod.encMaybe('segredo'), /texto puro/);
    } finally { restore(); }
  });
}

test('boot with a good key: initVaultNoBoot ok and encrypts normally', async () => {
  const { mod, restore } = await loadVault({ VAULT_KEY: KEY32 });
  try {
    assert.deepEqual(await mod.initVaultNoBoot({ error: () => assert.fail('should not log an error') }), { ok: true });
    assert.match(mod.encMaybe('segredo'), /^v1:/);
  } finally { restore(); }
});

test('VAULT_KEY without the trailing "=" (43 characters) still works', async () => {
  const { mod, restore } = await loadVault({ VAULT_KEY: KEY32.replace(/=+$/, '') });
  try {
    await mod.initVault();
    assert.equal(mod.decMaybe(mod.encMaybe('segredo')), 'segredo');
  } finally { restore(); }
});

test('local mode: generates its own key, 0600, and reuses it on the next boot', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cofre-local-'));
  const file = path.join(dir, 'sub', 'vault.key');
  const env = { BRAMBS_LOCAL: '1', VAULT_KEY_FILE: file };
  try {
    const a = await loadVault(env);
    let blob;
    try {
      assert.equal(a.mod.vaultConfigured(), true);
      await a.mod.initVault();
      assert.equal((fs.statSync(file).mode & 0o777), 0o600);
      blob = a.mod.encMaybe('segredo');
      assert.ok(blob.startsWith('v1:'));
    } finally { a.restore(); }
    const b = await loadVault(env);
    try {
      await b.mod.initVault();
      assert.equal(b.mod.decMaybe(blob), 'segredo', 'second boot decrypts what the first one encrypted');
    } finally { b.restore(); }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('local mode with a corrupted key file: stops, without overwriting', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cofre-local-'));
  const file = path.join(dir, 'vault.key');
  fs.writeFileSync(file, 'curta\n');
  const { mod, restore } = await loadVault({ BRAMBS_LOCAL: '1', VAULT_KEY_FILE: file });
  try {
    await assert.rejects(mod.initVault(), (e) => e.code === 'VAULT_BOOT');
    assert.equal(fs.readFileSync(file, 'utf8'), 'curta\n');
  } finally { restore(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('env key wins over local mode (does not generate a file)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cofre-local-'));
  const file = path.join(dir, 'vault.key');
  const { mod, restore } = await loadVault({ BRAMBS_LOCAL: '1', VAULT_KEY_FILE: file, VAULT_KEY: KEY32 });
  try {
    await mod.initVault();
    assert.equal(fs.existsSync(file), false);
  } finally { restore(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('legacy VAULT_KEY: encrypts and decrypts', async () => {
  const { mod, restore } = await loadVault({ VAULT_KEY: KEY32 });
  try {
    assert.equal(mod.vaultConfigured(), true);
    assert.equal(mod.vaultEnabled(), true);
    const blob = mod.encMaybe('segredo');
    assert.ok(blob.startsWith('v1:'));
    assert.equal(mod.decMaybe(blob), 'segredo');
  } finally { restore(); }
});

test('KMS mode without initVault: refuses to write instead of leaking plain text', async () => {
  const { mod, restore } = await loadVault({ VAULT_KEY_ENC: 'blob-kms-qualquer' });
  try {
    assert.equal(mod.vaultConfigured(), true, 'installation DOES have a vault');
    assert.equal(mod.vaultEnabled(), false, 'but the key did not load');
    assert.throws(() => mod.encMaybe('segredo'), /texto puro/);
  } finally { restore(); }
});

test('KMS failed with an old VAULT_KEY in the env: does not encrypt with the wrong key', async () => {
  const { mod, restore } = await loadVault({ VAULT_KEY_ENC: 'blob-kms-qualquer', VAULT_KEY: KEY32 });
  try {
    assert.equal(mod.vaultEnabled(), false);
    assert.throws(() => mod.encMaybe('segredo'), /texto puro/);
    assert.throws(() => mod.encryptSecret('segredo'), /KMS/);
  } finally { restore(); }
});

test('reading stays tolerant of a legacy plain-text line', async () => {
  const { mod, restore } = await loadVault({ VAULT_KEY: KEY32 });
  try {
    assert.equal(mod.decMaybe('token-legado-em-claro'), 'token-legado-em-claro');
    assert.equal(mod.decMaybe(null), null);
  } finally { restore(); }
});
