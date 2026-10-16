// ── Config file ──
// The installation's settings live in ONE file, in the env format
// (KEY=value per line, the same file systemd reads with EnvironmentFile=).
// BRAMBIT_CONFIG_FILE names it. The server reads it itself at boot, watches it
// and applies every change to process.env while running, so the file and the
// running server never disagree: an edit by hand or by the admin screen counts
// the same way.
//
// Without BRAMBIT_CONFIG_FILE nothing here runs and the server only sees the
// environment it was started with, as before.
//
// Precedence: a key present in the file wins over the inherited environment,
// except for the keys in BRAMBIT_CONFIG_PINNED (comma list), which belong to
// whoever started the server (e.g. `npm run local` sets the database and the
// port itself). A key removed from the file goes back to its inherited value,
// unless that value only existed because of the file (systemd loaded the same
// file at start), in which case it is removed.
//
// Secrets may be stored encrypted with the vault key: KEY=vault:v1:<base64>.
// Those are applied once the vault key is loaded (onVaultReady) and never
// reach process.env as ciphertext.
//
// Reading follows systemd's rules (not a shell): `#` or `;` starts a comment
// only at the start of a line; single quotes are literal; inside double quotes
// only \" \\ \$ \` are escapes; quoted values may span lines; unquoted values
// lose trailing spaces and a backslash takes the next character literally.
// Writing only produces forms every reader agrees on (bare safe characters or
// single quotes), and refuses a value that cannot be written that way.
import fs from 'node:fs';
import path from 'node:path';
import { decryptSecret, encryptSecret, onVaultReady, vaultEnabled } from './vault.mjs';

export const ENCRYPTED_PREFIX = 'vault:';
const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SAFE_BARE = /^[A-Za-z0-9_\-.,:/@+=%~^]*$/;

export class ConfigValueError extends Error {
  constructor(msg) { super(msg); this.name = 'ConfigValueError'; this.code = 'CONFIG_VALUE'; }
}

const resolveFile = (file) => (file ? path.resolve(file) : null);
export const configFilePath = () => resolveFile(process.env.BRAMBIT_CONFIG_FILE);
const pinnedKeys = (list) => new Set(String(list || '').split(',').map((k) => k.trim()).filter(Boolean));

// Parses the file text. Returns the definitions in order, each with the line
// span it occupies ([start, end], inclusive), plus the lines that could not be
// read. A key defined twice keeps the last value, like systemd.
export function parseConfig(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const entries = [];
  const errors = [];
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trimStart();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(';')) continue;
    const m = trimmed.match(/^(?:export\s+)?([^=\s]+)\s*=\s*([\s\S]*)$/);
    if (!m || !KEY_RE.test(m[1])) { errors.push({ line: i + 1, reason: 'not a KEY=value line' }); continue; }
    const start = i;
    let rest = m[2];
    let value = '';
    let quotedUpTo = 0; // value length at the last closing quote: spaces before it stay
    let ok = true;
    // Walks the value; a quote left open continues on the next line.
    for (let p = 0; ; p++) {
      if (p >= rest.length) break;
      const c = rest[p];
      if (c === "'" || c === '"') {
        let q = p + 1;
        for (;;) {
          if (q >= rest.length) {
            if (i + 1 >= lines.length) { ok = false; break; }
            value += '\n';
            rest = rest + '\n' + lines[++i];
            q++;
            continue;
          }
          const d = rest[q];
          if (d === c) break;
          if (c === '"' && d === '\\' && q + 1 < rest.length) {
            const e = rest[q + 1];
            if ('"\\`$'.includes(e)) { value += e; q += 2; continue; }
          }
          if (d !== '\n') value += d;
          q++;
        }
        if (!ok) break;
        p = q;
        quotedUpTo = value.length;
        continue;
      }
      if (c === '\\' && p + 1 < rest.length) { value += rest[++p]; continue; }
      value += c;
    }
    if (!ok) { errors.push({ line: start + 1, reason: 'quote not closed' }); continue; }
    // Unquoted trailing spaces are dropped; quoted ones are kept.
    value = value.slice(0, quotedUpTo) + value.slice(quotedUpTo).replace(/\s+$/, '');
    // Dotenv readers cut `value # note`; systemd keeps it as part of the value.
    if (/\s#/.test(value.slice(quotedUpTo))) errors.push({ line: start + 1, key: m[1], reason: 'text after " #" is part of the value (no comments after a value)' });
    entries.push({ key: m[1], value, start, end: i });
  }
  return { entries, errors };
}

// Last value of each key: { KEY: value }.
export function configValues(text) {
  const out = {};
  for (const e of parseConfig(text).entries) out[e.key] = e.value;
  return out;
}

// How a value is written. Bare when it only has safe characters, single
// quotes otherwise; a value with a single quote or a line break has no form
// that systemd and the other readers read the same way, so it is refused
// (store it encrypted, or as base64 if the setting accepts it).
export function formatValue(value) {
  const v = String(value);
  if (SAFE_BARE.test(v)) return v;
  if (v.includes("'") || /[\r\n]/.test(v)) throw new ConfigValueError('value has a single quote or a line break; store it encrypted or as base64');
  return `'${v}'`;
}

// Applies { KEY: value | null } to the file text and returns the new text.
// Only the lines of the changed keys move: comments, order and the other lines
// stay as they were. A new key goes right below its commented example
// (`# KEY=`) when there is one, otherwise at the end. null removes the key.
export function updateConfigText(text, updates) {
  const src = String(text ?? '');
  const eol = src.includes('\r\n') ? '\r\n' : '\n';
  const lines = src.length ? src.split(/\r?\n/) : [];
  const hadFinalEol = !lines.length || lines[lines.length - 1] === '';
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const { entries } = parseConfig(lines.join('\n'));
  const out = lines.map((l) => [l]);
  for (const [key, value] of Object.entries(updates)) {
    if (!KEY_RE.test(key)) throw new ConfigValueError(`invalid setting name: ${key}`);
    const line = value == null ? null : `${key}=${formatValue(value)}`;
    const defs = entries.filter((e) => e.key === key);
    defs.forEach((e, n) => {
      for (let i = e.start; i <= e.end; i++) out[i] = [];
      if (n === defs.length - 1 && line !== null) out[e.start] = [line];
    });
    if (defs.length || line === null) continue;
    const example = lines.findIndex((l) => new RegExp(`^#\\s?${key}=`).test(l));
    if (example >= 0) out[example].push(line);
    else out.push([line]);
  }
  const flat = out.flat();
  return flat.join(eol) + (flat.length && hadFinalEol ? eol : '');
}

// Writes { KEY: value | null } to the file in one step (temporary file +
// rename, same permissions, 0600 for a new file) and applies it right away.
// Keys listed in `encrypt` are stored encrypted with the vault key; without a
// loaded key the write is refused rather than storing the secret in clear.
export function writeConfig(updates, { encrypt = [], file = state?.file ?? configFilePath() } = {}) {
  if (!file) throw new Error('no config file: set BRAMBIT_CONFIG_FILE');
  const toWrite = { ...updates };
  for (const key of encrypt) {
    if (toWrite[key] == null) continue;
    if (!vaultEnabled()) throw new Error(`vault key not loaded: refusing to write ${key} in clear`);
    toWrite[key] = ENCRYPTED_PREFIX + encryptSecret(toWrite[key]);
  }
  const target = fs.existsSync(file) ? fs.realpathSync(file) : file;
  const before = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
  const mode = fs.existsSync(target) ? fs.statSync(target).mode & 0o777 : 0o600;
  const next = updateConfigText(before, toWrite);
  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, next, { mode });
  try { fs.renameSync(tmp, target); }
  catch (e) { fs.rmSync(tmp, { force: true }); throw e; }
  if (state && state.file === path.resolve(file)) reload();
}

// ── Running state ──
let state = null;
const listeners = new Set();

// Called with the list of keys whose value changed, after process.env has the
// new values. Returns a function that stops listening.
export function onConfigChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// Reads the file and starts watching it. Idempotent.
export function startConfigFile({
  env = process.env, file = env.BRAMBIT_CONFIG_FILE, pinned = env.BRAMBIT_CONFIG_PINNED, watchMs = 2000, log = console,
} = {}) {
  file = resolveFile(file);
  if (!file || state) return state ? status() : null;
  state = {
    file, env, log, pinned: pinnedKeys(pinned),
    inherited: { ...env }, fromFileAtStart: null,
    applied: new Set(), pending: new Set(), errors: [], loadedAt: null,
  };
  reload();
  const own = state;
  // Deferred: the vault can become ready in the middle of a reload (lazy key).
  onVaultReady(() => queueMicrotask(() => { if (state === own) reload(); }));
  if (watchMs > 0) fs.watchFile(file, { interval: watchMs }, (cur, prev) => { if (cur.mtimeMs !== prev.mtimeMs || cur.size !== prev.size) reload(); });
  log.log(`[config] reading ${file}${state.pinned.size ? ` (set by the launcher: ${[...state.pinned].join(', ')})` : ''}`);
  return status();
}

// Stops watching (tests and shutdown).
export function stopConfigFile() {
  if (!state) return;
  fs.unwatchFile(state.file);
  state = null;
  listeners.clear();
}

function reload() {
  const s = state;
  let text = '';
  try { text = fs.existsSync(s.file) ? fs.readFileSync(s.file, 'utf8') : ''; }
  catch (e) { s.errors = [{ line: 0, reason: `cannot read the file: ${e.message}` }]; s.log.error(`[config] cannot read ${s.file}: ${e.message}`); return; }
  const { entries, errors } = parseConfig(text);
  const values = {};
  for (const e of entries) values[e.key] = e.value;
  s.errors = errors;
  s.fromFileAtStart ??= values;
  s.pending = new Set();
  const changed = [];
  const set = (key, value) => {
    if (s.env[key] === value) return;
    if (value === undefined) delete s.env[key]; else s.env[key] = value;
    changed.push(key);
  };
  for (const [key, raw] of Object.entries(values)) {
    if (s.pinned.has(key)) continue;
    let value = raw;
    if (raw.startsWith(ENCRYPTED_PREFIX)) {
      if (!vaultEnabled()) {
        s.pending.add(key);
        // systemd loaded the same file at start: drop the ciphertext until it opens.
        if (s.env[key] === raw) set(key, undefined);
        continue;
      }
      try { value = decryptSecret(raw.slice(ENCRYPTED_PREFIX.length)); }
      catch { s.errors.push({ key, reason: 'cannot decrypt with this vault key' }); continue; }
    }
    s.applied.add(key);
    set(key, value);
  }
  for (const key of [...s.applied]) {
    if (key in values) continue;
    s.applied.delete(key);
    const inherited = s.inherited[key];
    set(key, inherited !== undefined && inherited !== s.fromFileAtStart[key] ? inherited : undefined);
  }
  s.loadedAt = new Date();
  for (const e of s.errors) s.log.warn(`[config] ${path.basename(s.file)}: ${e.key ?? `line ${e.line}`}: ${e.reason}`);
  if (!changed.length) return;
  for (const fn of listeners) {
    try { fn(changed); } catch (e) { s.log.error('[config] change listener failed:', e?.message ?? e); }
  }
}

// What the admin screen needs to know about the file itself.
export function status() {
  if (!state) return { file: configFilePath(), active: false };
  return {
    file: state.file, active: true, loadedAt: state.loadedAt,
    pinned: [...state.pinned], waitingForVault: [...state.pending], errors: state.errors,
  };
}
