// ── Brambit Runner (Phase 0): execution on the user's MACHINE via an outbound channel ──
//
// Problem: today's free mode (ssh.mjs livreExec) dials FROM OUTSIDE IN (the
// sandbox runs `ssh user@host`). A personal laptop behind NAT has no IP/port
// to receive on, so it can't be reached by SSH-in. The fix is the reverse
// path: a daemon ("Brambit Runner") on the user's machine DIALS us
// (outbound), waits for commands and runs them LOCALLY, returning the output.
//
// This module is the SECOND transport behind the SAME `terminal` tool (seam
// pattern: the consumer/tool doesn't change, only the provider/channel). Phase 0
// uses HTTP long-poll (no new dependency, outbound-only, NAT-safe) reusing the
// existing device token (resolveDeviceToken); WS/SSE is a later-phase
// optimization and goes HERE without touching the tool or runnerExec.
//
// Auth: the runner is a "device" (same system as the device channel, e.g. an
// OS/desktop client). Authenticates on handshake with Bearer <device_token>;
// the server resolves token -> userId before calling anything here.

import { marca } from './marca.mjs';

const HOLD_MS = 25_000;        // how long the long-poll holds the response before sending idle
const ONLINE_TTL_MS = 45_000;  // device is "online" if it polled/responded within this
const MAX_OUT = 200_000;       // accumulated output ceiling per command (memory)
const REQ_GRACE_MS = 15_000;   // slack over the command's timeout before giving up

// FILE channel (v2.1.0). OWN ceiling, deliberately separate from MAX_OUT: the
// MAX_OUT exists to protect the MODEL'S CONTEXT (terminal output becomes
// text in the prompt), and in this path the bytes never get close to the model — they go
// straight to OUR S3. Here the limit is only the process's memory.
const MAX_FILE = 25 * 1024 * 1024;   // byte ceiling per file brought from the machine
const FILE_GRACE_MS = 20_000;        // slack over the file request timeout
const MIN_FILE_VERSION = '2.1.0';    // older runner silently discards the frame

// Version /runner SERVES today (= runner-go/main.go `version`). Exported
// because the page must say which version the download delivers and compare it
// with the connected one: without it the owner updated the binary with no way
// to know if they got the new one (user report 26/08). Bump with the Go core.
export const RUNNER_VERSION = '2.2.0';

// key `${userId}:${deviceId}` -> { userId, deviceId, meta, lastSeen, waiter, queue }
const DEVICES = new Map();
// reqId -> { userId, out, err, size, cwdKey, host, done, resolve, timer }
const PENDING = new Map();
// reqId -> { userId, parts, size, cap, nextSeq, host, path, done, resolve, timer }
const FILES = new Map();
// `${userId}:${threadId}:${deviceId}` -> current remote cwd (`cd` persistence)
const CWD = new Map();

let SEQ = 0;
function newReqId() { return 'rq' + (++SEQ).toString(36) + Date.now().toString(36); }
function now() { return Date.now(); }

function devKey(userId, deviceId) { return `${userId}:${deviceId}`; }

// User's most recently seen online device (Phase 0 assumes ~1 runner per
// person; with several, picks the one with the newest heartbeat). Noted as a limitation.
function pickDevice(userId) {
  let best = null;
  const cut = now() - ONLINE_TTL_MS;
  for (const d of DEVICES.values()) {
    if (d.userId !== userId) continue;
    if (d.lastSeen < cut) continue;
    if (!best || d.lastSeen > best.lastSeen) best = d;
  }
  return best;
}

// Is there an online runner for the user? Used to enable free mode and for the
// `terminal` tool to decide the transport. Synchronous on purpose (in-memory check).
export function runnerOnline(userId) {
  return !!pickDevice(userId);
}

function touch(userId, deviceId, meta, activeAgentId) {
  const key = devKey(userId, deviceId);
  let d = DEVICES.get(key);
  if (!d) { d = { userId, deviceId, meta: meta || null, activeAgentId: null, lastSeen: 0, waiter: null, queue: [] }; DEVICES.set(key, d); }
  if (meta) d.meta = meta;
  if (activeAgentId !== undefined) d.activeAgentId = activeAgentId || null;
  d.lastSeen = now();
  return d;
}

// Which assistant is bound to the user's online runner (device_tokens
// .active_agent_id, propagated on poll). null => the caller falls back to the first
// assistant, same as the device-chat default. Only the bound assistant uses the
// runner; this way free mode doesn't leak to every assistant of the owner.
export function runnerBoundAgentId(userId) {
  const d = pickDevice(userId);
  return d ? (d.activeAgentId || null) : null;
}

// Immediately applies the assistant bound to the user's online runner (the next poll
// would already bring it from the database within <=HOLD_MS, this just avoids the window). Returns the
// affected deviceId, or null if there's no online runner.
export function runnerSetBoundAgent(userId, agentId) {
  const d = pickDevice(userId);
  if (!d) return null;
  d.activeAgentId = agentId || null;
  return d.deviceId;
}

// ── Channel side (called by the /api/runner/* routes) ──────────────────────

// Long-poll: the runner calls this and receives the next command (or {type:'idle'}
// after HOLD_MS, when it should re-poll right away). deviceId = device token id.
export async function runnerPoll(userId, deviceId, meta, activeAgentId) {
  const d = touch(userId, deviceId, meta, activeAgentId);
  if (d.queue.length) return d.queue.shift();
  return await new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (d.waiter && d.waiter._timer === timer) d.waiter = null;
      resolve({ type: 'idle' });
    }, HOLD_MS);
    const w = (frame) => { clearTimeout(timer); d.waiter = null; resolve(frame); };
    w._timer = timer;
    d.waiter = w;
  });
}

// The runner returns output frames correlated by reqId:
//   { reqId, type:'stdout'|'stderr'|'exit', chunk?, exitCode?, cwd? }
// userId is from the authenticated device; blocks a frame for ANOTHER user's reqId.
export function runnerResult(userId, deviceId, frame) {
  if (deviceId != null) touch(userId, deviceId, null);
  if (frame && (frame.type === 'filechunk' || frame.type === 'filedone')) {
    return fileResult(userId, frame);
  }
  const rec = frame && PENDING.get(frame.reqId);
  if (!rec) return { ok: true, ignored: true };
  if (rec.userId !== userId) return { ok: false, error: 'reqId de outro usuário.' };
  if (rec.done) return { ok: true, ignored: true };
  const t = frame.type;
  if (t === 'stdout' || t === 'stderr') {
    const chunk = String(frame.chunk ?? '');
    if (rec.size < MAX_OUT) {
      const room = MAX_OUT - rec.size;
      const piece = chunk.length > room ? chunk.slice(0, room) : chunk;
      (t === 'stdout' ? rec.out : rec.err).push(piece);
      rec.size += piece.length;
      if (rec.size >= MAX_OUT) rec.err.push('\n[saída truncada: teto atingido]');
    }
  } else if (t === 'exit') {
    finishReq(frame.reqId, { exit: frame.exitCode ?? null, cwd: frame.cwd });
  }
  return { ok: true };
}

function finishReq(reqId, { exit, cwd, error } = {}) {
  const rec = PENDING.get(reqId);
  if (!rec || rec.done) return;
  rec.done = true;
  clearTimeout(rec.timer);
  PENDING.delete(reqId);
  if (cwd) CWD.set(rec.cwdKey, cwd);
  const code = (exit === undefined ? null : exit);
  rec.resolve({
    ok: code === 0,
    host: rec.host,
    cwd: cwd || CWD.get(rec.cwdKey) || '~',
    exit: code,
    saida: rec.out.join(''),
    stderr: rec.err.join(''),
    error: error || (code === 0 ? undefined : `Comando terminou com código ${code}.`),
  });
}

// ── Provider behind the `terminal` tool (same return signature as
// ssh.mjs's livreExec). The tool does maskSecrets on the output, as it already did. ──
export async function runnerExec(userId, comando, { threadId, timeout = 180_000 } = {}) {
  if (!comando) return { ok: false, error: 'Sem comando pra rodar.' };
  const d = pickDevice(userId);
  if (!d) return { ok: false, error: `Runner offline. Abra o ${marca().nome} Runner na sua máquina pra eu conseguir rodar aí.` };
  const reqId = newReqId();
  const cwdKey = `${userId}:${threadId || 'no-thread'}:${d.deviceId}`;
  const rec = { userId, out: [], err: [], size: 0, cwdKey, host: d.deviceId, done: false, resolve: null, timer: null };
  const p = new Promise((resolve) => { rec.resolve = resolve; });
  rec.timer = setTimeout(() => finishReq(reqId, { exit: null, error: 'Tempo esgotado esperando o runner responder.' }), timeout + REQ_GRACE_MS);
  PENDING.set(reqId, rec);
  const frame = { type: 'exec', reqId, comando: String(comando), cwd: CWD.get(cwdKey) || '', timeoutMs: timeout };
  if (d.waiter) d.waiter(frame); else d.queue.push(frame);
  return p;
}

// ── FILE channel (v2.1.0) ─────────────────────────────────────────────────
//
// Why it exists: the exec channel only returns TEXT and with a ceiling. To bring a
// binary from the owner's machine (photo, PDF, zip) there was no internal path, and the
// lack of one pushed toward a workaround — in the worst case, uploading the file to a third-party
// host to "fetch it back," which is a leak. Here the bytes leave the
// owner's machine straight to OUR backend, in their own frames, and from there to our
// S3 (putMedia). Nothing passes through the terminal's output nor the model's context.

function versionAtLeast(v, min) {
  const a = String(v || '').split('.').map((n) => parseInt(n, 10) || 0);
  const b = String(min).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const x = a[i] || 0, y = b[i] || 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return true;
}

function finishFile(reqId, { error } = {}) {
  const rec = FILES.get(reqId);
  if (!rec || rec.done) return;
  rec.done = true;
  clearTimeout(rec.timer);
  FILES.delete(reqId);
  if (error) {
    rec.resolve({ ok: false, host: rec.host, path: rec.path, error });
    return;
  }
  const bytes = Buffer.concat(rec.parts, rec.size);
  rec.resolve({ ok: true, host: rec.host, path: rec.remotePath || rec.path, nome: rec.name || rec.path.split(/[\\/]/).pop(), tamanho: bytes.length, bytes });
}

// filechunk/filedone frames arrive through the SAME /api/runner/result, correlated
// by reqId. Order: the runner posts in sequence, and `seq` checks it.
function fileResult(userId, frame) {
  const rec = FILES.get(frame.reqId);
  if (!rec) return { ok: true, ignored: true };
  if (rec.userId !== userId) return { ok: false, error: 'reqId de outro usuário.' };
  if (rec.done) return { ok: true, ignored: true };
  if (frame.type === 'filechunk') {
    const seq = Number(frame.seq) || 0;
    if (seq !== rec.nextSeq) {
      finishFile(frame.reqId, { error: `Transferência fora de ordem (esperava a parte ${rec.nextSeq}, veio a ${seq}).` });
      return { ok: false, error: 'fora de ordem' };
    }
    let buf;
    try { buf = Buffer.from(String(frame.chunk || ''), 'base64'); }
    catch { finishFile(frame.reqId, { error: 'Parte do arquivo veio corrompida.' }); return { ok: false }; }
    if (rec.size + buf.length > rec.cap) {
      finishFile(frame.reqId, { error: `Arquivo passou do teto de ${Math.floor(rec.cap / (1024 * 1024))} MB.` });
      return { ok: false, error: 'teto excedido' };
    }
    rec.parts.push(buf);
    rec.size += buf.length;
    rec.nextSeq = seq + 1;
    return { ok: true };
  }
  // filedone
  if (frame.error) { finishFile(frame.reqId, { error: String(frame.error) }); return { ok: true }; }
  if (frame.name) rec.name = String(frame.name);
  if (frame.path) rec.remotePath = String(frame.path);
  if (frame.size != null && Number(frame.size) !== rec.size) {
    finishFile(frame.reqId, { error: `Transferência incompleta: recebi ${rec.size} de ${frame.size} bytes.` });
    return { ok: true };
  }
  finishFile(frame.reqId);
  return { ok: true };
}

// Sibling of runnerExec: requests ONE file from the owner's machine and returns the
// bytes. The caller is responsible for storing it (putMedia) and for NOT throwing the content into
// the model's context.
export async function runnerReadFile(userId, caminho, { maxBytes = MAX_FILE, timeout = 120_000 } = {}) {
  if (!caminho) return { ok: false, error: 'Sem caminho de arquivo.' };
  const d = pickDevice(userId);
  if (!d) return { ok: false, error: `Runner offline. Abra o ${marca().nome} Runner na máquina pra eu conseguir pegar o arquivo aí.` };
  const v = d.meta && (d.meta.version || d.meta.v);
  if (!versionAtLeast(v, MIN_FILE_VERSION)) {
    // Mandatory gate: runner < 2.1.0 silently discards an unknown frame
    // (runner-go pollOnce), so the request would hang until the timeout.
    return { ok: false, error: `O ${marca().nome} Runner aí (${v || 'versão desconhecida'}) ainda não sabe transferir arquivo. Atualize pra ${MIN_FILE_VERSION} ou mais novo em /runner e peça de novo.` };
  }
  const cap = Math.min(Math.max(1, Number(maxBytes) || MAX_FILE), MAX_FILE);
  const reqId = newReqId();
  const rec = { userId, parts: [], size: 0, cap, nextSeq: 0, host: d.deviceId, path: String(caminho), name: null, remotePath: null, done: false, resolve: null, timer: null };
  const p = new Promise((resolve) => { rec.resolve = resolve; });
  rec.timer = setTimeout(() => finishFile(reqId, { error: 'Tempo esgotado esperando o arquivo chegar da máquina.' }), timeout + FILE_GRACE_MS);
  FILES.set(reqId, rec);
  const frame = { type: 'readfile', reqId, path: String(caminho), maxBytes: cap };
  if (d.waiter) d.waiter(frame); else d.queue.push(frame);
  return p;
}

// Diagnostics/inspection (may serve a future /runner UI).
export function runnerStatus(userId) {
  const d = pickDevice(userId);
  // `currentVersion` always goes out (even offline) because the screen needs to say which
  // version the download delivers. `outdated` is compared HERE, not in the browser: the
  // comparison is per numeric component (2.10.0 > 2.1.0), and comparing strings in the page's
  // JS would give a false negative.
  if (!d) return { online: false, currentVersion: RUNNER_VERSION };
  const v = (d.meta && (d.meta.version || d.meta.v)) || null;
  return {
    online: true,
    deviceId: d.deviceId,
    meta: d.meta || null,
    activeAgentId: d.activeAgentId || null,
    lastSeen: d.lastSeen,
    version: v,
    currentVersion: RUNNER_VERSION,
    outdated: !versionAtLeast(v, MIN_FILE_VERSION),
  };
}

// Prompt context block, when the Runner is online AND bound to THIS assistant.
// It exists because the binding alone wasn't enough: the gate opened, the
// `codar` tool was built, and the assistant still answered "I have no access to
// your machine" (user report 25/08). Nothing in the prompt said the owner's
// machine was there, and the entry tool is described as CODE, not "owner's
// machine". Here the capability is declared, with the real write scope.
export function runnerContext(userId) {
  const s = runnerStatus(userId);
  if (!s.online) return '';
  const m = s.meta || {};
  const quem = [m.hostname, [m.os, m.arch].filter(Boolean).join('/')].filter(Boolean).join(', ');
  // Write fence: only asserts confinement with the data IN HAND. Absence is
  // UNKNOWN (old Runner, poll without the field), never "it's fenced": honest
  // degradation is a Runner invariant (projetos/runner-local.md), and defaulting
  // to the optimistic side is exactly what the daemon avoids on the owner's machine.
  const confinado = m.confined === '1' || m.confined === true;
  const semCerca = m.confined === '0' || m.confined === false;
  const modo = m.mode || (confinado ? 'workspace-write' : 'não informado');
  // In full-access the daemon sends confined=1 (there's nothing to fence), so the
  // mode comes first: full access chosen by the owner is not fenced write.
  // Since 2.2.0, without a fence in restricted mode the daemon REFUSES every command.
  const escopo = modo === 'full-access'
    ? `Escopo: o dono escolheu ACESSO TOTAL nesta máquina: LEITURA e ESCRITA em qualquer pasta, sem cerca do sistema operacional. Confirme com o dono antes de criar, alterar ou apagar arquivo fora do que ele acabou de pedir.`
    : semCerca && versionAtLeast(m.version || m.v, '2.2.0')
      ? `Escopo: BLOQUEADO. A máquina dele não consegue cercar a escrita e, no modo restrito (modo "${modo}"), o Runner RECUSA todo comando. Não tente contornar. Se o dono quiser usar o Runner nela, ele abre o painel do ${marca().nome} Runner nessa máquina e escolhe "Liberar acesso total nesta máquina"${m.os === 'linux' ? ' (ou instala o bubblewrap, pacote bwrap, que liga a cerca)' : ''}.`
      : confinado
        ? `Escopo: LEITURA é livre em qualquer lugar da máquina. ESCRITA vale só nas pastas autorizadas (modo "${modo}", cercada pelo sistema operacional); fora delas o próprio sistema recusa, e aí é só avisar o dono em vez de insistir.`
        : `Escopo: LEITURA é livre em qualquer lugar da máquina. ESCRITA ${semCerca ? 'NÃO está cercada pelo sistema operacional (a máquina dele não suporta cercar)' : 'pode NÃO estar cercada pelo sistema operacional (o Runner não informou o modo de escrita)'} (modo "${modo}"): não diga que a escrita está protegida e confirme com o dono antes de criar, alterar ou apagar arquivo fora do que ele acabou de pedir.`;
  return [
    `MÁQUINA DO DONO (${marca().nome} Runner ATIVO${quem ? `: ${quem}` : ''}): o daemon está rodando AGORA na máquina pessoal do seu dono e VOCÊ é o assistente amarrado a ela.`,
    `Você TEM acesso a essa máquina: pastas, arquivos, área de trabalho, comandos. Nunca responda que não tem acesso, e nunca peça pra ele "ativar o runner": ele já está ativo. Na dúvida, VERIFIQUE rodando um comando.`,
    `Como usar: chame a ferramenta \`codar\` descrevendo o objetivo e dizendo explicitamente que é NA MÁQUINA LOCAL do dono (pelo Runner). Ex: "na máquina local do dono, lista o que tem na área de trabalho dele".`,
    escopo,
    versionAtLeast(m.version || m.v, MIN_FILE_VERSION)
      ? `Pra trazer um ARQUIVO de verdade da máquina dele (foto, PDF, planilha, zip) use a ferramenta \`pegar_arquivo_da_maquina\` com o caminho: os bytes vêm direto pro ${marca().nome} e viram anexo no chat. O terminal só devolve TEXTO, então nunca tente mover binário por ele (base64 no stdout) e JAMAIS por serviço de fora (host de arquivo, paste, bucket de terceiro) — isso é vazamento do dado do dono.`
      : `O Runner instalado aí é antigo (${m.version || m.v || 'versão desconhecida'}) e ainda não transfere arquivo; o terminal só devolve TEXTO. Se o dono precisar do arquivo em si, peça pra ele atualizar o Runner em /runner. Nunca improvise a transferência por serviço de fora (host de arquivo, paste, bucket de terceiro): isso é vazamento do dado dele.`,
  ].join(' ');
}

// Read-only diagnostics. Tells an expired heartbeat from no observation in
// this process. Doesn't infer installation from the device_token label: that
// registry also serves other device clients. Doesn't change the access gate.
export function runnerAvailability(userId) {
  const online=pickDevice(userId);
  if (online) return {state:'online',activeAgentId:online.activeAgentId || null};
  let seen=false;
  for (const d of DEVICES.values()) {
    if (d.userId===userId) {seen=true;break;}
  }
  return {state:seen?'offline':'unknown',activeAgentId:null};
}

// Factual context, not a promise of execution. Group/draft never receive
// data about the machine. The registry's gates still decide the tools.
export function runnerContextForTurn(userId, {
  agentId, agentCategory='pessoal', ephemeral=false,
  runnerForThisAgent=false, terminalAvailable=false,
}={}) {
  if (ephemeral || agentCategory==='grupo') return '';
  const s=runnerAvailability(userId);
  const prefix=`ESTADO DA CONEXÃO LOCAL (${marca().nome} Runner): `;
  const boundary=' Isto é estado de conexão, não autorização. Use somente as ferramentas disponibilizadas neste turno e não contorne permissões. Só o que vive na máquina do usuário (arquivos, apps e programas instalados nela) depende do Runner: não finja acessar isso por um servidor SSH/sandbox. Instalar ou rodar programa de terceiro, repositório do GitHub, CLI ou servidor MCP que não depende da máquina dele NÃO precisa do Runner: use a sandbox (abrir_ferramentas grupo "codigo"). Informe esse estado quando o pedido depender da máquina local, sem anunciar falha em assuntos não relacionados.';
  if (s.state==='offline') return prefix+
    `um Runner deste usuário já foi observado neste processo, mas nenhum está online agora (heartbeat expirado). Explique que a conexão com a máquina está indisponível neste momento, não que o ${marca().nome} nunca acessa arquivos locais. Peça verificar se o Runner está aberto e conectado em /runner. Não diga que verificou arquivos nem execute no lugar errado.`+boundary;
  if (s.state==='unknown') return prefix+
    'nenhum Runner está online e este processo não tem evidência anterior de conexão. Isso NÃO prova que o usuário nunca instalou/configurou o Runner (o servidor pode ter reiniciado). Não invente cadastro nem diagnóstico de desligamento. Diga que não há conexão local ativa detectada agora e peça verificar o estado em /runner.'+boundary;
  if (s.activeAgentId && s.activeAgentId!==agentId) return prefix+
    'há Runner online, mas o vínculo observado é com OUTRO assistente deste usuário. Não diga que a máquina está offline ou que você tem acesso. Peça usar o assistente vinculado ou revisar o vínculo em /runner; não mude o vínculo por conta própria.'+boundary;
  if (!runnerForThisAgent) return prefix+
    'há Runner online, mas ele não foi habilitado para este assistente neste turno. Verifique o vínculo em /runner e tente novamente. Não infira acesso só porque a máquina está online.'+boundary;
  if (!terminalAvailable) return prefix+
    'há Runner online vinculado a este assistente, mas o terminal local não está disponível neste turno devido às restrições do ambiente/roteamento. Não peça ligar um Runner que já está conectado. Só use transferência de arquivos se a ferramenta correspondente estiver disponível; não prometa executar comandos.'+boundary;
  // Preserve the existing active context (includes confinement/version), without creating
  // an alternative execution path or expanding the registry's permissions.
  const active=runnerContext(userId);
  return active ? active+boundary : prefix+'o estado da conexão mudou durante a preparação deste turno. Verifique /runner e tente novamente.'+boundary;
}
