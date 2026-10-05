// ── Brambs Runner (Fase 0): execução na MÁQUINA do usuário via canal outbound ──
//
// Problema: o modo livre de hoje (ssh.mjs livreExec) disca DE FORA PRA DENTRO
// (o sandbox SP faz `ssh usuario@host`). Um notebook pessoal atrás de NAT não
// tem IP/porta pra receber, então não é alcançável por SSH-in. A solução é o
// caminho inverso: um daemon ("Brambs Runner") na máquina do usuário DISCA pra
// nós (saída), fica esperando comando e roda LOCALMENTE, devolvendo a saída.
//
// Este módulo é o SEGUNDO transporte atrás da MESMA tool `terminal` (padrão de
// costura: o consumer/tool não muda, troca-se só o provider/canal). Fase 0 usa
// long-poll HTTP (zero dependência nova, outbound-only, NAT-safe) reusando o
// device token que já existe (resolveDeviceToken); WS/SSE é otimização de fase
// posterior e entra AQUI sem mexer na tool nem em runnerExec.
//
// Auth: o runner é um "device" (mesmo sistema do Brambs OS). Autentica no
// handshake por Bearer <device_token>; o server resolve token -> userId antes
// de chamar qualquer coisa aqui.

import { marca } from './marca.mjs';

const HOLD_MS = 25_000;        // quanto o long-poll segura a resposta antes de mandar idle
const ONLINE_TTL_MS = 45_000;  // device é "online" se pollou/respondeu dentro disso
const MAX_OUT = 200_000;       // teto de saída acumulada por comando (memória)
const REQ_GRACE_MS = 15_000;   // folga sobre o timeout do comando antes de desistir

// Canal de ARQUIVO (v2.1.0). Teto PRÓPRIO, separado do MAX_OUT de propósito: o
// MAX_OUT existe pra proteger o CONTEXTO DO MODELO (a saída do terminal vira
// texto no prompt), e neste caminho os bytes nunca chegam perto do modelo — vão
// direto pro nosso S3. Aqui o limite é só memória do processo.
const MAX_FILE = 25 * 1024 * 1024;   // teto de bytes por arquivo trazido da máquina
const FILE_GRACE_MS = 20_000;        // folga sobre o timeout do pedido de arquivo
const MIN_FILE_VERSION = '2.1.0';    // runner mais velho descarta o frame calado

// Versão que /runner DISTRIBUI hoje (= runner-go/main.go `version`). Exportada
// porque a tela precisa dizer qual versão o download entrega e comparar com a
// que está conectada: sem isso o dono atualizava o binário e não tinha como
// saber se pegou o novo (caso Marcos 26/08). Ao subir o núcleo Go, subir aqui.
export const RUNNER_VERSION = '2.2.0';

// key `${userId}:${deviceId}` -> { userId, deviceId, meta, lastSeen, waiter, queue }
const DEVICES = new Map();
// reqId -> { userId, out, err, size, cwdKey, host, done, resolve, timer }
const PENDING = new Map();
// reqId -> { userId, parts, size, cap, nextSeq, host, path, done, resolve, timer }
const FILES = new Map();
// `${userId}:${threadId}:${deviceId}` -> cwd remoto atual (persistência de `cd`)
const CWD = new Map();

let SEQ = 0;
function newReqId() { return 'rq' + (++SEQ).toString(36) + Date.now().toString(36); }
function now() { return Date.now(); }

function devKey(userId, deviceId) { return `${userId}:${deviceId}`; }

// Device online mais recentemente visto do usuário (Fase 0 assume ~1 runner por
// pessoa; com vários, escolhe o de heartbeat mais novo). Anota-se como limite.
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

// Existe um runner online pro usuário? Usado pra ligar o modo livre e pra tool
// `terminal` decidir o transporte. Síncrono de propósito (checagem em memória).
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

// Qual assistente está amarrado ao runner online do usuário (device_tokens
// .active_agent_id, propagado no poll). null => o chamador cai no primeiro
// assistente, igual ao default do device-chat. Só o assistente amarrado usa o
// runner; assim o modo livre não vaza pra todos os assistentes do dono.
export function runnerBoundAgentId(userId) {
  const d = pickDevice(userId);
  return d ? (d.activeAgentId || null) : null;
}

// Aplica na hora o assistente amarrado ao runner online do usuário (o next poll
// já traria do banco em <=HOLD_MS, isto só evita a janela). Devolve o deviceId
// afetado, ou null se não há runner online.
export function runnerSetBoundAgent(userId, agentId) {
  const d = pickDevice(userId);
  if (!d) return null;
  d.activeAgentId = agentId || null;
  return d.deviceId;
}

// ── Lado do canal (chamado pelas rotas /api/runner/*) ──────────────────────

// Long-poll: o runner chama isto e recebe o próximo comando (ou {type:'idle'}
// após HOLD_MS, quando deve re-pollar na hora). deviceId = id do device token.
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

// O runner devolve frames de saída pela MESMA correlação por reqId:
//   { reqId, type:'stdout'|'stderr'|'exit', chunk?, exitCode?, cwd? }
// userId é do device autenticado; barra frame pra reqId de OUTRO usuário.
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

// ── Provider por trás da tool `terminal` (mesma assinatura de retorno do
// livreExec do ssh.mjs). A tool faz o maskSecrets na saída, como já fazia. ──
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

// ── Canal de ARQUIVO (v2.1.0) ─────────────────────────────────────────────────
//
// Por que existe: o canal exec só devolve TEXTO e com teto. Pra trazer um
// binário da máquina do dono (foto, PDF, zip) não havia caminho interno, e a
// falta dele empurrava pra gambiarra — no caso limite, subir o arquivo num host
// de terceiro pra "buscar de volta", que é vazamento. Aqui os bytes saem da
// máquina dele direto pro NOSSO backend, em frames próprios, e de lá pro nosso
// S3 (putMedia). Nada passa pela saída do terminal nem pelo contexto do modelo.

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

// Frames filechunk/filedone chegam pelo MESMO /api/runner/result, correlacionados
// pelo reqId. Ordem: o runner posta em sequência, e o `seq` confere.
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

// Irmão do runnerExec: pede UM arquivo da máquina do dono e devolve os bytes.
// Quem chama é responsável por guardar (putMedia) e por NÃO jogar o conteúdo no
// contexto do modelo.
export async function runnerReadFile(userId, caminho, { maxBytes = MAX_FILE, timeout = 120_000 } = {}) {
  if (!caminho) return { ok: false, error: 'Sem caminho de arquivo.' };
  const d = pickDevice(userId);
  if (!d) return { ok: false, error: `Runner offline. Abra o ${marca().nome} Runner na máquina pra eu conseguir pegar o arquivo aí.` };
  const v = d.meta && (d.meta.version || d.meta.v);
  if (!versionAtLeast(v, MIN_FILE_VERSION)) {
    // Gate obrigatório: runner < 2.1.0 descarta frame desconhecido em silêncio
    // (runner-go pollOnce), então o pedido ficaria pendurado até o timeout.
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

// Diagnóstico/inspeção (pode servir a uma futura UI /runner).
export function runnerStatus(userId) {
  const d = pickDevice(userId);
  // `currentVersion` sai sempre (mesmo offline) porque a tela precisa dizer qual
  // versão o download entrega. `outdated` é comparado AQUI, não no browser: o
  // compare é por componente numérico (2.10.0 > 2.1.0), e comparar string no JS
  // da página daria falso negativo.
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

// Bloco de contexto pro prompt, quando o Runner está online E amarrado a ESTE
// assistente. Existe porque o vínculo sozinho não bastava: o gate abria, a tool
// `codar` era montada, e mesmo assim o assistente respondia "não tenho acesso à
// sua máquina" (caso Marcos 25/08) — nada no prompt contava que a máquina do dono
// estava ali, e a porta de entrada tem descrição de CÓDIGO, não de "máquina do
// dono". Aqui a capacidade fica declarada, com o escopo real de escrita.
export function runnerContext(userId) {
  const s = runnerStatus(userId);
  if (!s.online) return '';
  const m = s.meta || {};
  const quem = [m.hostname, [m.os, m.arch].filter(Boolean).join('/')].filter(Boolean).join(', ');
  // Cerca de escrita: só afirma confinamento com o dado NA MÃO. Ausência é
  // DESCONHECIDO (Runner antigo, poll sem o campo), nunca "está cercado": o
  // degrade honesto é invariante do Runner (projetos/runner-local.md), e chutar
  // pro lado otimista é exatamente o que o daemon evita na máquina do dono.
  const confinado = m.confined === '1' || m.confined === true;
  const semCerca = m.confined === '0' || m.confined === false;
  const modo = m.mode || (confinado ? 'workspace-write' : 'não informado');
  // Em full-access o daemon manda confined=1 (não há o que cercar), então o
  // modo vem antes: acesso total escolhido pelo dono não é escrita cercada.
  // Desde a 2.2.0, sem cerca no modo restrito o daemon RECUSA todo comando.
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

// Diagnóstico somente leitura. Diferencia heartbeat expirado de ausência de
// observação neste processo. Não infere instalação pelo label de device_token:
// esse cadastro também atende Brambs OS. Não modifica o gate de acesso.
export function runnerAvailability(userId) {
  const online=pickDevice(userId);
  if (online) return {state:'online',activeAgentId:online.activeAgentId || null};
  let seen=false;
  for (const d of DEVICES.values()) {
    if (d.userId===userId) {seen=true;break;}
  }
  return {state:seen?'offline':'unknown',activeAgentId:null};
}

// Contexto factual, não promessa de execução. Grupo/rascunho nunca recebem
// dados sobre a máquina. Os gates do registry continuam decidindo as tools.
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
  // Preserve o contexto ativo existente (inclui confinamento/versão), sem criar
  // caminho alternativo de execução ou ampliar as permissões do registry.
  const active=runnerContext(userId);
  return active ? active+boundary : prefix+'o estado da conexão mudou durante a preparação deste turno. Verifique /runner e tente novamente.'+boundary;
}
