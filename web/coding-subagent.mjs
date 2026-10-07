import {scopeConflict,reviewRequestNeedsClarification,editRequestNeedsClarification} from './app-task-scope.mjs';
import {runCodingTask} from './coding-task-runner.mjs';
import { runAppTask } from './app-task-runner.mjs';
// ── Sub-agente de CODING (isolamento estrutural) ──
// Molde = runGoogleSubagent (server.mjs), com UMA diferença central: coding
// NÃO é one-shot. Uma tarefa de código se estende por VÁRIOS turnos do
// principal (você lê, ele responde, você pede o próximo passo). Por isso este
// sub-agente tem SESSÃO PERSISTENTE por (agente, thread): o history do loop de
// código vive aqui e é reusado turno a turno, em vez de ser jogado no history
// do principal (que é o que inchava o contexto de um caso real: 5M tokens).
//
// O que sai do principal: a suíte inteira de tools de código (~40-80 defs,
// ~20k tok de schema reenviados a cada passo) e os resultados crus enormes
// (dumps de arquivo, saída de comando). O principal fica só com a meta-tool
// `codar`; a síntese volta como texto. Igual google/pesquisar/conectores.
//
// Escrita gated: a trava de confirmação (addGated) é presa ao turno/thread do
// principal e NÃO funciona dentro de um sub-agente. Então o sub-agente só é
// dono do loop quando a escrita já roda inline (modo aceitar_edicoes ou super/
// livre) — que é EXATAMENTE o cenário pesado. Em modo padrao a decisão
// de rota fica com o server (mantém inline no principal). Este módulo não
// decide política; só executa o loop com as tools que recebe.

import { retainedFilePage } from '../core-proto/file-page.mjs';
import { createBuildState } from './app-build-state.mjs';
import { runAgent } from '../core-proto/core.mjs';
import { comIdioma } from './locale.mjs';
import { marca } from './marca.mjs';

// Sessões persistentes de coding, por sessionKey = `${agentId}:${threadId}`.
// { history: [...], lastUsed: ms }. Idle > SESSION_TTL_MS é coletado (o resumo
// do trabalho já voltou pro principal como texto a cada turno; retomar do zero
// custa pouco perto de guardar contexto morto).
const sessions = new Map();
const SESSION_TTL_MS = Number(process.env.CODING_SESSION_TTL_MS) || 30 * 60 * 1000; // 30 min
// Teto de history do sub-agente (mensagens). Coding gera muitos passos; sem
// teto o history do sub cresce igual o do principal crescia. Mantém as N mais
// recentes (o par user/assistant + tool msgs). Compactação real fica p/ depois.
const HISTORY_MAX = Number(process.env.CODING_HISTORY_MAX) || 60;

function gcSessions(nowMs) {
  for (const [k, s] of sessions) {
    if (nowMs - s.lastUsed > SESSION_TTL_MS) sessions.delete(k);
  }
}

// Higiene de contexto ENTRE chamadas (item 3). O pruneTurnBlobs do core só
// colapsa blobs gerados DENTRO da chamada atual (turnStart = messages.length);
// o history que entra de chamadas anteriores fica full-size. Numa sessão de
// coding persistente isso reacumula (releitura do mesmo arquivo turno a turno =
// o inchaço daquele caso). Aqui, ao persistir, colapsamos leituras/saídas
// antigas e args de escrita grandes, preservando intactas as N mais recentes
// (o modelo ainda precisa do que acabou de ver).
const BLOB_MAX = Number(process.env.CODING_BLOB_MAX) || 2000;   // chars
const KEEP_RECENT = Number(process.env.CODING_KEEP_RECENT) || 6; // últimas msgs intactas
function collapseHistoryBlobs(messages) {
  const lastKeep = messages.length - KEEP_RECENT;
  for (let i = 0; i < lastKeep; i++) {
    const m = messages[i];
    if (!m) continue;
    if (m.role === 'tool' && typeof m.content === 'string' && m.content.length > BLOB_MAX) {
      m.content = retainedFilePage(m.content) || `[resultado de ${m.name || 'tool'} recolhido pra poupar contexto (${m.content.length} chars). Você já viu esse conteúdo. Não releia o mesmo arquivo/trecho: use o que extraiu. Só releia se o estado tiver mudado desde então.]`;
    } else if (m.role === 'assistant' && Array.isArray(m.toolCalls)) {
      for (const c of m.toolCalls) {
        if (!c || !c.args || typeof c.args !== 'object') continue;
        for (const k of Object.keys(c.args)) {
          const v = c.args[k];
          if (typeof v === 'string' && v.length > BLOB_MAX) c.args[k] = `[${v.length} chars omitidos pra poupar contexto]`;
        }
      }
    }
  }
  return messages;
}

// Costura do par chamada/resultado depois de qualquer poda. Cortar o history
// pelo teto de mensagens é um corte CEGO: ele pode cair entre o `assistant` que
// pediu a ferramenta e o `tool` que traz o resultado, e o resultado sozinho é
// inválido pra API. A Together recusa a chamada inteira com 400
// `invalid_tool_messages` ("tool message tool_call_id '...' does not match any
// tool call in the preceding assistant messages"); o provider cai no fallback e,
// como o history envenenado FICA guardado na sessão, TODA chamada seguinte da
// mesma thread repete o mesmo erro até a sessão expirar (30 min). Foi o que
// derrubou o DeepSeek pro Gemini em 03/09 e 05/09, sempre com o mesmo
// tool_call_id repetindo. Aqui mantemos só os `tool` cujo id foi de fato pedido
// por um `assistant` ANTERIOR no que sobrou da poda.
function dropOrphanToolMessages(messages) {
  const called = new Set();
  const out = [];
  for (const m of messages) {
    if (m.role === 'assistant' && Array.isArray(m.toolCalls)) {
      for (const c of m.toolCalls) if (c && c.id) called.add(c.id);
    }
    if (m.role === 'tool' && !called.has(m.toolCallId)) continue;
    out.push(m);
  }
  return out;
}

// Corte por número de mensagens, preservando o OBJETIVO da sessão.
// O corte antigo era um slice puro da cauda, e a cauda descarta a cabeça — e a
// cabeça é justamente a primeira mensagem do usuário, a que diz o que a sessão
// veio fazer. Esse caminho não é raro: o resumo só dispara acima de
// COMPACT_TRIGGER_TOKENS, então uma sessão com MUITA mensagem curta (o padrão de
// quem itera em passos pequenos) passa de HISTORY_MAX sem nunca chegar ao
// gatilho do resumo, e o executor perde o objetivo original enquanto acha que
// está com o contexto inteiro. Quando a âncora sai no corte, ela volta como
// bloco de contexto explícito na frente da cauda.
function capHistory(messages) {
  if (messages.length <= HISTORY_MAX) return messages;
  const tail = messages.slice(messages.length - HISTORY_MAX);
  const anchor = messages.find((m) => m.role === 'user' && typeof m.content === 'string' && m.content.trim());
  if (!anchor || tail.includes(anchor)) return tail;
  return [{ role: 'user', content: `[OBJETIVO ORIGINAL DESTA SESSÃO DE CÓDIGO]\n${anchor.content.slice(0, 2000)}` }, ...tail];
}

// ── Compactação por RESUMO (igual Claude Code) ──
// Colapsar blob corta o TAMANHO das leituras/escritas antigas, mas o histórico
// cru continua em `contents` (que o Gemini NÃO cacheia) e cresce turno a turno,
// derrubando o cache hit. A compactação por resumo troca todo o histórico velho
// por um único bloco "estado do trabalho até aqui" + a última resposta, encolhendo
// `contents` de dezenas de milhares de tokens pra alguns milhares. É o passo que
// recupera o cache e o que fecha a diferença pro Claude Code.
// Gatilho ALTO de propósito. O colapso de blob (collapseHistoryBlobs) já encolhe
// o conteúdo pesado sem custo de chamada extra; o resumo só compensa a chamada de
// resumo quando o histórico é MUITO longo (aquele cenário, centenas de passos),
// onde mesmo os stubs colapsados + as msgs recentes somam muito. O bench de 6
// turnos mostrou que disparar cedo (8k) piora vs só-colapso (a chamada de resumo
// não se paga nessa escala). Acima deste teto (contents já colapsados), o resumo
// vira o único jeito de estancar. Tunável por env sem redeploy.
const COMPACT_TRIGGER_TOKENS = Number(process.env.CODING_COMPACT_TRIGGER) || 30000; // aprox tokens
const estMsgTokens = (m) => {
  if (!m) return 0;
  let chars = (typeof m.content === 'string' ? m.content.length : 0);
  if (Array.isArray(m.toolCalls)) { try { chars += JSON.stringify(m.toolCalls).length; } catch {} }
  return Math.ceil(chars / 4);
};
const estHistoryTokens = (messages) => messages.reduce((a, m) => a + estMsgTokens(m), 0);

const COMPACT_SYSTEM = [
  'Você resume o ESTADO de um trabalho de código em andamento pra ele continuar',
  'sem carregar todo o histórico. Produza um resumo COMPACTO e factual, em',
  'tópicos, com só o que o executor precisa pra seguir:',
  '• Objetivo geral do trabalho e o que já foi FEITO (arquivos criados/mexidos,',
  '  comandos rodados, o que foi publicado e onde).',
  '• Estado atual relevante (estrutura/arquivos que importam, decisões tomadas,',
  '  fatos aprendidos do código). NÃO cole conteúdo de arquivo inteiro; descreva.',
  '• O que ficou PENDENTE ou por confirmar, se algo ficou.',
  'Não invente nada que não esteja no histórico. Seja econômico.',
].join('\n');

// Monta um transcript curto do histórico pra alimentar o resumo (trunca blobs).
function transcriptOf(messages) {
  const line = (m) => {
    if (!m || !m.role) return '';
    if (m.role === 'user') return `USUÁRIO: ${String(m.content || '').slice(0, 1200)}`;
    if (m.role === 'tool') return `RESULTADO(${m.name || 'tool'}): ${String(m.content || '').slice(0, 800)}`;
    if (m.role === 'assistant') {
      const calls = Array.isArray(m.toolCalls) && m.toolCalls.length
        ? ` [chamou: ${m.toolCalls.map((c) => c.name).join(', ')}]` : '';
      return `ASSISTENTE: ${String(m.content || '').slice(0, 1200)}${calls}`;
    }
    return '';
  };
  return messages.map(line).filter(Boolean).join('\n');
}

// Resume o histórico num único bloco e devolve a nova sessão compacta:
// [ {user: resumo}, {assistant: última resposta} ] — sequência válida (o próximo
// turno acrescenta um user, mantendo a alternância). Em falha, devolve null e o
// caller mantém o comportamento anterior (cap + colapso).
async function compactHistory({ messages, provider, onUsage }) {
  try {
    const transcript = transcriptOf(messages);
    if (!transcript.trim()) return null;
    const res = await provider.complete({
      system: COMPACT_SYSTEM,
      messages: [{ role: 'user', content: `Histórico do trabalho de código até aqui:\n\n${transcript}\n\nResuma o ESTADO conforme as instruções.` }],
      tools: [],
    });
    if (res?.usage && onUsage) { try { onUsage({ ...res.usage, kind: 'compact', noBill: true }); } catch {} }
    const resumo = (res?.text || '').trim();
    if (!resumo) return null;
    // preserva a última resposta em texto do assistente (o passo mais fresco)
    const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant' && typeof m.content === 'string' && m.content.trim() && !(Array.isArray(m.toolCalls) && m.toolCalls.length));
    const out = [{ role: 'user', content: `[CONTEXTO] Resumo do trabalho de código até aqui:\n${resumo}` }];
    if (lastAssistant) out.push({ role: 'assistant', content: lastAssistant.content });
    return out;
  } catch { return null; }
}

// System enxuto do sub-agente de coding. Só o essencial: ele é um executor de
// tarefa de código com ferramental próprio; o principal já cuidou de persona,
// canal, memória. Nada disso precisa ser reenviado aqui.
export const CODING_SUBAGENT_SYSTEM = [
  'Você é o executor de tarefas de CÓDIGO de um assistente. Recebe um objetivo',
  'de programação (mexer num app, projeto, servidor ou sandbox) e o cumpre',
  'usando as ferramentas disponíveis: ler/listar/buscar no código, editar/',
  'escrever arquivos, rodar comandos, publicar.',
  '',
  'Regras:',
  '• Trabalhe de forma incremental: leia o que precisa ANTES de editar; não',
  '  reescreva um arquivo inteiro quando uma edição pontual resolve.',
  '• Leia só o trecho relevante (use faixa de linhas / busca), não o arquivo',
  '  inteiro, e NÃO releia o que você já leu neste trabalho.',
  '• Seja econômico: cada passo reenvia o contexto. Vá direto ao ponto.',
  '• DADO DO DONO NUNCA SAI DA NOSSA INFRA (inegociável): é PROIBIDO subir,',
  '  hospedar ou espelhar arquivo, foto, documento ou dado do usuário em',
  '  serviço de TERCEIRO — host temporário/anônimo (catbox, litter.catbox,',
  '  file.io, transfer.sh, 0x0.st, gofile, tmpfiles, wetransfer, imgur),',
  '  paste/gist, bucket ou repositório que não seja nosso, webhook de fora.',
  '  Vale mesmo que expire em minutos, seja "privado" ou seja só um passo',
  '  intermediário pra trazer o arquivo pro sandbox: no instante do upload o',
  '  dado saiu do nosso controle, e isso é vazamento. A internet daqui é pra',
  '  BAIXAR (pacote, página), nunca pra SUBIR dado do dono.',
  '• Se a tarefa só fecha passando por fora, ela NÃO fecha: pare e responda que',
  '  falta um caminho interno pra mover o arquivo. Preferir falhar a improvisar.',
  '• Ao terminar (ou travar), responda em TEXTO curto: o que fez, o resultado',
  '  concreto (arquivos mexidos, comando rodado, URL publicada) e o que falta,',
  '  se algo faltar. Esse texto é o que volta pro assistente principal — ele',
  '  não vê os passos intermediários nem a saída crua das ferramentas.',
].join('\n');

// ── System do sub-agente de BUILD DE APP ───────────────────────────────────
// Segunda instância do MESMO motor (runCodingSubagent), com outro system e
// outro registry — é o "carrega o plugin duas vezes com toolName diferente" do
// dsh. O que muda em relação ao `codar`: aqui o alvo é sempre um app do dono no
// subdomínio dele, e as ações IRREVERSÍVEIS (publicar, apagar, replicar, voltar
// versão, remover) NÃO existem neste registry — são decisão do dono, e o gate de
// confirmação vive no turno principal, não num sub-agente. O sub termina o
// rascunho e RELATA o que falta confirmar (mesma disciplina do dsh: filho
// reporta a limitação, pai decide perguntar ao humano).
export const APP_SUBAGENT_SYSTEM = () => [
  `Você é o CONSTRUTOR DE APPS de um assistente do ${marca().nome}. Recebe um objetivo`,
  '(criar ou mudar um app web do dono, publicado no subdomínio dele) e o executa',
  'com as ferramentas de arquivo do app. Persona, canal e conversa já são cuidados',
  'pelo assistente principal; aqui é execução.',
  '',
  'O QUE ESTÁ NA SUA MÃO — E O QUE NÃO ESTÁ:',
  '• Você mexe no RASCUNHO do app: criar estrutura, listar/ler/escrever/editar',
  '  arquivos, definir segredos, ver logs, diff e histórico.',
  '• PUBLICAR, apagar, replicar, voltar versão e remover arquivo/segredo são',
  '  decisão do DONO e não estão na sua mão (as ferramentas nem existem aqui).',
  '  Termine o trabalho no rascunho e DIGA no relatório que falta publicar. Não',
  '  tente contornar por outro caminho: quem fala com o dono é o principal.',
  '',
  'FLUXO:',
  '• Mudar app que já existe: ler_arquivo_do_app (listar_arquivos_do_app se não',
  '  souber os nomes) → editar_arquivo_do_app pra mudança pontual (várias mudanças',
  '  no mesmo arquivo: mande a lista "edicoes" numa chamada só, é atômico).',
  '  escrever_arquivo_do_app só pra arquivo NOVO ou reescrita completa. NUNCA',
  '  reconstrua um app do zero.',
  '• App node NOVO: chame iniciar_estrutura_do_app ANTES (cria o esqueleto pronto)',
  '  e só preencha.',
  '• ESPEC.md (memória do app): todo app tem um ESPEC.md na raiz com o que o dono',
  '  JÁ TESTOU E APROVOU. Leia ANTES da primeira edição (se não existir, crie junto',
  '  com a primeira mudança) e registre lá o que for aprovado, em bullets curtos.',
  '  O que está lá é CONTRATO: não altere comportamento aprovado sem o objetivo',
  '  pedir. Regressão do que o dono já validou é o erro mais grave que existe.',
  '• Iterações pequenas e arquivos PEQUENOS e separados (HTML, CSS, JS, rotas em',
  '  arquivos distintos): arquivo enxuto é fácil de editar por trecho e não estoura',
  '  o teto de saída. Cerque o escopo: ideia extra que ninguém pediu não entra.',
  '• NÃO re-inspecione o que você acabou de escrever: o retorno de escrever/editar',
  '  JÁ é a confirmação (ok, bytes, hash). Não releia arquivo que você mesmo gravou,',
  '  nem fique listando arquivos entre uma edição e outra.',
  '• Depurar: leia o código ANTES de qualquer diagnóstico; só chame com',
  '  chamar_sistema uma rota que você CONFIRMOU que existe lendo os arquivos de rota',
  '  (rota inexistente devolve vazio e NÃO é bug do app); ver_logs_sistema mostra o',
  '  erro real de runtime. Atenção: chamar_sistema bate no que está NO AR (última',
  '  versão publicada), não no seu rascunho.',
  '',
  'REGRAS DE CÓDIGO (invioláveis):',
  '• NÃO existe passo de instalação de dependência: use só biblioteca padrão. Node =',
  '  módulos nativos (http, fs, path, crypto, url) e, pra banco, o SQLite embutido:',
  "  require('node:sqlite') + new DatabaseSync(caminho) (API igual à do",
  '  better-sqlite3). NUNCA better-sqlite3, express ou qualquer pacote npm — o',
  '  require falha e o app não sobe. Flask = flask, gunicorn e sqlite3, nada além.',
  "• Dado persistente sempre em /app/data (crie a pasta antes: fs.mkdirSync('/app/data',{recursive:true})).",
  '• CAMINHOS RELATIVOS no front (crítico): o app é servido num SUBCAMINHO, não na',
  '  raiz do domínio. Use href="style.css", src="core.js", fetch(\'api/status\') —',
  '  NUNCA com barra no começo (com barra o navegador busca na raiz e dá 404).',
  '  Dentro do server.js/app.py as rotas ficam na raiz normalmente.',
  '• SEGREDO NUNCA NO CÓDIGO (o publish recusa se achar): guarde com definir_segredo',
  '  (cofre cifrado, injetado como env no boot) e no código use process.env.NOME',
  '  (Node) / os.environ["NOME"] (Flask).',
  '• O DADO DO APP TAMBÉM É DO ASSISTENTE: se o app guarda dado, já deixe desde o',
  '  começo uma rota de leitura que o assistente alcança (protegida por um segredo do',
  '  cofre, no cabeçalho), pra ele nunca ficar trancado do lado de fora do dado do',
  '  próprio dono. NUNCA desenhe algo que exija pedir senha/token do app ao dono.',
  '• Se o app mostra dado PESSOAL, ele precisa de acesso protegido: a URL fica',
  '  acessível a quem tiver o link.',
  '',
  '• DADO DO DONO NUNCA SAI DA NOSSA INFRA (inegociável): é PROIBIDO subir,',
  '  hospedar ou espelhar arquivo, foto, documento ou dado do usuário em serviço de',
  '  TERCEIRO — host temporário/anônimo (catbox, file.io, transfer.sh, 0x0.st,',
  '  gofile, tmpfiles, wetransfer, imgur), paste/gist, bucket ou repositório que não',
  '  seja nosso, webhook de fora. Vale mesmo que expire em minutos, seja "privado"',
  '  ou seja só um passo intermediário. Se a tarefa só fecha passando por fora, ela',
  '  NÃO fecha: pare e relate.',
  '',
  'Antes de terminar, chame validar_rascunho_do_app após a última edição. Corrija seus diagnósticos exatos e revalide. Essa tool não publica nem valida boot/UX. Nunca anuncie conclusão funcional só pelo lint.',
  'Leituras grandes retornam páginas: avance com proximo_inicio e hash_esperado; não releia a primeira página em loop nem grave um fragmento como arquivo inteiro.',
  'RELATÓRIO FINAL: ao terminar (ou travar), responda em TEXTO curto e factual —',
  'o que fez, quais arquivos mexeu, e o que falta (em especial se falta PUBLICAR',
  'pra ir ao ar). Esse texto é a ÚNICA coisa que volta pro assistente principal:',
  'ele não vê seus passos nem a saída crua das ferramentas. Escreva pro assistente,',
  'não pro dono.',
].join('\n');

// Executa uma rodada do sub-agente de coding sobre uma sessão persistente.
//   objetivo   — o que fazer (o principal descreve com contexto; o sub não vê a conversa)
//   tools      — ToolRegistry já montado com o ferramental de código
//   provider   — provider forte (coding precisa do modelo bom)
//   sessionKey — `${agentId}:${threadId}` (persiste o history entre turnos)
//   system     — override do system (default CODING_SUBAGENT_SYSTEM)
//   maxSteps   — teto de passos do loop
//   onUsage    — recebe cada usage pra cobrança (kind='subagent')
//   onEvent    — encaminha eventos (tool_call etc.) pra narração ao vivo
//   nowMs      — relógio injetável (testes)
export async function runCodingSubagent({
  objetivo, tools, provider, sessionKey,
  system = CODING_SUBAGENT_SYSTEM, maxSteps = 40,
  onUsage, onEvent, nowMs = Date.now(),
  compact = process.env.CODING_COMPACT !== '0', structured = false,
}) {
  if (!objetivo || !String(objetivo).trim()) return 'ERRO: objetivo vazio.';
  gcSessions(nowMs);
  let sess = sessionKey ? sessions.get(sessionKey) : null;
  if (!sess) {
    sess = { history: [], lastUsed: nowMs };
    if (sessionKey) sessions.set(sessionKey, sess);
  }
  sess.lastUsed = nowMs;

  const buildState = structured ? createBuildState() : null;
  const { text, messages, usages, termination } = await runAgent({
    provider,
    tools,
    system,
    userInput: String(objetivo),
    history: sess.history,
    maxSteps,
    onEvent: ev => { buildState?.event(ev); onEvent?.(ev); },
  });

  // Persiste o history do sub (sem imagens; coding não usa), colapsa blobs
  // antigos (higiene entre chamadas) e o poda pelo teto de mensagens.
  const hist = messages.filter((m) => m && m.role);
  for (const m of hist) if (m.images) delete m.images;
  collapseHistoryBlobs(hist);
  // Compactação por resumo: se o history (já colapsado) ainda passa do limiar,
  // troca-o por um único bloco "estado do trabalho" + a última resposta. Isso
  // encolhe os `contents` (não cacheáveis) que cresciam turno a turno e derrubavam
  // o cache hit. Em falha do resumo, cai no cap por nº de mensagens (comportamento
  // anterior), então nunca fica pior. Rodamos ANTES do cap pra o resumo enxergar
  // todo o history.
  let compacted = null;
  if (compact && estHistoryTokens(hist) > COMPACT_TRIGGER_TOKENS) {
    compacted = await compactHistory({ messages: hist, provider, onUsage });
  }
  // O que for guardado passa pela costura do par chamada/resultado: é o que
  // sobra da poda que vai virar o `history` da próxima chamada, então é aqui que
  // um resultado órfão precisa morrer, antes de envenenar a sessão inteira.
  if (compacted) sess.history = compacted;
  else sess.history = dropOrphanToolMessages(capHistory(hist));
  sess.lastUsed = Date.now();

  if (onUsage && Array.isArray(usages)) {
    for (const u of usages) { try { onUsage({ ...u, kind: 'subagent' }); } catch {} }
  }
  return buildState ? buildState.finish({ text, termination }) : text || 'A chamada de código terminou sem resumo textual; conclusão não confirmada.';
}

// Descarta a sessão de coding de uma thread (ex.: sair do projeto/app, reset).
export function resetCodingSession(sessionKey) {
  if (sessionKey) sessions.delete(sessionKey);
}

// Fábrica da meta-tool `codar` pro registry do PRINCIPAL. Recebe uma closure
// que monta (lazy) o registry de coding + provider quando a tool é chamada, pra
// não pagar a montagem em turno que não coda.
// `language` = idioma do dono. O relatório do sub-agente volta pro principal,
// mas pedaços dele (resumo, perguntas) chegam à pessoa quase literais.
export function makeCodarTool({ buildCodingContext, sessionKey, executionId, onUsage, onEvent, compact, extra, taskStore, targetIdentity, authorize, shouldPause, dispatch, language }) {
  return {
    name: 'codar',
    description: [
      'Runs a PROGRAMMING/CODE task by delegating it to a specialized',
      'sub-agent that has the code tooling (read/edit files,',
      'run commands, publish app/project/server). Use it for ANY code',
      'work: changing a user\'s app, a dev project, the connected',
      'server or the sandbox. The sub-agent does NOT see the conversation — describe the',
      'goal with context (which app/project, what to change, expected result).',
      'It keeps its own work session across calls, so it can',
      'continue ("now adjust the header CSS") without repeating everything. Returns only',
      'the summary of what it did; the raw tool output stays in the sub-agent.',
      // When the sub has an extra transport mounted (today: the owner's local
      // machine via the Brambit Runner), the description must SAY so: otherwise
      // the only terminal door advertises itself as "code only" and the main agent
      // answers "I can't access your machine" with the capability mounted (25/08).
      ...(dispatch?['In this channel, it returns a receipt of a task in progress, not a completion. The worker saves the result in the conversation when it finishes. For progress use consultar_programacao; do not ask to continue because of an operational window.']:[]),
      ...(extra ? [String(extra)] : []),
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        objetivo: {
          type: 'string',
          description: 'The code task, with context (the sub-agent does not see the conversation). E.g.: "in the lista-de-compras app, add an export CSV button on the main screen", "in the api project, fix the bug in the /users endpoint that returns 500".',
        },
      },
      required: ['objetivo'],
    },
    run: async ({ objetivo }) => {
      if (!objetivo || !String(objetivo).trim()) return 'ERRO: objetivo vazio.';
      try {
        if(dispatch)return await dispatch({objetivo});
        const { tools, provider } = await buildCodingContext();
        if(taskStore){
          if(typeof provider.completeDurable!=='function')throw Error('Contabilização durável indisponível; execução não iniciada.');
          return await runCodingTask({store:taskStore,executionId,scope:JSON.stringify(['advanced',sessionKey,targetIdentity]),target:targetIdentity,
            objetivo,tools,provider,system:comIdioma(CODING_SUBAGENT_SYSTEM,language),authorize,onUsage,onEvent,shouldPause});
        }
        return await runCodingSubagent({
          objetivo, tools, provider, sessionKey, onUsage, onEvent,
          system: comIdioma(CODING_SUBAGENT_SYSTEM, language),
          ...(compact === undefined ? {} : { compact }),
        });
      } catch (e) {
        return `ERRO ao executar a tarefa de código: ${e?.message ?? e}`;
      }
    },
  };
}

// Fábrica da meta-tool `construir_app` pro registry do PRINCIPAL. Mesma forma da
// makeCodarTool (mesmo motor, outra instância): o que muda é o system, o registry
// que a closure monta e a sessionKey (`:app`, separada da sessão do `codar`).
// É por AQUI que o modelo forte entra — num contexto novo e limpo. O turno
// principal não troca de modelo em momento nenhum.
export function makeConstruirAppTool({ buildAppContext, sessionKey, executionId, onUsage, onEvent, compact, onAppTarget, taskStore, shouldPause, userRequest, dispatch, language }) {
  return {
    name: 'construir_app',
    description: [
      'When resuming, use the CURRENT request, do not copy the old goal. If the mode changes, propose gerenciar_tarefa_de_app atualizar_escopo; do not cancel the task nor repeat the old review. It also reviews code: use modo revisao to check without editing; modo edicao only when the user asks for changes. app is required in the durable executor. For collaboration provide dono. ',
      'Builds or modifies a user\'s WEB APP (on their subdomain) by delegating to',
      'a specialized sub-agent, which has the app file tooling (create',
      'structure, read/write/edit files, secrets, logs, diff, history).',
      'Use it ALWAYS when the request is to create, change, fix, add or remove something',
      'in a user\'s app — it is the default path; never rebuild from scratch nor try',
      'to do it via sandbox, SSH or GitHub.',
      'The sub-agent does NOT see the conversation: describe the goal with context (WHICH app,',
      'what exactly to change, expected result). It keeps its own work',
      'session across calls, so you can continue ("now adjust the',
      'header CSS") without repeating everything.',
      'It works on the DRAFT and does NOT publish: when it finishes, you are the one who puts it live,',
      'by calling publicar_sistema (which asks for the owner\'s confirmation). Structured state, validation and summary come back;',
      'of what was done; the raw tool output stays in the sub-agent.',
      ...(dispatch?['In this channel, it initially returns a receipt of a task in progress. The result will be saved in the conversation; do not confuse the task record with a completed edit or a publish.']:[]),
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        modo:{type:'string',enum:['revisao','edicao'],description:'revisao (default): read-only. edicao: only if the user asked to change/create code.'},
        dono:{type:'string',description:'Owner of the shared app, when applicable.'},
        arquivos_revisao:{type:'array',minItems:1,maxItems:50,items:{type:'string'},description:'Only when the request restricts the review to specific files, pass those paths along. Without a restriction, omit it: the review covers the app files. Do not shrink the request to appear complete.'},
        objetivo: {
          type: 'string',
          description: 'What to build/change in the app, with context (the sub-agent does not see the conversation). E.g.: "in the lista-de-compras app, add an export CSV button on the main screen", "create a new plant tracking app with watering log and history".',
        },
        app: {
          type: 'string',
          description: 'Name of the target app. In the durable executor it is required, including to create a new app: pick a short name or ask if there is ambiguity.',
        },
      },
      required: taskStore ? ['objetivo','modo','app'] : ['objetivo'],
    },
    run: async ({ objetivo, app, modo = 'revisao', dono, arquivos_revisao }) => {
      if (!objetivo || !String(objetivo).trim()) return 'ERRO: objetivo vazio.';
      try {
        if(dispatch){
          if(!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(String(app||'').trim())||!['revisao','edicao'].includes(modo))return 'ERRO: informe app e modo válidos antes de iniciar.';
          const record=await taskStore?.read?.(JSON.stringify([sessionKey,app,dono||'']));
          if(record&&!['completed','cancelled'].includes(record.status)&&record.mode!==modo)return scopeConflict(record.mode,'mode_conflict',record.id);
          if(modo==='revisao'&&reviewRequestNeedsClarification(userRequest)||modo==='edicao'&&editRequestNeedsClarification(userRequest))return scopeConflict(modo,'scope_clarification',record?.id);
          if(typeof onAppTarget==='function')await onAppTarget(app);
          return await dispatch({objetivo,app,modo,arquivos_revisao,dono});
        }
        const { tools, provider } = await buildAppContext();
        const nomeAlvo = app && String(app).trim() ? String(app).trim() : '';
        // Quando o principal JÁ sabe qual app é, avisa o hosting: assim a PRIMEIRA
        // escrita do sub-agente já sai com o app certo, sem ele ter que repetir o
        // slug em cada chamada (pedido de um usuário).
        if (nomeAlvo && typeof onAppTarget === 'function') {
          try { onAppTarget(nomeAlvo); } catch {}
        }
        if(taskStore) {
          if(!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(nomeAlvo))return 'ERRO: informe o app alvo explícito antes de iniciar a tarefa.';
          // Pin every hosting operation to this task target, including collaborators.
          const scoped=new tools.constructor();
          for(const t of tools.map.values())scoped.add({...t,
            run:args=>t.run({...args,nome_do_sistema:nomeAlvo,dono}),
            ...(t.repeatRevision?{repeatRevision:args=>t.repeatRevision({...args,nome_do_sistema:nomeAlvo,dono})}:{})});
          return await runAppTask({store:taskStore,executionId,scope:JSON.stringify([sessionKey,nomeAlvo,dono||'']),objetivo,mode:modo,reviewFiles:arquivos_revisao,userRequest,
            tools:scoped,provider,system:comIdioma(APP_SUBAGENT_SYSTEM(),language),onUsage,onEvent,shouldPause});
        }
        const alvo = nomeAlvo ? `App alvo: ${nomeAlvo}\n\n` : '';
        return await runCodingSubagent({
          objetivo: `${alvo}${objetivo}`, tools, provider, sessionKey,
          system: comIdioma(APP_SUBAGENT_SYSTEM(), language), onUsage, onEvent, structured:true,
          ...(compact === undefined ? {} : { compact }),
        });
      } catch (e) {
        return `ERRO ao construir o app: ${e?.message ?? e}`;
      }
    },
  };
}
