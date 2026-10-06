import { retainedSearchPage } from './search-page.mjs';
import { REVISION_READS, callSignature } from './repetition.mjs';
// ── Core harness (model-agnostic) ──
// Dono do tool-loop e do estado de mensagens. Roda QUALQUER provider que
// satisfaça o contrato em provider.mjs. ~50 linhas de lógica de verdade.

import { retainedFilePage } from './file-page.mjs';
import { STOP } from './provider.mjs';
import { protocolCode, CODING_TOOLS, codingAvailable, CODING_EXECUTION_POLICY, protocolRepairFor, PROMISE_REPAIR,
  codingPromise, codingTurnContext, codingFallback, protocolFallback, executionSignature } from './turn-recovery.mjs';

// Sanitiza texto que entra no history/nas mensagens: remove surrogates UTF-16
// SOLTOS (um par de emoji cortado no meio por um .slice()) e o caractere NUL.
// Sem isso, um único code point inválido faz o parser JSON do provider (ex.: o
// Go da Together, "unexpected end of hex escape") E o Postgres jsonb ("invalid
// input syntax for type json") rejeitarem a mensagem inteira, e a resposta some.
const REPLACEMENT = String.fromCharCode(0xFFFD);
const NUL = String.fromCharCode(0);
function sanitizeText(s) {
  if (typeof s !== 'string') return s;
  return s
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, REPLACEMENT) // high surrogate sem par
    .replace(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, REPLACEMENT) // low surrogate sem par
    .split(NUL).join('');
}

// Resultado de tool -> texto pro modelo. String passa direto. Objeto/array vira
// JSON (senão `String(obj)` colapsava tudo em "[object Object]" e o modelo ficava
// CEGO ao conteúdo — o que quebrava justamente as tools de app que devolvem
// objeto: listar_arquivos_do_app, ler_arquivo_do_app, publicar_sistema, ...).
function toToolText(out) {
  if (out == null) return '';
  if (typeof out === 'string') return out;
  try { return JSON.stringify(out); }
  catch { return String(out); } // fallback: circular/serialização impossível
}

// Progressive disclosure DENTRO do turno. Um turno de build chama o modelo várias
// vezes (ler → pensar → escrever → publicar → ver log) e CADA resultado grande
// (conteúdo de ler_arquivo_do_app, args de escrever_arquivo_do_app) fica no working
// set e é RE-ENVIADO ao modelo em todo passo seguinte do MESMO turno — foi o que
// levou o tok_in a 150k-210k por chamada e um turno inteiro a 2,4M tokens no build
// de um usuário (app.js de 123k lido/reenviado dezenas de vezes num turno de 23
// passos). Antes de cada nova chamada colapsamos os blobs ANTIGOS deste turno num
// marcador curto (mantendo os mais recentes intactos, que o modelo ainda pode
// precisar). É o que o Claude Code faz (context editing / clear tool results).
//
// thoughtSignature do Gemini 3: a assinatura vive no `c.meta.thoughtSignature`
// (o provider a reemite como uma PART separada do functionCall, não dentro dos
// args — ver gemini.mjs). Colapsar o VALOR de um arg NÃO toca o meta, então a
// assinatura fica intacta. Verificado ao vivo contra o gemini-3.7-flash: colapsar
// os args do assistant mantendo o meta NÃO dá 400 de thought_signature. Por isso
// colapsamos os DOIS lados em todo provider: o resultado de tool (role:'tool', a
// LEITURA do arquivo) E os args do assistant (role:'assistant', a ESCRITA do
// arquivo). Naquele build a escrita era o que mais pesava: o modelo
// reescreve o arquivo inteiro a cada passo (out de 10k-16k) e esses args ficavam
// circulando no input, que crescia 53k->111k dentro do MESMO turno. ANTES o trim
// inteiro era pulado no gemini (primário), depois colapsava só a leitura; agora
// colapsa a escrita também, que era o grosso.
const TURN_BLOB_MAX = 2000;   // chars; acima disso é blob que vale colapsar
const TURN_KEEP_RECENT = 4;   // últimas N mensagens do turno nunca são colapsadas

// Teto pros blobs DENTRO da janela recente. As últimas TURN_KEEP_RECENT
// mensagens não são colapsadas (o modelo ainda está trabalhando nelas), mas
// também não podem ser ilimitadas: um `ler_arquivo_do_app` de 100k ou uma
// saída de terminal gigante circula INTEIRA a cada passo enquanto está na
// janela. Cortamos head+tail (começo tem o que importa: shebang/imports/
// estrutura; fim tem o erro/resultado) com marcador explícito no meio. 24k
// chars ≈ 6k tokens por blob recente — grande o bastante pra qualquer arquivo
// de app razoável passar inteiro, pequeno o bastante pra não dominar o input.
const TURN_RECENT_MAX = 24000;  // chars; teto de blob na janela recente
const TURN_RECENT_HEAD = 15800; // chars mantidos do começo
const TURN_RECENT_TAIL = 8000;  // chars mantidos do fim
// HEAD+TAIL+marcador < TURN_RECENT_MAX de propósito: o resultado do corte fica
// abaixo do teto, então a segunda passada não retoca (idempotente).
function capRecentBlob(s) {
  if (typeof s !== 'string' || s.length <= TURN_RECENT_MAX) return s;
  const cut = s.length - TURN_RECENT_HEAD - TURN_RECENT_TAIL;
  return s.slice(0, TURN_RECENT_HEAD) + `\n…[cortado: ${cut} chars]…\n` + s.slice(s.length - TURN_RECENT_TAIL);
}

// Freio anti-loop DENTRO do turno. Se o modelo reemite uma chamada IDÊNTICA
// (mesma tool + mesmos args) repetidas vezes, ele está preso: o resultado já
// está no working set e rechamar não avança (ex.: tentar aplicar de novo um
// editar_arquivo_do_app cujo trecho já foi substituído → "não encontrado" →
// tenta de novo). Isso queimou passos/crédito naquele build. Ao atingir
// REPEAT_LIMIT chamadas idênticas, cortamos pro salvage em vez de gastar o resto
// do teto de passos. É o que permite subir maxSteps com segurança nos turnos de
// build sem risco de loop infinito.
const REPEAT_LIMIT = 3;       // 3ª chamada idêntica = preso; corta pro salvage

// Mensagem que chega NO MEIO do turno (o usuário manda outra antes de a primeira
// ser respondida). Antes ela era invisível pro turno em andamento: o agente
// entregava a resposta da primeira em full — mesmo já obsoleta — e só então rodava
// um segundo turno pra segunda. Agora ela é injetada nas fronteiras de passo, do
// jeito que o Claude Code faz: o modelo lê e decide se ajusta, abandona ou segue.
// Teto por turno pra uma rajada de mensagens não virar contexto infinito nem
// impedir o turno de fechar; o que passar do teto fica pro turno seguinte.
const MAX_INTERJECTIONS = 3;
// Injetada como role:'user' (mesmo idioma da nota de estado abaixo). O aviso de
// "uma resposta só" é essencial: sem ele o modelo tende a responder a mensagem 1,
// depois a 2, e o usuário recebe dois blocos pro que era uma conversa.
const INTERJECT_PREFIX = '[o usuário mandou esta mensagem AGORA, no meio do seu trabalho — ela é mais recente que tudo acima]';
const INTERJECT_SUFFIX = 'Decida antes de continuar: se isso muda o que você estava fazendo, ajuste ou abandone o rumo anterior; se não muda, siga. Entregue UMA resposta só no fim, contemplando tudo — não mande uma resposta por mensagem.';

// Nota de estado do turno interrompido. Quando um turno de build é cortado
// (teto de passos, loop, geração truncada), a "memória" do que já foi feito
// vivia só na cabeça do modelo — e o turno seguinte ("continua") partia de um
// contexto podado/compactado e REESCREVIA arquivos a partir de versões velhas
// (o incidente KhaosClass, 2×). Antes do salvage, injetamos uma mensagem
// DETERMINÍSTICA (montada em código, sem chamada de modelo) listando as tools
// já executadas neste turno com seus args-chave. Ela persiste no history, então
// a continuação sabe exatamente onde o turno anterior parou.
const STATE_NOTE_MAX_CALLS = 30; // teto de linhas na nota (turnos de 40 passos)
const STATE_NOTE_KEYS = ['nome_do_sistema', 'caminho', 'arquivo', 'comando', 'rotulo', 'host', 'versao', 'dono'];
function callHint(c) {
  const a = c?.args;
  if (!a || typeof a !== 'object') return '';
  const parts = [];
  for (const k of STATE_NOTE_KEYS) {
    const v = a[k];
    if (typeof v === 'string' && v.trim()) parts.push(`${k}=${v.trim().slice(0, 80)}`);
  }
  return parts.join(', ');
}
function buildStateNote(turnLog, motivo) {
  const extra = turnLog.length > STATE_NOTE_MAX_CALLS ? turnLog.length - STATE_NOTE_MAX_CALLS : 0;
  const linhas = turnLog.slice(-STATE_NOTE_MAX_CALLS)
    .map((t, i) => `${extra + i + 1}. ${t.name}${t.hint ? ` (${t.hint})` : ''}${t.falhou ? ' [FALHOU]' : ''}`);
  return `[ESTADO — turno interrompido]\n`
    + `Este turno foi cortado antes de fechar (motivo: ${motivo}). Ferramentas já executadas neste turno, em ordem`
    + `${extra ? ` (mostrando as últimas ${STATE_NOTE_MAX_CALLS} de ${turnLog.length})` : ''}:\n`
    + `${linhas.join('\n')}\n`
    + `Nota gerada automaticamente pelo sistema. Se o usuário pedir pra continuar, retome DESTE ponto: `
    + `não refaça o que já está feito e NUNCA reescreva um arquivo inteiro a partir de uma versão antiga da sua memória — `
    + `releia o estado atual (ler_arquivo_do_app / listar) antes de qualquer reescrita.`;
}

const callSig = callSignature;

function pruneTurnBlobs(messages, turnStart, providerName, consumedUpTo = Infinity, retainedToolResult = null) {
  // Colapsa blobs ANTIGOS do turno (além da janela recente) em todo provider.
  // Só tocamos o VALOR de args/content; o meta (thoughtSignature do gemini) fica
  // intacto, então a assinatura não é desassociada. providerName mantido na
  // assinatura por compat/log; hoje o tratamento é o mesmo pra todos.
  //
  // `consumedUpTo` = quantas mensagens o modelo JÁ VIU (tamanho do array na última
  // chamada a complete()). Nada além disso pode ser colapsado: os resultados de uma
  // rodada são empilhados no FIM do passo N e esta função roda no TOPO do passo N+1,
  // antes do complete(). Sem essa trava, uma rodada com mais de TURN_KEEP_RECENT
  // resultados grandes tinha os primeiros trocados por "Você já viu esse conteúdo
  // antes neste turno" — uma afirmação falsa, sobre um conteúdo que o modelo nunca
  // leu. O que ainda não foi consumido segue pro corte brando da janela recente
  // (capRecentBlob) e só vira stub no passo seguinte, depois de lido de fato.
  const lastKeep = Math.min(messages.length - TURN_KEEP_RECENT, consumedUpTo);
  for (let i = turnStart; i < lastKeep; i++) {
    const m = messages[i];
    if (!m) continue;
    if (m.role === 'tool' && typeof m.content === 'string' && m.content.length > TURN_BLOB_MAX) {
      m.content = retainedFilePage(m.content) || retainedSearchPage(m.content, m.name) || retainedToolResult?.(m) || `[resultado de ${m.name || 'tool'} recolhido pra poupar contexto (${m.content.length} chars). Você já viu esse conteúdo antes neste turno; siga com o que extraiu dele. Pra editar um arquivo, use a tool de patch com o trecho que você já tem, em vez de reler o arquivo inteiro. Só releia se o estado tiver mudado desde então.]`;
    } else if (m.role === 'assistant' && Array.isArray(m.toolCalls)) {
      for (const c of m.toolCalls) {
        if (!c || !c.args || typeof c.args !== 'object') continue;
        for (const k of Object.keys(c.args)) {
          const v = c.args[k];
          if (typeof v === 'string' && v.length > TURN_BLOB_MAX) c.args[k] = `[${v.length} chars omitidos pra poupar contexto]`;
        }
      }
    }
  }
  // Janela recente: não colapsa, mas TAMBÉM não é ilimitada — blobs acima de
  // TURN_RECENT_MAX levam corte head+tail com marcador (ver capRecentBlob).
  // Idempotente: uma mensagem já cortada fica ≤ TURN_RECENT_MAX e não é retocada.
  for (let i = Math.max(turnStart, lastKeep); i < messages.length; i++) {
    const m = messages[i];
    if (!m) continue;
    if (m.role === 'tool' && typeof m.content === 'string') {
      m.content = m.content.length > TURN_RECENT_MAX ? retainedSearchPage(m.content,m.name) || retainedToolResult?.(m) || capRecentBlob(m.content) : m.content;
    } else if (m.role === 'assistant' && Array.isArray(m.toolCalls)) {
      for (const c of m.toolCalls) {
        if (!c || !c.args || typeof c.args !== 'object') continue;
        for (const k of Object.keys(c.args)) c.args[k] = capRecentBlob(c.args[k]);
      }
    }
  }
}

/**
 * Registry de tools. As defs viram JSON Schema (mesmo shape que MCP usa),
 * então plugar um MCP server depois é trivial: só mapear suas tools pra cá.
 */
export class ToolRegistry {
  constructor() { this.map = new Map(); }
  add(tool) { this.map.set(tool.name, tool); return this; }
  get defs() {
    return [...this.map.values()].map(({ name, description, parameters }) => ({ name, description, parameters }));
  }
  // Failover after an unconfirmed provider call is allowed only while every
  // tool already attempted in this turn is explicitly declared read-only by
  // trusted server code. Missing metadata is deliberately unsafe (fail closed):
  // neither the model nor tool arguments can opt an operation into replay.
  providerFallbackSafe(name) { return this.map.get(name)?.readOnly === true; }
  revisionAware(name) { return REVISION_READS.has(name) && typeof this.map.get(name)?.repeatRevision === 'function'; }
  async repetitionKey(name, args) {
    if (!this.revisionAware(name)) return null;
    try {
      const revision = await this.map.get(name).repeatRevision(args ?? {});
      return typeof revision === 'string' && /^[a-f0-9]{64}$/.test(revision) ? revision : null;
    } catch { return null; } // Failure cannot invent progress or waive the guard.
  }
  async run(name, args) {
    const t = this.map.get(name);
    if (!t) return `ERRO: tool desconhecida "${name}"`;
    try { return await t.run(args ?? {}); }
    catch (e) {
      if(e?.constructor?.name==='ExecutionCreditError' && e.creditStop) return {creditStop:e.creditStop,text:e.creditStopText,unavailable:true};
      return `ERRO ao executar ${name}: ${e?.message ?? e}`;
    }
  }
}

/**
 * O loop. Idêntico pra todo modelo. Troque `provider` e tudo continua igual.
 * `history` permite continuar uma conversa (chat multi-turno): passe as
 * messages devolvidas na chamada anterior.
 * `images` (opcional) anexa imagens à mensagem do usuário DESTE turno (visão):
 * cada item { mimeType, data(base64) }. Só o provider que suporta multimodal as
 * usa; o caller deve removê-las antes de persistir o history (não re-enviar).
 * `pollNewUserMsg` (opcional) é o canal de mensagem-no-meio-do-turno: uma função
 * (async) que devolve `null` ou `{ text }` com o que o usuário mandou DEPOIS que
 * este turno já começou. É consultada em cada fronteira de passo e antes de
 * entregar a resposta — o modelo vê a mensagem nova e decide se muda de rumo, em
 * vez de o usuário receber a resposta obsoleta e só depois a nova.
 * @param {{ provider, tools:ToolRegistry, system:string, userInput:string,
 *           images?:{mimeType:string,data:string}[], history?:object[],
 *           maxSteps?:number, onEvent?:(e:object)=>void,
 *           transformToolResult?:((call:object,out:unknown)=>unknown)|null,
 *           pollNewUserMsg?:(()=>Promise<{text:string}|null>)|null,
 *           allowCreditFailover?:boolean }} opts
 */
export async function runAgent({ provider, tools, system, userInput, images, history = [], maxSteps = 12, onEvent = () => {}, pollNewUserMsg = null, transformToolResult = null, initialToolLog = [], control = null, salvage = true, allowCreditFailover = false, retainedToolResult = null, promiseClassifier = null }) {
  const userMsg = { role: 'user', content: sanitizeText(userInput) };
  if (images?.length) userMsg.images = images;
  const messages = [...history, userMsg];
  // Uso/custo de cada chamada ao provider neste turno (1 turno pode ter N chamadas
  // por causa do tool-loop). O caller persiste isso com as dimensões (usuário,
  // conversa, tipo). O provider preenche res.usage; aqui só acumulamos.
  const usages = [];
  // Fontes da busca nativa do provider (grounding), acumuladas do turno inteiro e
  // sem repetir URL. O provider preenche res.sources; o caller decide se mostra.
  const sources = [];
  const sourceSeen = new Set();
  const coletarFontes = (res) => {
    for (const s of res?.sources ?? []) {
      if (s?.uri && !sourceSeen.has(s.uri)) { sourceSeen.add(s.uri); sources.push(s); }
    }
  };
  let turnStart = messages.length; // só blobs GERADOS neste turno são colapsados
  let consumedUpTo = messages.length; // quantas mensagens o modelo já viu (ver pruneTurnBlobs)
  const sigCounts = new Map(); // freio anti-loop: contagem de chamadas idênticas
  let emptyEnd = false; // fim SEM texto (seco ou truncado no teto de saída) -> vai pro salvage, nunca devolve branco
  let loopBreak = false; // cortado pelo freio anti-loop -> motivo certo na nota de estado
  const turnLog = initialToolLog.map(c => ({ name:c.name, hint:c.hint || c.name, falhou:!!c.falhou })); // toda tool executada neste turno (nome + args-chave) -> nota de estado se o turno for cortado
  let protocolRepairs = 0, promiseRepairs = 0, repairInstruction = '';
  let answerRepairTools = null, answerRepairFallback = '', answerRepairs = 0;
  const executedSignatures = new Set();
  const executedReadStates = new Set();
  const readCallCounts = new Map();
  // A provider timeout/missing-usage result is not replayed. On routes with an
  // explicit backup, we may issue a NEW request to a different provider. Before
  // effects it may continue the loop; after any side-effectful/unclassified tool
  // it receives no tools and may only close the turn for the user. This preserves
  // UX without letting a second model duplicate actions. Initial confirmed tools
  // ran outside this loop and must count as well.
  let unsafeToolAttempted = initialToolLog.some(c => tools.providerFallbackSafe?.(c.name) !== true);
  let creditFailovers = 0;
  const MAX_CREDIT_FAILOVERS = 2; // primary -> Gemini -> OpenAI
  const ANSWER_ONLY = '\n\n[RECUPERAÇÃO DE PROVEDOR] Uma chamada anterior falhou depois que uma ferramenta potencialmente modificadora já foi tentada. Responda ao usuário usando apenas o histórico e os resultados registrados. NÃO chame ferramentas, NÃO repita ações e NÃO afirme que uma ação ocorreu sem um comprovante no histórico.';
  // Tool turns are provider-specific. In particular, Gemini 3 rejects a
  // functionCall produced by another model because it has no Gemini
  // thoughtSignature. At a cross-provider boundary, flatten each completed
  // assistant+tool batch into ordinary assistant text. Results survive, but no
  // foreign call structure/signature is forwarded or eligible for execution.
  const portableInput = (input, answerOnly) => {
    const portable = [];
    for (let i = 0; i < (input.messages || []).length; i++) {
      const m = input.messages[i];
      if (m?.role === 'assistant' && m.toolCalls?.length) {
        const lines = [];
        if (m.content?.trim()) lines.push(m.content.trim());
        lines.push('[REGISTRO DO SISTEMA — chamadas já processadas pelo modelo anterior; não as repita]');
        for (const call of m.toolCalls) {
          let args = '{}'; try { args = JSON.stringify(call.args ?? {}); } catch {}
          if (args.length > 4000) args = `${args.slice(0,4000)}…`;
          const results = [];
          let j = i + 1;
          while (j < input.messages.length && input.messages[j]?.role === 'tool') {
            const t = input.messages[j];
            if (!t.toolCallId || t.toolCallId === call.id) results.push(String(t.content ?? '').slice(0,24000));
            j++;
          }
          lines.push(`• ${call.name}(${args})\nResultado registrado: ${results.join('\n') || '(sem resultado registrado)'}`);
        }
        while (i + 1 < input.messages.length && input.messages[i + 1]?.role === 'tool') i++;
        portable.push({role:'assistant',content:sanitizeText(lines.join('\n'))});
      } else if (m?.role === 'tool') {
        portable.push({role:'assistant',content:sanitizeText(`[REGISTRO DO SISTEMA — resultado já processado de ${m.name || 'ferramenta'}]\n${String(m.content ?? '').slice(0,24000)}`)});
      } else if (m) {
        const clean = {role:m.role,content:sanitizeText(m.content ?? '')};
        if (m.images?.length) clean.images = m.images;
        portable.push(clean);
      }
    }
    return {...input,messages:portable,
      system:answerOnly?`${input.system || ''}${ANSWER_ONLY}`:input.system,
      tools:answerOnly?[]:input.tools};
  };
  const completeProvider = async (input, step) => {
    let res = await provider.complete(input);
    while (allowCreditFailover && creditFailovers < MAX_CREDIT_FAILOVERS &&
           res?.creditStop === 'credit_reconciliation_required' &&
           typeof provider.recoverCreditStop === 'function') {
      const answerOnly = unsafeToolAttempted;
      const recoveryInput = portableInput(input, answerOnly);
      // Increment before awaiting: a failed backup cannot reuse this hop.
      creditFailovers++;
      const recovered = await provider.recoverCreditStop(recoveryInput);
      if (!recovered?.result) return res; // route already exhausted / declined
      onEvent({ type:'provider_credit_failover', step, reason:res.creditStop,
        from:recovered.from || provider.name, to:recovered.to || 'fallback',
        mode:answerOnly?'answer_only':'continue' });
      res = recovered.result;
      // A provider must not be able to smuggle an action into answer-only mode,
      // even if it emits a tool call despite receiving an empty tool schema.
      if (answerOnly && (res.stop === STOP.TOOL || res.toolCalls?.length)) {
        return {stop:STOP.END,text:(res.text || '').trim() || 'Preservei o estado do que já foi feito e não repeti nenhuma ação. Posso continuar quando o serviço normalizar.'};
      }
    }
    return res;
  };
  const revisionRead = call => REVISION_READS.has(call.name) && tools.revisionAware?.(call.name) === true;
  const finish = (text, termination = 'interrupted') => {
    messages.push({ role: 'assistant', content: sanitizeText(text) });
    onEvent({ type: 'end', text });
    return { text, messages, usages, sources, termination };
  };
  let interjections = 0; // quantas mensagens-no-meio-do-turno já entraram (teto MAX_INTERJECTIONS)
  // Puxa o que chegou desde a última consulta. Nunca deixa o turno morrer por erro
  // daqui: se o canal falhar, o turno segue como antes (a mensagem fica pendente e
  // vira o turno seguinte, que é exatamente o comportamento antigo).
  async function drainNewUserMsg() {
    if (!pollNewUserMsg || interjections >= MAX_INTERJECTIONS) return null;
    let novo;
    try { novo = await pollNewUserMsg(); }
    catch (e) { onEvent({ type: 'interject_error', error: String(e?.message ?? e) }); return null; }
    const t = typeof novo === 'string' ? novo : novo?.text;
    if (!t || !t.trim()) return null;
    interjections++;
    return t.trim();
  }
  onEvent({ type: 'start', provider: provider.name, userInput });

  for (let step = 0; step < maxSteps; step++) {
    if(typeof control?.prepareContext==='function')await control.prepareContext({messages,consumedUpTo,step});
    else if (step > 0) pruneTurnBlobs(messages, turnStart, provider.name, consumedUpTo, retainedToolResult);
    // Fronteira de passo: é aqui que a mensagem nova entra. Nunca no meio de uma
    // rodada de tools (a turn de assistant+tool_results tem que ficar intacta).
    const entrou = await drainNewUserMsg();
    if (entrou) {
      // `raw` = só a fala do usuário. O invólucro (prefixo/sufixo de instrução) e o
      // rascunho descartado abaixo servem pro modelo DESTE turno; no history persiste
      // apenas o raw (server.mjs troca content por raw antes de gravar), senão cada
      // interjeição carregaria a moldura — e o rascunho de até 4000 chars — em todo
      // turno futuro daquela thread até a compactação.
      messages.push({ role: 'user', meta: 'interject', raw: entrou, content: sanitizeText(`${INTERJECT_PREFIX}\n\n${entrou}\n\n${INTERJECT_SUFFIX}`) });
      onEvent({ type: 'interject', step, text: entrou });
    }
    // Marca ANTES da chamada: tudo que está no array agora vai ser lido pelo modelo
    // nesta chamada, e só a partir daqui pode ser colapsado em passos futuros.
    consumedUpTo = messages.length;
    if (control?.beforeStep) {
      const boundary = await control.beforeStep({ messages, step, usages });
      if (boundary?.stop) return finish(boundary.text || 'Tarefa pausada com progresso salvo.', boundary.stop);
      if (boundary?.messages) { messages.splice(0, messages.length, ...boundary.messages); turnStart = 0; consumedUpTo = 0; }
    }
    const defs = answerRepairTools ? tools.defs.filter(t => answerRepairTools.has(t.name)) : tools.defs;
    const codingPolicy = codingAvailable(defs) ? CODING_EXECUTION_POLICY : '';
    let res;
    try {
      res = await completeProvider({ system: `${system || ''}${codingPolicy}${repairInstruction}`, messages, tools: defs }, step);
    } catch (e) {
      if (answerRepairTools) {
        if (e?.usage) usages.push(e.usage);
        onEvent({type:'answer_recovery_failed',step});
        return finish(answerRepairFallback);
      }
      if (!repairInstruction) throw e;
      // An outage during the one repair is terminal. Keep earlier metered work
      // and history, but never expose a provider error body or retry the network.
      if (e?.usage) usages.push(e.usage);
      onEvent({ type: 'turn_recovery_failed', step });
      return finish('Não consegui concluir a retomada porque o serviço de geração falhou. O pedido e os resultados anteriores continuam nesta conversa; esta resposta não iniciou trabalho em background.');
    }
    if (res.usage) usages.push(res.usage);
    coletarFontes(res);
    if(res.creditStop)return finish(res.text,res.creditStop);
    const protocol = protocolCode(res);
    if (protocol) {
      // Only a typed rejection of the entire, unexecuted batch can be repaired.
      // No timeout/HTTP retry, no model fallback, no invalid args in logs/history.
      onEvent({ type: 'provider_protocol_error', code: protocol, step, retry: protocolRepairs === 0 && step + 1 < maxSteps });
      if (protocolRepairs === 0 && step + 1 < maxSteps) {
        protocolRepairs++;
        repairInstruction = protocolRepairFor(defs, protocol);
        continue;
      }
      return finish(protocolFallback(turnLog));
    }

    if (res.stop === STOP.END) {
      if (res.text && res.text.trim()) {
        // Última checagem ANTES de entregar. Se chegou algo agora, o rascunho não
        // é enviado: vai pro contexto como rascunho não-enviado junto da mensagem
        // nova e o modelo decide se ainda serve. É o "ainda é pertinente entregar
        // isso?" — sem isso o usuário recebia a resposta obsoleta e depois a nova.
        const tarde = await drainNewUserMsg();
        if (tarde) {
          const rascunho = res.text.length > 4000 ? `${res.text.slice(0, 4000)}\n[…rascunho cortado aqui]` : res.text;
          messages.push({ role: 'user', meta: 'interject', raw: tarde, content: sanitizeText(
            `[você ia enviar esta resposta agora, mas ela AINDA NÃO FOI ENVIADA — o usuário não viu nada disso]\n\n${rascunho}\n\n${INTERJECT_PREFIX}\n\n${tarde}\n\nDecida: se a resposta acima ainda serve, entregue ela (pode ajustar/completar pra já contemplar a mensagem nova). Se não serve mais, descarte e responda o que faz sentido agora. UMA resposta só.`,
          ) });
          onEvent({ type: 'interject_predraft', step, text: tarde });
          continue;
        }
        if (codingPromise(res.text, defs, codingTurnContext(messages))) {
          const attempted = turnLog.some(c => CODING_TOOLS.has(c.name));
          const retry = !attempted && promiseRepairs === 0 && step + 1 < maxSteps;
          onEvent({ type: 'coding_promise_blocked', step, retry, attempted });
          if (retry) {
            promiseRepairs++;
            repairInstruction = PROMISE_REPAIR;
            continue;
          }
          return finish(codingFallback(turnLog));
        }
        // Classificador opcional (Jev, #43): pega a promessa que a regra perde.
        // Só pode pedir o MESMO reparo único; nunca troca a resposta pelo fallback.
        if (promiseClassifier && promiseRepairs === 0 && step + 1 < maxSteps && codingAvailable(defs)
          && !turnLog.some(c => CODING_TOOLS.has(c.name))
          && await Promise.resolve(promiseClassifier(res.text)).catch(() => null) === 'promessa') {
          onEvent({ type: 'coding_promise_blocked', step, retry: true, attempted: false, source: 'classifier' });
          promiseRepairs++;
          repairInstruction = PROMISE_REPAIR;
          continue;
        }
        // A trusted caller may require a structured, audited answer. Its single
        // repair can expose only explicitly read-only tools; neither a model
        // nor a recovery may replay an external action to obtain that answer.
        const answer = await control?.beforeAnswer?.({text:res.text,messages,step,termination:'completed'});
        if (answer?.retry) {
          const allowed = (answer.tools || []).filter(name => tools.providerFallbackSafe?.(name) === true);
          if (answerRepairs === 0 && allowed.length && step + 1 < maxSteps) {
            answerRepairs++;
            answerRepairTools = new Set(allowed);
            answerRepairFallback = answer.fallback || '';
            messages.push({role:'user',meta:'answer_contract',content:sanitizeText(answer.retry)});
            onEvent({type:'answer_contract_retry',step});
            continue;
          }
          return finish(answer.fallback || '', 'completed');
        }
        if (typeof answer?.text === 'string') res = {...res,text:answer.text};
        messages.push({ role: 'assistant', content: sanitizeText(res.text) });
        onEvent({ type: 'assistant', text: res.text });
        onEvent({ type: 'end', text: res.text });
        return { text: res.text, messages, usages, sources, termination:'completed' };
      }
      // Fim SEM texto: o modelo encerrou seco OU a geração foi CORTADA no teto de
      // saída (res.truncated) antes de emitir a resposta. Nunca devolver branco
      // pro usuário: sai do loop e cai no salvage abaixo pra arrancar uma resposta.
      onEvent({ type: 'empty_end', step, truncated: !!res.truncated });
      emptyEnd = true;
      break;
    }

    // stop === TOOL: a turn INTEIRA (texto-pensamento + TODAS as functionCalls)
    // vira UMA única mensagem de assistant. Quebrar em mensagens separadas
    // desassocia o thoughtSignature que o Gemini 3 exige amarrado à turn — e o
    // 400 "missing thought_signature" volta. Mantemos a turn intacta.
    const calls = res.toolCalls ?? [];
    if (answerRepairTools && calls.some(c => !answerRepairTools.has(c.name))) {
      onEvent({type:'answer_recovery_tool_blocked',step});
      return finish(answerRepairFallback);
    }
    // Only known read operations may recover data no longer in the active context.
    // The trusted executor proves that state; model text/flags cannot waive replay guards.
    const recoverableReads=new Set();
    for(const c of calls)if(['ler_arquivo_do_app','recuperar_contexto_de_codigo'].includes(c.name)&&await control?.isContextRecovery?.({call:c,messages})===true)recoverableReads.add(c);
    if (repairInstruction && calls.some(c => !revisionRead(c) && !recoverableReads.has(c) && executedSignatures.has(executionSignature(c)))) {
      onEvent({ type: 'repair_replay_blocked', step });
      return finish('A retomada tentou repetir uma chamada já executada neste turno. Bloqueei a repetição; o resultado anterior precisa ser conferido antes de continuar. Não iniciei outra execução por esta resposta.');
    }
    // Preserve preflight replay/repetition protection for writes and ordinary tools.
    // Revision-aware reads are checked immediately before their execution, after
    // any earlier write in the SAME batch. This avoids checking an obsolete draft.
    const ordinary = calls.filter(c => !revisionRead(c)&&!recoverableReads.has(c));
    let culpada = null;
    for (const c of ordinary) {
      const key = callSig(c), count = (sigCounts.get(key) || 0) + 1;
      sigCounts.set(key, count);
      if (count >= REPEAT_LIMIT && !culpada) culpada = c;
    }
    if (culpada) {
      loopBreak = true;
      let args = ''; try { args = JSON.stringify(culpada.args ?? {}); } catch {}
      onEvent({ type: 'loop_break', step, steps: maxSteps, tool: culpada.name, argsLen: args.length, args: args.slice(0, 300), reason:'identical_call', revisionAware:false, repeatCount:REPEAT_LIMIT });
      break;
    }
    if (res.text) onEvent({ type: 'assistant', text: res.text });
    messages.push({ role: 'assistant', content: sanitizeText(res.text || ''), toolCalls: calls });
    for (const [callIndex, call] of calls.entries()) {
      let readState = null;
      if (revisionRead(call)) {
        const revision = await tools.repetitionKey(call.name, call.args);
        readState = callSignature(call, revision || '');
        const baseKey = callSig(call);
        const recoveringContext=recoverableReads.has(call)&&await control?.isContextRecovery?.({call,messages})===true;
        const total = recoveringContext ? 0 : (readCallCounts.get(baseKey) || 0) + 1;
        readCallCounts.set(baseKey, total);
        const count = recoveringContext ? 0 : revision ? (sigCounts.get(readState) || 0) + 1 : total;
        sigCounts.set(readState, count);
        const replay = !recoveringContext && !!repairInstruction && (executedReadStates.has(readState) || (!revision && executedSignatures.has(executionSignature(call))));
        if (replay || count >= REPEAT_LIMIT) {
          // Complete the tool-call/result protocol for calls skipped after partial
          // batch execution. Earlier writes remain real; nothing is replayed/undone.
          for (const skipped of calls.slice(callIndex)) messages.push({ role:'tool', toolCallId:skipped.id,
            name:skipped.name, content:'ERRO: chamada não executada; proteção de repetição interrompeu este lote.' });
          if (replay) {
            onEvent({ type:'repair_replay_blocked', step, tool:call.name, revisionAware:!!revision });
            return finish('A retomada tentou repetir uma leitura já executada sem mudança de revisão comprovada. Bloqueei a repetição; as operações anteriores não foram desfeitas. Não há trabalho rodando em background.');
          }
          loopBreak = true;
          onEvent({ type:'loop_break', step, steps:maxSteps, tool:call.name, reason:revision ? 'unchanged_revision' : 'revision_unavailable', revisionAware:!!revision, repeatCount:count, argsLen:0, args:'' });
          break;
        }
      }
      await control?.beforeTool?.({call,messages});
      onEvent({ type: 'tool_call', id: call.id, name: call.name, args: call.args });
      // Mark before execution. A tool that throws after an external write is
      // still unsafe to follow with a second model/provider decision.
      if (tools.providerFallbackSafe?.(call.name) !== true) unsafeToolAttempted = true;
      const rawOut = await tools.run(call.name, call.args);
      if (rawOut?.creditStop) {
        // Complete the outstanding tool protocol without running the rest of the
        // batch, a principal continuation or salvage after an uncertain call.
        for (const skipped of calls.slice(callIndex)) messages.push({
          role:'tool',toolCallId:skipped.id,name:skipped.name,
          content:'ERRO: execução interrompida pelo controle de créditos.'
        });
        return finish(rawOut.text,rawOut.creditStop);
      }
      executedSignatures.add(executionSignature(call));
      if (readState) executedReadStates.add(readState);
      const out = transformToolResult ? transformToolResult(call, rawOut) : rawOut;
      const falhou = (typeof rawOut === 'string' && rawOut.startsWith('ERRO')) || (rawOut && typeof rawOut === 'object' && rawOut.ok === false);
      turnLog.push({ name: call.name, hint: callHint(call), falhou });
      onEvent({ type: 'tool_result', id: call.id, name: call.name, args: call.args, out: rawOut });
      messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content: sanitizeText(toToolText(out)) });
      const toolBoundary=await control?.afterTool?.({call,out:rawOut,messages});
      if(toolBoundary?.stop){
        for(const skipped of calls.slice(callIndex+1))messages.push({role:'tool',toolCallId:skipped.id,name:skipped.name,content:'Não executada: a tarefa foi encaminhada; este lote foi encerrado.'});
        return finish(toolBoundary.text||'Execução encaminhada.',toolBoundary.stop);
      }
    }
    if (loopBreak) break;
  }

  // Bateu no teto de passos sem o modelo fechar. Em vez de devolver um texto seco
  // de erro pro usuário, fazemos UMA última chamada SEM tools, pedindo que ele
  // responda AGORA com o que já levantou (nada de chamar mais ferramenta). Assim o
  // usuário sempre recebe uma resposta natural com o parcial, não uma mensagem crua.
  const termination = loopBreak ? 'repeated_calls' : emptyEnd ? 'empty_end' : 'step_limit';
  onEvent({ type: 'max_steps', steps: maxSteps });
  // A specialized executor owns its structured consolidation; don't spend an
  // extra model call on a disposable plain-text salvage in that path.
  if (!salvage) return { text: '', messages, usages, sources, termination };
  // Fallback message: honest about what happened, but written FOR THE USER, not
  // for whoever debugs. The old one ("step limit for this turn", "I used all the
  // tools", "I didn't freeze or vanish") leaked backstage jargon and denied
  // vanishing, which only plants the doubt (26/08). Here we say the same truth
  // in plain language and offer the way out ("continue").
  // The technical reason stays visible in onEvent ('max_steps'/'salvage_empty'/
  // 'salvage_error') for logs/metrics, so a silent dead end never goes unnoticed.
  // Short on purpose (26/08): the reader already waited the whole turn and
  // doesn't want an apology paragraph. One line on what happened + the way out.
  const CEILING_MSG = 'Essa tarefa é grande e não coube numa resposta só. Me diz "continua" que eu sigo de onde parei.';
  // Quando caímos aqui por FIM SEM TEXTO (truncamento no teto de saída), a mensagem
  // acima não descreve o que houve; usa uma honesta sobre o corte.
  const FALLBACK_MSG = emptyEnd ? 'Minha resposta ficou longa e foi cortada no meio. Me diz "continua" que eu retomo daqui.' : CEILING_MSG;
  // Nota de estado ANTES do salvage: entra nas messages (e portanto no history
  // persistido), então tanto o salvage quanto o turno de "continua" enxergam o
  // que já foi executado — mesmo que a compactação/poda tenha comido os detalhes.
  if (turnLog.length) {
    const motivo = emptyEnd ? 'geração cortada no limite de saída'
      : loopBreak ? 'chamadas repetidas em loop'
      : 'teto de passos do turno';
    // meta:'estado' = mensagem injetada por nós, não é fala do usuário. Quem
    // persiste o history usa isso pra não sobrescrever esta nota com o texto do
    // usuário (o caller reescreve a ÚLTIMA mensagem de user com a versão limpa).
    messages.push({ role: 'user', meta: 'estado', content: sanitizeText(buildStateNote(turnLog, motivo)) });
  }
  try {
    const wrapSystem = `${system}\n\nATENÇÃO: você já usou todas as suas ferramentas neste turno. NÃO chame mais nenhuma ferramenta. Responda AGORA, de forma completa e útil, com base em tudo que você já levantou até aqui. Se ficou faltando confirmar algum item, entregue o que tem e diga com honestidade o que não deu pra confirmar. NÃO fale de bastidor com o usuário: nada de "limite de passos", "teto do turno", "ferramentas esgotadas", nem de negar que travou/sumiu. Se a tarefa ficou pela metade, feche em UMA frase curta: que ela é grande e não coube numa resposta só, e que é só pedir "continua".`;
    const res = await completeProvider({ system: wrapSystem, messages, tools: [] }, maxSteps);
    if (res.usage) usages.push(res.usage);
    coletarFontes(res);
    if (res.creditStop) return finish(res.text,res.creditStop);
    let text = protocolCode(res) ? protocolFallback(turnLog)
      : codingPromise(res.text, tools.defs, codingTurnContext(messages)) ? codingFallback(turnLog)
      : (res.text && res.text.trim()) ? res.text : FALLBACK_MSG;
    const answer = await control?.beforeAnswer?.({text,messages,step:maxSteps,termination});
    if (typeof answer?.text === 'string') text = answer.text;
    else if (answer?.retry) text = answer.fallback || '';
    if (!res.text || !res.text.trim()) onEvent({ type: 'salvage_empty', steps: maxSteps });
    messages.push({ role: 'assistant', content: sanitizeText(text) });
    onEvent({ type: 'end', text });
    return { text, messages, usages, sources, termination };
  } catch (e) {
    onEvent({ type: 'salvage_error', error: String(e?.message ?? e), steps: maxSteps });
    return { text: FALLBACK_MSG, messages, usages, sources, termination };
  }
}
