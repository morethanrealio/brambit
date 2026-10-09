import { retainedSearchPage } from './search-page.mjs';
import { REVISION_READS, callSignature } from './repetition.mjs';
// ── Core harness (model-agnostic) ──
// Owner of the tool-loop and message state. Runs ANY provider that
// satisfies the contract in provider.mjs. ~50 lines of actual logic.

import { retainedFilePage } from './file-page.mjs';
import { STOP } from './provider.mjs';
import { protocolCode, CODING_TOOLS, codingAvailable, CODING_EXECUTION_POLICY, protocolRepairFor, PROMISE_REPAIR,
  codingPromise, codingTurnContext, codingFallback, protocolFallback, executionSignature } from './turn-recovery.mjs';

// Sanitizes text entering history/messages: removes LOOSE UTF-16
// surrogates (an emoji pair cut in half by a .slice()) and the NUL character.
// Without this, a single invalid code point makes the provider's JSON parser (e.g. Together's
// Go, "unexpected end of hex escape") AND Postgres jsonb ("invalid
// input syntax for type json") reject the entire message, and the reply disappears.
const REPLACEMENT = String.fromCharCode(0xFFFD);
const NUL = String.fromCharCode(0);
function sanitizeText(s) {
  if (typeof s !== 'string') return s;
  return s
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, REPLACEMENT) // unpaired high surrogate
    .replace(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, REPLACEMENT) // unpaired low surrogate
    .split(NUL).join('');
}

// Tool result -> text for the model. String passes through directly. Object/array becomes
// JSON (otherwise `String(obj)` collapsed everything into "[object Object]" and the model was
// BLIND to the content — which broke precisely the app tools that return
// an object: listar_arquivos_do_app, ler_arquivo_do_app, publicar_sistema, ...).
function toToolText(out) {
  if (out == null) return '';
  if (typeof out === 'string') return out;
  try { return JSON.stringify(out); }
  catch { return String(out); } // fallback: circular/serialization impossible
}

// Progressive disclosure WITHIN the turn. A build turn calls the model several
// times (read → think → write → publish → check log) and EVERY large result
// (content of ler_arquivo_do_app, args of escrever_arquivo_do_app) stays in the working
// set and is RESENT to the model on every subsequent step of the SAME turn — this is what
// drove tok_in to 150k-210k per call and a whole turn to 2.4M tokens in one user's
// build (a 123k app.js read/resent dozens of times in a 23-step
// turn). Before each new call we collapse the OLD blobs from this turn into a
// short marker (keeping the most recent ones intact, since the model may still
// need them). This is what Claude Code does (context editing / clear tool results).
//
// Gemini 3's thoughtSignature: the signature lives in `c.meta.thoughtSignature`
// (the provider re-emits it as a PART separate from the functionCall, not inside the
// args — see gemini.mjs). Collapsing the VALUE of an arg does NOT touch the meta, so the
// signature stays intact. Verified live against gemini-3.7-flash: collapsing
// the assistant's args while keeping the meta does NOT produce a 400 for thought_signature. That's why
// we collapse BOTH sides on every provider: the tool result (role:'tool', the
// file READ) AND the assistant's args (role:'assistant', the file WRITE).
// In that build the write was what weighed the most: the model
// rewrites the entire file on every step (out of 10k-16k) and those args kept
// circulating in the input, which grew 53k->111k within the SAME turn. BEFORE, the
// entire trim was skipped on gemini (primary), then it collapsed only the read; now
// it collapses the write too, which was the bulk of it.
const TURN_BLOB_MAX = 2000;   // chars; above this it's a blob worth collapsing
const TURN_KEEP_RECENT = 4;   // last N messages of the turn are never collapsed

// Cap for blobs WITHIN the recent window. The last TURN_KEEP_RECENT
// messages are not collapsed (the model is still working on them), but
// they can't be unlimited either: a 100k `ler_arquivo_do_app` or a
// giant terminal output circulates IN FULL on every step while it's in the
// window. We cut head+tail (the start has what matters: shebang/imports/
// structure; the end has the error/result) with an explicit marker in the middle. 24k
// chars ≈ 6k tokens per recent blob — big enough for any reasonable
// app file to go through in full, small enough to not dominate the input.
const TURN_RECENT_MAX = 24000;  // chars; blob cap in the recent window
const TURN_RECENT_HEAD = 15800; // chars kept from the start
const TURN_RECENT_TAIL = 8000;  // chars kept from the end
// HEAD+TAIL+marker < TURN_RECENT_MAX on purpose: the result of the cut stays
// below the cap, so the second pass doesn't touch it again (idempotent).
function capRecentBlob(s) {
  if (typeof s !== 'string' || s.length <= TURN_RECENT_MAX) return s;
  const cut = s.length - TURN_RECENT_HEAD - TURN_RECENT_TAIL;
  return s.slice(0, TURN_RECENT_HEAD) + `\n…[cortado: ${cut} chars]…\n` + s.slice(s.length - TURN_RECENT_TAIL);
}

// Anti-loop guard WITHIN the turn. If the model re-emits an IDENTICAL call
// (same tool + same args) repeatedly, it's stuck: the result is already
// in the working set and calling again doesn't move forward (e.g. trying to apply again an
// editar_arquivo_do_app whose snippet was already replaced → "não encontrado" →
// tries again). This burned steps/credit in that build. On reaching
// REPEAT_LIMIT identical calls, we cut to salvage instead of spending the rest
// of the step cap. This is what allows safely raising maxSteps on build turns
// without risk of an infinite loop.
const REPEAT_LIMIT = 3;       // 3rd identical call = stuck; cuts to salvage

// Message that arrives MID-turn (the user sends another one before the first
// is answered). Before, it was invisible to the turn in progress: the agent
// delivered the first reply in full — even if already stale — and only then ran
// a second turn for the second one. Now it's injected at step boundaries, the
// way Claude Code does it: the model reads it and decides whether to adjust, abandon or continue.
// Cap per turn so a burst of messages doesn't become infinite context nor
// prevent the turn from closing; whatever exceeds the cap is left for the next turn.
const MAX_INTERJECTIONS = 3;
// Injected as role:'user' (same language as the state note below). The notice about
// "only one reply" is essential: without it the model tends to answer message 1,
// then 2, and the user gets two blocks for what was one conversation.
const INTERJECT_PREFIX = '[o usuário mandou esta mensagem AGORA, no meio do seu trabalho — ela é mais recente que tudo acima]';
const INTERJECT_SUFFIX = 'Decida antes de continuar: se isso muda o que você estava fazendo, ajuste ou abandone o rumo anterior; se não muda, siga. Entregue UMA resposta só no fim, contemplando tudo — não mande uma resposta por mensagem.';

// State note for the interrupted turn. When a build turn is cut short
// (step cap, loop, truncated generation), the "memory" of what was already done
// used to live only in the model's head — and the next turn ("continua") started from a
// pruned/compacted context and REWROTE files from old versions
// (the KhaosClass incident, 2×). Before the salvage, we inject a
// DETERMINISTIC message (built in code, without a model call) listing the tools
// already executed this turn with their key args. It persists in history, so
// the continuation knows exactly where the previous turn stopped.
const STATE_NOTE_MAX_CALLS = 30; // line cap in the note (40-step turns)
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
  // Collapses OLD blobs from the turn (beyond the recent window) on every provider.
  // We only touch the VALUE of args/content; the meta (gemini's thoughtSignature) stays
  // intact, so the signature isn't disassociated. providerName kept in the
  // signature for compat/log; today the handling is the same for everyone.
  //
  // `consumedUpTo` = how many messages the model has ALREADY SEEN (array size on the last
  // call to complete()). Nothing beyond that can be collapsed: the results of a
  // round are stacked at the END of step N and this function runs at the TOP of step N+1,
  // before complete(). Without this guard, a round with more than TURN_KEEP_RECENT
  // large results had the first ones swapped for "Você já viu esse conteúdo
  // antes neste turno" — a false claim, about content the model never
  // read. Whatever hasn't been consumed yet goes through the soft cut of the recent window
  // (capRecentBlob) and only becomes a stub on the next step, after actually being read.
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
  // Recent window: doesn't collapse, but is ALSO not unlimited — blobs above
  // TURN_RECENT_MAX get a head+tail cut with a marker (see capRecentBlob).
  // Idempotent: a message already cut stays ≤ TURN_RECENT_MAX and isn't touched again.
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
 * Tool registry. The defs become JSON Schema (the same shape MCP uses),
 * so plugging in an MCP server later is trivial: just map its tools here.
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
  // Text written in the SAME step as a tool flagged keepsStepText (record something,
  // propose an action for confirmation) is part of the answer: the core delivers it
  // before the final text instead of dropping it.
  keepsStepText(name) { const t = this.map.get(name); return t?.keepsStepText === true || t?.confirmationTool?.keepsStepText === true; }
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
 * The loop. Identical for every model. Swap `provider` and everything stays the same.
 * `history` allows continuing a conversation (multi-turn chat): pass the
 * messages returned from the previous call.
 * `images` (optional) attaches images to THIS turn's user message (vision):
 * each item { mimeType, data(base64) }. Only a provider that supports multimodal
 * uses them; the caller must remove them before persisting the history (don't resend).
 * `pollNewUserMsg` (optional) is the mid-turn-message channel: a function
 * (async) that returns `null` or `{ text }` with what the user sent AFTER
 * this turn already started. It's checked at every step boundary and before
 * delivering the reply — the model sees the new message and decides whether to change course, instead
 * of the user receiving the stale reply and only then the new one.
 * @param {{ provider, tools:ToolRegistry, system:string, userInput:string,
 *           images?:{mimeType:string,data:string}[], history?:object[],
 *           maxSteps?:number, onEvent?:(e:object)=>void,
 *           transformToolResult?:((call:object,out:unknown)=>unknown)|null,
 *           pollNewUserMsg?:(()=>Promise<{text:string}|null>)|null,
 *           allowCreditFailover?:boolean, ceilingRetry?:boolean }} opts
 */
export async function runAgent({ provider, tools, system, userInput, images, history = [], maxSteps = 12, onEvent = () => {}, pollNewUserMsg = null, transformToolResult = null, initialToolLog = [], control = null, salvage = true, allowCreditFailover = false, retainedToolResult = null, promiseClassifier = null, ceilingRetry = false }) {
  const userMsg = { role: 'user', content: sanitizeText(userInput) };
  if (images?.length) userMsg.images = images;
  const messages = [...history, userMsg];
  // Usage/cost of every call to the provider in this turn (1 turn can have N calls
  // because of the tool-loop). The caller persists this with the dimensions (user,
  // conversation, type). The provider fills res.usage; here we just accumulate.
  const usages = [];
  // Sources from the provider's native search (grounding), accumulated across the whole turn and
  // without repeating URLs. The provider fills res.sources; the caller decides whether to show them.
  const sources = [];
  const sourceSeen = new Set();
  const coletarFontes = (res) => {
    for (const s of res?.sources ?? []) {
      if (s?.uri && !sourceSeen.has(s.uri)) { sourceSeen.add(s.uri); sources.push(s); }
    }
  };
  let turnStart = messages.length; // only blobs GENERATED in this turn are collapsed
  let consumedUpTo = messages.length; // how many messages the model has already seen (see pruneTurnBlobs)
  const sigCounts = new Map(); // anti-loop guard: count of identical calls
  // Answer text written alongside keepsStepText tools. Without this it was lost,
  // because only the last step's text becomes the reply.
  let carriedText = '';
  const withCarried = (text) => {
    const final = String(text || '').trim();
    if (!carriedText) return text;
    if (!final) return carriedText;
    const norm = (x) => x.replace(/\s+/g, ' ').trim();
    if (norm(final).includes(norm(carriedText).slice(0, 200))) return text;
    if (norm(carriedText).includes(norm(final))) return carriedText;
    return `${carriedText}\n\n${final}`;
  };
  let emptyEnd = false; // end WITHOUT text (dry or truncated at the output cap) -> goes to salvage, never returns blank
  let loopBreak = false; // cut by the anti-loop guard -> correct reason in the state note
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
  const ANSWER_ONLY = '\n\n[PROVIDER RECOVERY] An earlier call failed after a tool that may change something had already been attempted. Answer the user using only the history and the recorded results. Do NOT call tools, do NOT repeat actions and do NOT claim an action happened without proof in the history.';
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
  let interjections = 0; // how many mid-turn messages have already come in (cap MAX_INTERJECTIONS)
  // Pulls what arrived since the last check. Never lets the turn die from an error
  // here: if the channel fails, the turn continues as before (the message stays pending and
  // becomes the next turn, which is exactly the old behavior).
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
    // Step boundary: this is where the new message comes in. Never in the middle of a
    // round of tools (the assistant+tool_results turn has to stay intact).
    const entrou = await drainNewUserMsg();
    if (entrou) {
      // `raw` = only the user's utterance. The wrapper (instruction prefix/suffix) and the
      // discarded draft below serve the model of THIS turn; in the history only
      // the raw persists (server.mjs swaps content for raw before saving), otherwise every
      // interjection would carry the framing — and the draft of up to 4000 chars — into every
      // future turn of that thread until compaction.
      messages.push({ role: 'user', meta: 'interject', raw: entrou, content: sanitizeText(`${INTERJECT_PREFIX}\n\n${entrou}\n\n${INTERJECT_SUFFIX}`) });
      onEvent({ type: 'interject', step, text: entrou });
    }
    // Marks BEFORE the call: everything in the array now will be read by the model
    // on this call, and only from here on can it be collapsed in future steps.
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
        // Last check BEFORE delivering. If something arrived now, the draft is not
        // sent: it goes into context as an unsent draft alongside the new
        // message and the model decides whether it's still useful. It's the "is it still relevant to
        // deliver this?" check — without it the user would get the stale reply and then the new one.
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
        // Optional classifier (Jev, #43): catches the promise that the rule misses.
        // Can only request the SAME single repair; never swaps the reply for the fallback.
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
        const delivered = withCarried(res.text);
        onEvent({ type: 'end', text: delivered });
        return { text: delivered, messages, usages, sources, termination:'completed' };
      }
      // End WITHOUT text: the model finished dry OR generation was CUT at the output
      // cap (res.truncated) before emitting the reply. Never return blank
      // to the user: exits the loop and falls into the salvage below to extract a reply.
      if (carriedText && !res.truncated) {
        messages.push({ role: 'assistant', content: sanitizeText(carriedText) });
        onEvent({ type: 'end', text: carriedText });
        return { text: carriedText, messages, usages, sources, termination:'completed' };
      }
      onEvent({ type: 'empty_end', step, truncated: !!res.truncated });
      emptyEnd = true;
      break;
    }

    // stop === TOOL: the WHOLE turn (thought-text + ALL functionCalls)
    // becomes ONE single assistant message. Splitting it into separate messages
    // disassociates the thoughtSignature that Gemini 3 requires bound to the turn — and the
    // 400 "missing thought_signature" comes back. We keep the turn intact.
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
    if (res.text?.trim() && calls.length && calls.every(c => tools.keepsStepText?.(c.name) === true))
      carriedText = carriedText ? `${carriedText}\n\n${res.text.trim()}` : res.text.trim();
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

  // Hit the step cap without the model closing. Instead of returning a dry error
  // text to the user, we make ONE last call WITHOUT tools, asking it to
  // answer NOW with what it has already gathered (no more tool calling). This way the
  // user always gets a natural reply with the partial result, not a raw message.
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
  // `ceilingRetry` (web/step-ceiling.mjs) means the CALLER already granted this
  // conversation's one bounded step-budget bump for this "continue" streak and
  // it STILL hit the ceiling: repeating "say continue" again would be the exact
  // loop from Naomi item 11 (Gabriel got it 4 times in 2 days). Propose
  // splitting the work instead, once per streak.
  const SPLIT_MSG = 'Essa tarefa continua grande demais mesmo com mais passos liberados. Vamos dividir em partes menores: me diga qual é a primeira parte pra eu fechar agora.';
  const proposeSplit = ceilingRetry && termination === 'step_limit';
  // When we land here due to END WITHOUT TEXT (truncation at the output cap), the message
  // above doesn't describe what happened; use an honest one about the cut.
  const FALLBACK_MSG = emptyEnd ? 'Minha resposta ficou longa e foi cortada no meio. Me diz "continua" que eu retomo daqui.' : proposeSplit ? SPLIT_MSG : CEILING_MSG;
  // State note BEFORE the salvage: goes into messages (and therefore into the
  // persisted history), so both the salvage and the "continua" turn can see
  // what was already executed — even if compaction/pruning has eaten the details.
  if (turnLog.length) {
    const motivo = emptyEnd ? 'geração cortada no limite de saída'
      : loopBreak ? 'chamadas repetidas em loop'
      : 'teto de passos do turno';
    // meta:'estado' = message injected by us, not the user's utterance. Whoever
    // persists the history uses this to avoid overwriting this note with the user's
    // text (the caller rewrites the LAST user message with the clean version).
    messages.push({ role: 'user', meta: 'estado', content: sanitizeText(buildStateNote(turnLog, motivo)) });
  }
  try {
    const closingInstruction = proposeSplit
      ? 'If the task is unfinished, close with ONE short sentence, in the language of the conversation, proposing to split what is left into smaller parts and asking which smaller part the person wants finished first; do NOT just ask them to say "continue" again, that was already tried and it did not fit.'
      : 'Se a tarefa ficou pela metade, feche em UMA frase curta: que ela é grande e não coube numa resposta só, e que é só pedir "continua".';
    const wrapSystem = `${system}\n\nATENÇÃO: você já usou todas as suas ferramentas neste turno. NÃO chame mais nenhuma ferramenta. Responda AGORA, de forma completa e útil, com base em tudo que você já levantou até aqui. Se ficou faltando confirmar algum item, entregue o que tem e diga com honestidade o que não deu pra confirmar. NÃO fale de bastidor com o usuário: nada de "limite de passos", "teto do turno", "ferramentas esgotadas", nem de negar que travou/sumiu. ${closingInstruction}`;
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
