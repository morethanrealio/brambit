// ── Product credential vault ──
// Its OWN system. Stores user secrets (API keys, SSH keys, pasted tokens)
// encrypted in the database. Decrypts ONLY in memory, at the moment the
// credential is used.
//
// Master key source (32 bytes), in order of preference:
//   1. VAULT_KEY_ENC: master key encrypted by an external key service
//      (envelope encryption), unwrapped ONCE at boot via initVault(). The
//      core doesn't know which service: whoever installs it registers the
//      unwrap with definirChaveDoCofre() (e.g. a plugin wiring AWS KMS). The
//      material never sits in plain text.
//   2. VAULT_KEY: base64 key straight in the env (legacy mode / local dev).
//   3. BRAMBS_LOCAL=1 with neither: key generated on first run and stored
//      in a file (VAULT_KEY_FILE, default ~/.brambs/vault.key, 0600).
//      It's the path for running on your own machine, without AWS.
// The caller runs initVault() at boot before serving; then key() serves from cache.
//
// FAILS CLOSED on write, not on boot: a malformed key (VAULT_KEY not 32 bytes,
// KMS returning a wrong size) or no key outside local mode makes initVault()
// throw VaultBootError. The server boots anyway (initVaultNoBoot), degraded:
// everything works except storing/reading secrets, and the log raises the alarm.
// Before, a malformed VAULT_KEY was treated as "no vault" and secrets went to
// the database in plain text.
//
// Encrypted blob format: "v1:" + base64( iv(12) || tag(16) || ciphertext ).
// AES-256-GCM: the tag authenticates (detects tampering/wrong key).
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

let _cachedKey = null; // raw 32-byte key, resolved once (KMS or env)

// Vault key port: { name, unwrap(blob) → Buffer }. Without registration,
// VAULT_KEY_ENC has no way to open and the boot flags it; VAULT_KEY and the local
// key remain valid.
let _externa = null;
export function definirChaveDoCofre({ nome, desembrulhar } = {}) {
  if (typeof desembrulhar !== 'function') throw new Error('chave do cofre: desembrulhar(blob) precisa ser função');
  _externa = { nome: String(nome || 'serviço de chaves'), desembrulhar };
}
// Name of the service that opens VAULT_KEY_ENC (for the boot log), or null.
export const nomeDaChaveExterna = () => _externa?.nome ?? null;

// Unwraps and caches the master key. Idempotent. Call it ONCE at boot,
// before the server starts serving. If VAULT_KEY_ENC is set,
// unwraps via KMS; otherwise falls back to the env's VAULT_KEY (legacy/dev).
// Key configuration error (doesn't resolve itself). KMS network/permission
// failure is a plain Error. In both cases the server comes up and refuses to write secrets
// (encMaybe); the only difference is the alarm message.
export class VaultBootError extends Error {
  constructor(msg) { super(msg); this.name = 'VaultBootError'; this.code = 'VAULT_BOOT'; }
}

const localMode = () => /^(1|true|on|yes)$/i.test(process.env.BRAMBS_LOCAL || '');
export const localKeyPath = () => process.env.VAULT_KEY_FILE || path.join(os.homedir(), '.brambs', 'vault.key');

// Reads the local key; if the file doesn't exist, creates it with 32 random bytes.
// A file that exists and isn't 32 bytes is an error: overwriting it would lose access
// to everything already encrypted with it.
function localKey() {
  const file = localKeyPath();
  const ler = () => {
    const buf = Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'base64');
    if (buf.length !== 32) throw new VaultBootError(`chave local do cofre em ${file} não tem 32 bytes (base64); corrija ou apague o arquivo`);
    return buf;
  };
  if (fs.existsSync(file)) return ler();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  try {
    fs.writeFileSync(file, crypto.randomBytes(32).toString('base64') + '\n', { flag: 'wx', mode: 0o600 });
    console.log(`[vault] local mode: vault key generated at ${file}`);
  } catch (e) { if (e?.code !== 'EEXIST') throw e; }
  return ler();
}

export async function initVault() {
  if (_cachedKey) return;
  const enc = process.env.VAULT_KEY_ENC;
  if (enc) {
    if (!_externa) throw new VaultBootError('VAULT_KEY_ENC setada, mas nenhum serviço de chaves registrado pra abrir (definirChaveDoCofre)');
    const raw = await _externa.desembrulhar(enc);
    if (raw?.length !== 32) throw new VaultBootError(`chave desembrulhada do ${_externa.nome} não tem 32 bytes`);
    _cachedKey = raw;
    return;
  }
  const k = process.env.VAULT_KEY;
  if (k) {
    const buf = Buffer.from(k, 'base64');
    if (buf.length !== 32) throw new VaultBootError(`VAULT_KEY inválida: dá ${buf.length} bytes, precisa de 32 (base64)`);
    _cachedKey = buf;
    return;
  }
  if (localMode()) { _cachedKey = localKey(); return; }
  throw new VaultBootError('nenhuma chave do cofre configurada: use VAULT_KEY_ENC (KMS) ou VAULT_KEY; rodando na própria máquina, BRAMBS_LOCAL=1 gera uma chave local');
}

// Boot version: never brings the server down because of the vault. A key problem
// only takes down what depends on secrets (encMaybe refuses to write), not the rest.
export async function initVaultNoBoot(log = console) {
  try { await initVault(); return { ok: true }; }
  catch (e) {
    const msg = e?.message ?? String(e);
    if (e?.code === 'VAULT_BOOT') log.error(`[vault] ALERTA: ${msg}. Servidor de pé em modo degradado: nenhum segredo será gravado nem lido até corrigir.`);
    else log.error('[vault] falha ao inicializar cofre:', msg);
    return { ok: false, error: e };
  }
}

function key() {
  if (_cachedKey) return _cachedKey;
  // In KMS mode the key can ONLY come from initVault(). Falling back to VAULT_KEY here
  // would encrypt with a different key than the one that decrypts the rest of the database.
  if (process.env.VAULT_KEY_ENC) {
    throw new Error('cofre em modo KMS não inicializado (initVault falhou ou não foi chamado)');
  }
  const k = process.env.VAULT_KEY;
  if (!k) throw new Error('VAULT_KEY não configurada (nem VAULT_KEY_ENC inicializada, nem chave local carregada)');
  const buf = Buffer.from(k, 'base64');
  if (buf.length !== 32) throw new Error('VAULT_KEY precisa ter 32 bytes (base64)');
  _cachedKey = buf;
  return buf;
}

// Installation that INTENDS to have a vault (even if the key hasn't loaded yet).
// A malformed VAULT_KEY counts as a vault that's configured and BROKEN (it used to count
// as "no vault" and would allow plain text).
export function vaultConfigured() {
  return !!(_cachedKey || process.env.VAULT_KEY_ENC || process.env.VAULT_KEY || localMode());
}

// Only "enabled" if the key is REALLY loadable right now. In KMS mode this
// means initVault() has completed; if the unwrap failed, this is false and
// whoever encrypts has to fail closed (encMaybe), not write plain text.
export function vaultEnabled() {
  if (_cachedKey) return true;
  if (process.env.VAULT_KEY_ENC) return false;
  const k = process.env.VAULT_KEY;
  if (!k) return false;
  try { return Buffer.from(k, 'base64').length === 32; } catch { return false; }
}

export function encryptSecret(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return 'v1:' + Buffer.concat([iv, tag, ct]).toString('base64');
}

export function decryptSecret(blob) {
  const s = String(blob || '');
  if (!s.startsWith('v1:')) throw new Error('formato de segredo desconhecido');
  const raw = Buffer.from(s.slice(3), 'base64');
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const ct = raw.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

// Helpers to encrypt tokens at rest (Google/OAuth). Preserve null and, on read,
// only decrypt blobs in "v1:" format — so legacy plain-text rows keep
// working during the migration.
//
// Write FAILS CLOSED: with no key loaded, it throws instead of writing the secret
// in the clear to the database, whether it's a configured vault that didn't open (KMS unwrap
// failed, malformed VAULT_KEY) or an installation with no key at all.
export function encMaybe(v) {
  if (v == null) return v;
  if (vaultEnabled()) return encryptSecret(v);
  if (vaultConfigured()) {
    throw new Error('cofre configurado mas indisponível: recusando gravar segredo em texto puro');
  }
  throw new Error('cofre sem chave: recusando gravar segredo em texto puro');
}

export function decMaybe(v) {
  if (v == null) return v;
  const s = String(v);
  return s.startsWith('v1:') ? decryptSecret(s) : v;
}

// Blind index: the same text always gives the same value, to find a row without
// storing the data in the clear (e.g. the phone number of whoever talks to the public assistant).
// HMAC with a key derived from the vault key per context, so an index doesn't
// work for comparing against another context, nor can it be recomputed without the key
// (a phone number has few combinations; a plain hash would be broken by brute force).
export function indiceCego(texto, contexto) {
  const k = Buffer.from(crypto.hkdfSync('sha256', key(), Buffer.alloc(0), 'indice-cego:' + contexto, 32));
  return crypto.createHmac('sha256', k).update(String(texto)).digest('base64url');
}
