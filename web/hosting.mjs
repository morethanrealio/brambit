import {rejectedEdit} from './coding-effects.mjs';
import { searchAppCode } from './app-code-search.mjs';
// ── Tools de hosting (mini-PaaS por usuário) ──
// Cada usuário tem um subdomínio (fulano.<domínio dos apps>, ver appshost.mjs). O agente pode:
//   • publicar "sisteminhas" (apps Node ou Flask) em /nome_do_sistema (container)
//   • parar / reiniciar / apagar / ver logs / listar esses sistemas
//   • acrescentar conteúdo na HOME do subdomínio (fulano.<domínio>/ raiz),
//     que é o "app default" do usuário — sem container, servido no roteador.
//
// Fala com o host de apps pelo control-plane SSH (appshost.mjs → ctl.py).
// Liga só se hostingEnabled() (APPS_HOST_SSH + APPS_HOST_KEY no ambiente).

import { filePage } from '../core-proto/file-page.mjs';
import { validateDraft, validationPage, draftRevision } from './app-draft-validation.mjs';
import zlib from 'node:zlib';
import { createHash, randomBytes } from 'node:crypto';
import { ctl, hostingEnabled, dominioDosApps, urlDoApp } from './appshost.mjs';
import { linkDaPagina, marca } from './marca.mjs';
import { anonymizeSnapshotBlob } from './anonymize.mjs';
import { lintAppB64, countLines } from './applint.mjs';
import { resolverAncora } from './app-anchor.mjs';
import { pioraSintaxe } from './app-syntax.mjs';
import { avaliarReducao } from './app-shrink-guard.mjs';
import { conferirPermissoes } from './permissoes.mjs';
import { ensureUserSubdomain, registerApp, setAppStatus, deleteAppRow, getAppRow, listAppsForUser,
  setAppSecret, listAppSecrets, deleteAppSecret, getAppSecretsDecrypted,
  setAppSnapshot, getAppSnapshot, setAppVisibility, listPublicApps, getPublicApp,
  getAppAccess, setAppAccess,
  getUserById, resolveConnectedUser, contatoAmbiguoMsg, addAppCollaborator, removeAppCollaborator,
  isAppCollaborator, listAppCollaborators, listSharedAppsForCollaborator,
  putAppDraftFile, getAppDraft, deleteAppDraftFile, clearAppDraft, listAppDraftSystems,
  listAgents, listAppsForModeration, listAppOwnersForQuota } from './db.mjs';

export { hostingEnabled };

export let appAccessReconciliation={at:null,checked:0,repaired:0,issues:[]};
export async function reconcileAppAccess(){
  if(!hostingEnabled())return appAccessReconciliation={at:new Date().toISOString(),checked:0,repaired:0,issues:[{reason:'host_unavailable'}]};
  const [host,apps]=await Promise.all([ctl({verb:'list'},{timeoutMs:30_000}),listAppsForModeration()]);
  if(!host?.ok)throw new Error('Falha ao listar portões no host');
  const remote=new Map((host.apps||[]).map(x=>[x.key,x]));let repaired=0;const issues=[];
  for(const app of apps){
    const gate=remote.get(`${app.label}/${app.system}`);if(!gate){issues.push({label:app.label,system:app.system,reason:'host_missing'});continue;}
    if(typeof gate.privado!=='boolean'){issues.push({label:app.label,system:app.system,reason:'host_capability_missing'});continue;}
    if(!gate.privado){
      if(app.access!=='public'){const changed=await setAppAccess(app.user_id,app.system,{access:'public'});if(changed===1)repaired++;else issues.push({label:app.label,system:app.system,reason:'db_row_missing'});}
      continue;
    }
    const saved=await getAppAccess(app.user_id,app.system).catch(()=>null);
    if(saved?.access!=='private'||!saved.user||!saved.pass)issues.push({label:app.label,system:app.system,reason:'private_credentials_missing',hostUser:gate.access_user||null});
  }
  return appAccessReconciliation={at:new Date().toISOString(),checked:apps.length,repaired,issues:issues.slice(0,100)};
}

const MAX_FILE_BYTES  = 512 * 1024;    // 512 KB por arquivo
const MAX_TOTAL_BYTES = 2 * 1024 * 1024; // 2 MB por app
const RE_SYSTEM = /^[a-z0-9][a-z0-9_-]{0,30}$/;

// Hash curto do conteúdo de um arquivo (entrada em base64). Serve de "versão"
// pra concorrência otimista: ler_arquivo/listar devolvem, escrever_arquivo
// aceita hash_esperado e falha alto se o arquivo mudou desde a leitura.
const fileHash = (b64) => createHash('sha256').update(Buffer.from(b64 || '', 'base64')).digest('hex').slice(0, 12);

// ── Acesso à URL do app: PRIVADO por padrão ──
// Todo app NOVO nasce trancado com usuário/senha (HTTP Basic verificado no
// ROTEADOR, antes de acordar o container). Público é opt-in explícito, decidido
// pelo usuário, e o assistente tem que PERGUNTAR antes de publicar.
// Isto é ortogonal a `visibilidade` (biblioteca/cópia do código): um app pode
// ser copiável e trancado, ou aberto e fora da biblioteca.
// Alfabeto sem caracteres ambíguos (0/O, 1/l/I) porque a senha é ditada/copiada
// à mão pelo usuário. 10 chars nesse alfabeto ≈ 51 bits de entropia.
const PWD_ALPHABET = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function randomToken(len) {
  const bytes = randomBytes(len * 2);
  let out = '';
  for (let i = 0; out.length < len && i < bytes.length; i++) {
    const v = bytes[i];
    if (v >= 256 - (256 % PWD_ALPHABET.length)) continue; // descarta pra não viesar
    out += PWD_ALPHABET[v % PWD_ALPHABET.length];
  }
  return out.length === len ? out : out + randomToken(len - out.length);
}
// Usuário derivado do nome do sistema (fácil de lembrar), senha aleatória.
const genAccessCreds = (system) => ({
  user: (String(system || 'app').replace(/[^a-z0-9]/g, '') || 'app').slice(0, 20),
  pass: randomToken(10),
});

// Decide o portão a mandar pro host num publish, e o que gravar no banco.
// Regras: app NOVO sem escolha explícita => privado com credencial gerada;
// app JÁ publicado => PRESERVA o que já existe (republicar nunca destranca nem
// troca senha por esquecimento do chamador); "publico" só quando pedido.
// Devolve { authSpec, access, creds } — authSpec vai no ctl (undefined = preserva
// no host), creds só existe quando a credencial foi GERADA agora (pra mostrar).
async function resolveAccessForPublish(ownerUserId, system, isNew, acesso) {
  const pedido = String(acesso || '').toLowerCase();
  if (pedido === 'publico') return { authSpec: { mode: 'none' }, access: 'public', creds: null };
  const atual = (!isNew && await getAppAccess(ownerUserId, system).catch(() => null)) || null;
  if (atual && atual.user && atual.pass && atual.access !== 'public') {
    // Já tem credencial: reenvia a MESMA. O host (ctl.py _auth_entry) reconhece
    // que a credencial não mudou e PRESERVA o salt, e é o salt que versiona o
    // realm do HTTP Basic no roteador. Re-salgar a cada republish faria o
    // navegador esquecer uma senha válida e pedir login de novo à toa.
    return { authSpec: { user: atual.user, password: atual.pass }, access: 'private', creds: null };
  }
  if (!isNew && pedido !== 'privado') {
    // App JÁ publicado, sem portão registrado (público explícito ou app antigo
    // de antes desta mudança) e ninguém pediu pra trancar: NÃO trancar por conta
    // própria. Republicar não pode invalidar um link que o dono já distribuiu —
    // trancar app existente é decisão dele, via definir_acesso_sistema.
    return { authSpec: undefined, access: atual?.access || null, creds: null };
  }
  const creds = genAccessCreds(system);
  return { authSpec: { user: creds.user, password: creds.pass }, access: 'private', creds };
}

// O host e o banco precisam concordar sobre o portão. Repetimos falhas
// transitórias e devolvemos um aviso explícito; nunca fingimos que o registro
// ficou recuperável quando o host publicou mas o banco não confirmou.
async function persistAccess(ownerUserId, system, { access, creds }) {
  if (!access) return true;
  for(let attempt=1;attempt<=3;attempt++)try {
    const changed=await setAppAccess(ownerUserId, system, {access,user:creds?.user??null,pass:creds?.pass??null});
    if(changed===1)return true;
  } catch(error){
    if(attempt===3)console.error('[app-access] host publicado, persistência no banco falhou',{system,ownerUserId,error:error?.message||'unknown'});
    else await new Promise(resolve=>setTimeout(resolve,attempt*100));
  }
  return false;
}

// ── Publish gate: nenhum segredo pode ir INLINE no código de um app ──
// Isolamento por construção: chave/senha/token vão pro cofre (definir_segredo) e
// o código usa só process.env.X. Se algo com cara de segredo aparecer no fonte,
// o publish é RECUSADO. Heurístico (rede de segurança); a trava real é o agente
// sempre pôr segredo no cofre. Linhas com placeholder/uso de env são ignoradas.
const SECRET_PATTERNS = [
  { re: /AKIA[0-9A-Z]{16}/, what: 'AWS access key' },
  { re: /\bASIA[0-9A-Z]{16}\b/, what: 'AWS temp key' },
  { re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/, what: 'chave Anthropic (sk-ant-)' },
  { re: /\bsk-[A-Za-z0-9]{20,}\b/, what: 'chave estilo OpenAI (sk-...)' },
  { re: /\bghp_[A-Za-z0-9]{30,}\b/, what: 'GitHub token (ghp_)' },
  { re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/, what: 'GitHub PAT' },
  { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/, what: 'token Slack (xox...)' },
  { re: /\bAIza[0-9A-Za-z_-]{35}\b/, what: 'chave Google API (AIza...)' },
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, what: 'chave privada (PEM)' },
  { re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/, what: 'JWT' },
  { re: /\bpostg(?:res|resql):\/\/[^\s:@/]+:[^\s:@/]+@/i, what: 'URL de Postgres com senha' },
  { re: /\bmongodb(?:\+srv)?:\/\/[^\s:@/]+:[^\s:@/]+@/i, what: 'URL de Mongo com senha' },
  { re: /(?:password|passwd|senha|secret|api[_-]?key|access[_-]?token|client[_-]?secret)\s*[:=]\s*["'`][^"'`]{8,}["'`]/i, what: 'senha/segredo escrito no código' },
];
const PLACEHOLDER = /process\.env|os\.environ|getenv|YOUR_|EXAMPLE|CHANGE_?ME|xxxx|<[^>]+>|\bplaceholder\b/i;

function scanSecrets(files) {
  const out = [];
  const seen = new Set();
  for (const [rel, b64] of Object.entries(files)) {
    let txt;
    try { txt = Buffer.from(b64, 'base64').toString('utf8'); } catch { continue; }
    for (const { re, what } of SECRET_PATTERNS) {
      const m = txt.match(re);
      if (!m) continue;
      const idx = m.index || 0;
      const ls = txt.lastIndexOf('\n', idx) + 1;
      let le = txt.indexOf('\n', idx); if (le < 0) le = txt.length;
      if (PLACEHOLDER.test(txt.slice(ls, le))) continue;
      const k = rel + '|' + what;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ arquivo: rel, tipo: what });
    }
  }
  return out;
}

// Snapshot de código pra replicação (Fase 2). `files` = {caminho: b64} do fonte
// enviado no publish (nunca inclui dado de runtime). Comprime e serializa num
// blob de texto guardável no banco. Devolve null se passar do teto (não bloqueia
// o publish; só não fica replicável).
const MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024; // teto do blob comprimido no banco
function buildSnapshot(files) {
  try {
    const json = JSON.stringify(files);
    const gz = zlib.gzipSync(Buffer.from(json, 'utf8'));
    if (gz.length > MAX_SNAPSHOT_BYTES) return null;
    return 'gz1:' + gz.toString('base64');
  } catch { return null; }
}

// Inverso de buildSnapshot: blob de texto -> {caminho: b64}. Usado na replicação.
export function readSnapshot(blob) {
  if (typeof blob !== 'string' || !blob.startsWith('gz1:')) return null;
  try {
    const gz = Buffer.from(blob.slice(4), 'base64');
    return JSON.parse(zlib.gunzipSync(gz).toString('utf8'));
  } catch { return null; }
}

// Resolve a origem de uma replicação: aceita "label/system" ou uma URL
// https://<label>.<domínio dos apps>/<system>/. Devolve {label, system} ou null.
function parseOrigin(origem) {
  const s = String(origem || '').trim();
  if (!s) return null;
  const dominio = dominioDosApps().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = s.match(new RegExp(`^https?://([a-z0-9-]+)\\.${dominio}/([a-z0-9_-]+)/?`, 'i'));
  if (m) return { label: m[1].toLowerCase(), system: m[2].toLowerCase() };
  const p = s.replace(/^\/+|\/+$/g, '').split('/');
  if (p.length === 2 && p[0] && p[1]) return { label: p[0].toLowerCase(), system: p[1].toLowerCase() };
  return null;
}

// Resolve o subdomínio do dono e garante que a landing saiba o nome dele.
async function resolveLabel(userId) {
  const { label, name } = await ensureUserSubdomain(userId);
  ctl({ verb: 'seed_user', label, name }).catch(() => { /* best-effort */ });
  return { label, name };
}

function sysOk(s) { return RE_SYSTEM.test((s || '').toLowerCase()); }

// ── App corrente por usuário (pedido de um usuário) ──
// Exigir o slug em CADA chamada de arquivo é atrito puro quando o app é óbvio no
// trabalho em andamento: no caso dele, a escrita do rascunho falhou porque a tool
// cobrou o nome do sistema no meio de uma sequência que já estava naquele app.
// Aqui o último app resolvido com sucesso fica LEMBRADO por usuário e serve de
// DEFAULT quando `nome_do_sistema` vem vazio. Só nas tools de RASCUNHO e LEITURA;
// publicar/apagar/replicar/acesso seguem exigindo o nome, porque ali errar de app
// é irreversível. Memória de processo com validade curta: se o processo reinicia
// (ou a memória expira), cai no caminho de sempre (app único ou pergunta), nunca
// num app errado.
const APP_ATUAL = new Map(); // userId -> { system, ts }
const APP_ATUAL_TTL_MS = 6 * 60 * 60 * 1000;
export function lembrarAppAtual(userId, system) {
  const s = String(system || '').trim().toLowerCase();
  if (!userId || !sysOk(s)) return;
  APP_ATUAL.set(String(userId), { system: s, ts: Date.now() });
}
function appAtual(userId) {
  const e = APP_ATUAL.get(String(userId || ''));
  if (!e) return null;
  if (Date.now() - e.ts > APP_ATUAL_TTL_MS) { APP_ATUAL.delete(String(userId)); return null; }
  return e.system;
}

// ── Resolução de app para colaboração Modo B ──
// Descobre QUAL app uma tool deve operar e sob QUAL dono, cobrindo o caso do
// colaborador mexer na instância única do dono (mesmo código, mesmo /app/data).
//  • `dono` informado: resolve o usuário CONECTADO (conexão aceita), confere que
//    o CHAMADOR está no roster do app dele, e devolve o app do DONO.
//  • `dono` ausente: tenta um app PRÓPRIO do chamador; se não tiver, procura
//    entre os apps COMPARTILHADOS com ele. Se houver mais de um com o mesmo
//    nome, pede pra desambiguar com `dono`.
// Devolve { ok, app, ownerUserId, ownerLabel, ownerName, shared } ou { error }.
async function resolveApp(callerUserId, system, dono) {
  const sys = (system || '').toLowerCase();
  if (dono && String(dono).trim()) {
    const who = await resolveConnectedUser(callerUserId, dono);
    if (who.error === 'contato_ambiguo') return { error: contatoAmbiguoMsg(dono, who.opcoes) };
    if (who.error && who.error !== 'contato_vazio' && who.userId !== callerUserId) {
      return { error: `Não achei "${dono}" nos seus contatos conectados. Só dá pra colaborar em sistema de quem está conectado com você (Conexões › Contatos).` };
    }
    if (who.ok && who.userId !== callerUserId) {
      const allowed = await isAppCollaborator(who.userId, sys, callerUserId);
      if (!allowed) return { error: `${who.name} ainda não te adicionou como colaborador do sistema "${sys}". Peça pra ${who.name} rodar convidar_colaborador.` };
      const app = await getAppRow(who.userId, sys);
      if (!app) return { error: `${who.name} não tem um sistema chamado "${sys}".` };
      const { label, name } = await ensureUserSubdomain(who.userId);
      return { ok: true, app, ownerUserId: who.userId, ownerLabel: label, ownerName: name, shared: true };
    }
    // "dono" apontou pra mim mesmo: trata como app próprio.
  }
  // App próprio primeiro.
  const own = await getAppRow(callerUserId, sys);
  if (own) {
    const { label, name } = await ensureUserSubdomain(callerUserId);
    return { ok: true, app: own, ownerUserId: callerUserId, ownerLabel: label, ownerName: name, shared: false };
  }
  // Sem app próprio: procura entre os compartilhados comigo.
  const shared = await listSharedAppsForCollaborator(callerUserId);
  const matches = shared.filter((s) => s.system === sys);
  if (matches.length === 1) {
    const m = matches[0];
    const app = await getAppRow(m.ownerUserId, sys);
    if (!app) return { error: `O sistema compartilhado "${sys}" não existe mais no dono.` };
    return { ok: true, app, ownerUserId: m.ownerUserId, ownerLabel: m.label, ownerName: m.ownerName, shared: true };
  }
  if (matches.length > 1) {
    return { error: `Há mais de um sistema "${sys}" compartilhado com você (${matches.map((m) => m.ownerName).join(', ')}). Diga o dono no parâmetro "dono".` };
  }
  return { error: `Não achei o sistema "${sys}". Use listar_sistemas.` };
}

// Nome de exibição do chamador (autor do commit numa publicação colaborativa).
async function callerName(userId) {
  try { const u = await getUserById(userId); return (u && u.name) || null; } catch { return null; }
}

// Resolve o DONO do app pra operações de ESCRITA (rascunho + publish). Aceita app
// NOVO (ainda sem row): nesse caso o dono é o próprio chamador (app: null). É a
// mesma lógica que o publish usava inline, extraída pra ser reusada pelas tools de
// rascunho. Devolve {ownerUserId, ownerLabel, ownerName, shared, app} ou {error}.
async function resolveOwnerForWrite(userId, system, dono) {
  if (dono && String(dono).trim()) {
    const who = await resolveConnectedUser(userId, dono);
    // Ambíguo não pode cair no ramo de baixo: o dono foi informado de propósito,
    // e seguir sem ele escreveria no app PRÓPRIO do chamador.
    if (who.error === 'contato_ambiguo') return { error: contatoAmbiguoMsg(dono, who.opcoes) };
    if (who.ok && who.userId !== userId) {
      const r = await resolveApp(userId, system, dono);
      if (r.error) return { error: r.error };
      return r;
    }
  }
  const own = await getAppRow(userId, system);
  if (own) {
    const { label, name } = await resolveLabel(userId);
    return { ownerUserId: userId, ownerLabel: label, ownerName: name, shared: false, app: own };
  }
  const sh = (await listSharedAppsForCollaborator(userId)).filter((s) => s.system === system);
  if (sh.length === 1) {
    const r = await resolveApp(userId, system, undefined);
    if (r.error) return { error: r.error };
    return r;
  }
  if (sh.length > 1) {
    return { error: `Há mais de um sistema "${system}" compartilhado com você (${sh.map((s) => s.ownerName).join(', ')}). Diga o dono no parâmetro "dono".` };
  }
  const { label, name } = await resolveLabel(userId);
  return { ownerUserId: userId, ownerLabel: label, ownerName: name, shared: false, app: null };
}

// Read resolution must not allocate subdomains or seed a draft in the DB.
async function resolveOwnerForRead(userId, system, dono) {
  let ownerUserId = userId, shared = false;
  if (dono && String(dono).trim()) {
    const who = await resolveConnectedUser(userId, dono);
    if (who.error === 'contato_ambiguo') return { error: contatoAmbiguoMsg(dono, who.opcoes) };
    if (!who.ok || !who.userId) return { error:'Dono não encontrado entre seus contatos conectados.' };
    ownerUserId = who.userId;
    if (ownerUserId !== userId) {
      if (!await isAppCollaborator(ownerUserId, system, userId)) return { error:'Você não é colaborador deste app.' };
      shared = true;
    }
  } else if (!await getAppRow(userId, system)) {
    const matches = (await listSharedAppsForCollaborator(userId)).filter(a => a.system === system);
    if (matches.length > 1) return { error:'Mais de um app compartilhado com esse nome. Informe dono.' };
    if (matches.length === 1) { ownerUserId = matches[0].ownerUserId; shared = true; }
  }
  const app = await getAppRow(ownerUserId, system);
  if (shared && !app) return { error:'App compartilhado não encontrado.' };
  return { ownerUserId, shared, app };
}
async function readDraftFiles(ownerUserId, system, app) {
  const draft = await getAppDraft(ownerUserId, system);
  if (Object.keys(draft).length || !app) return draft;
  const snapshot = await getAppSnapshot(ownerUserId, system);
  return (snapshot && readSnapshot(snapshot.source_snapshot)) || {};
}

// Semeia o rascunho de um app publicado com o último código no ar (snapshot),
// mas só se o rascunho ainda estiver vazio. Idempotente. Devolve o rascunho.
// Usado pelas tools de leitura/listagem pra que o agente enxergue o código atual
// de um app já publicado sem precisar reescrever nada (nem, jamais, pedir SSH).
// Rascunho de app NOVO já é criar app: checa o teto aqui, antes de gastar a
// construção inteira (caso de 24/09: app montado no Básico, barrado só ao
// publicar). Rascunho já começado ou app publicado seguem editáveis.
async function newDraftQuotaBlock(ownerUserId, system, app, opts) {
  if (app) return null;
  if (Object.keys(await getAppDraft(ownerUserId, system)).length) return null;
  return appQuotaBlock(ownerUserId, system, opts);
}
async function ensureDraftSeeded(ownerUserId, system, app) {
  let draft = await getAppDraft(ownerUserId, system);
  if (!Object.keys(draft).length && app) {
    const snapRow = await getAppSnapshot(ownerUserId, system).catch(() => null);
    const prev = snapRow && readSnapshot(snapRow.source_snapshot);
    if (prev && Object.keys(prev).length) {
      for (const [p, b64] of Object.entries(prev)) await putAppDraftFile(ownerUserId, system, p, b64);
      draft = await getAppDraft(ownerUserId, system);
    }
  }
  return draft;
}

// ── App cap (permissions port, permissoes.mjs) ──
// The cap applies only to a NEW app and counts the OWNER's apps, not the caller's:
// in a collaborative publish (Mode B) the owner pays for the resource.
// Republishing/editing an existing app is NEVER blocked. The cap and what to
// say when it's hit belong to whoever installs it (e.g. a plan-based plugin).
let permissoes = null;
export function configurarPermissoes(p) { permissoes = conferirPermissoes(p); }
function perm() {
  if (!permissoes) throw Error('Permissões não configuradas: chame configurarPermissoes no boot');
  return permissoes;
}
async function appQuotaBlock(ownerUserId, system, { appClient = false } = {}) {
  if (system && await getAppRow(ownerUserId, system)) return null; // já existe: é edição
  const atuais = (await listAppsForUser(ownerUserId)).length;
  return perm().bloqueioDeApp({ ownerUserId, atuais, appClient });
}

// Owner's disk quota, in the format ctl.py expects. ONE place only: every
// publish path (publicar_sistema and replicar_sistema) must send this value,
// because ctl.py applies the quota on the LABEL, which is per USER, and without
// the field it falls back to 200 MB, taking down ALL of a paying user's apps.
// The "m" suffix is required: without a unit XFS reads the number as bytes.
// dono = users row of the space owner; how much disk they get is up to
// whoever installs it (e.g. a plan-based plugin).
export function cotaDeDisco(dono) {
  return `${perm().discoDoAppMb(dono)}m`;
}

// ── Reconciliação da cota de disco ──
// A cota só era aplicada DENTRO do publish, e vale no LABEL (por usuário). Ou seja:
// trocar de plano não mexia no disco. Quem subia de plano não recebia o espaço que
// passou a pagar até publicar um app de novo, e quem descia continuava com o espaço
// do plano grande. Em 17/09 isso já tinha desalinhado 7 das 13 pessoas com app.
// Nem toda troca de plano passa por código nosso (a virada mensal e os scripts de
// classificação fazem UPDATE direto no banco), então o conserto certo é varrer e
// reconciliar, não pendurar um gancho em cada caminho que escreve users.plan.
export function montarCotasDesejadas(donos) {
  return (donos || [])
    .filter((d) => d && d.label)
    .map((d) => ({ label: String(d.label), quota: cotaDeDisco(d) }));
}

// Resultado de uma reconciliação, olhando o antes/depois que o host devolveu.
// "ajustados" conta só quem REALMENTE mudou de cota, pra varredura silenciosa
// quando está tudo certo (que é o caso normal) e log quando algo mudou.
export function lerRespostaDeCota(resp) {
  const itens = Array.isArray(resp?.itens) ? resp.itens : [];
  const ajustados = [], falhas = [];
  for (const it of itens) {
    if (!it?.ok) { falhas.push({ label: it?.label, erro: it?.error || 'falha' }); continue; }
    const antes = it.antes?.hard_mb, depois = it.depois?.hard_mb;
    if (Number(antes) !== Number(depois)) ajustados.push({ label: it.label, de: antes, para: depois });
  }
  return { vistos: itens.length, ajustados, falhas };
}

export async function reconciliarCotasDeDisco({ listar = listAppOwnersForQuota, chamarCtl = ctl } = {}) {
  if (!hostingEnabled()) return { vistos: 0, ajustados: [], falhas: [] };
  const itens = montarCotasDesejadas(await listar());
  if (!itens.length) return { vistos: 0, ajustados: [], falhas: [] };
  const resp = await chamarCtl({ verb: 'quota', itens }, { timeoutMs: 120_000 });
  if (!resp?.ok) return { vistos: 0, ajustados: [], falhas: [{ label: '*', erro: resp?.error || 'ctl falhou' }] };
  return lerRespostaDeCota(resp);
}

// ── Núcleo da replicação (Fase 3 + biblioteca web) ──
// Copia SÓ o código de um app público pro espaço de `userId` e publica como um
// sistema dele. Nenhum segredo (ficam no cofre do dono) nem dado de runtime
// (fica no /app/data do dono) viaja. Usado tanto pela tool replicar_sistema
// quanto pela rota web POST /api/library/copy. Devolve {ok, url, sistema, ...}.
export async function replicateApp({ userId, agentId, origem, novo_nome, appClient = false }) {
  const src = parseOrigin(origem);
  if (!src) return { ok: false, error: 'Origem inválida. Use "dono/nome_do_sistema" ou a URL pública.' };
  const pub = await getPublicApp(src.label, src.system);
  if (!pub) return { ok: false, error: `Não achei um app público replicável em "${src.label}/${src.system}". Ele precisa estar na biblioteca (público) e ter snapshot de código.` };
  const files = readSnapshot(pub.source_snapshot);
  if (!files || !Object.keys(files).length) return { ok: false, error: 'O snapshot de código da origem está vazio ou corrompido. Não dá pra replicar.' };
  const target = ((novo_nome || src.system) || '').toLowerCase();
  if (!sysOk(target)) return { ok: false, error: 'Nome de destino inválido (minúsculas, números, - ou _, até 31 chars).' };
  const existing = await getAppRow(userId, target);
  if (existing) return { ok: false, error: `Você já tem um sistema chamado "${target}". Escolha um nome diferente pra não sobrescrever.`, ja_existe: true };
  // Replicar/instalar da biblioteca também CRIA app, então passa pelo mesmo teto
  // (senão a regra teria uma porta dos fundos pela rota /api/library/copy).
  const quota = await appQuotaBlock(userId, target, { appClient });
  if (quota) return quota;
  // Rede de segurança: o gate já rodou na origem, mas re-checa antes de subir.
  const leaks = scanSecrets(files);
  if (leaks.length) return { ok: false, error: 'O código da origem tem segredo embutido; não vou replicar.', segredos_encontrados: leaks };
  const { label, name } = await resolveLabel(userId);
  const env = await getAppSecretsDecrypted(userId, target); // segredos SEUS (provável vazio)
  // Réplica também é app NOVO => nasce PRIVADO com credencial própria (nunca a
  // do dono original: só o código viaja). Quem quiser abrir usa definir_acesso_sistema.
  const acc = await resolveAccessForPublish(userId, target, true, null);
  // Cota de disco = entitlement do plano de QUEM está replicando (a réplica nasce
  // no espaço dele). Obrigatório passar: o ctl.py aplica a cota no LABEL, que é por
  // USUÁRIO, e sem este campo cai no default de 200 MB, derrubando de uma vez a cota
  // de TODOS os apps de quem paga. Mesmo cálculo do publicar_sistema, inclusive o
  // sufixo "m" (sem unidade o XFS lê o número como bytes e zera a cota).
  const donoRow = await getUserById(userId).catch(() => null);
  const res = await ctl({ verb: 'publish', label, system: target, runtime: pub.runtime, files, env,
    author: name, message: `replicado de ${src.label}/${src.system}`, quota: cotaDeDisco(donoRow),
    ...(acc.authSpec ? { auth: acc.authSpec } : {}) }, { timeoutMs: 120_000 });
  if (res.error === 'app_crashed') return { ok: false, error: 'O app replicado crashou ao iniciar e NÃO foi publicado. Talvez precise de segredos (defina com definir_segredo) ou de ajuste no código.', log_do_crash: res.logs || null };
  if (res.error === 'assets_quebrados') return { ok: false, error: 'O app replicado subiu mas um CSS/JS não carregou, então NÃO foi publicado.', assets_quebrados: (res.broken || []).map((b) => `${b.ref} (${b.status})`).join(', ') };
  if (res.error === 'smoke_funcional_falhou') return { ok: false, error: 'O app replicado subiu, mas seu endpoint de diagnóstico falhou no teste funcional e ele NÃO foi publicado.', falhas_funcionais: (res.broken || []).map((b) => `${b.ref} (${b.status})`).join(', ') };
  if (!res.ok) return { ok: false, error: `Falha ao replicar: ${res.error || 'erro no host'}` };
  await registerApp({ userId, agentId, label, system: target, runtime: pub.runtime, url: res.url });
  await setAppSnapshot(userId, target, pub.source_snapshot).catch(() => {}); // a réplica também é replicável
  // Só afirma "privado" se o HOST confirmou o portão (mesma regra do publish).
  const gateOk = !acc.authSpec || res.privado === true;
  if (!gateOk) { acc.access = null; acc.creds = null; }
  const accessPersisted=await persistAccess(userId, target, acc);
  return { ok: true, url: res.url, sistema: target, replicado_de: `${src.label}/${src.system}`,
    credenciais: acc.creds ? { usuario: acc.creds.user, senha: acc.creds.pass } : undefined,
    aviso_acesso: !gateOk
      ? 'A réplica FOI publicada mas a plataforma não conseguiu trancar a URL: por enquanto qualquer pessoa com o link abre. Avise o usuário e tente definir_acesso_sistema mais tarde.'
      : !accessPersisted ? 'O portão foi aplicado no host, mas o registro interno de acesso não confirmou após três tentativas. Entregue as credenciais agora e encaminhe o incidente; não prometa que será possível recuperá-las depois.' : undefined };
}

// Apaga de VERDADE um app do usuário: remove o container do host de apps e a
// linha no banco. Usado pela UI (botão apagar, com confirmação) e reusa a
// mesma mecânica da tool apagar_sistema.
// O que EXISTE hoje dentro do app, em linguagem de gente — pra ninguém apagar às
// cegas. Apagar um app destrói também o /app/data (o banco de dados do próprio
// app), que de propósito não vai em snapshot nem em git: não tem como voltar.
// Best-effort: se o host não responder, devolve null e quem chama segue sem o
// detalhe (a confirmação continua obrigatória).
export async function appContentsSummary(userId, system) {
  const sys = (system || '').toLowerCase();
  if (!hostingEnabled() || !sys) return null;
  try {
    const app = await getAppRow(userId, sys);
    if (!app) return null;
    const inv = await ctl({ verb: 'inventory', label: app.label, system: sys }, { timeoutMs: 20_000 });
    if (!inv || !inv.ok) return null;
    const partes = [];
    const tabelas = inv.dados?.tabelas || {};
    const colecoes = inv.dados?.colecoes || {};
    for (const [t, n] of Object.entries(tabelas)) partes.push(`${n} ${n === 1 ? 'registro' : 'registros'} em ${t}`);
    for (const [c, n] of Object.entries(colecoes)) partes.push(`${n} ${n === 1 ? 'item' : 'itens'} em ${c}`);
    const totalRegistros = [...Object.values(tabelas), ...Object.values(colecoes)].reduce((a, b) => a + b, 0);
    return {
      arquivos_de_codigo: inv.codigo?.arquivos ?? null,
      tem_dados: !!inv.dados?.existe,
      arquivos_de_dados: inv.dados?.arquivos ?? null,
      registros: totalRegistros,
      detalhe: partes,
      versoes: inv.versoes ?? null,
      // Uma linha só, pronta pra entrar num texto de confirmação.
      resumo: inv.dados?.existe
        ? (partes.length
          ? `dados do app: ${partes.join(', ')}`
          : `${inv.dados.arquivos || 0} arquivo(s) de dados do app`)
        : 'sem dados de runtime guardados',
    };
  } catch { return null; }
}

export async function deleteAppForUser(userId, system) {
  if (!hostingEnabled()) return { ok: false, error: 'Hospedagem de apps não está habilitada.' };
  const sys = (system || '').toLowerCase();
  if (!sys) return { ok: false, error: 'Sistema não informado.' };
  const app = await getAppRow(userId, sys);
  if (!app) return { ok: false, error: `Não achei o sistema "${sys}".`, nao_encontrado: true };
  const res = await ctl({ verb: 'delete', label: app.label, system: sys });
  if (!res.ok) return { ok: false, error: `Falha ao apagar: ${res.error || 'erro no host'}` };
  await deleteAppRow(userId, sys);
  return { ok: true, sistema: sys };
}

// server.js padrão injetado quando o agente manda só o frontend (sem server.js).
// Serve os arquivos estáticos do app (raiz ou public/) sem o agente precisar
// escrever servidor nenhum — assim o front NUNCA vive dentro de uma template
// string do Node, que era a origem dos crashes de `${...}` no boot.
const DEFAULT_STATIC_SERVER = () => `// Gerado automaticamente pelo ${marca().nome}: serve seus arquivos estáticos.
// Seu frontend fica em public/ (ou na raiz). Não precisa editar este arquivo.
const http = require('http');
const fs = require('fs');
const path = require('path');
const PORT = process.env.PORT || 8080;
const ROOT = fs.existsSync(path.join(__dirname, 'public')) ? path.join(__dirname, 'public') : __dirname;
const TYPES = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.mjs':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.json':'application/json; charset=utf-8', '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.gif':'image/gif', '.svg':'image/svg+xml', '.ico':'image/x-icon', '.webp':'image/webp', '.txt':'text/plain; charset=utf-8', '.woff':'font/woff', '.woff2':'font/woff2' };
http.createServer((req, res) => {
  try {
    let p = decodeURIComponent((req.url || '/').split('?')[0]);
    if (p.endsWith('/')) p += 'index.html';
    const full = path.normalize(path.join(ROOT, p));
    if (full !== ROOT && !full.startsWith(ROOT + path.sep)) { res.writeHead(403); return res.end('403'); }
    fs.readFile(full, (err, buf) => {
      if (err) {
        if (path.extname(full)) { res.writeHead(404); return res.end('404'); }
        return fs.readFile(path.join(ROOT, 'index.html'), (e2, b2) => {
          if (e2) { res.writeHead(404); return res.end('404'); }
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          res.end(b2);
        });
      }
      res.writeHead(200, { 'content-type': TYPES[path.extname(full).toLowerCase()] || 'application/octet-stream' });
      res.end(buf);
    });
  } catch (e) { res.writeHead(500); res.end('500'); }
}).listen(PORT, () => console.log('static server on ' + PORT));
`;

// ── Esqueleto modular de app node (tool iniciar_estrutura_do_app) ──
// Gera no HOST (zero tokens de runtime) a estrutura que o resgate do KhaosClass
// provou funcionar: server.js FINO + lib/ (db, helpers, rotas por área) + public/
// (um .js por área). O app nasce funcional (api/status + página) e já nasce no
// formato que passa no lint e nunca esbarra no guarda de tamanho. Exportada pra
// dar pra testar sem harness.
export function scaffoldNodeApp(system, titulo) {
  const t = String(titulo || system)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const serverJs = `'use strict';

// ${system} — servidor HTTP. Entrada FINA de propósito: CORS/OPTIONS, prefixo,
// loop de rotas (lib/routes/), arquivos estáticos e erro 500. NÃO cresça este
// arquivo: área nova do backend = arquivo novo em lib/routes/ + require no array rotas.

const http = require('http');
const path = require('path');

const { db } = require('./lib/db');
const { sendJson, parseBody, serveStatic } = require('./lib/helpers');

const PORT = process.env.PORT || 8080;
const PUBLIC_DIR = path.join(__dirname, 'public');
const PREFIX = '/${system}';

// Cada módulo exporta handle(ctx) e retorna true quando tratou a requisição.
const rotas = [
  require('./lib/routes/exemplo'),
];

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    });
    return res.end();
  }

  const urlObj = new URL(req.url, 'http://localhost');
  let pathname = urlObj.pathname;

  // O app roda em /${system}/ no subdomínio: remove o prefixo se presente.
  if (pathname.startsWith(PREFIX)) {
    pathname = pathname.slice(PREFIX.length);
    if (!pathname.startsWith('/')) pathname = '/' + pathname;
  }

  try {
    const ctx = { req, res, pathname, urlObj, db, sendJson, parseBody };
    for (const rota of rotas) {
      if (await rota.handle(ctx)) return;
    }
    const filePath = path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname);
    return serveStatic(req, res, filePath, PUBLIC_DIR);
  } catch (err) {
    console.error('Server error:', err);
    return sendJson(res, { error: err.message }, 500);
  }
});

server.listen(PORT, () => {
  console.log('${system} rodando na porta ' + PORT);
});
`;

  const helpersJs = `'use strict';

// ${system} — helpers de HTTP: resposta JSON, parse de body e arquivos estáticos.

const fs = require('fs');
const path = require('path');

// Retorna true para que as rotas possam fazer \`return sendJson(...)\`
// e o server saiba que a requisição foi tratada.
function sendJson(res, data, status = 200) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  });
  res.end(JSON.stringify(data));
  return true;
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => body += chunk);
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        resolve({});
      }
    });
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
};

function serveStatic(req, res, filePath, publicDir) {
  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME[ext] || 'application/octet-stream';
  fs.readFile(filePath, (err, content) => {
    if (err) {
      if (err.code === 'ENOENT') {
        // SPA fallback: rota desconhecida devolve o index
        fs.readFile(path.join(publicDir, 'index.html'), (err2, indexContent) => {
          if (err2) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('Not Found');
          } else {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(indexContent);
          }
        });
      } else {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Server Error');
      }
    } else {
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content);
    }
  });
}

module.exports = { sendJson, parseBody, serveStatic };
`;

  const dbJs = `'use strict';

// ${system} — banco de dados (SQLite nativo do Node). Schema idempotente:
// CREATE TABLE IF NOT EXISTS roda em todo boot sem apagar dados.
// Dado de runtime fica SEMPRE em /app/data (persiste entre publishes).

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.DATA_DIR || '/app/data';
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, '${system}.db'));

// Troque "itens" pelo SEU schema (pode ter várias tabelas neste mesmo exec).
db.exec(\`
  CREATE TABLE IF NOT EXISTS itens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
\`);

module.exports = { db };
`;

  const exemploJs = `'use strict';

// ${system} — rotas de EXEMPLO. Este arquivo é o MODELO de módulo de rota:
// uma ÁREA por arquivo em lib/routes/, cada um exporta handle(ctx) e retorna
// true (via sendJson) quando tratou a requisição, false caso contrário.
// Crie os seus (ex: lib/routes/pedidos.js) e registre no array rotas do server.js.

async function handle(ctx) {
  const { req, res, pathname, urlObj, db, sendJson, parseBody } = ctx;

  if (pathname === '/api/status' && req.method === 'GET') {
    const row = db.prepare('SELECT COUNT(*) AS n FROM itens').get();
    return sendJson(res, { ok: true, sistema: '${system}', itens: row.n });
  }

  if (pathname === '/api/itens' && req.method === 'GET') {
    return sendJson(res, db.prepare('SELECT * FROM itens ORDER BY id DESC').all());
  }

  if (pathname === '/api/itens' && req.method === 'POST') {
    const body = await parseBody(req);
    const nome = String(body.nome || '').trim();
    if (!nome) return sendJson(res, { error: 'Campo "nome" é obrigatório.' }, 400);
    const r = db.prepare('INSERT INTO itens (nome) VALUES (?)').run(nome);
    return sendJson(res, { ok: true, id: Number(r.lastInsertRowid) }, 201);
  }

  return false;
}

module.exports = { handle };
`;

  const indexHtml = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${t}</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <main>
    <h1>${t}</h1>
    <p id="status">Carregando…</p>
  </main>
  <!-- Um .js por ÁREA, em ordem fixa: core.js primeiro (helpers), depois os seus
       (ex: <script src="pedidos.js"></script>). Caminhos sempre RELATIVOS. -->
  <script src="core.js"></script>
</body>
</html>
`;

  const coreJs = `// ${system} — core do cliente: helpers compartilhados + boot. NÃO cresça este
// arquivo: cada área do frontend = um .js próprio (ex: public/pedidos.js),
// carregado no index.html DEPOIS do core.js. E nunca defina a mesma função
// em dois arquivos (o escopo é global compartilhado; a última carregada vence).

const el = (id) => document.getElementById(id);

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Toda chamada de API passa por aqui. Caminho RELATIVO ('api/...'), nunca '/api/...'.
async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || 'Erro na requisição');
  }
  return res.json();
}

async function boot() {
  try {
    const st = await api('api/status');
    el('status').textContent = 'No ar — ' + st.itens + ' item(ns) no banco.';
  } catch (e) {
    el('status').textContent = 'Erro ao falar com o servidor: ' + e.message;
  }
}

boot();
`;

  const styleCss = `/* ${system} — estilos base. */
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body {
  font-family: system-ui, -apple-system, sans-serif;
  margin: 0 auto;
  padding: 2rem;
  max-width: 720px;
}
h1 { margin-top: 0; }
`;

  return {
    'server.js': serverJs,
    'lib/helpers.js': helpersJs,
    'lib/db.js': dbJs,
    'lib/routes/exemplo.js': exemploJs,
    'public/index.html': indexHtml,
    'public/core.js': coreJs,
    'public/style.css': styleCss,
  };
}

export function hostingTools(userId, agentId, opts = {}) {
  if (!hostingEnabled()) return [];
  // #6: sink pra mostrar link de app como CARD com botão "Abrir app" (mesmo
  // mecanismo do mostrar_produtos), em vez de URL crua no texto. Quando presente,
  // publicar/replicar/listar emitem o card; sem sink (ex.: caminho de emergência),
  // as tools seguem só com o texto de sempre.
  // `Raw` porque o listar_sistemas o desliga quando a chamada é sondagem interna
  // (intencao:"consulta"); publicar/replicar sempre emitem, ali o card É o resultado.
  const emitAppCardRaw = typeof opts.onAppLink === 'function' ? opts.onAppLink : null;
  const emitAppCard = emitAppCardRaw;
  // Conversa vinda do app iOS: ver appQuotaBlock.
  const appClient = !!opts.appClient;
  // ── Guardrail: each app is looked after by ONE of the owner's assistants (apps.agent_id) ──
  // If the ACTIVE assistant doesn't own the app (and it's the user's own app,
  // not a collaboration between people), it does NOT act: it hands off to the
  // owner. The user switches to the right assistant (menu/@name). (27/07)
  async function ownerAgentName(ownerAgentId) {
    try {
      const ags = await listAgents(userId);
      const a = ags.find((x) => x.id === ownerAgentId);
      return (a && a.name) || null;
    } catch { return null; }
  }
  function routeToOwnerMsg(system, nome) {
    const quem = nome || 'outro assistente seu';
    return `Esse sistema ("${system}") é cuidado pelo assistente ${quem}, não por você. NÃO publique, edite, depure, chame nem compartilhe esse app você mesmo. Diga ao usuário, com naturalidade, que quem cuida do "${system}" é o ${quem} e que é só falar com ele: mandar "menu" e escolher, ou começar a mensagem com @${quem}.`;
  }
  async function guardAgentOwner(res) {
    if (!res || res.error) return res;
    if (!res.app || res.shared || res.ownerUserId !== userId) return res; // app novo ou colaboração => libera
    const owner = res.app.agent_id;
    if (!owner || !agentId || owner === agentId) return res;               // sem dono definido ou é o próprio => libera
    return { error: routeToOwnerMsg(res.app.system, await ownerAgentName(owner)) };
  }
  const rApp = async (system, dono) => guardAgentOwner(await resolveApp(userId, system, dono));
  const rOwner = async (system, dono) => guardAgentOwner(await resolveOwnerForWrite(userId, system, dono));
  // ── Qual app quando `nome_do_sistema` vem vazio (só rascunho/leitura) ──
  // Ordem: nome dado > app lembrado nesta sessão > rascunho aberto único >
  // app publicado único > PERGUNTA. Nunca escolhe entre vários: se há ambiguidade
  // devolve a lista pro assistente perguntar. Nome dado sempre ganha.
  async function slugAlvo(nome_do_sistema) {
    const dado = String(nome_do_sistema || '').trim().toLowerCase();
    if (dado) {
      if (!sysOk(dado)) return { error: 'Nome do sistema inválido (use minúsculas, números, - ou _, até 31 chars).' };
      return { system: dado };
    }
    const lembrado = appAtual(userId);
    if (lembrado) return { system: lembrado };
    let rascunhos = [];
    try { rascunhos = (await listAppDraftSystems(userId)) || []; } catch { rascunhos = []; }
    if (rascunhos.length === 1) return { system: String(rascunhos[0]).toLowerCase() };
    let publicados = [];
    try { publicados = ((await listAppsForUser(userId)) || []).map((a) => a?.system).filter((s) => sysOk(s)); } catch { publicados = []; }
    const opcoes = [...new Set([...rascunhos, ...publicados])];
    if (rascunhos.length === 0 && publicados.length === 1) return { system: String(publicados[0]).toLowerCase() };
    if (opcoes.length > 1) {
      return { error: `Não deu pra saber de qual app você está falando. Passe nome_do_sistema. Apps deste usuário: ${opcoes.join(', ')}.` };
    }
    return { error: 'Informe o nome do sistema (nome_do_sistema).' };
  }
  // Resolve o alvo e já LEMBRA (o próximo passo da mesma sequência não precisa repetir).
  async function alvoRascunho(nome_do_sistema, dono) {
    const alvo = await slugAlvo(nome_do_sistema);
    if (alvo.error) return { error: alvo.error };
    const owner = await rOwner(alvo.system, dono);
    if (owner.error) return { error: owner.error };
    lembrarAppAtual(userId, alvo.system);
    return { system: alvo.system, owner };
  }
  async function alvoLeitura(nome_do_sistema, dono) {
    const alvo = await slugAlvo(nome_do_sistema);
    if (alvo.error) return alvo;
    const owner = await guardAgentOwner(await resolveOwnerForRead(userId, alvo.system, dono));
    return owner.error ? { error:owner.error } : { system:alvo.system, owner };
  }
  // Internal-only fingerprint hook, omitted from model schemas. Uses the same
  // read-only ownership resolution as the tool; never seeds drafts or runs apps.
  async function readRevision({ nome_do_sistema, dono, caminho }, fileOnly = false) {
    const alvo = await alvoLeitura(nome_do_sistema, dono);
    if (alvo.error) return null;
    const files = await readDraftFiles(alvo.owner.ownerUserId, alvo.system, alvo.owner.app);
    const rel = String(caminho || '').replace(/^\/+/, '').trim();
    if (fileOnly && !Object.hasOwn(files, rel)) return null;
    const revision = fileOnly ? draftRevision({ [rel]:files[rel] }) : draftRevision(files);
    return createHash('sha256').update(JSON.stringify([alvo.owner.ownerUserId, alvo.system, revision])).digest('hex');
  }
  // Mesma coisa pras tools de INSPEÇÃO de app publicado (logs/histórico/diff),
  // que resolvem por rApp e devolvem erro como texto puro.
  async function alvoPublicado(nome_do_sistema, dono) {
    const alvo = await slugAlvo(nome_do_sistema);
    if (alvo.error) return { error: alvo.error };
    const r = await rApp(alvo.system, dono);
    if (r.error) return { error: r.error };
    lembrarAppAtual(userId, alvo.system);
    return { system: alvo.system, r };
  }
  return [
    {
      name: 'publicar_sistema',
      description:
        `Publishes a "small system" (web app) on the user's subdomain, reachable at https://<subdominio>.${dominioDosApps()}/<nome_do_sistema>/. `
        + 'Each app runs in an isolated container with memory/CPU limits and SLEEPS on its own when idle (wakes up on the 1st access). '
        + 'PERSISTENT DATA ALWAYS goes in /app/data (this directory is durable and reserved for runtime data): SQLite in /app/data/<nome>.db, uploads and generated files in /app/data/. Do NOT write runtime data at the /app root or next to the code. Reason: only /app/data keeps state; the code you send is what defines the app, and when an app is replicated by another user ONLY the code travels, the data in /app/data NEVER travels. '
        + 'Publishing again with the same name REWRITES the code; the data in /app/data is preserved. '
        + 'HOW TO BUILD THE APP (important for apps with several files): the reliable way is to write each file with the escrever_arquivo_do_app tool (it stays saved in a draft on the server across turns) and THEN call this publicar_sistema WITHOUT the "arquivos" parameter (it publishes the draft). You do NOT need to resend all the code in one go. To edit an already published app, the draft already starts with the current code, so just rewrite the files that changed. Alternative (small app): send everything at once in the "arquivos" parameter. '
        + 'RIGHT WAY TO ORGANIZE THE FILES (avoids bugs and is the preferred one): '
        + `(1) FRONTEND ONLY (site/page, no backend): send the HTML/CSS/JS in SEPARATE FILES inside public/ (public/index.html, public/app.js, public/style.css). You do NOT need to send server.js: ${marca().nome} serves your static files on its own. `
        + '(2) WITH BACKEND: runtime "node" with a server.js that listens on process.env.PORT (and serves the files in public/ + your API routes), or runtime "flask" with app.py exposing `app` (runs with gunicorn; front in templates/ and static/). To START a new node app with a backend, call iniciar_estrutura_do_app FIRST: it creates the ready-made modular skeleton (thin server.js + lib/routes/ + public/) and you only fill in routes and screens. '
        + 'GOLDEN RULE: NEVER build the browser HTML/JS inside a template string (backtick) in server.js/app.py. Keep the frontend in its own files. Pasting browser JS into a server string makes the client-side `${...}` be evaluated by Node and the app crashes on boot. '
        + 'RELATIVE PATHS: since the app runs under a subpath (/nome_do_sistema/), every href/src/fetch in the HTML and JS must be RELATIVE (style.css, app.js, api/status), never with a leading slash (/style.css). The publish normalizes absolute paths to relative on its own, but generate them relative from the start. '
        + 'The publish VALIDATES the boot AND the assets: if the app crashes, or if a CSS/JS referenced in the HTML does not load, it is NOT published and you get the reason so you can fix it; only say it is live when ok:true. CONFIRMED ACTION before executing. '
        + 'IF YOU ARE GOING TO MANAGE THE SYSTEM DATA (create/edit/query records through the chat): expose a real API in server.js/app.py (GET/POST/etc. routes that read and write to SQLite) and call that API with the chamar_sistema tool. You do NOT register anything "from memory": publishing the screen registers no data at all. If the API needs login, leave a way for you yourself to authenticate (e.g.: accept a token that you keep) or an internal route. After publishing, confirm the real state with a GET via chamar_sistema before saying what is there. '
        + 'SECRETS (mandatory): NEVER write an API key, password, token or connection string directly in the code; the publish REFUSES if it finds a secret in the source. Store each secret with definir_segredo and in the code use only process.env.NOME (Node) or os.environ["NOME"] (Flask). Secrets are injected into the app as environment variables at boot. '
        + 'URL ACCESS — ASK FIRST (mandatory for a NEW app): every app is born PRIVATE, protected by a username and password requested in the browser. Before the first publish, ask the user whether they want the app PUBLIC (anyone with the link can open it) or PRIVATE (only whoever has the password). '
        + 'If they say public, pass acesso:"publico". If they do not know, say it is just for them, or you cannot ask, keep the default (private) — it is the safe one. '
        + 'When publishing private, the tool returns `credenciais` (generated username and password): DELIVER both to the user in your reply, telling them it is the login to open the app. Republishing does NOT change the password nor unlock the app. Afterwards, the definir_acesso_sistema tool is what changes that.',
      parameters: {
        type: 'object',
        properties: {
          nome_do_sistema: { type: 'string', description: 'system slug (lowercase letters, numbers, - and _). Becomes the path.' },
          runtime: { type: 'string', enum: ['node', 'flask'], description: 'node or flask' },
          acesso: { type: 'string', enum: ['publico', 'privado'], description: 'OPTIONAL, only on the FIRST publish. "publico" = anyone with the link can open it (only pass it if the user ASKED for that). Omitted = private (default): the app is born with username/password and the tool returns the credentials for you to deliver. Ignored on republish — use definir_acesso_sistema to change it later.' },
          mensagem: { type: 'string', description: 'OPTIONAL. Short description of the change in this version (becomes the commit message in the app history). E.g.: "add date filter".' },
          dono: { type: 'string', description: 'OPTIONAL. Only for COLLABORATION: name or e-mail of the connected contact who is the OWNER of a system SHARED with you, when you want to edit their system (same instance, same data). Leave empty for your own systems. You can only do it if the owner added you as a collaborator.' },
          confirmo_reducao: { type: 'string', description: 'OPTIONAL. Only use it if the publish was BLOCKED for code reduction AND the reduction is intentional (you removed code on purpose). Write the justification here (e.g.: "removed the reports module at the user\'s request"). NEVER use it to bypass the block without having reread the current files.' },
          confirmo_lint: { type: 'string', description: 'OPTIONAL. Only use it if the publish was BLOCKED by the consistency lint AND you VERIFIED that the findings are false positives (e.g.: function defined dynamically). Write the justification. The normal path is to FIX what the lint pointed out, not bypass it.' },
          arquivos: {
            type: 'array',
            description: 'OPTIONAL if you already built the app with escrever_arquivo_do_app (the publish reads the draft). App files sent in this call (they override the draft): static frontend in public/index.html (+ public/app.js, public/style.css, and you may omit server.js); backend in server.js (node) or app.py (flask, + optional requirements.txt). For an app with SEVERAL files, prefer building it gradually with escrever_arquivo_do_app and calling this publish without "arquivos".',
            items: {
              type: 'object',
              properties: {
                caminho: { type: 'string', description: 'relative path, e.g.: server.js, app.py, static/index.html' },
                conteudo: { type: 'string', description: 'file content (text)' },
              },
              required: ['caminho', 'conteudo'],
            },
          },
        },
        required: ['nome_do_sistema', 'runtime'],
      },
      async run({ nome_do_sistema, runtime, acesso, arquivos, mensagem, dono, confirmo_reducao, confirmo_lint }) {
        const system = (nome_do_sistema || '').toLowerCase();
        if (!sysOk(system)) return { ok: false, error: 'Nome do sistema inválido (use minúsculas, números, - ou _, até 31 chars).' };
        if (!['node', 'flask'].includes(runtime)) return { ok: false, error: 'runtime deve ser node ou flask.' };
        // Resolve o DONO cedo: o rascunho (staging) pertence ao dono do app, e é a
        // base dos arquivos a publicar. Cobre app novo (dono = chamador) e Modo B.
        const owner = await rOwner(system, dono);
        if (owner.error) return { ok: false, error: owner.error };
        lembrarAppAtual(userId, system); // vira o app corrente da sequência
        // Teto de apps do plano do dono. Cedo de propósito: barra antes de gastar
        // build/publish no host. Só pega app NOVO (ver appQuotaBlock).
        const quota = await appQuotaBlock(owner.ownerUserId, system, { appClient });
        if (quota) return quota;
        // Monta os arquivos: base = rascunho salvo (escrito com escrever_arquivo_do_app),
        // com os arquivos passados INLINE nesta chamada por cima (retrocompat + edição
        // pontual). Assim o modelo não precisa mandar todo o código numa tacada só.
        const files = { ...(await getAppDraft(owner.ownerUserId, system)) };
        if (Array.isArray(arquivos)) {
          for (const a of arquivos) {
            const rel = (a.caminho || '').replace(/^\/+/, '');
            if (!rel) continue;
            files[rel] = Buffer.from(String(a.conteudo ?? ''), 'utf8').toString('base64');
          }
        }
        if (!Object.keys(files).length) {
          return {
            ok: false,
            reentrar: true,
            error: 'Não há arquivos pra publicar.',
            agente: 'O app não tem nenhum arquivo. Monte-o primeiro escrevendo cada arquivo com escrever_arquivo_do_app (server.js, public/index.html, public/app.js, ...) e chame publicar_sistema de novo; OU mande todos os arquivos no parâmetro "arquivos" desta chamada, com o CONTEÚDO de cada um. Arquivos não persistem entre turnos a menos que você use escrever_arquivo_do_app.',
          };
        }
        const paths = Object.keys(files);
        if (runtime === 'node' && !paths.includes('server.js')) {
          // Sem server.js: se veio frontend (algum index.html), injeta um servidor
          // estático padrão. Assim o agente não precisa escrever servidor e o front
          // fica em arquivos próprios (nada de HTML dentro de template string).
          const hasIndex = paths.some((p) => p === 'index.html' || p === 'public/index.html' || p.endsWith('/index.html'));
          if (!hasIndex) return { ok: false, error: `Pra um app estático, mande um public/index.html (o ${marca().nome} serve sozinho). Pra um backend, mande um server.js.` };
          files['server.js'] = Buffer.from(DEFAULT_STATIC_SERVER(), 'utf8').toString('base64');
        } else if (runtime === 'flask' && !paths.includes('app.py')) {
          return { ok: false, error: 'Falta o arquivo app.py (obrigatório pro runtime flask).' };
        }
        let total = 0;
        for (const [rel, b64] of Object.entries(files)) {
          const n = Buffer.from(b64, 'base64').length;
          if (n > MAX_FILE_BYTES) return { ok: false, error: `Arquivo ${rel} passou de 512 KB.` };
          total += n;
          if (total > MAX_TOTAL_BYTES) return { ok: false, error: 'App passou do limite de 2 MB no total.' };
        }
        // Publish gate: recusa segredo escrito no código (força uso do cofre).
        const leaks = scanSecrets(files);
        if (leaks.length) {
          const lst = leaks.map((l) => `${l.arquivo}: ${l.tipo}`).join('; ');
          return {
            ok: false,
            reentrar: true,
            error: 'Encontrei um segredo (chave/senha/token) escrito direto no código, então não publiquei por segurança.',
            // `usuario` = a frase que o DONO do app precisa ler. Sem ela, um publish
            // barrado some da resposta quando o modelo volta a mexer no rascunho, e a
            // pessoa fica esperando uma publicação que nunca aconteceu (caso de 17/09).
            usuario: 'Não publiquei: achei uma chave/senha escrita direto no código do app, e publicar assim deixaria ela exposta. Vou guardar no cofre do app e publicar de novo.',
            agente: 'NUNCA escreva chave/senha/token direto no fonte. Guarde cada segredo com a tool definir_segredo (cofre cifrado) e no código use só process.env.NOME (Node) ou os.environ["NOME"] (Flask). '
              + 'Encontrei: ' + lst + '. Tire do código, defina no cofre e publique de novo.',
            segredos_encontrados: leaks,
          };
        }
        // Shrink-guard: app JÁ publicado não pode ENCOLHER demais num publish sem
        // confirmação explícita. Protege contra o pior modo de falha observado:
        // reescrita de arquivo inteiro a partir de uma versão VELHA no contexto do
        // modelo (turno truncado/compaction) → publish full-replace apaga código bom.
        // App novo (sem snapshot) não passa por aqui.
        if (owner.app && !String(confirmo_reducao || '').trim()) {
          const snapRow = await getAppSnapshot(owner.ownerUserId, system).catch(() => null);
          const prev = (snapRow && readSnapshot(snapRow.source_snapshot)) || null;
          if (prev && Object.keys(prev).length) {
            // Reorganização (código mudou de arquivo, app cresceu, rotas mantidas) passa; ver app-shrink-guard.mjs.
            const { bloquear, reducoes, oldTotal, newTotal } = avaliarReducao(prev, files);
            if (bloquear) {
              return {
                ok: false,
                reentrar: true,
                error: 'Publicação bloqueada por segurança: a nova versão é bem menor que a que está no ar (possível perda de código).',
                usuario: 'Não publiquei: a versão nova ficou bem menor que a que já está no ar, e o app pode perder código. Vou reler o que está publicado e refazer a sua mudança por cima da versão atual. Se a redução for de propósito, me diga que pode publicar mesmo assim.',
                agente: 'O que você ia publicar PERDE código em relação à versão publicada (veja reducoes_detectadas, bytes antes→depois). '
                  + 'A causa mais comum é reescrever um arquivo INTEIRO a partir de uma versão velha que estava na sua memória da conversa. NÃO republique assim. '
                  + 'Primeiro RELEIA o estado atual com ler_arquivo_do_app e aplique sua mudança com editar_arquivo_do_app (patch de trecho) em cima do código atual. '
                  + 'SÓ SE a redução for de propósito (você removeu código intencionalmente), chame publicar_sistema de novo passando confirmo_reducao com a justificativa.',
                reducoes_detectadas: reducoes,
                total_antes: oldTotal,
                total_depois: newTotal,
              };
            }
          }
        }
        // Lint de consistência (determinístico, roda no host, zero tokens):
        // (1) handler on* referenciado em HTML/template sem função definida;
        // (2) função declarada em dois arquivos de cliente. Ambos BLOQUEIAM: são
        // exatamente os bugs "botão que não faz nada" que custam turnos de caçada.
        // (3) api()/fetch() sem rota no servidor vira só AVISO (heurístico).
        const lint = lintAppB64(files);
        if (lint.erros.length && !String(confirmo_lint || '').trim()) {
          return {
            ok: false,
            reentrar: true,
            error: 'Publicação bloqueada: o lint de consistência achou referências quebradas no código (botões/funções que não funcionariam).',
            usuario: 'Não publiquei: a checagem de consistência achou referências quebradas no app (um botão que chama uma função que não existe). Vou corrigir e publicar de novo.',
            agente: 'Corrija os problemas listados em lint_erros ANTES de publicar de novo — cada item tem o nome exato e os arquivos envolvidos, então dá pra resolver em uma edição: '
              + 'handler_orfao = o HTML/template chama uma função que não existe em nenhum .js (defina a função ou corrija o nome no onclick); '
              + 'funcao_duplicada = a mesma função está declarada em dois arquivos de cliente e uma sobrescreve a outra em silêncio (apague uma das cópias). '
              + 'Use ler_arquivo_do_app pra ver o estado atual e editar_arquivo_do_app pra corrigir. '
              + 'SÓ SE você verificar que um apontamento é falso-positivo (ex: função criada dinamicamente), republique passando confirmo_lint com a justificativa.',
            lint_erros: lint.erros,
            ...(lint.avisos.length ? { lint_avisos: lint.avisos } : {}),
          };
        }
        // Arquivos de código inchados (≥400 linhas) viram aviso no sucesso — o
        // bloqueio duro (≥800) fica na ESCRITA (escrever_arquivo_do_app), não aqui:
        // bloquear o publish de código que já entrou no rascunho só travaria o app.
        const arquivosGrandes = Object.entries(files)
          .filter(([rel]) => /\.(js|mjs|cjs|py|html|htm)$/i.test(rel))
          .map(([rel, b64]) => {
            try { return { arquivo: rel, linhas: countLines(Buffer.from(b64, 'base64').toString('utf8')) }; }
            catch { return null; }
          })
          .filter((f) => f && f.linhas >= 400);
        // O DONO do app (Modo B / app novo) já foi resolvido no topo (owner). O
        // AUTOR do commit é sempre quem publicou.
        const label = owner.ownerLabel;
        const author = (await callerName(userId)) || owner.ownerName;
        const env = await getAppSecretsDecrypted(owner.ownerUserId, system);
        // Cota de disco = entitlement do plano do DONO do app (recurso reservado,
        // NÃO usa crédito). ctl.py aplica via XFS project quota (ensure_quota);
        // o formato vem de cotaDeDisco().
        const ownerRow = await getUserById(owner.ownerUserId).catch(() => null);
        // Portão de acesso à URL. App novo nasce privado (usuário/senha pedidos
        // pelo roteador antes de acordar o container); republicação preserva.
        // `acesso` só vale na primeira publicação — depois é definir_acesso_sistema.
        const acc = await resolveAccessForPublish(owner.ownerUserId, system, !owner.app, owner.app ? null : acesso);
        const res = await ctl({ verb: 'publish', label, system, runtime, files, env,
          author, message: mensagem, quota: cotaDeDisco(ownerRow),
          ...(acc.authSpec ? { auth: acc.authSpec } : {}) }, { timeoutMs: 120_000 });
        if (res.error === 'app_crashed') {
          // O app subiu e CRASHOU no boot. NÃO foi publicado. O `error` é o texto
          // LIMPO pro usuário; as instruções técnicas ficam em `agente` (só pro
          // modelo) e a re-entrada no loop é sinalizada por `reentrar`.
          return {
            ok: false,
            reentrar: true,
            error: 'O app teve um erro ao iniciar e não foi publicado.',
            agente: 'O container saiu com erro no boot (provável erro de sintaxe ou de execução no código gerado). Analise o log_do_crash, CORRIJA o código e publique de novo. '
              + 'Dica comum: não coloque HTML grande dentro de string no server (colisão de aspas quebra o parse); prefira arquivos separados (public/index.html) e deixe o server só com a API.',
            exit_code: res.exit_code ?? null,
            log_do_crash: res.logs || '(sem log)',
          };
        }
        if (res.error === 'assets_quebrados') {
          // O app subiu, mas um CSS/JS referenciado no HTML não carrega (arquivo
          // faltando ou caminho errado). NÃO foi publicado. Diz o que quebrou.
          const lst = (res.broken || []).map((b) => `${b.ref} (${b.status})`).join(', ');
          return {
            ok: false,
            reentrar: true,
            error: 'O app subiu mas uma página ficaria quebrada (um CSS/JS não carregou), então não foi publicado.',
            agente: 'Um arquivo CSS/JS referenciado no HTML não carregou (arquivo faltando ou caminho errado). Confira se você ENVIOU esses arquivos e se o caminho no HTML bate com o nome do arquivo. Corrija e publique de novo.',
            assets_quebrados: lst || '(sem detalhe)',
          };
        }
        if (res.error === 'smoke_funcional_falhou') {
          const lst = (res.broken || []).map((b) => `${b.ref} (${b.status})`).join(', ');
          return {
            ok: false,
            reentrar: true,
            error: 'O app subiu, mas seu endpoint de diagnóstico falhou no teste funcional; por isso não foi publicado.',
            agente: 'O host abriu a página e chamou o endpoint literal de status/health/ping usado pelo app. Corrija a rota/status indicado e publique novamente; não trate boot ou lint como prova funcional.',
            falhas_funcionais: lst || '(sem detalhe)',
          };
        }
        if (!res.ok) return {
          ok: false,
          reentrar: true,
          error: 'Não consegui publicar o app agora (erro no host).',
          agente: `Falha ao publicar: ${res.error || 'erro no host'}. Se parecer transitório, tente de novo; senão veja ver_logs_sistema.`,
        };
        // Registra sob o DONO do app. Numa publicação colaborativa, preserva o
        // agente do dono (não reatribui a app pro agente do colaborador).
        const regAgent = owner.shared ? (owner.app && owner.app.agent_id) || null : agentId;
        await registerApp({ userId: owner.ownerUserId, agentId: regAgent, label, system, runtime, url: res.url });
        // O portão de acesso mora no host (ctl.py grava a entrada `auth`, router.py
        // valida). Só afirmamos que o app está trancado se o HOST confirmou
        // (`privado:true`): host antigo ignora o `auth` e devolveria a URL aberta —
        // aí é melhor avisar o assistente do que prometer privacidade que não existe.
        const gateOk = !acc.authSpec || res.privado === true;
        if (!gateOk) { acc.access = null; acc.creds = null; }
        const accessPersisted=await persistAccess(owner.ownerUserId, system, acc);
        // Snapshot do código (só o fonte enviado) pra permitir replicar depois.
        // Dado de runtime (em /app/data) não é enviado, então não entra aqui.
        // SÓ limpa o rascunho se o snapshot NOVO ficou salvo: o rascunho re-semeia
        // do snapshot, então limpar com snapshot velho/ausente faria a próxima
        // edição partir de código STALE (um dos vetores do incidente KhaosClass).
        const snap = buildSnapshot(files);
        let snapshotOk = false;
        if (snap) {
          try { await setAppSnapshot(owner.ownerUserId, system, snap); snapshotOk = true; } catch { /* mantém o rascunho */ }
        }
        if (snapshotOk) await clearAppDraft(owner.ownerUserId, system).catch(() => {});
        // Espia o log logo após o publish (best-effort, não bloqueia): o boot foi
        // validado pelo host, mas erro de runtime nas primeiras requisições só
        // aparece aqui (ex: "no such column" do SQLite).
        let avisosDeLog;
        try {
          const lg = await ctl({ verb: 'logs', label, system, tail: 80 }, { timeoutMs: 20_000 });
          if (lg && lg.ok && lg.logs) {
            const reErr = /\b(Error|Traceback|Exception|SyntaxError|UnhandledPromiseRejection|ECONNREFUSED|EADDRINUSE|SQLITE_ERROR|no such (?:table|column))\b/i;
            const hits = String(lg.logs).split('\n').filter((l) => reErr.test(l));
            if (hits.length) avisosDeLog = hits.slice(-8);
          }
        } catch { /* best-effort */ }
        if (emitAppCard) emitAppCard({ name: system, url: res.url, description: 'App publicado no seu subdomínio.' });
        return { ok: true, url: res.url, quota: res.quota || null,
          acesso: acc.access === 'public' ? 'público (qualquer pessoa com o link abre)'
            : acc.access === 'private' ? 'privado (pede usuário e senha)' : undefined,
          credenciais: acc.creds
            ? { usuario: acc.creds.user, senha: acc.creds.pass,
                obs: 'O app é PRIVADO: o navegador vai pedir esse usuário e essa senha. ENTREGUE os dois ao usuário na sua resposta (é ele quem precisa deles) e diga que ele pode compartilhar com quem quiser dar acesso. Pra deixar o app aberto a qualquer pessoa, use definir_acesso_sistema.' }
            : undefined,
          cartao_mostrado: emitAppCard ? 'Já mostrei o app como um card com botão "Abrir app". NÃO repita a URL crua no texto; só comente naturalmente que o app está no ar.' : undefined,
          validacao: 'boot, assets e endpoint de diagnóstico (quando declarado) validados pelo host',
          aviso_acesso: gateOk ? undefined
            : 'O app FOI publicado mas a plataforma NÃO conseguiu trancar a URL (portão de acesso indisponível no host): por enquanto qualquer pessoa com o link abre. Diga isso ao usuário, sem senha nenhuma, e tente definir_acesso_sistema mais tarde.',
          aviso_registro_acesso: gateOk && !accessPersisted
            ? 'O portão está ativo no host, mas o banco não confirmou o registro após três tentativas. Entregue as credenciais agora e informe a falha; não prometa recuperação futura até reconciliar.' : undefined,
          aviso_dados: res.dados_fora_do_data && res.dados_fora_do_data.length
            ? { obs: 'Este app grava dado de runtime FORA de /app/data (arquivos abaixo). Eles ficaram de fora do versionamento (então um rollback de código não apaga nem rebobina o dado do usuário), mas o certo é o app usar /app/data: só ele é durável e reservado a dado. Ajuste os caminhos no código na próxima edição.', arquivos: res.dados_fora_do_data }
            : undefined,
          avisos_de_log: avisosDeLog && avisosDeLog.length
            ? { obs: 'O app subiu, mas o log recente tem linhas com cara de erro. Confira se são esperadas; se não, corrija antes de avisar o usuário.', linhas: avisosDeLog }
            : undefined,
          avisos_lint: lint.avisos.length
            ? { obs: 'O app FOI publicado, mas o lint achou chamadas api()/fetch() do cliente sem rota correspondente no servidor (heurístico — confira; se a rota realmente não existe, esses botões vão falhar em uso).', itens: lint.avisos }
            : undefined,
          avisos_tamanho: arquivosGrandes.length
            ? { obs: 'Arquivos de código grandes (≥400 linhas). Antes de crescer mais algum deles, divida em módulos (lib/routes/ no servidor, um .js por área no cliente) — reescritas ≥800 linhas são bloqueadas.', itens: arquivosGrandes }
            : undefined,
          aviso: snapshotOk ? undefined
            : 'Não consegui atualizar o snapshot interno desta versão (o app FOI publicado). Mantive o rascunho com o código publicado; a próxima edição parte dele normalmente.',
          colaborativo: owner.shared || undefined, dono: owner.shared ? owner.ownerName : undefined };
      },
    },
    // ── Prova de vida (Fase 2 do item 3 das frustrações de 16/09) ─────────────
    // O lint só enxerga o que é ESTÁTICO. O erro de Tipo 2 (o nome existe, mas o
    // VALOR está errado: `/api/pign` no lugar de `/api/ping`) só aparece quando o
    // código RODA. Esta tool sobe o rascunho num container DESCARTÁVEL no host,
    // vê se ele fica de pé e exercita os GET literais que o próprio app declara.
    //
    // NÃO é ferramenta do modelo: fica fora de READS/EDITS no app-task-runner, que
    // é quem a dispara no fim da tarefa de app. Custo de schema no prompt = zero, e
    // o modelo não consegue chamá-la em loop. É portão que INFORMA, não que bloqueia.
    //
    // Nunca publica, nunca registra o app, nunca limpa o rascunho, nunca encosta no
    // container publicado nem no /app/data real (o verbo `probe` do ctl.py roda em
    // diretório e nome próprios, com teto de 1 prova viva por pessoa, TTL e teardown
    // garantido inclusive no erro).
    //
    // Contrato herdado do `probe`: ok:false = a PROVA não rodou (não diz nada sobre
    // o app). App quebrado é resultado VÁLIDO da prova: ok:true com `veredito` em
    // passou | quebrado | crashou | nao_subiu.
    {
      name: 'provar_app',
      description: 'Internal platform use: boots the app draft in a disposable container and reports whether it stays up. Publishes nothing.',
      parameters: { type: 'object', properties: { nome_do_sistema: { type: 'string' }, dono: { type: 'string' } } },
      async run({ nome_do_sistema, dono } = {}) {
        const alvo = await alvoRascunho(nome_do_sistema, dono);
        if (alvo.error) return { ok: false, prova: 'nao_rodou', error: alvo.error };
        const { system, owner } = alvo;
        const files = { ...(await getAppDraft(owner.ownerUserId, system)) };
        if (!Object.keys(files).length) return { ok: false, prova: 'nao_rodou', error: 'Não há rascunho pra provar.' };
        // Mesma montagem do publish, pra provar EXATAMENTE o que seria publicado:
        // o runtime do app que já existe manda; em app novo, app.py sem server.js
        // é flask e o resto é node.
        const paths = Object.keys(files);
        const runtime = ['node', 'flask'].includes(owner.app?.runtime)
          ? owner.app.runtime
          : (paths.includes('app.py') && !paths.includes('server.js') ? 'flask' : 'node');
        if (runtime === 'node' && !paths.includes('server.js')) {
          const hasIndex = paths.some((p) => p === 'index.html' || p === 'public/index.html' || p.endsWith('/index.html'));
          if (!hasIndex) return { ok: false, prova: 'nao_rodou', error: 'Rascunho sem server.js e sem index.html: não há o que subir.' };
          files['server.js'] = Buffer.from(DEFAULT_STATIC_SERVER(), 'utf8').toString('base64');
        } else if (runtime === 'flask' && !paths.includes('app.py')) {
          return { ok: false, prova: 'nao_rodou', error: 'Falta o arquivo app.py (obrigatório pro runtime flask).' };
        }
        let total = 0;
        for (const [rel, b64] of Object.entries(files)) {
          const n = Buffer.from(b64, 'base64').length;
          if (n > MAX_FILE_BYTES) return { ok: false, prova: 'nao_rodou', error: `Arquivo ${rel} passou de 512 KB.` };
          total += n;
          if (total > MAX_TOTAL_BYTES) return { ok: false, prova: 'nao_rodou', error: 'App passou do limite de 2 MB no total.' };
        }
        // Os segredos do cofre entram como no publish: sem eles um app que lê
        // process.env.X morre no boot e a prova acusaria um defeito que não existe.
        const env = await getAppSecretsDecrypted(owner.ownerUserId, system);
        const ownerRow = await getUserById(owner.ownerUserId).catch(() => null);
        const res = await ctl({ verb: 'probe', label: owner.ownerLabel, runtime, files, env,
          quota: cotaDeDisco(ownerRow) }, { timeoutMs: 120_000 });
        if (!res.ok) {
          const motivo = res.error === 'prova_em_andamento'
            ? `Já existe uma prova de vida rodando pra este usuário (restam ~${res.restam_s ?? '?'}s).`
            : res.error === 'prova_estourou_tempo'
              ? `A prova passou do teto de ${res.limite_s ?? '?'}s e foi abortada.`
              : `Não deu pra rodar a prova: ${res.error || 'erro no host'}.`;
          return { ok: false, prova: 'nao_rodou', error: motivo,
            agente: 'A prova de vida NÃO chegou a rodar, então ela não diz NADA sobre o app: não trate como aprovado nem como quebrado. Siga pela validação estática e diga o que de fato sabe.' };
        }
        const base = { ok: true, prova: 'rodou', veredito: res.veredito, efemero: true, app: system };
        if (res.fixed_paths) base.caminhos_corrigidos = res.fixed_paths;
        const lista = (arr) => ((arr || []).map((b) => `${b.ref} (${b.status})`).join(', ') || undefined);
        if (res.veredito === 'crashou' || res.veredito === 'nao_subiu') {
          return { ...base,
            error: res.veredito === 'crashou'
              ? 'Subi o app num container de teste e ele CRASHOU no boot.'
              : 'Subi o app num container de teste e ele não respondeu dentro do tempo de boot.',
            agente: 'O código atual NÃO fica de pé. Leia o log_do_crash, ache a linha que estourou e corrija ANTES de dar a tarefa por concluída. Nada foi publicado; este container era descartável.',
            exit_code: res.exit_code ?? null,
            log_do_crash: res.logs || '(sem log)' };
        }
        if (res.veredito === 'quebrado') {
          return { ...base,
            error: 'O app sobe, mas alguma coisa que ele mesmo chama não respondeu.',
            agente: 'Cada item abaixo é um GET LITERAL tirado do código do app que o host executou de verdade e não voltou 200. Status 404 numa rota de API costuma ser erro de DIGITAÇÃO no caminho (o clássico /api/pign por /api/ping): compare o caminho chamado no cliente com a rota declarada no servidor. Corrija e só então conclua.',
            assets_quebrados: lista(res.broken_critical),
            rotas_quebradas: lista(res.broken_functional),
            outros_quebrados: lista(res.broken_other) };
        }
        return { ...base,
          health: res.health || null,
          outros_quebrados: lista(res.broken_other),
          avisos_funcionais: res.functional_warnings || undefined,
          escopo: 'O app sobe e os GET que ele mesmo declara responderam. NÃO valida regra de negócio, layout, POST nem o que o usuário pediu.' };
      },
    },
    {
      name: 'iniciar_estrutura_do_app',
      description:
        'Creates in the DRAFT the modular skeleton of a NEW node app, in a single call and without you writing code: THIN server.js (entry point only: CORS, prefix, route loop, static files, 500 error), lib/db.js (SQLite in /app/data), lib/helpers.js (sendJson/parseBody/serveStatic), lib/routes/exemplo.js (route module template: exports handle(ctx) and returns true when it handled the request) and public/ (index.html + core.js + style.css). The app is born working (GET api/status + page). '
        + 'ALWAYS USE IT when starting a node app with a backend: starting from this skeleton avoids the monolith (a giant file that later stalls every edit). Then just: (1) adjust the schema in lib/db.js; (2) one AREA per file in lib/routes/ (copy the format of exemplo.js) + require it in the rotas array of server.js; (3) one .js per area in public/, loaded in index.html after core.js; (4) publicar_sistema. '
        + 'ONLY for a new app: if the system was already published or already has a draft, the tool refuses (it does not overwrite existing code).',
      parameters: {
        type: 'object',
        properties: {
          nome_do_sistema: { type: 'string', description: 'Slug of the NEW system (lowercase, numbers, - and _; up to 31 chars). Becomes the app path.' },
          titulo: { type: 'string', description: 'OPTIONAL. Human-readable app title for index.html (e.g.: "Controle de Pedidos"). Default: the slug itself.' },
        },
        required: ['nome_do_sistema'],
      },
      async run({ nome_do_sistema, titulo }) {
        const system = String(nome_do_sistema || '').trim().toLowerCase();
        if (!sysOk(system)) return { ok: false, error: 'Nome do sistema inválido: use minúsculas, números, hífen ou underscore (até 31 caracteres, começando com letra/número).' };
        const owner = await rOwner(system, undefined);
        if (owner.error) return owner;
        lembrarAppAtual(userId, system); // vira o app corrente da sequência
        if (owner.app) {
          return { ok: false, error: `O sistema "${system}" já está publicado. Esta tool é só pra COMEÇAR app novo; num app existente o rascunho já parte do código atual — use ler_arquivo_do_app + editar_arquivo_do_app/escrever_arquivo_do_app.` };
        }
        const existing = await getAppDraft(owner.ownerUserId, system);
        const jaTem = Object.keys(existing);
        if (!jaTem.length) {
          const quota = await appQuotaBlock(owner.ownerUserId, system, { appClient });
          if (quota) return quota;
        }
        if (jaTem.length) {
          return { ok: false, error: `Já existe rascunho de "${system}" com ${jaTem.length} arquivo(s) — não vou sobrescrever. Continue com escrever_arquivo_do_app/editar_arquivo_do_app, ou use outro nome se quiser recomeçar do esqueleto.`, arquivos_no_rascunho: jaTem };
        }
        const files = scaffoldNodeApp(system, String(titulo || '').trim() || system);
        for (const [rel, txt] of Object.entries(files)) {
          await putAppDraftFile(owner.ownerUserId, system, rel, Buffer.from(txt, 'utf8').toString('base64'));
        }
        return {
          ok: true,
          sistema: system, alvo_validacao: `${owner.ownerUserId}:${system}`,
          arquivos_criados: Object.keys(files),
          obs: 'Esqueleto modular criado no rascunho (NADA publicado ainda). O app já nasce funcional: GET api/status + página inicial. Agora: 1) troque o schema de exemplo em lib/db.js pelo seu; 2) cada ÁREA do backend = um arquivo novo em lib/routes/ (mesmo formato do exemplo.js) + require no array rotas do server.js; 3) cada área do frontend = um public/<area>.js + <script> no index.html DEPOIS do core.js; 4) NUNCA concentre tudo num arquivo só; 5) quando quiser subir, publicar_sistema (runtime node), sem o parâmetro arquivos — o rascunho inteiro vai junto.',
        };
      },
    },
    {
      name: 'escrever_arquivo_do_app',
      description:
        'Creates or updates ONE file in an app draft, WITHOUT publishing. It is the way to create a NEW file or rewrite a file entirely. For a targeted CHANGE in a file that already exists, use editar_arquivo_do_app (swaps only the snippet, cheaper and with no risk of cutting a large file in the middle). '
        + 'Build the app file by file (server.js, public/index.html, public/app.js, public/style.css, ...) and then call publicar_sistema to push everything. The draft STAYS SAVED on the server across turns, so you do NOT need to resend all the code in one go. When editing an ALREADY PUBLISHED app, the draft starts with its current code. You NEVER need SSH or server access to edit an app. '
        + 'Same rules as publicar_sistema: frontend in its own files inside public/ (NEVER HTML/JS inside a server template string), relative paths (style.css, app.js, api/...), runtime data only in /app/data (it does not go in the code), and no secrets in the source (use definir_segredo). Writing to the draft does NOT change the live app; only publicar_sistema publishes.',
      parameters: {
        type: 'object',
        properties: {
          nome_do_sistema: { type: 'string', description: 'OPTIONAL if you are already working on an app in this conversation: when empty, uses the app you worked on last (or the user\'s only draft/app). Pass the slug when it is another app or when in doubt.' },
          caminho: { type: 'string', description: 'relative file path, e.g.: server.js, public/index.html, public/app.js.' },
          conteudo: { type: 'string', description: 'file content (text).' },
          hash_esperado: { type: 'string', description: 'OPTIONAL but RECOMMENDED when REWRITING a file that already exists: the "hash" that came in your last read of it (ler_arquivo_do_app/listar_arquivos_do_app). If the file changed since then, the write FAILS instead of overwriting — reread and redo. Leave empty for a new file.' },
          confirmo_arquivo_grande: { type: 'string', description: 'OPTIONAL. Only use it if the write was BLOCKED because the file is too large (≥800 lines) AND splitting really makes no sense (e.g.: vendored third-party library). Write the justification. The normal path is to SPLIT into smaller modules.' },
          dono: { type: 'string', description: 'OPTIONAL. Only for COLLABORATION: name/e-mail of the connected contact who owns a system shared with you.' },
        },
        required: ['caminho', 'conteudo'],
      },
      async run({ nome_do_sistema, caminho, conteudo, hash_esperado, confirmo_arquivo_grande, dono }) {
        const rel = String(caminho || '').replace(/^\/+/, '').trim();
        if (!rel) return rejectedEdit('Informe o caminho do arquivo (ex: server.js, public/index.html).');
        const alvo = await alvoRascunho(nome_do_sistema, dono);
        if (alvo.error) return rejectedEdit(alvo.error);
        const system = alvo.system;
        const owner = alvo.owner;
        const buf = Buffer.from(String(conteudo ?? ''), 'utf8');
        if (buf.length > MAX_FILE_BYTES) return rejectedEdit(`Arquivo ${rel} passou de 512 KB.`);
        // Guarda de tamanho (lição do incidente KhaosClass): arquivo de código
        // gigante vira reescrita integral a cada mudança → contexto estoura no meio,
        // versões pela metade, loop de conserta-quebra. Métrica = LINHAS (vendor
        // minificado é 1 linha e passa). Bloqueia ≥800; a partir de 400 só avisa.
        let avisoTamanho;
        if (/\.(js|mjs|cjs|py|html|htm)$/i.test(rel)) {
          const linhas = countLines(String(conteudo ?? ''));
          if (linhas >= 800 && !String(confirmo_arquivo_grande || '').trim()) {
            return rejectedEdit(
              `Escrita bloqueada: "${rel}" ficaria com ${linhas} linhas. Arquivo desse tamanho quebra a manutenção (cada mudança vira reescrita integral e pode ser cortada no meio).`, {
              reentrar: true,
              agente: 'DIVIDA o código em módulos menores em vez de crescer este arquivo: no servidor, uma área por arquivo em lib/routes/ (cada um exporta handle(ctx) e o server.js só faz o loop de rotas); no cliente, um .js por área carregado pelo index.html em ordem fixa. Mova as funções pro módulo novo com escrever_arquivo_do_app e deixe aqui só o que é deste arquivo. SÓ SE dividir não fizer sentido (ex: biblioteca de terceiros vendorizada), repita a chamada passando confirmo_arquivo_grande com a justificativa.',
              linhas,
            });
          }
          if (linhas >= 400) {
            avisoTamanho = `"${rel}" está com ${linhas} linhas. Acima de 800 a escrita passa a ser bloqueada — se for crescer mais, já divida em módulos (lib/routes/ no servidor, um .js por área no cliente).`;
          }
        }
        // Edição incremental: se ainda não há rascunho e o app já foi publicado,
        // semeia o rascunho com o último código publicado (snapshot) antes de aplicar.
        const quota = await newDraftQuotaBlock(owner.ownerUserId, system, owner.app, { appClient });
        if (quota) return rejectedEdit(quota.error, { agente: quota.agente, plano: quota.plano, teto: quota.teto, atuais: quota.atuais });
        const draft = await ensureDraftSeeded(owner.ownerUserId, system, owner.app);
        // Concorrência otimista: se o agente diz qual versão ele LEU, a escrita só
        // vale se o arquivo ainda for aquela versão. Evita gravar por cima de
        // mudança que o agente não viu (contexto stale de turno truncado).
        const esperado = String(hash_esperado || '').trim();
        if (esperado) {
          const atualB64 = draft[rel];
          if (atualB64 == null) {
            return rejectedEdit(`Você passou hash_esperado, mas "${rel}" não existe no app "${system}". Se é um arquivo NOVO, chame de novo sem hash_esperado; se você achava que ele existia, liste com listar_arquivos_do_app antes.`,
              { arquivos_disponiveis: Object.keys(draft) });
          }
          const hashAtual = fileHash(atualB64);
          if (hashAtual !== esperado) {
            return rejectedEdit(`O arquivo "${rel}" MUDOU desde a sua última leitura (hash atual ${hashAtual}, você esperava ${esperado}). NÃO gravei por cima. Releia com ler_arquivo_do_app e refaça a mudança em cima do conteúdo atual (de preferência com editar_arquivo_do_app).`,
              { hash_atual: hashAtual });
          }
        }
        await putAppDraftFile(owner.ownerUserId, system, rel, buf.toString('base64'));
        const files = await getAppDraft(owner.ownerUserId, system);
        return { ok: true, sistema:system, alvo_validacao:`${owner.ownerUserId}:${system}`, arquivo: rel, bytes: buf.length, hash: fileHash(buf.toString('base64')),
          arquivos_no_rascunho: Object.keys(files),
          ...(avisoTamanho ? { aviso_tamanho: avisoTamanho } : {}),
          obs: `Salvo no rascunho de "${system}". Quando terminar de escrever os arquivos, chame publicar_sistema pra subir.${owner.shared ? ` (app compartilhado do ${owner.ownerName})` : ''}` };
      },
    },
    {
      name: 'editar_arquivo_do_app',
      description:
        'EDITS a file in an app draft by swapping SNIPPETS for others (patch), WITHOUT rewriting the whole file. '
        + 'It is the PREFERRED way to change an app that already exists: instead of resending the whole file (expensive and, for a large file, it may get cut in the middle and stall), you swap only the piece that changes. '
        + 'Flow: read with ler_arquivo_do_app, copy into "trecho_antigo" the EXACT text that will change (with enough context to be unique in the file), put the new version in "trecho_novo", and publish with publicar_sistema. '
        + 'Copy trecho_antigo from the file: the host resolves small whitespace or line-break differences on its own, but the snippet must be unambiguous (a single place in the file). If it is ambiguous, or if the swap leaves the file with a syntax error, nothing is saved and the tool says what to fix. '
        + 'For SEVERAL changes in the SAME file at once, pass "edicoes": a list of {trecho_antigo, trecho_novo} applied in order, all-or-nothing (if any one fails, none is saved). It is cheaper than one edit per call. '
        + 'Use escrever_arquivo_do_app only for a NEW file or a complete rewrite. Editing the draft does NOT change the live app; only publicar_sistema publishes.',
      parameters: {
        type: 'object',
        properties: {
          nome_do_sistema: { type: 'string', description: 'OPTIONAL if you are already working on an app in this conversation: when empty, uses the app you worked on last (or the user\'s only draft/app). Pass the slug when it is another app or when in doubt.' },
          caminho: { type: 'string', description: 'relative path of the file to edit, e.g.: server.js, public/app.js, public/index.html.' },
          trecho_antigo: { type: 'string', description: 'SINGLE edit: the EXACT text already in the file that will be replaced (copy it from ler_arquivo_do_app, with enough context to be unique). Ignore if using "edicoes".' },
          trecho_novo: { type: 'string', description: 'SINGLE edit: the text that goes in place of trecho_antigo. Ignore if using "edicoes".' },
          edicoes: {
            type: 'array',
            description: 'SEVERAL edits in the same file, applied IN ORDER and atomically (all-or-nothing). Use instead of trecho_antigo/trecho_novo when there is more than one change.',
            items: {
              type: 'object',
              properties: {
                trecho_antigo: { type: 'string', description: 'EXACT text already in the file (unique).' },
                trecho_novo: { type: 'string', description: 'text that goes in its place.' },
              },
              required: ['trecho_antigo', 'trecho_novo'],
            },
          },
          dono: { type: 'string', description: 'OPTIONAL. Only for COLLABORATION: name/e-mail of the connected contact who owns a system shared with you.' },
        },
        required: ['caminho'],
      },
      async run({ nome_do_sistema, caminho, trecho_antigo, trecho_novo, edicoes, dono }) {
        const rel = String(caminho || '').replace(/^\/+/, '').trim();
        if (!rel) return rejectedEdit('Informe o caminho do arquivo (ex: server.js, public/app.js).');
        // Normaliza pra lista de edições: usa "edicoes" se veio, senão o par único.
        let lista;
        if (Array.isArray(edicoes) && edicoes.length) {
          lista = edicoes;
        } else {
          if (typeof trecho_antigo !== 'string' || trecho_antigo === '') return rejectedEdit('Informe trecho_antigo (o texto exato que vai ser trocado) ou uma lista "edicoes".');
          if (typeof trecho_novo !== 'string') return rejectedEdit('Informe trecho_novo (o texto que entra no lugar).');
          lista = [{ trecho_antigo, trecho_novo }];
        }
        // Valida a forma de cada edição antes de mexer em qualquer coisa.
        for (let i = 0; i < lista.length; i++) {
          const e = lista[i] || {};
          if (typeof e.trecho_antigo !== 'string' || e.trecho_antigo === '') return rejectedEdit(`Edição ${i + 1}: trecho_antigo vazio.`);
          if (typeof e.trecho_novo !== 'string') return rejectedEdit(`Edição ${i + 1}: trecho_novo ausente.`);
        }
        const alvo = await alvoRascunho(nome_do_sistema, dono);
        if (alvo.error) return rejectedEdit(alvo.error);
        const system = alvo.system;
        const owner = alvo.owner;
        // Semeia o rascunho com o código publicado, se preciso, e lê o arquivo atual.
        const files = await ensureDraftSeeded(owner.ownerUserId, system, owner.app);
        const b64 = files[rel];
        if (b64 == null) {
          return rejectedEdit(`Não achei "${rel}" no app "${system}". Liste com listar_arquivos_do_app.`,
            { arquivos_disponiveis: Object.keys(files) });
        }
        // Aplica as edições EM MEMÓRIA, em ordem, cada uma exigindo match único no
        // estado corrente (após as anteriores). Atômico: se qualquer uma falhar,
        // nada é gravado. Substituição por índice (não usa String.replace pra não
        // interpretar $ no trecho_novo).
        const fonteAntes = Buffer.from(b64, 'base64').toString('utf8');
        let atual = fonteAntes;
        const aproximadas = [];
        for (let i = 0; i < lista.length; i++) {
          const { trecho_antigo: ta, trecho_novo: tn } = lista[i];
          let count = 0, firstIdx = -1, idx = atual.indexOf(ta);
          while (idx !== -1) { if (firstIdx === -1) firstIdx = idx; count++; idx = atual.indexOf(ta, idx + ta.length); }
          const rot = lista.length > 1 ? `Edição ${i + 1}: ` : '';
          if (count === 0) {
            // Sem casamento byte a byte, o host tenta ANCORAR por similaridade
            // (≥90%, com folga sobre o 2º lugar e corpo mínimo — ver app-anchor.mjs).
            // Medido em produção: 12 de 12 recusas reais eram diferença de um
            // espaço/quebra de linha, e nenhum trecho de outro arquivo ancorou.
            const ancora = resolverAncora(atual, ta);
            if (!ancora.ok) {
              return rejectedEdit(`${rot}trecho_antigo não encontrado. Leia o arquivo com ler_arquivo_do_app e copie o texto EXATO (mesmos espaços e quebras de linha). Nada foi gravado.`,
                ancora.melhor_similaridade != null ? { melhor_similaridade: ancora.melhor_similaridade, motivo_ancora: ancora.motivo } : { motivo_ancora: ancora.motivo });
            }
            atual = atual.slice(0, ancora.inicio) + tn + atual.slice(ancora.fim);
            aproximadas.push({ edicao: i + 1, similaridade: ancora.similaridade });
            continue;
          }
          if (count > 1) {
            return rejectedEdit(`${rot}trecho_antigo é ambíguo: aparece ${count} vezes. Inclua mais linhas ao redor pra ficar único. Nada foi gravado.`);
          }
          atual = atual.slice(0, firstIdx) + tn + atual.slice(firstIdx + ta.length);
        }
        const buf = Buffer.from(atual, 'utf8');
        if (buf.length > MAX_FILE_BYTES) return rejectedEdit(`Arquivo ${rel} passaria de 512 KB. Nada foi gravado.`);
        // Portão de sintaxe: só barra quando a edição QUEBRA um arquivo que estava
        // íntegro (se já estava quebrado, pode ser justamente o conserto).
        const quebra = await pioraSintaxe(rel, fonteAntes, atual);
        if (quebra) {
          return rejectedEdit(`A edição deixaria "${rel}" com erro de sintaxe, então nada foi gravado. O compilador disse:\n${quebra.erro}\nCorrija o trecho_novo e mande de novo.`,
            { erro_de_sintaxe: quebra.erro });
        }
        await putAppDraftFile(owner.ownerUserId, system, rel, buf.toString('base64'));
        // Patch nunca bloqueia por tamanho (é o jeito CERTO de mexer em arquivo
        // grande já existente), mas avisa quando o arquivo está inchado.
        const linhasNovas = /\.(js|mjs|cjs|py|html|htm)$/i.test(rel) ? countLines(atual) : 0;
        return { ok: true, sistema:system, alvo_validacao:`${owner.ownerUserId}:${system}`, arquivo: rel, ocorrencias: lista.length, bytes_novos: buf.length, hash: fileHash(buf.toString('base64')),
          ...(aproximadas.length ? { ancora_aproximada: aproximadas, obs_ancora: 'O texto no arquivo não era idêntico ao trecho_antigo (diferença de espaços/quebras de linha); o host ancorou pela posição de maior semelhança. Confira o resultado com ler_arquivo_do_app se a edição for sensível.' } : {}),
          ...(linhasNovas >= 400 ? { aviso_tamanho: `"${rel}" está com ${linhasNovas} linhas. Se for crescer mais, divida em módulos (lib/routes/ no servidor, um .js por área no cliente) — reescritas de arquivo ≥800 linhas são bloqueadas.` } : {}),
          obs: `${lista.length > 1 ? `${lista.length} trechos trocados` : 'Trecho trocado'} em "${rel}" (rascunho de "${system}"). Quando terminar, chame publicar_sistema pra subir.${owner.shared ? ` (app compartilhado do ${owner.ownerName})` : ''}` };
      },
    },
    {
      name:'buscar_codigo_do_app',
      repeatRevision: args => readRevision(args),
      description:'Searches LITERAL text in the draft files (or snapshot). Returns file, line, hash, revision and snippets; does not execute or modify anything. Prefer searching for functions/IDs and then reading the context, instead of going through large files blindly. Continue with proximo_inicio and revisao_esperada.',
      parameters:{type:'object',properties:{nome_do_sistema:{type:'string'},dono:{type:'string'},texto:{type:'string',maxLength:200},caminho:{type:'string'},inicio:{type:'integer',minimum:0},limite:{type:'integer',minimum:1,maximum:50},revisao_esperada:{type:'string'}},required:['texto']},
      async run(args) {
        const alvo=await alvoLeitura(args.nome_do_sistema,args.dono);
        if(alvo.error)return {ok:false,error:alvo.error};
        const files=await readDraftFiles(alvo.owner.ownerUserId,alvo.system,alvo.owner.app);
        return {...searchAppCode(files,args),alvo_validacao:`${alvo.owner.ownerUserId}:${alvo.system}`};
      },
    },
    {
      name:'validar_rascunho_do_app',
      repeatRevision: args => readRevision(args),
      description:'Validates the static consistency of the current draft (or the published snapshot if there is no draft), without writing, publishing, running the app or making external network calls. Returns the revision and exact diagnostics. Does not prove it works in a browser. Revalidate after editing. If proximo_diagnostico is not null, continue from it using inicio_diagnostico and revisao_esperada.',
      parameters:{ type:'object', properties:{ nome_do_sistema:{type:'string'}, dono:{type:'string'}, inicio_diagnostico:{type:'integer',minimum:0}, revisao_esperada:{type:'string'} }, required:[] },
      async run({ nome_do_sistema, dono, inicio_diagnostico, revisao_esperada }) {
        const alvo = await alvoLeitura(nome_do_sistema, dono);
        if (alvo.error) return { ok:false, error:alvo.error };
        const files = await readDraftFiles(alvo.owner.ownerUserId, alvo.system, alvo.owner.app);
        return { ...validationPage(validateDraft(files), { inicio_diagnostico, revisao_esperada }), nome_do_sistema:alvo.system, alvo_validacao:`${alvo.owner.ownerUserId}:${alvo.system}` };
      },
    },
    {
      name: 'listar_arquivos_do_app',
      repeatRevision: args => readRevision(args),
      description: 'Lists the files of an app, with the size of each one. If the app is ALREADY published, shows the code that is LIVE (no need to rewrite anything to see it). If you already started editing, shows the draft. It is the first step to edit an existing app: list, read with ler_arquivo_do_app what will change, rewrite with escrever_arquivo_do_app and publish. You NEVER need SSH or server access to read or edit an app.',
      parameters: {
        type: 'object',
        properties: {
          nome_do_sistema: { type: 'string', description: 'OPTIONAL if you are already working on an app in this conversation: when empty, uses the app you worked on last (or the user\'s only draft/app).' },
          dono: { type: 'string', description: 'OPTIONAL. Collaboration: owner of the shared system.' },
        },
        required: [],
      },
      async run({ nome_do_sistema, dono }) {
        const alvo = await alvoLeitura(nome_do_sistema, dono);
        if (alvo.error) return { ok: false, error: alvo.error };
        const system = alvo.system;
        const owner = alvo.owner;
        const files = await readDraftFiles(owner.ownerUserId, system, owner.app);
        const lista = Object.entries(files).map(([p, b64]) => ({ caminho: p, bytes: Buffer.from(b64, 'base64').length, hash: fileHash(b64) }));
        return { ok: true, publicado: !!owner.app, arquivos: lista, revisao:draftRevision(files), alvo_validacao:`${owner.ownerUserId}:${system}`,
          obs: lista.length
            ? (owner.app
                ? 'Estes são os arquivos atuais do app. Leia com ler_arquivo_do_app, edite com escrever_arquivo_do_app e chame publicar_sistema pra publicar.'
                : 'Estes arquivos vão no próximo publicar_sistema.')
            : 'App vazio. Use escrever_arquivo_do_app pra montar o app (ou mande os arquivos direto no publicar_sistema).' };
      },
    },
    {
      name: 'ler_arquivo_do_app',
      repeatRevision: args => readRevision(args, true),
      description: 'Reads a limited PAGE of ONE app file. For large files, advance with proximo_inicio and hash_esperado until null; never rewrite the whole file with only one page. If the app is already published, returns the code that is live (even if you have not started editing yet). Use this to see the current code BEFORE changing it: list with listar_arquivos_do_app, read here the file that will change, edit with escrever_arquivo_do_app and publish. SSH or server access is never needed to read the code of an app.',
      parameters: {
        type: 'object',
        properties: {
          nome_do_sistema: { type: 'string', description: 'OPTIONAL if you are already working on an app in this conversation: when empty, uses the app you worked on last (or the user\'s only draft/app).' },
          inicio: { type:'integer', minimum:0, description:'UTF-16 offset. Use proximo_inicio from the previous page; default 0.' },
          limite: { type:'integer', minimum:1, maximum:6000, description:'Maximum characters per page, default 6000.' },
          hash_esperado: { type:'string', description:'Required to continue (inicio > 0). Hash of the whole file received on the first page.' },
          caminho: { type: 'string', description: 'relative file path, e.g.: server.js, public/index.html, public/app.js.' },
          dono: { type: 'string', description: 'OPTIONAL. Collaboration: owner of the shared system.' },
        },
        required: ['caminho'],
      },
      async run({ nome_do_sistema, caminho, dono, inicio, limite, hash_esperado }) {
        const rel = String(caminho || '').replace(/^\/+/, '').trim();
        if (!rel) return { ok: false, error: 'Informe o caminho do arquivo (ex: server.js, public/index.html).' };
        const alvo = await alvoLeitura(nome_do_sistema, dono);
        if (alvo.error) return { ok: false, error: alvo.error };
        const system = alvo.system;
        const owner = alvo.owner;
        const files = await readDraftFiles(owner.ownerUserId, system, owner.app);
        const b64 = files[rel];
        if (b64 == null) {
          return { ok: false, error: `Não achei "${rel}" no app "${system}".`,
            arquivos_disponiveis: Object.keys(files) };
        }
        const buf = Buffer.from(b64, 'base64');
        return { ...filePage({ content:buf.toString('utf8'), hash:fileHash(b64), arquivo:rel,
          bytes:buf.length, inicio, limite, hash_esperado }), revisao:draftRevision(files), alvo_validacao:`${owner.ownerUserId}:${system}`, publicado:!!owner.app };
      },
    },
    {
      name: 'remover_arquivo_do_app',
      description: 'Removes ONE file from an app draft (before publishing). Does not touch the live app.',
      parameters: {
        type: 'object',
        properties: {
          nome_do_sistema: { type: 'string', description: 'system slug.' },
          caminho: { type: 'string', description: 'relative path of the file to remove from the draft.' },
          dono: { type: 'string', description: 'OPTIONAL. Collaboration: owner of the shared system.' },
        },
        required: ['nome_do_sistema', 'caminho'],
      },
      async run({ nome_do_sistema, caminho, dono }) {
        const system = (nome_do_sistema || '').toLowerCase();
        if (!sysOk(system)) return { ok: false, error: 'Nome do sistema inválido.' };
        const rel = String(caminho || '').replace(/^\/+/, '').trim();
        if (!rel) return { ok: false, error: 'Informe o caminho do arquivo.' };
        const owner = await rOwner(system, dono);
        if (owner.error) return { ok: false, error: owner.error };
        const n = await deleteAppDraftFile(owner.ownerUserId, system, rel);
        const files = await getAppDraft(owner.ownerUserId, system);
        return { ok: true, removido: n > 0, arquivos_no_rascunho: Object.keys(files) };
      },
    },
    {
      name: 'definir_segredo',
      description:
        'Stores a SECRET of a system (API key, password, token, connection string) in an ENCRYPTED VAULT, to be injected into the app as an environment variable. '
        + 'GOLDEN RULE: a secret never goes in the code. In the app code use process.env.NOME (Node) or os.environ["NOME"] (Flask); here you set the real value. '
        + 'The key (name) must be UPPERCASE/digits/_ (e.g.: OPENAI_API_KEY, DB_PASSWORD). You can set it BEFORE publishing (kept for the next publish) or AFTER (applied immediately, the app restarts with the new value). '
        + 'The value stays encrypted, NEVER appears in the source and does NOT travel when the app is replicated by another user.',
      parameters: {
        type: 'object',
        properties: {
          nome_do_sistema: { type: 'string', description: 'system slug (e.g.: "contas").' },
          chave: { type: 'string', description: 'environment variable name (UPPERCASE, digits, _). E.g.: OPENAI_API_KEY.' },
          valor: { type: 'string', description: 'the secret value.' },
        },
        required: ['nome_do_sistema', 'chave', 'valor'],
      },
      async run({ nome_do_sistema, chave, valor }) {
        const system = (nome_do_sistema || '').toLowerCase();
        if (!sysOk(system)) return { ok: false, error: 'Nome do sistema inválido.' };
        const r = await setAppSecret(userId, system, chave, valor);
        if (r.error === 'chave_invalida') return { ok: false, error: 'Chave inválida: use MAIÚSCULAS, dígitos e _ (ex: OPENAI_API_KEY).' };
        if (r.error === 'valor_grande') return { ok: false, error: 'Valor muito grande (máx 8 KB).' };
        if (r.error === 'cofre_indisponivel') return { ok: false, error: 'O cofre não está configurado no servidor. Avise o suporte.' };
        if (!r.ok) return { ok: false, error: 'Falha ao guardar o segredo.' };
        // Se o app já existe, aplica agora (recria o container com o novo env).
        const app = await getAppRow(userId, system);
        if (app) {
          const env = await getAppSecretsDecrypted(userId, system);
          const res = await ctl({ verb: 'reload', label: app.label, system, env }, { timeoutMs: 120_000 });
          if (res.error === 'app_crashed') {
            return { ok: true, guardado: true, aplicado: false,
              aviso: 'Segredo guardado, mas o app crashou ao reiniciar com ele. Veja ver_logs_sistema e corrija.', log_do_crash: res.logs || null };
          }
          return { ok: true, guardado: true, aplicado: !!res.ok, chave };
        }
        return { ok: true, guardado: true, aplicado: false, chave, obs: 'Guardado no cofre; será aplicado quando você publicar o sistema.' };
      },
    },
    {
      name: 'listar_segredos',
      description: 'Lists the NAMES of the environment variables (secrets) set for a system. Does NOT show the values (they stay encrypted in the vault).',
      parameters: {
        type: 'object',
        properties: { nome_do_sistema: { type: 'string' } },
        required: ['nome_do_sistema'],
      },
      async run({ nome_do_sistema }) {
        const system = (nome_do_sistema || '').toLowerCase();
        const rows = await listAppSecrets(userId, system);
        if (!rows.length) return `Nenhum segredo definido para "${system}".`;
        return `Segredos de "${system}" (só os nomes):\n` + rows.map((r) => `• ${r.key}`).join('\n');
      },
    },
    {
      name: 'remover_segredo',
      description: 'Removes a secret (environment variable) from a system. If the system is published, the app restarts without that variable.',
      parameters: {
        type: 'object',
        properties: {
          nome_do_sistema: { type: 'string' },
          chave: { type: 'string', description: 'name of the variable to remove.' },
        },
        required: ['nome_do_sistema', 'chave'],
      },
      async run({ nome_do_sistema, chave }) {
        const system = (nome_do_sistema || '').toLowerCase();
        const n = await deleteAppSecret(userId, system, chave);
        if (!n) return `Não achei o segredo "${chave}" em "${system}".`;
        const app = await getAppRow(userId, system);
        if (app) {
          const env = await getAppSecretsDecrypted(userId, system);
          await ctl({ verb: 'reload', label: app.label, system, env }, { timeoutMs: 120_000 });
        }
        return `Segredo "${chave}" removido de "${system}".`;
      },
    },
    {
      name: 'definir_visibilidade_sistema',
      description:
        `Controls whether a published system appears in the PUBLIC app LIBRARY of ${marca().nome} (${linkDaPagina('apps') ?? 'achada com buscar_apps_publicos'}), where any person/agent can COPY the app into their own space. `
        + '"publico" = listed in the library and copyable; "privado" (default) = out of the library, nobody copies it. '
        + 'ATTENTION, this is about COPYING the code, NOT about access to the URL: who can open the app is controlled separately by the definir_acesso_sistema tool (every app is born private, with username and password). Marking it as public in the library does NOT unlock the URL, and unlocking the URL does not put the app in the library. '
        + 'In a copy ONLY the code travels: NO secrets (they stay in the vault) and NO runtime data (it stays in /app/data) go along. '
        + 'Give it a good description when listing it in the library (it helps others find it). To be copyable the app must have been published (it has a code snapshot); republish it if it is old.',
      parameters: {
        type: 'object',
        properties: {
          nome_do_sistema: { type: 'string', description: 'system slug (e.g.: "contas").' },
          visibilidade: { type: 'string', enum: ['publico', 'privado'], description: 'publico or privado.' },
          descricao: { type: 'string', description: 'OPTIONAL. Short description of what the app does (recommended when making it public).' },
        },
        required: ['nome_do_sistema', 'visibilidade'],
      },
      async run({ nome_do_sistema, visibilidade, descricao }) {
        const system = (nome_do_sistema || '').toLowerCase();
        if (!sysOk(system)) return { ok: false, error: 'Nome do sistema inválido.' };
        const app = await getAppRow(userId, system);
        if (!app) return { ok: false, error: `Não achei o sistema "${system}". Use listar_sistemas.` };
        const vis = visibilidade === 'publico' ? 'public' : 'private';
        const n = await setAppVisibility(userId, system, vis, descricao);
        if (!n) return { ok: false, error: 'Falha ao atualizar a visibilidade.' };
        if (vis === 'public') {
          const snap = await getAppSnapshot(userId, system);
          const replicavel = !!(snap && snap.source_snapshot);
          // Anonimização única no publish-para-biblioteca: limpa conteúdo do dono
          // do snapshot copiável (nome/cidade/dados reais → genéricos/exemplo).
          // Best-effort: falha aqui não bloqueia a publicação.
          let anonimizado = false;
          if (replicavel) {
            try {
              const res = await anonymizeSnapshotBlob(snap.source_snapshot);
              if (res.changed) { await setAppSnapshot(userId, system, res.blob); anonimizado = true; }
            } catch { /* mantém snapshot original */ }
          }
          return {
            ok: true, visibilidade: 'público', replicavel, anonimizado,
            obs: replicavel ? `Agora aparece na biblioteca pública (${[linkDaPagina('apps'), 'buscar_apps_publicos'].filter(Boolean).join(' e ')}) e pode ser copiado.${anonimizado ? ' O código copiável foi anonimizado (conteúdo do dono virou exemplo genérico).' : ''} Lembre: quem CONSEGUE ABRIR o app não mudou — se ele nasceu privado, segue pedindo usuário e senha (isso se muda em definir_acesso_sistema).`
              : 'Marcado como público, mas ainda NÃO é copiável (sem snapshot de código). Republique o sistema pra gerar o snapshot.',
          };
        }
        return { ok: true, visibilidade: 'privado' };
      },
    },
    {
      name: 'definir_acesso_sistema',
      description:
        'Controls WHO CAN OPEN the URL of a published app. Every app is born PRIVATE: the browser asks for username and password (platform gate, checked before the app even wakes up). '
        + 'WITHOUT the "acesso" parameter, this tool only QUERIES: returns whether the app is public or private and, if private, the current username and password (so you can remind the owner). '
        + 'With acesso:"privado" it locks the app (generates a new password if it had none) and with nova_senha:true it changes the password. '
        + 'With acesso:"publico" it UNLOCKS — anyone with the link can open it. ASK AND CONFIRM with the user first, and only then pass confirmo_publico:true; if the app stores other people\'s data (sign-ups, orders, messages), tell them that first. '
        + 'This is DIFFERENT from definir_visibilidade_sistema, which is about listing the CODE in the library for others to copy.',
      parameters: {
        type: 'object',
        properties: {
          nome_do_sistema: { type: 'string', description: 'system slug (e.g.: "contas").' },
          acesso: { type: 'string', enum: ['publico', 'privado'], description: 'OPTIONAL. Omit it to only query the current state. "publico" opens the URL to anyone (requires confirmo_publico). "privado" locks it with username and password.' },
          confirmo_publico: { type: 'boolean', description: 'Required together with acesso:"publico". Only pass true AFTER the user confirms they want the app open to anyone with the link.' },
          nova_senha: { type: 'boolean', description: 'OPTIONAL, only with acesso:"privado". true = generates a new password (invalidates the old one).' },
        },
        required: ['nome_do_sistema'],
      },
      async run({ nome_do_sistema, acesso, confirmo_publico, nova_senha }) {
        const system = (nome_do_sistema || '').toLowerCase();
        if (!sysOk(system)) return { ok: false, error: 'Nome do sistema inválido.' };
        const app = await getAppRow(userId, system);
        if (!app) return { ok: false, error: `Não achei o sistema "${system}". Use listar_sistemas.` };
        const atual = await getAppAccess(userId, system).catch(() => null);
        const privadoAgora = !!(atual && atual.access === 'private');

        // Consulta pura.
        if (!acesso) {
          if (!privadoAgora) {
            return { ok: true, acesso: 'público',
              obs: atual?.access === 'public'
                ? 'Qualquer pessoa com o link abre este app.'
                : 'Este app foi publicado antes do portão de senha existir, então a URL está aberta a quem tem o link. Se o dono quiser proteger, chame de novo com acesso:"privado".' };
          }
          return { ok: true, acesso: 'privado',
            credenciais: { usuario: atual.user, senha: atual.pass },
            obs: 'O navegador pede esse usuário e essa senha pra abrir o app.' };
        }

        if (acesso === 'publico') {
          if (!confirmo_publico) {
            return { ok: false, precisa_confirmar: true,
              error: 'Pra deixar o app aberto a qualquer pessoa com o link, confirme com o usuário e chame de novo com confirmo_publico:true.',
              agente: 'PERGUNTE ao usuário se ele realmente quer que qualquer pessoa com o link consiga abrir o app. Se o app guarda dados de outras pessoas, avise que ficariam acessíveis. Só depois do sim, repita a chamada com confirmo_publico:true.' };
          }
          const res = await ctl({ verb: 'set_auth', label: app.label, system, auth: { mode: 'none' } });
          if (!res.ok) return { ok: false, error: `Falha ao liberar o acesso: ${res.error || 'erro no host'}` };
          await setAppAccess(userId, system, { access: 'public', user: null, pass: null });
          return { ok: true, acesso: 'público',
            obs: 'A URL está aberta: qualquer pessoa com o link abre o app, sem senha. Pra trancar de novo, chame com acesso:"privado".' };
        }

        // acesso === 'privado'
        const creds = (privadoAgora && !nova_senha && atual.user && atual.pass)
          ? { user: atual.user, pass: atual.pass }
          : { ...genAccessCreds(system), ...(privadoAgora && atual.user ? { user: atual.user } : {}) };
        const res = await ctl({ verb: 'set_auth', label: app.label, system, auth: { user: creds.user, password: creds.pass } });
        if (!res.ok) return { ok: false, error: `Falha ao trancar o acesso: ${res.error || 'erro no host'}` };
        await setAppAccess(userId, system, { access: 'private', user: creds.user, pass: creds.pass });
        return { ok: true, acesso: 'privado',
          credenciais: { usuario: creds.user, senha: creds.pass },
          obs: `A URL agora pede usuário e senha. ENTREGUE as duas ao usuário na sua resposta.${nova_senha ? ' A senha anterior deixou de valer.' : ''}` };
      },
    },
    {
      name: 'buscar_apps_publicos',
      description:
        `Finds PUBLIC apps published by any ${marca().nome} user, which you can REPLICATE on your user's subdomain. `
        + 'Returns name, description, runtime, the "origem" (to pass to replicar_sistema) and the public URL. Use a keyword search to filter.',
      parameters: {
        type: 'object',
        properties: {
          busca: { type: 'string', description: 'OPTIONAL. Keyword (matches name, description or the owner\'s subdomain).' },
        },
      },
      async run({ busca }) {
        let rows = await listPublicApps({ q: busca, limit: 30 });
        // A busca é por substring (LIKE), não semântica. Se um termo específico não
        // casar, cai pra lista completa pra você julgar quais servem pelo sentido —
        // ex: "acervo de produtos" não bate em "catálogo de peças" no LIKE, mas você
        // consegue reconhecer que servem lendo as descrições.
        let fallback = false;
        if (busca && String(busca).trim() && !rows.length) {
          rows = await listPublicApps({ limit: 30 });
          fallback = true;
        }
        if (!rows.length) return 'Nenhum app público disponível ainda.';
        const lines = rows.map((r) => {
          const desc = r.description ? ` — ${r.description}` : '';
          return `• ${r.system} (${r.runtime})${desc}\n   origem: ${r.label}/${r.system} · ${r.url || urlDoApp(r.label, r.system)}`;
        });
        const head = fallback
          ? `Nenhum app casou exatamente com "${busca}", mas a busca é literal (não semântica). Estes são TODOS os apps públicos; veja pela descrição se algum atende ao que a pessoa quer antes de dizer que não existe:`
          : 'Apps públicos (replicáveis com replicar_sistema, passando a "origem"):';
        return head + '\n' + lines.join('\n');
      },
    },
    {
      name: 'replicar_sistema',
      description:
        'Replicates a PUBLIC app (from any user) on YOUR user\'s subdomain: copies ONLY the app code and publishes it as a system of yours. '
        + 'NO secrets and NO data from the original owner come along (secrets stay in their vault, runtime data stays in their /app/data). '
        + 'After replicating, if the app needs keys/passwords, set YOUR OWN with definir_segredo. '
        + 'The "origem" comes from buscar_apps_publicos (format "dono/nome" or the public URL). CONFIRMED ACTION before executing.',
      parameters: {
        type: 'object',
        properties: {
          origem: { type: 'string', description: `source app: "dono/nome_do_sistema" or the public URL (https://dono.${dominioDosApps()}/nome/).` },
          novo_nome: { type: 'string', description: 'OPTIONAL. Name of the system on your subdomain (default: the same name as the source).' },
        },
        required: ['origem'],
      },
      async run({ origem, novo_nome }) {
        const r = await replicateApp({ userId, agentId, origem, novo_nome, appClient });
        if (!r.ok) return r;
        if (emitAppCard) emitAppCard({ name: r.sistema || novo_nome || 'app', url: r.url, description: 'App replicado no seu subdomínio.' });
        return { ok: true, url: r.url, replicado_de: r.replicado_de,
          cartao_mostrado: emitAppCard ? 'Já mostrei o app como um card com botão "Abrir app"; NÃO repita a URL crua no texto.' : undefined,
          credenciais: r.credenciais
            ? { ...r.credenciais, obs: 'A sua cópia nasceu PRIVADA (pede usuário e senha no navegador). ENTREGUE as duas ao usuário. Pra deixar aberta, use definir_acesso_sistema.' }
            : undefined,
          obs: 'Só o código veio. Defina seus próprios segredos com definir_segredo se o app precisar.' };
      },
    },
    {
      name: 'listar_sistemas',
      description: 'Lists the systems (apps) the user has published on their subdomain, with status (on/sleeping) and whether the URL is public or private (asks for username and password). '
        + 'ATTENTION: by default this tool DRAWS each app as a card with an "Abrir app" button on the user\'s screen. '
        + 'If you are calling it only for YOURSELF to check something (find the exact slug before a chamar_sistema, check whether an app exists, decide where to store some data), pass intencao:"consulta" — the list comes the same in the text, but without painting their apps in the conversation without them having asked.',
      parameters: {
        type: 'object',
        properties: {
          intencao: {
            type: 'string',
            enum: ['mostrar', 'consulta'],
            description: '"mostrar" (default) when the user asked to see/open their apps: draws the cards. "consulta" when the call is an internal step of yours: draws nothing.',
          },
        },
      },
      async run({ intencao = 'mostrar' } = {}) {
        // The card is UI: only when the user asked to see the apps. A probing call
        // (find a slug, decide where to store data) must not paint their screen;
        // that's what happened in the "grocery list" case (03/09/2026).
        const emitAppCard = intencao === 'consulta' ? null : emitAppCardRaw;
        const { label } = await resolveLabel(userId);
        const rows = await listAppsForUser(userId);
        const shared = await listSharedAppsForCollaborator(userId);
        if (!rows.length && !shared.length) return 'Nenhum sistema publicado ainda.';
        const live = await ctl({ verb: 'list', label });
        const st = {};
        if (live.ok) for (const a of live.apps) st[a.key] = a.status;
        let out = '';
        let cardCount = 0;
        const MAX_CARDS = 12;
        if (rows.length) {
          const lines = rows.map((r) => {
            const s = st[`${label}/${r.system}`];
            const estado = s === 'running' ? 'ligado' : s === 'exited' || s === 'created' ? 'dormindo' : (s || r.status);
            const appUrl = urlDoApp(label, r.system);
            // `access` NULL = app publicado antes do portão existir: URL aberta.
            const acesso = r.access === 'private' ? `privado, login "${r.access_user || '?'}"` : 'público';
            if (emitAppCard && cardCount < MAX_CARDS) { emitAppCard({ name: r.system, url: appUrl, description: `${r.runtime}, ${estado}, ${acesso}` }); cardCount++; }
            return `• ${r.system} (${r.runtime}, ${estado}, ${acesso}) → ${appUrl}`;
          });
          out += 'Sistemas publicados:\n' + lines.join('\n');
          const q = (live.ok && live.quotas) ? live.quotas[label] : null;
          if (q) out += `\n\nDisco: ${q.used_mb} MB de ${q.hard_mb} MB usados.`;
        }
        if (shared.length) {
          const lines = shared.map((s) => {
            const appUrl = s.url || urlDoApp(s.label, s.system);
            if (emitAppCard && cardCount < MAX_CARDS) { emitAppCard({ name: s.system, url: appUrl, description: `${s.runtime}, de ${s.ownerName}` }); cardCount++; }
            return `• ${s.system} (${s.runtime}, de ${s.ownerName}) → ${appUrl}`;
          });
          out += (out ? '\n\n' : '') + 'Compartilhados com você (colaboração Modo B; passe "dono" nas tools de sistema):\n' + lines.join('\n');
        }
        if (emitAppCard && cardCount > 0) out += '\n\n(Já mostrei cada app como um card com botão "Abrir app"; NÃO repita as URLs cruas no texto, só comente a lista com naturalidade.)';
        return out;
      },
    },
    {
      name: 'chamar_sistema',
      description:
        'Makes an HTTP request to the API of a system that YOU published (the app runs on the user\'s subdomain). '
        + 'This is how you READ and WRITE the data of a system of yours: create/edit/delete records, query what is there, check totals. '
        + 'The `caminho` is relative to the app root (e.g.: "api/contas", "api/status") — no leading slash, no domain. '
        + 'Use GET to read and POST/PUT/PATCH/DELETE to change; send the body as a JSON object. '
        + 'INTERNAL AUTHENTICATION (automatic): for INTERNAL ROUTES of your OWN app (the ones the app protects with the INTERNAL_API_KEY secret, typically under /api/internal/...), the platform already signs the call for you with the x-internal-key header — do NOT try to guess or send the secret value, it is impossible for you to have it and you do not need it. Only use `cabecalhos` for other authentication that you defined yourself. '
        + 'If the app is PRIVATE (platform username/password gate), the call is also already authenticated automatically — do not send Authorization by hand nor worry about a 401 because of the gate. '
        + 'SOURCE OF TRUTH RULE (mandatory): the system/database is the truth, NOT your memory of the conversation. '
        + 'NEVER say that you created, edited, deleted or that it "is already there" without having called this tool and seen the response confirm it. '
        + 'Before stating the state of a system (what is registered, how much is left, whether it was already done), QUERY with a GET and answer from what came back. If the call fails, say you could not confirm — do not make it up.',
      parameters: {
        type: 'object',
        properties: {
          nome_do_sistema: { type: 'string', description: 'slug of the published system (e.g.: "contas").' },
          caminho: { type: 'string', description: 'path relative to the app root (e.g.: "api/contas"). No leading slash nor domain.' },
          metodo: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], description: 'HTTP method (default GET).' },
          corpo: { type: 'object', description: 'OPTIONAL. JSON request body (object) for POST/PUT/PATCH.' },
          cabecalhos: { type: 'object', description: 'OPTIONAL. Extra headers (e.g.: {"Authorization":"Basic ..."}) when the app requires auth.' },
          dono: { type: 'string', description: 'OPTIONAL. Only for COLLABORATION: name/e-mail of the connected contact who owns a system shared with you. Leave empty for your own systems.' },
        },
        required: ['nome_do_sistema', 'caminho'],
      },
      async run({ nome_do_sistema, caminho, metodo, corpo, cabecalhos, dono }) {
        const system = (nome_do_sistema || '').toLowerCase();
        const r = await rApp(system, dono);
        if (r.error) return { ok: false, error: r.error, efeito: { versao: 1, operacao: 'chamada_http', estado: 'nao_aplicado' } };
        const app = r.app;
        // Caminho: relativo à raiz do app, sem escapar o path do sistema.
        let rel = String(caminho || '').trim().replace(/^\/+/, '');
        if (/^https?:\/\//i.test(rel) || rel.includes('..')) {
          return { ok: false, error: 'caminho inválido: use um caminho relativo à raiz do app (ex: "api/contas"), sem domínio nem "..".', efeito: { versao: 1, operacao: 'chamada_http', estado: 'nao_aplicado' } };
        }
        const method = (metodo || 'GET').toUpperCase();
        // Recibo de efeito, pro executor de tarefas saber se uma chamada que deu
        // errado pode ou não ter alterado algo no app. Sem isso QUALQUER resposta
        // não-2xx era "efeito incerto" e travava a tarefa de programação inteira
        // (caso de 17/09: um GET em api/status voltou erro e a tarefa morreu).
        // GET não altera dado por definição de HTTP; nos demais métodos a gente
        // continua honesto e não afirma nada.
        const NAO_APLICADO = { versao: 1, operacao: 'chamada_http', estado: 'nao_aplicado' };
        const efeitoDoMetodo = method === 'GET' ? NAO_APLICADO : undefined;
        const base = urlDoApp(app.label, system);
        const target = base + rel;
        const headers = {};
        if (cabecalhos && typeof cabecalhos === 'object') {
          for (const [k, v] of Object.entries(cabecalhos)) headers[String(k)] = String(v);
        }
        // Assinatura interna do PRÓPRIO app: o agente não tem (nem deve ter) o
        // valor do segredo, então a plataforma injeta o x-internal-key a partir
        // do cofre pra ele conseguir escrever/ler as rotas internas do seu app.
        // Só pra app PRÓPRIO (não compartilhado) e só se o agente não mandou o
        // header explicitamente. O valor nunca é exposto ao modelo/usuário.
        try {
          const hasInternal = Object.keys(headers).some((k) => k.toLowerCase() === 'x-internal-key');
          if (!r.shared && !hasInternal) {
            const secrets = await getAppSecretsDecrypted(r.ownerUserId, system);
            if (secrets && secrets.INTERNAL_API_KEY) headers['x-internal-key'] = secrets.INTERNAL_API_KEY;
          }
        } catch { /* cofre indisponível: segue sem injetar, a chamada pode voltar 401 */ }
        // Portão de acesso do app (app privado): o roteador pede HTTP Basic antes
        // de qualquer coisa. A plataforma assina por você a partir do registro do
        // dono — o modelo nunca vê a senha. Só se o agente não mandou Authorization.
        try {
          const temAuth = Object.keys(headers).some((k) => k.toLowerCase() === 'authorization');
          if (!temAuth) {
            const gate = await getAppAccess(r.ownerUserId, system);
            if (gate && gate.access !== 'public' && gate.user && gate.pass) {
              headers.Authorization = 'Basic ' + Buffer.from(`${gate.user}:${gate.pass}`, 'utf8').toString('base64');
            }
          }
        } catch { /* sem registro de acesso: segue; se for privado volta 401 */ }
        let body;
        if (corpo != null && method !== 'GET' && method !== 'DELETE') {
          if (typeof corpo === 'string') { body = corpo; if (!headers['Content-Type'] && !headers['content-type']) headers['Content-Type'] = 'application/json'; }
          else { body = JSON.stringify(corpo); headers['Content-Type'] = 'application/json'; }
        }
        const ctrl = new AbortController();
        // Timeout generoso: o app pode estar dormindo (scale-to-zero) e acordar no 1º acesso.
        const timer = setTimeout(() => ctrl.abort(), 30_000);
        try {
          // Redirect NUNCA no automático: a requisição carrega o x-internal-key do
          // cofre e o Basic do portão do app, e o código do app é do usuário. Um
          // 302 pra fora levaria o header custom junto (o fetch só tira o
          // Authorization ao trocar de origem, não headers próprios) e entregaria
          // o segredo do app pra qualquer host. Seguimos só dentro da própria
          // origem do app; saiu dali, a gente para e conta o que aconteceu.
          let alvoAtual = target;
          let r;
          for (let salto = 0; ; salto++) {
            r = await fetch(alvoAtual, { method, headers, body, signal: ctrl.signal, redirect: 'manual' });
            if (r.status < 300 || r.status >= 400) break;
            const loc = r.headers.get('location');
            if (!loc || salto >= 3) break;
            let prox;
            try { prox = new URL(loc, alvoAtual); } catch { break; }
            if (prox.origin !== new URL(base).origin) {
              return {
                ok: false,
                status: r.status,
                url: alvoAtual,
                error: `O app redirecionou pra fora dele (${prox.origin}). Não sigo redirect externo porque a chamada leva credenciais internas do app; ajuste a rota pra responder direto.`,
                efeito: efeitoDoMetodo,
              };
            }
            alvoAtual = prox.toString();
          }
          const ct = r.headers.get('content-type') || '';
          let text = await r.text();
          const truncated = text.length > 6000;
          if (truncated) text = text.slice(0, 6000);
          return {
            ok: r.ok,
            status: r.status,
            content_type: ct,
            corpo: text,
            truncado: truncated,
            url: target,
            aviso: r.ok ? undefined : 'A chamada não voltou 2xx. Não afirme que a operação deu certo; confira o status/corpo.',
            efeito: r.ok ? undefined : efeitoDoMetodo,
          };
        } catch (e) {
          const aborted = e?.name === 'AbortError';
          return { ok: false, error: aborted ? 'A requisição estourou o tempo (o app pode não ter subido).' : `Falha na requisição: ${e.message}`, url: target, efeito: efeitoDoMetodo };
        } finally {
          clearTimeout(timer);
        }
      },
    },
    {
      name: 'parar_sistema',
      description: 'Stops (puts to sleep) a published system. It turns back on by itself on the next access.',
      parameters: {
        type: 'object',
        properties: {
          nome_do_sistema: { type: 'string' },
          dono: { type: 'string', description: 'OPTIONAL. Only for COLLABORATION: owner of the system shared with you. Empty = your systems.' },
        },
        required: ['nome_do_sistema'],
      },
      async run({ nome_do_sistema, dono }) {
        const system = (nome_do_sistema || '').toLowerCase();
        const r = await rApp(system, dono);
        if (r.error) return r.error;
        const app = r.app;
        const res = await ctl({ verb: 'stop', label: app.label, system });
        if (!res.ok) return `Falha ao parar: ${res.error || 'erro'}`;
        await setAppStatus(r.ownerUserId, system, 'stopped');
        return `Sistema "${system}" parado.`;
      },
    },
    {
      name: 'reiniciar_sistema',
      description: 'Restarts a published system (useful after changing the app or if it froze).',
      parameters: {
        type: 'object',
        properties: {
          nome_do_sistema: { type: 'string' },
          dono: { type: 'string', description: 'OPTIONAL. Only for COLLABORATION: owner of the system shared with you. Empty = your systems.' },
        },
        required: ['nome_do_sistema'],
      },
      async run({ nome_do_sistema, dono }) {
        const system = (nome_do_sistema || '').toLowerCase();
        const r = await rApp(system, dono);
        if (r.error) return r.error;
        const app = r.app;
        const res = await ctl({ verb: 'restart', label: app.label, system });
        if (!res.ok) return `Falha ao reiniciar: ${res.error || 'erro'}`;
        await setAppStatus(r.ownerUserId, system, 'running');
        return `Sistema "${system}" reiniciado.`;
      },
    },
    {
      name: 'apagar_sistema',
      description:
        'Deletes a published system FOR GOOD: removes the container, the code, the version history AND the DATA the app stored (the /app/data, which is not in any snapshot nor in git). It cannot be undone or restored. '
        + 'CONFIRMED ACTION: before executing, the user sees how many records will be destroyed and must confirm in writing.',
      parameters: {
        type: 'object',
        properties: { nome_do_sistema: { type: 'string' } },
        required: ['nome_do_sistema'],
      },
      // Roda ANTES da confirmação: enriquece o texto que o usuário vai ler com o
      // que existe de fato dentro do app (nº de registros), pra ele não confirmar
      // no escuro. Nunca escreve nada.
      async preflight({ nome_do_sistema }) {
        const system = (nome_do_sistema || '').toLowerCase();
        if (!sysOk(system)) return null;
        const inv = await appContentsSummary(userId, system);
        if (!inv) return null;
        const perdas = [];
        if (inv.registros > 0) perdas.push(inv.detalhe.join(', '));
        else if (inv.tem_dados) perdas.push(`${inv.arquivos_de_dados || 0} arquivo(s) de dados`);
        if (inv.versoes) perdas.push(`${inv.versoes} versão(ões) no histórico`);
        if (!perdas.length) return null;
        return { aviso: `Vai destruir: ${perdas.join(' · ')}` };
      },
      async run({ nome_do_sistema }) {
        const system = (nome_do_sistema || '').toLowerCase();
        const app = await getAppRow(userId, system);
        if (!app) return { ok: false, error: `Não achei o sistema "${system}".` };
        const inv = await appContentsSummary(userId, system);
        const res = await ctl({ verb: 'delete', label: app.label, system });
        if (!res.ok) return { ok: false, error: `Falha ao apagar: ${res.error || 'erro'}` };
        await deleteAppRow(userId, system);
        return { ok: true, apagado: system,
          destruido: inv ? inv.resumo : undefined,
          obs: 'Código, histórico, dados, segredos do cofre e acessos de colaboradores do app foram removidos. Não há backup nem como voltar.' };
      },
    },
    {
      name: 'ver_logs_sistema',
      description: 'Shows the last log lines of a published system (useful for debugging when it does not start or throws errors).',
      parameters: {
        type: 'object',
        properties: {
          nome_do_sistema: { type: 'string', description: 'OPTIONAL if you are already working on an app in this conversation: when empty, uses the app you worked on last (or the user\'s only draft/app).' },
          linhas: { type: 'number', description: 'how many lines (default 100, max 500)' },
          dono: { type: 'string', description: 'OPTIONAL. Only for COLLABORATION: owner of the system shared with you. Empty = your systems.' },
        },
        required: [],
      },
      async run({ nome_do_sistema, linhas, dono }) {
        const alvo = await alvoPublicado(nome_do_sistema, dono);
        if (alvo.error) return alvo.error;
        const { system, r } = alvo;
        const app = r.app;
        const tail = Math.min(Math.max(Number(linhas) || 100, 1), 500);
        const res = await ctl({ verb: 'logs', label: app.label, system, tail });
        if (!res.ok) return `Falha ao ler logs: ${res.error || 'erro'}`;
        return res.logs ? `Logs de "${system}":\n${res.logs}` : `Sem logs pra "${system}".`;
      },
    },
    {
      name: 'ver_historico',
      description:
        'Shows the version HISTORY of a published system. Each publish becomes a version (commit) with author, date and message. '
        + 'Use it to see what changed over time and get the identifier (hash) of a version to see its diff (ver_diff) or go back to it (voltar_versao).',
      parameters: {
        type: 'object',
        properties: {
          nome_do_sistema: { type: 'string', description: 'OPTIONAL if you are already working on an app in this conversation: when empty, uses the app you worked on last (or the user\'s only draft/app).' },
          limite: { type: 'number', description: 'how many versions to list (default 20, max 100)' },
          dono: { type: 'string', description: 'OPTIONAL. Only for COLLABORATION: owner of the system shared with you. Empty = your systems.' },
        },
        required: [],
      },
      async run({ nome_do_sistema, limite, dono }) {
        const alvo = await alvoPublicado(nome_do_sistema, dono);
        if (alvo.error) return alvo.error;
        const { system, r } = alvo;
        const app = r.app;
        const res = await ctl({ verb: 'git_log', label: app.label, system, limit: limite });
        if (!res.ok) return `Falha ao ler o histórico: ${res.error || 'erro'}`;
        const commits = res.commits || [];
        if (!commits.length) return `"${system}" ainda não tem versões registradas (publique de novo pra começar o histórico).`;
        return `Histórico de "${system}" (mais recente primeiro):\n` + commits.map((c) =>
          `• ${c.hash} — ${c.message || '(sem mensagem)'} · ${c.author || '?'} · ${c.date || ''}`).join('\n');
      },
    },
    {
      name: 'ver_diff',
      description:
        'Shows what CHANGED in a version of a system (the commit diff): which files and lines changed. '
        + 'Pass the identifier (hash) of the version that came from ver_historico; without a version, shows the latest.',
      parameters: {
        type: 'object',
        properties: {
          nome_do_sistema: { type: 'string', description: 'OPTIONAL if you are already working on an app in this conversation: when empty, uses the app you worked on last (or the user\'s only draft/app).' },
          versao: { type: 'string', description: 'OPTIONAL. Version hash (from ver_historico). Default: the latest.' },
          dono: { type: 'string', description: 'OPTIONAL. Only for COLLABORATION: owner of the system shared with you. Empty = your systems.' },
        },
        required: [],
      },
      async run({ nome_do_sistema, versao, dono }) {
        const alvo = await alvoPublicado(nome_do_sistema, dono);
        if (alvo.error) return alvo.error;
        const { system, r } = alvo;
        const app = r.app;
        const res = await ctl({ verb: 'git_diff', label: app.label, system, ref: versao });
        if (!res.ok) return `Falha ao ler o diff: ${res.error || 'erro'}`;
        if (!res.diff) return `Sem mudanças pra mostrar nessa versão de "${system}".`;
        return (res.truncated ? '(diff longo, mostrando o começo)\n' : '') + res.diff;
      },
    },
    {
      name: 'voltar_versao',
      description:
        'Reverts a published system to a previous code VERSION (rollback). The app runs again on the code of that version; '
        + 'the runtime DATA in /app/data is PRESERVED (the rollback is code only). '
        + 'This creates a new version in the history marking the return (it does not erase the history). '
        + 'Pass the identifier (hash) of the version that came from ver_historico. CONFIRMED ACTION before executing.',
      parameters: {
        type: 'object',
        properties: {
          nome_do_sistema: { type: 'string' },
          versao: { type: 'string', description: 'hash of the version to go back to (from ver_historico).' },
          dono: { type: 'string', description: 'OPTIONAL. Only for COLLABORATION: owner of the system shared with you. Empty = your systems.' },
        },
        required: ['nome_do_sistema', 'versao'],
      },
      async run({ nome_do_sistema, versao, dono }) {
        const system = (nome_do_sistema || '').toLowerCase();
        if (!(versao || '').trim()) return { ok: false, error: 'Diga a versão (hash) pra voltar. Veja em ver_historico.' };
        const r = await rApp(system, dono);
        if (r.error) return { ok: false, error: r.error };
        const app = r.app;
        const author = (await callerName(userId)) || r.ownerName;
        const env = await getAppSecretsDecrypted(r.ownerUserId, system);
        const res = await ctl({ verb: 'git_rollback', label: app.label, system, ref: versao, env, author }, { timeoutMs: 120_000 });
        if (res.error === 'app_crashed') {
          return { ok: false, error: 'O app crashou ao subir na versão pedida; o rollback NÃO foi concluído. Veja ver_logs_sistema.', log_do_crash: res.logs || null };
        }
        if (res.error === 'versao_invalida' || res.error === 'ref_invalida') {
          return { ok: false, error: `Não achei a versão "${versao}". Confira o hash em ver_historico.` };
        }
        if (!res.ok) return { ok: false, error: `Falha no rollback: ${res.error || 'erro no host'}` };
        // Atualiza o snapshot da biblioteca com o código restaurado.
        let snapshotAtualizado = false;
        if (res.files && Object.keys(res.files).length) {
          const snap = buildSnapshot(res.files);
          if (snap) {
            try { await setAppSnapshot(r.ownerUserId, system, snap); snapshotAtualizado = true; } catch { /* aviso abaixo */ }
          }
        }
        // O rascunho apontava pro código de ANTES do rollback: limpa pra próxima
        // edição re-semear do código restaurado. Sem isso, um publish depois do
        // rollback re-aplicaria a versão errada por cima (estado misto).
        await clearAppDraft(r.ownerUserId, system).catch(() => {});
        await setAppStatus(r.ownerUserId, system, 'running').catch(() => {});
        return { ok: true, voltou_para: res.reverted_to || versao, url: urlDoApp(app.label, system),
          aviso: snapshotAtualizado ? undefined
            : 'O snapshot interno NÃO foi atualizado com o código restaurado. Antes de editar este app, RELEIA os arquivos com ler_arquivo_do_app e confira se o que você vê bate com a versão restaurada.' };
      },
    },
    {
      name: 'convidar_colaborador',
      description:
        'COLLABORATION (Mode B): opens a system of YOURS for a CONNECTED contact to work on the SAME instance '
        + '(same code, SAME data, same container). The collaborator\'s Bramb becomes able to edit/publish the code and operate the system data, passing "dono" (you) in the system tools. '
        + 'ATTENTION: this gives the collaborator ACCESS TO THE DATA of this system. Only invite people you trust. The collaborator does NOT get a copy; they operate YOUR instance (billing stays per owner). '
        + 'Prerequisite: already being CONNECTED with the person (Conexões › Contatos, invite accepted). CONFIRMED ACTION before executing.',
      parameters: {
        type: 'object',
        properties: {
          nome_do_sistema: { type: 'string', description: 'slug of YOUR system to share.' },
          contato: { type: 'string', description: 'name or e-mail of the connected contact who will collaborate.' },
        },
        required: ['nome_do_sistema', 'contato'],
      },
      async run({ nome_do_sistema, contato }) {
        const system = (nome_do_sistema || '').toLowerCase();
        const app = await getAppRow(userId, system);
        if (!app) return { ok: false, error: `Não achei um sistema SEU chamado "${system}". Só o dono compartilha (use listar_sistemas).` };
        if (app.agent_id && agentId && app.agent_id !== agentId) {
          return { ok: false, error: routeToOwnerMsg(system, await ownerAgentName(app.agent_id)) };
        }
        const who = await resolveConnectedUser(userId, contato);
        if (who.error === 'contato_ambiguo') return { ok: false, error: contatoAmbiguoMsg(contato, who.opcoes) };
        if (who.error) return { ok: false, error: `Não achei "${contato}" nos seus contatos conectados. Conecte-se primeiro em Conexões › Contatos.` };
        if (who.userId === userId) return { ok: false, error: 'Você não precisa se convidar pro próprio sistema.' };
        await addAppCollaborator(userId, system, who.userId, agentId);
        return { ok: true, sistema: system, colaborador: who.name,
          obs: `${who.name} agora pode editar e operar "${system}" (mesma instância, mesmos dados). O Bramb dele acessa passando "dono" com seu nome/e-mail nas tools de sistema.` };
      },
    },
    {
      name: 'listar_colaboradores',
      description: 'Lists who has COLLABORATION access (Mode B) to a system of YOURS.',
      parameters: {
        type: 'object',
        properties: { nome_do_sistema: { type: 'string' } },
        required: ['nome_do_sistema'],
      },
      async run({ nome_do_sistema }) {
        const system = (nome_do_sistema || '').toLowerCase();
        const app = await getAppRow(userId, system);
        if (!app) return `Não achei um sistema SEU chamado "${system}".`;
        const rows = await listAppCollaborators(userId, system);
        if (!rows.length) return `Ninguém colabora em "${system}" ainda.`;
        return `Colaboradores de "${system}":\n` + rows.map((c) => `• ${c.name}${c.email ? ` (${c.email})` : ''}`).join('\n');
      },
    },
    {
      name: 'remover_colaborador',
      description: 'Removes someone\'s COLLABORATION access to a system of YOURS. The collaborator can no longer edit/operate it. Data and code remain yours, intact.',
      parameters: {
        type: 'object',
        properties: {
          nome_do_sistema: { type: 'string' },
          contato: { type: 'string', description: 'name or e-mail of the collaborator to remove.' },
        },
        required: ['nome_do_sistema', 'contato'],
      },
      async run({ nome_do_sistema, contato }) {
        const system = (nome_do_sistema || '').toLowerCase();
        const app = await getAppRow(userId, system);
        if (!app) return `Não achei um sistema SEU chamado "${system}".`;
        const who = await resolveConnectedUser(userId, contato);
        if (who.error === 'contato_ambiguo') return contatoAmbiguoMsg(contato, who.opcoes);
        let collabUserId = who.ok ? who.userId : null;
        // Se a conexão foi desfeita, ainda dá pra remover casando pelo nome/e-mail
        // no próprio roster de colaboradores do sistema.
        if (!collabUserId) {
          const rows = await listAppCollaborators(userId, system);
          const q = String(contato || '').trim().toLowerCase();
          const hit = rows.find((c) => (c.email || '').toLowerCase() === q)
            || rows.find((c) => (c.name || '').toLowerCase() === q)
            || rows.find((c) => (c.name || '').toLowerCase().includes(q));
          collabUserId = hit ? hit.userId : null;
        }
        if (!collabUserId) return `Não achei "${contato}" na lista de colaboradores de "${system}".`;
        const n = await removeAppCollaborator(userId, system, collabUserId);
        return n ? `Colaborador removido de "${system}".` : `"${contato}" não estava colaborando em "${system}".`;
      },
    },
    {
      name: 'adicionar_na_home',
      description:
        `Adds a content block to the HOME of the user's subdomain (the root page https://<subdominio>.${dominioDosApps()}/). `
        + 'It is the "default app": the place the user accesses from anywhere and shares with friends/family. '
        + 'tipo "texto" (paragraph/note), "html" (ready-made HTML block, e.g.: a table or formatted list) or "link".',
      parameters: {
        type: 'object',
        properties: {
          tipo: { type: 'string', enum: ['texto', 'html', 'link'] },
          titulo: { type: 'string', description: 'optional block title' },
          conteudo: { type: 'string', description: 'for texto/html: the content. For link: the link text (optional).' },
          url: { type: 'string', description: 'required when tipo=link' },
        },
        required: ['tipo'],
      },
      async run({ tipo, titulo, conteudo, url }) {
        const map = { texto: 'text', html: 'html', link: 'link' };
        const kind = map[tipo];
        if (!kind) return 'tipo deve ser texto, html ou link.';
        if (kind === 'link' && !(url || '').trim()) return 'Link precisa de url.';
        if (kind !== 'link' && !(conteudo || '').trim()) return 'Bloco sem conteúdo.';
        const { label } = await resolveLabel(userId);
        const res = await ctl({ verb: 'home_add', label, kind, title: titulo, body: conteudo, url });
        if (!res.ok) return `Falha ao adicionar: ${res.error || 'erro'}`;
        return `Adicionado na home (id ${res.id}). Veja em ${urlDoApp(label)}`;
      },
    },
    {
      name: 'listar_home',
      description: 'Lists the blocks on the home of the user\'s subdomain (with their ids, so they can be removed).',
      parameters: { type: 'object', properties: {} },
      async run() {
        const { label } = await resolveLabel(userId);
        const res = await ctl({ verb: 'home_list', label });
        if (!res.ok) return `Falha: ${res.error || 'erro'}`;
        const blocks = res.blocks || [];
        if (!blocks.length) return 'A home está vazia (só a mensagem padrão).';
        return 'Blocos na home:\n' + blocks.map((b) => {
          const t = b.title ? `${b.title} — ` : '';
          const prev = (b.kind === 'link' ? (b.url || '') : (b.body || '')).slice(0, 60);
          return `• [${b.id}] (${b.kind}) ${t}${prev}`;
        }).join('\n');
      },
    },
    {
      name: 'remover_da_home',
      description: 'Removes a block from the subdomain home by id (see the ids in listar_home).',
      parameters: {
        type: 'object',
        properties: { id: { type: 'number' } },
        required: ['id'],
      },
      async run({ id }) {
        const { label } = await resolveLabel(userId);
        const res = await ctl({ verb: 'home_remove', label, id });
        if (!res.ok) return `Falha: ${res.error || 'erro'}`;
        return res.removed ? `Bloco ${id} removido.` : `Não achei o bloco ${id}.`;
      },
    },
  ];
}
