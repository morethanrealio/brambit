// ── Cofre de credenciais do produto ──
// Sistema PRÓPRIO (NÃO é o OneCli). Guarda segredos do usuário (API keys, chaves
// SSH, tokens colados) cifrados no banco. Decifra SÓ em memória, no momento de
// usar a credencial.
//
// Origem da chave mestra (32 bytes), em ordem de preferência:
//   1. VAULT_KEY_ENC — chave mestra cifrada por um serviço de chaves de fora
//      (envelope encryption), desembrulhada UMA vez no boot via initVault(). O
//      núcleo não sabe qual serviço é: quem instala registra o desembrulho com
//      definirChaveDoCofre() (o Brambs pluga o AWS KMS em cofre-brambs.mjs). O
//      material nunca fica em texto puro.
//   2. VAULT_KEY — chave em base64 direto no env (modo legado / dev local).
//   3. BRAMBS_LOCAL=1 sem nenhuma das duas — chave gerada sozinha na primeira vez
//      e guardada em arquivo (VAULT_KEY_FILE, padrão ~/.brambs/vault.key, 0600).
//      É o caminho de quem roda na própria máquina, sem AWS.
// Quem chama initVault() no boot antes de servir; depois key() serve do cache.
//
// FALHA FECHADA na gravação, não no boot: chave malformada (VAULT_KEY que não dá
// 32 bytes, KMS devolvendo tamanho errado) ou nenhuma chave fora do modo local faz
// initVault() lançar VaultBootError. O servidor sobe mesmo assim (initVaultNoBoot),
// em modo degradado: tudo funciona menos gravar/ler segredo, e o log dá o alarme.
// Antes, VAULT_KEY malformada era tratada como "sem cofre" e os segredos iam pro
// banco em texto puro.
//
// Formato do blob cifrado: "v1:" + base64( iv(12) || tag(16) || ciphertext ).
// AES-256-GCM: o tag autentica (detecta adulteração/chave errada).
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

let _cachedKey = null; // chave crua de 32 bytes, resolvida uma vez (KMS ou env)

// Porta da chave do cofre: { nome, desembrulhar(blob) → Buffer }. Sem registro,
// VAULT_KEY_ENC não tem como abrir e o boot acusa; VAULT_KEY e a chave local
// seguem valendo.
let _externa = null;
export function definirChaveDoCofre({ nome, desembrulhar } = {}) {
  if (typeof desembrulhar !== 'function') throw new Error('chave do cofre: desembrulhar(blob) precisa ser função');
  _externa = { nome: String(nome || 'serviço de chaves'), desembrulhar };
}
// Nome do serviço que abre a VAULT_KEY_ENC (pro log do boot), ou null.
export const nomeDaChaveExterna = () => _externa?.nome ?? null;

// Desembrulha e cacheia a chave mestra. Idempotente. Chamar UMA vez no boot,
// antes de o servidor começar a atender. Se VAULT_KEY_ENC estiver setada,
// desembrulha via KMS; senão cai na VAULT_KEY do env (legado/dev).
// Erro de configuração da chave (não se resolve sozinho). Falha de rede/permissão
// do KMS é Error comum. Nos dois casos o servidor sobe e recusa gravar segredo
// (encMaybe); a diferença é só a mensagem do alarme.
export class VaultBootError extends Error {
  constructor(msg) { super(msg); this.name = 'VaultBootError'; this.code = 'VAULT_BOOT'; }
}

const localMode = () => /^(1|true|on|yes)$/i.test(process.env.BRAMBS_LOCAL || '');
export const localKeyPath = () => process.env.VAULT_KEY_FILE || path.join(os.homedir(), '.brambs', 'vault.key');

// Lê a chave local; se o arquivo não existe, cria com 32 bytes aleatórios.
// Arquivo que existe e não dá 32 bytes é erro: sobrescrever perderia o acesso
// a tudo que já foi cifrado com ele.
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
    console.log(`[vault] modo local: chave do cofre gerada em ${file}`);
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

// Versão do boot: nunca derruba o servidor por causa do cofre. Problema na chave
// tira do ar só o que depende de segredo (encMaybe recusa gravar), não o resto.
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
  // Em modo KMS a chave SÓ pode vir do initVault(). Cair na VAULT_KEY aqui
  // cifraria com uma chave diferente da que decifra o resto do banco.
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

// Instalação que PRETENDE ter cofre (mesmo que a chave ainda não tenha carregado).
// VAULT_KEY malformada conta como cofre configurado e QUEBRADO (antes contava
// como "sem cofre" e liberava texto puro).
export function vaultConfigured() {
  return !!(_cachedKey || process.env.VAULT_KEY_ENC || process.env.VAULT_KEY || localMode());
}

// Só é "enabled" se a chave está REALMENTE carregável agora. Em modo KMS isso
// significa initVault() ter concluído; se o unwrap falhou, isso aqui é false e
// quem cifra tem que falhar fechado (encMaybe), não gravar texto puro.
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

// Helpers p/ cifrar tokens em repouso (Google/OAuth). Preservam null e, na leitura,
// só decifram blobs no formato "v1:" — assim linhas legadas em texto puro continuam
// funcionando durante a migração.
//
// Escrita FALHA FECHADA: sem chave carregada, lança em vez de gravar o segredo
// em claro no banco, seja cofre configurado que não abriu (unwrap do KMS falhou,
// VAULT_KEY malformada) ou instalação sem chave nenhuma.
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

// Índice cego: o mesmo texto sempre dá o mesmo valor, pra achar uma linha sem
// guardar o dado em claro (ex.: telefone de quem fala com o assistente público).
// HMAC com chave derivada da chave do cofre por contexto, então um índice não
// serve pra comparar com outro contexto nem dá pra recalcular sem a chave
// (telefone tem poucas combinações; hash puro seria quebrado por força bruta).
export function indiceCego(texto, contexto) {
  const k = Buffer.from(crypto.hkdfSync('sha256', key(), Buffer.alloc(0), 'indice-cego:' + contexto, 32));
  return crypto.createHmac('sha256', k).update(String(texto)).digest('base64url');
}
