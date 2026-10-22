// ── Admin settings screen ──
// /admin/settings shows and edits the installation's config file
// (BRAMBIT_CONFIG_FILE, config-file.mjs). The screen is only a way to edit
// that file: what it shows is what the file and the running server hold, and
// what it saves goes to the file, which the server applies by itself.
//
// The settings, their sections and their help come from .env.example, so a
// new setting documented there shows up here with no change to this module.
// Keys in the file that .env.example does not list appear under "other".
//
// Only the administrator (ADMIN_EMAIL) sees it; anyone else gets a 404.
// Secrets are never sent back to the browser, only whether they are set, and
// are stored encrypted with the vault key. A test button checks a group of
// settings without sending anything (config-checks.mjs).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readBody } from './http-body.mjs';
import { SEGUE } from './routes.mjs';
import { ConfigValueError, ENCRYPTED_PREFIX, configFilePath, configValues, formatValue, status, writeConfig } from './config-file.mjs';
import { vaultEnabled } from './vault.mjs';
import { pool, S } from './db.mjs';
import { checksFor, runCheck } from './config-checks.mjs';
import { readProfile } from './profiles.mjs';
import { adminUser } from './admin-user.mjs';

const EXAMPLE_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.env.example');
const KEY_LINE = /^(#\s?)?([A-Z][A-Z0-9_]*)=(.*)$/;
const MAX_VALUE = 16384;

// Read once, when the server starts: applies on the next start.
export const RESTART_KEYS = new Set([
  'HOST', 'PORT', 'PGHOST', 'PGPORT', 'PGUSER', 'PGPASSWORD', 'PGDATABASE',
  'BRAMBIT_PLUGINS', 'BRAMBIT_PROFILE', 'APP_TASK_STORE_DIR', 'CODING_JOB_STORE_DIR', 'BRAMBIT_LOCALES_DIR',
  'BRAMBIT_SHARED_URL',
]);
// Which vault key is in use. Changing it makes every stored secret unreadable,
// so the screen shows them and does not edit them.
export const VAULT_KEYS = new Set(['BRAMBS_LOCAL', 'VAULT_KEY', 'VAULT_KEY_ENC', 'VAULT_KEY_FILE', 'KMS_KEY_ID', 'KMS_REGION']);
// Set by the launcher (npm run brambit) or about the config file itself.
export const HIDDEN_KEYS = new Set(['BRAMBIT_CONFIG_FILE', 'BRAMBIT_CONFIG_PINNED', 'BRAMBIT_DATA_DIR', 'BRAMBIT_PORT', 'BRAMBIT_INSTALLATION']);
// Needed before the vault key opens (the database), so stored in clear; the
// file itself is readable only by its owner.
export const CLEAR_SECRETS = new Set(['PGPASSWORD']);
const NOT_SECRET = new Set(['APPS_HOST_KEY', 'VAULT_KEY_FILE']);
export const isSecret = (key) => !NOT_SECRET.has(key) && /(TOKEN|SECRET|PASS|PASSWORD|_KEY|_KEY_ENC)$/.test(key);

const isOff = (v) => /^(0|false|off)$/i.test(String(v ?? '').trim());

// What the running server read at start, to tell which restart-only settings
// changed since.
const atStart = { ...process.env };

// .env.example as sections > groups > items. A group is a block between blank
// lines; its items are the comment lines (notes) and the settings, in order.
// The notes right before a hidden setting are about it and go with it.
export function parseExample(text) {
  const sections = [];
  let section = null, group = null, notes = [], rule = false;
  const close = () => { if (group && notes.length) group.items.push(...notes.map((note) => ({ note }))); notes = []; group = null; };
  for (const line of String(text).split(/\r?\n/)) {
    if (/^#\s*-{10,}\s*$/.test(line)) { rule = true; continue; }
    const head = rule && line.match(/^#\s*(\d+)\.\s+(.+)$/);
    rule = false;
    if (head) { close(); section = { id: head[1], title: head[2].trim(), groups: [] }; sections.push(section); continue; }
    if (!section) continue;
    if (!line.trim()) { close(); continue; }
    if (!group) { group = { items: [] }; section.groups.push(group); }
    const m = line.match(KEY_LINE);
    if (m) {
      if (HIDDEN_KEYS.has(m[2])) { notes = []; continue; }
      group.items.push(...notes.map((note) => ({ note })), { key: m[2], sample: m[3] });
      notes = [];
    } else if (line.startsWith('#')) notes.push(line.replace(/^#\s?/, ''));
  }
  close();
  for (const s of sections) s.groups = s.groups.filter((g) => g.items.some((i) => i.key));
  return sections.filter((s) => s.groups.length);
}

let example = null;
const exampleSections = () => (example ??= parseExample(fs.readFileSync(EXAMPLE_FILE, 'utf8')));
const exampleKeys = () => new Set(exampleSections().flatMap((s) => s.groups.flatMap((g) => g.items.filter((i) => i.key).map((i) => i.key))));

const readFileValues = () => {
  const file = configFilePath();
  try { return file && fs.existsSync(file) ? configValues(fs.readFileSync(file, 'utf8')) : {}; } catch { return {}; }
};

// One setting as the browser sees it. A secret's value never leaves here.
function keyState(key, fileValues, st, env) {
  const inFile = key in fileValues;
  const pinned = !!st.pinned?.includes(key);
  const secret = isSecret(key);
  const value = env[key];
  const out = {
    key, secret,
    source: pinned ? 'launcher' : inFile ? 'file' : value !== undefined ? 'environment' : 'unset',
    isSet: !!(value || fileValues[key]),
    restart: RESTART_KEYS.has(key),
    readOnly: VAULT_KEYS.has(key) || pinned || !st.active,
  };
  if (!secret) out.value = value ?? '';
  if (VAULT_KEYS.has(key)) out.vault = true;
  if (secret && inFile) out.encrypted = fileValues[key].startsWith(ENCRYPTED_PREFIX);
  if (st.waitingForVault?.includes(key)) out.waitingForVault = true;
  if (out.restart && (value ?? '') !== (atStart[key] ?? '')) out.pendingRestart = true;
  return out;
}

export function settingsState({ env = process.env } = {}) {
  const st = status();
  const fileValues = readFileValues();
  const known = exampleKeys();
  const sections = exampleSections().map((s) => ({
    id: s.id, title: s.title,
    groups: s.groups.map((g) => ({
      checks: checksFor(g.items.filter((i) => i.key).map((i) => i.key)),
      items: g.items.map((i) => (i.key ? { ...keyState(i.key, fileValues, st, env), sample: i.sample } : i)),
    })),
  }));
  const others = Object.keys(fileValues).filter((k) => !known.has(k) && !HIDDEN_KEYS.has(k));
  if (others.length) sections.push({ id: 'other', groups: [{ checks: [], items: others.map((k) => keyState(k, fileValues, st, env)) }] });
  return {
    file: { active: !!st.active, path: st.file ?? null, errors: st.errors ?? [], waitingForVault: st.waitingForVault ?? [] },
    vaultReady: vaultEnabled(),
    sections,
  };
}

// Assistants that picked DeepSeek V4.1 Flash: they stop answering if it goes off.
const countDeepSeekFlashAgents = async () =>
  (await pool.query(`SELECT count(*)::int AS n FROM ${S}.agents WHERE model = 'deepseek41flash' AND archived_at IS NULL`)).rows[0].n;

// What a save would break and the admin should confirm first.
async function confirmations(updates, user, { env, countDeepSeek }) {
  const out = [];
  const flashOff = ('DEEPSEEK_FLASH_ENABLED' in updates && isOff(updates.DEEPSEEK_FLASH_ENABLED) && !isOff(env.DEEPSEEK_FLASH_ENABLED))
    || (updates.DEEPSEEK_API_KEY === null && !!env.DEEPSEEK_API_KEY);
  if (flashOff) {
    const count = await countDeepSeek();
    if (count > 0) out.push({ kind: 'deepseek_flash', count });
  }
  if ('ADMIN_EMAIL' in updates && String(updates.ADMIN_EMAIL ?? '').trim().toLowerCase() !== String(user.email || '').toLowerCase()) {
    out.push({ kind: 'admin_email' });
  }
  return out;
}

// Checks a save and turns it into what goes to the file. Returns
// { updates, encrypt } or { error, key }.
export function prepareSave(raw, { env = process.env, fileValues = readFileValues(), st = status() } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'bad_request' };
  const known = exampleKeys();
  const updates = {}, encrypt = [];
  for (const [key, v] of Object.entries(raw)) {
    if (!known.has(key) && !(key in fileValues)) return { error: 'unknown_setting', key };
    const state = keyState(key, fileValues, st, env);
    if (HIDDEN_KEYS.has(key) || state.readOnly) return { error: 'read_only', key };
    if (v === null) { if (key in fileValues) updates[key] = null; continue; }
    if (typeof v !== 'string' || v.length > MAX_VALUE) return { error: 'bad_value', key };
    const value = v.trim();
    if (!value) continue; // empty = leave as it is
    if (isSecret(key) && !CLEAR_SECRETS.has(key)) encrypt.push(key);
    else {
      try { formatValue(value); } catch (e) { if (e instanceof ConfigValueError) return { error: 'bad_value', key }; throw e; }
      if (key === 'BRAMBIT_PROFILE') { try { readProfile(value); } catch { return { error: 'bad_value', key }; } } // a wrong name would stop the next start
    }
    updates[key] = value;
  }
  return { updates, encrypt };
}

const reply = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };

const PAGE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public', 'system-settings.html');

// sendHtml: the server's page sender (nonce, language, texts).
export function registerConfigAdmin(rotas, { sendHtml, countDeepSeek = countDeepSeekFlashAgents, check = runCheck } = {}) {
  rotas.registrar('GET', '/admin/settings', async (req, res, url, ctx) => {
    if (!(await ctx.currentUser?.())) { res.writeHead(302, { location: '/' }); res.end(); return; }
    if (!(await adminUser(ctx))) return SEGUE;
    return sendHtml(res, PAGE, 200, await ctx.idiomaDaPagina?.());
  });

  rotas.registrar('GET', '/api/admin/settings', async (req, res, url, ctx) => {
    if (!(await adminUser(ctx))) return SEGUE;
    return reply(res, 200, settingsState());
  });

  rotas.registrar('POST', '/api/admin/settings', async (req, res, url, ctx) => {
    const user = await adminUser(ctx);
    if (!user) return SEGUE;
    if (!status().active) return reply(res, 409, { error: 'no_file' });
    const body = await readBody(req).catch(() => null);
    const prepared = prepareSave(body?.updates);
    if (prepared.error) return reply(res, 400, prepared);
    const { updates, encrypt } = prepared;
    if (!Object.keys(updates).length) return reply(res, 200, settingsState());
    if (encrypt.length && !vaultEnabled()) return reply(res, 409, { error: 'vault_not_ready' });
    try {
      const confirm = await confirmations(updates, user, { env: process.env, countDeepSeek });
      if (confirm.length && body.confirm !== true) return reply(res, 409, { error: 'confirm', confirm });
      writeConfig(updates, { encrypt });
    } catch (e) {
      console.error('[config-admin] save failed:', e?.code ?? e?.name ?? 'error');
      return reply(res, 500, { error: 'save_failed' });
    }
    return reply(res, 200, settingsState());
  });

  // { check, values }: values typed on the screen and not saved yet win over
  // the ones in use. Only settings the screen knows are taken.
  rotas.registrar('POST', '/api/admin/settings/test', async (req, res, url, ctx) => {
    if (!(await adminUser(ctx))) return SEGUE;
    const body = await readBody(req).catch(() => null);
    const known = exampleKeys();
    const values = { ...process.env };
    for (const [k, v] of Object.entries(body?.values ?? {})) {
      if (known.has(k) && typeof v === 'string' && v.trim() && v.length <= MAX_VALUE) values[k] = v.trim();
    }
    return reply(res, 200, await check(String(body?.check ?? ''), values));
  });
}
