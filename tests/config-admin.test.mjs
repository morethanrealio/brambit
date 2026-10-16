// Admin settings screen (web/config-admin.mjs) and its test buttons
// (web/config-checks.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { HIDDEN_KEYS, parseExample, prepareSave, registerConfigAdmin } from '../web/config-admin.mjs';
import { defaultTools, runCheck } from '../web/config-checks.mjs';
import { createRotas } from '../web/rotas.mjs';
import { startConfigFile, stopConfigFile } from '../web/config-file.mjs';

const quiet = { log() {}, warn() {}, error() {} };

test('every setting documented in .env.example shows on the screen, hidden ones excepted', () => {
  const text = fs.readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
  const documented = new Set([...text.matchAll(/^#?\s?([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]));
  const shown = parseExample(text).flatMap((s) => s.groups.flatMap((g) => g.items.filter((i) => i.key).map((i) => i.key)));
  const missing = [...documented].filter((k) => !HIDDEN_KEYS.has(k) && !shown.includes(k));
  assert.deepEqual(missing, []);
  assert.ok(!shown.some((k) => HIDDEN_KEYS.has(k)));
});

test('a save only takes known, editable settings and encrypts secrets', () => {
  const st = { active: true, pinned: ['PORT'], waitingForVault: [] };
  const opts = { env: {}, fileValues: { MY_OWN: 'x' }, st };
  assert.deepEqual(prepareSave({ NODE_OPTIONS: '--require /tmp/x.js' }, opts), { error: 'unknown_setting', key: 'NODE_OPTIONS' });
  assert.deepEqual(prepareSave({ VAULT_KEY: 'abc' }, opts), { error: 'read_only', key: 'VAULT_KEY' });
  assert.deepEqual(prepareSave({ PORT: '9000' }, opts), { error: 'read_only', key: 'PORT' });
  assert.deepEqual(prepareSave({ TAVILY_URL: "it's" }, opts), { error: 'bad_value', key: 'TAVILY_URL' });
  assert.deepEqual(
    prepareSave({ TOGETHER_API_KEY: ' sk-1 ', PGPASSWORD: 'pw', MY_OWN: null, TAVILY_URL: '', GEMINI_API_KEY: null }, opts),
    { updates: { TOGETHER_API_KEY: 'sk-1', PGPASSWORD: 'pw', MY_OWN: null }, encrypt: ['TOGETHER_API_KEY'] },
  );
});

// Drives the registered routes like the server does.
async function call(rotas, method, pathname, { user, body } = {}) {
  const req = Readable.from(body === undefined ? [] : [JSON.stringify(body)]);
  req.method = method;
  req.headers = { 'content-type': 'application/json' };
  const res = { code: 0, headers: {}, out: '', writeHead(c, h) { this.code = c; Object.assign(this.headers, h); }, end(s) { this.out += s ?? ''; } };
  const answered = await rotas.atender(req, res, new URL(pathname, 'http://x'), { currentUser: async () => user ?? null });
  return { answered, code: res.code, json: res.out ? JSON.parse(res.out) : null };
}

test('only the admin reaches the settings, and a secret never goes back to the browser', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brambit-admin-'));
  const file = path.join(dir, '.env');
  fs.writeFileSync(file, 'ADMIN_EMAIL=boss@example.com\nTOGETHER_API_KEY=sk-secret-value\nTAVILY_URL=https://search.example\n', { mode: 0o600 });
  const saved = { ...process.env };
  process.env.BRAMBIT_CONFIG_FILE = file;
  startConfigFile({ env: process.env, log: quiet, watchMs: 60_000 });
  t.after(() => { stopConfigFile(); process.env = saved; });

  const checks = [];
  const rotas = createRotas();
  registerConfigAdmin(rotas, { sendHtml() {}, countDeepSeek: async () => 0, check: async (name, values) => { checks.push([name, values.TOGETHER_API_KEY]); return { ok: true }; } });
  const boss = { email: 'Boss@example.com' };
  const other = { email: 'someone@example.com' };

  for (const [method, p] of [['GET', '/api/admin/settings'], ['POST', '/api/admin/settings'], ['POST', '/api/admin/settings/test']]) {
    assert.equal((await call(rotas, method, p, { user: other, body: {} })).answered, false, `${method} ${p}`);
    assert.equal((await call(rotas, method, p, { body: {} })).answered, false, `${method} ${p} logged out`);
  }

  const got = await call(rotas, 'GET', '/api/admin/settings', { user: boss });
  assert.equal(got.code, 200);
  assert.ok(!JSON.stringify(got.json).includes('sk-secret-value'));
  const items = got.json.sections.flatMap((s) => s.groups.flatMap((g) => g.items));
  assert.deepEqual(items.find((i) => i.key === 'TOGETHER_API_KEY'), { key: 'TOGETHER_API_KEY', secret: true, source: 'file', isSet: true, restart: false, readOnly: false, encrypted: false, sample: '' });
  assert.equal(items.find((i) => i.key === 'TAVILY_URL').value, 'https://search.example');

  // A value typed and not saved is tested; anything outside the screen is ignored.
  await call(rotas, 'POST', '/api/admin/settings/test', { user: boss, body: { check: 'together', values: { TOGETHER_API_KEY: 'sk-typed', NODE_OPTIONS: 'x' } } });
  assert.deepEqual(checks, [['together', 'sk-typed']]);

  // Handing the admin role to someone else needs a confirmation.
  const handOver = await call(rotas, 'POST', '/api/admin/settings', { user: boss, body: { updates: { ADMIN_EMAIL: 'new@example.com' } } });
  assert.equal(handOver.code, 409);
  assert.deepEqual(handOver.json, { error: 'confirm', confirm: [{ kind: 'admin_email' }] });

  const saved2 = await call(rotas, 'POST', '/api/admin/settings', { user: boss, body: { updates: { TAVILY_URL: 'https://other.example', TOGETHER_API_KEY: null } } });
  assert.equal(saved2.code, 200);
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /^TAVILY_URL=https:\/\/other\.example$/m);
  assert.doesNotMatch(text, /TOGETHER_API_KEY/);
});

test('a check reports what is missing and never echoes the service answer', async () => {
  assert.deepEqual(await runCheck('whatsapp', { WA_TOKEN: 't' }), { ok: false, reason: 'missing', missing: ['WA_PHONE_NUMBER_ID'] });
  const fetchFn = async () => new Response('{"error":"bad key sk-123"}', { status: 401 });
  assert.deepEqual(await runCheck('together', { TOGETHER_API_KEY: 'sk-123' }, defaultTools({ fetchFn })), { ok: false, reason: 'rejected' });
  const down = async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }); };
  assert.deepEqual(await runCheck('typesafe', { TYPESAFE_API_KEY: 'k' }, defaultTools({ fetchFn: down })), { ok: false, reason: 'host_not_found' });
});
