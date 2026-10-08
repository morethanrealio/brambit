import {scopeConflict,reviewRequestNeedsClarification,editRequestNeedsClarification} from './app-task-scope.mjs';
import {runCodingTask} from './coding-task-runner.mjs';
import { runAppTask } from './app-task-runner.mjs';
// ── CODING sub-agent (structural isolation) ──
// Template = runGoogleSubagent (server.mjs), with ONE central difference: coding
// is NOT one-shot. A coding task spans SEVERAL turns of the
// main agent (you read, it replies, you ask for the next step). That's why this
// sub-agent has a PERSISTENT SESSION per (agent, thread): the code loop's history
// lives here and is reused turn by turn, instead of being dumped into the main
// agent's history (which is what bloated the context in a real case: 5M tokens).
//
// What this takes out of the main agent: the entire suite of code tools (~40-80 defs,
// ~20k tok of schema resent on every step) and the huge raw results
// (file dumps, command output). The main agent is left with just the meta-tool
// `codar`; the synthesis comes back as text. Same as google/pesquisar/conectores.
//
// Gated writes: the confirmation guard (addGated) is tied to the main agent's
// turn/thread and does NOT work inside a sub-agent. So the sub-agent only
// owns the loop when the write already runs inline (aceitar_edicoes mode or super/
// livre) — which is EXACTLY the heavy scenario. In padrao mode, the routing
// decision stays with the server (keeps it inline in the main agent). This module doesn't
// decide policy; it just runs the loop with the tools it receives.

import { retainedFilePage } from '../core-proto/file-page.mjs';
import { createBuildState } from './app-build-state.mjs';
import { runAgent } from '../core-proto/core.mjs';
import { comIdioma } from './locale.mjs';
import { marca } from './marca.mjs';

// Persistent coding sessions, keyed by sessionKey = `${agentId}:${threadId}`.
// { history: [...], lastUsed: ms }. Idle > SESSION_TTL_MS gets collected (the work
// summary has already gone back to the main agent as text on every turn; starting from
// scratch again costs little compared to keeping dead context).
const sessions = new Map();
const SESSION_TTL_MS = Number(process.env.CODING_SESSION_TTL_MS) || 30 * 60 * 1000; // 30 min
// Cap on the sub-agent's history (messages). Coding generates many steps; without
// a cap, the sub's history would grow the way the main agent's used to. Keeps the N most
// recent (the user/assistant pair + tool msgs). Real compaction comes later.
const HISTORY_MAX = Number(process.env.CODING_HISTORY_MAX) || 60;

function gcSessions(nowMs) {
  for (const [k, s] of sessions) {
    if (nowMs - s.lastUsed > SESSION_TTL_MS) sessions.delete(k);
  }
}

// Context hygiene BETWEEN calls (item 3). The core's pruneTurnBlobs only
// collapses blobs generated WITHIN the current call (turnStart = messages.length);
// history coming in from previous calls stays full-size. In a persistent
// coding session this re-accumulates (re-reading the same file turn after turn =
// the bloat from that case). Here, when persisting, we collapse old reads/outputs
// and large write args, keeping the N most recent intact
// (the model still needs what it just saw).
const BLOB_MAX = Number(process.env.CODING_BLOB_MAX) || 2000;   // chars
const KEEP_RECENT = Number(process.env.CODING_KEEP_RECENT) || 6; // last msgs intact
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

// Stitching the call/result pair back together after any pruning. Cutting the history
// at the message cap is a BLIND cut: it can land between the `assistant` that
// requested the tool and the `tool` that carries the result, and the result alone is
// invalid for the API. Together rejects the entire call with a 400
// `invalid_tool_messages` ("tool message tool_call_id '...' does not match any
// tool call in the preceding assistant messages"); the provider falls back and,
// since the poisoned history STAYS stored in the session, EVERY subsequent call on the
// same thread repeats the same error until the session expires (30 min). This is what
// knocked DeepSeek down to Gemini on 2026-09-03 and 2026-09-05, always with the same
// tool_call_id repeating. Here we keep only the `tool` messages whose id was actually requested
// by a PREVIOUS `assistant` in what was left after pruning.
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

// Cutting by number of messages, preserving the session's GOAL.
// The old cut was a plain tail slice, and the tail discards the head — and the
// head is exactly the user's first message, the one that says what the session
// came to do. This path isn't rare: the summary only fires above
// COMPACT_TRIGGER_TOKENS, so a session with MANY short messages (the pattern of
// someone iterating in small steps) goes past HISTORY_MAX without ever reaching the
// summary trigger, and the executor loses the original goal while thinking it
// has the whole context. When the anchor drops out in the cut, it comes back as an
// explicit context block in front of the tail.
function capHistory(messages) {
  if (messages.length <= HISTORY_MAX) return messages;
  const tail = messages.slice(messages.length - HISTORY_MAX);
  const anchor = messages.find((m) => m.role === 'user' && typeof m.content === 'string' && m.content.trim());
  if (!anchor || tail.includes(anchor)) return tail;
  return [{ role: 'user', content: `[OBJETIVO ORIGINAL DESTA SESSÃO DE CÓDIGO]\n${anchor.content.slice(0, 2000)}` }, ...tail];
}

// ── Compaction by SUMMARY (like Claude Code) ──
// Collapsing blobs cuts the SIZE of old reads/writes, but the raw
// history stays in `contents` (which Gemini does NOT cache) and grows turn by turn,
// killing the cache hit. Summary compaction swaps the entire old history
// for a single "state of the work so far" block + the last response, shrinking
// `contents` from tens of thousands of tokens down to a few thousand. It's the step that
// recovers the cache and closes the gap with Claude Code.
// HIGH trigger on purpose. Blob collapsing (collapseHistoryBlobs) already shrinks
// heavy content with no extra call cost; the summary only pays for the
// summary call when the history is VERY long (that scenario, hundreds of steps),
// where even collapsed stubs + recent msgs add up to a lot. The 6-turn
// bench showed that firing early (8k) is worse than collapse-only (the summary call
// doesn't pay for itself at that scale). Above this cap (contents already collapsed), the summary
// becomes the only way to stop the bleeding. Tunable via env without a redeploy.
const COMPACT_TRIGGER_TOKENS = Number(process.env.CODING_COMPACT_TRIGGER) || 30000; // aprox tokens
const estMsgTokens = (m) => {
  if (!m) return 0;
  let chars = (typeof m.content === 'string' ? m.content.length : 0);
  if (Array.isArray(m.toolCalls)) { try { chars += JSON.stringify(m.toolCalls).length; } catch {} }
  return Math.ceil(chars / 4);
};
const estHistoryTokens = (messages) => messages.reduce((a, m) => a + estMsgTokens(m), 0);

const COMPACT_SYSTEM = [
  'You summarize the STATE of a coding job in progress so it can continue',
  'without carrying the whole history. Produce a COMPACT, factual summary, in',
  'bullet points, with only what the executor needs to keep going:',
  '• Overall goal of the job and what has already been DONE (files created/changed,',
  '  commands run, what was published and where).',
  '• Relevant current state (structure/files that matter, decisions made,',
  '  facts learned from the code). Do NOT paste whole file contents; describe them.',
  '• What is still PENDING or to be confirmed, if anything.',
  'Do not invent anything that is not in the history. Be economical.',
].join('\n');

// Builds a short transcript of the history to feed the summary (truncates blobs).
function transcriptOf(messages) {
  const line = (m) => {
    if (!m || !m.role) return '';
    if (m.role === 'user') return `USER: ${String(m.content || '').slice(0, 1200)}`;
    if (m.role === 'tool') return `RESULT(${m.name || 'tool'}): ${String(m.content || '').slice(0, 800)}`;
    if (m.role === 'assistant') {
      const calls = Array.isArray(m.toolCalls) && m.toolCalls.length
        ? ` [called: ${m.toolCalls.map((c) => c.name).join(', ')}]` : '';
      return `ASSISTANT: ${String(m.content || '').slice(0, 1200)}${calls}`;
    }
    return '';
  };
  return messages.map(line).filter(Boolean).join('\n');
}

// Summarizes the history into a single block and returns the new compact session:
// [ {user: resumo}, {assistant: última resposta} ] — a valid sequence (the next
// turn adds a user message, keeping the alternation). On failure, returns null and the
// caller keeps the previous behavior (cap + collapse).
async function compactHistory({ messages, provider, onUsage }) {
  try {
    const transcript = transcriptOf(messages);
    if (!transcript.trim()) return null;
    const res = await provider.complete({
      system: COMPACT_SYSTEM,
      messages: [{ role: 'user', content: `History of the coding job so far:\n\n${transcript}\n\nSummarize the STATE as instructed.` }],
      tools: [],
    });
    if (res?.usage && onUsage) { try { onUsage({ ...res.usage, kind: 'compact', noBill: true }); } catch {} }
    const resumo = (res?.text || '').trim();
    if (!resumo) return null;
    // preserves the assistant's last text response (the freshest step)
    const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant' && typeof m.content === 'string' && m.content.trim() && !(Array.isArray(m.toolCalls) && m.toolCalls.length));
    const out = [{ role: 'user', content: `[CONTEXT] Summary of the coding job so far:\n${resumo}` }];
    if (lastAssistant) out.push({ role: 'assistant', content: lastAssistant.content });
    return out;
  } catch { return null; }
}

// Lean system prompt for the coding sub-agent. Only the essentials: it's an executor of
// a code task with its own tooling; the main agent already handled persona,
// channel, memory. None of that needs to be resent here.
export const CODING_SUBAGENT_SYSTEM = [
  "You are an assistant's CODE task executor. You receive a programming",
  'goal (change an app, project, server or sandbox) and accomplish it',
  'using the available tools: read/list/search the code, edit/',
  'write files, run commands, publish.',
  '',
  'Rules:',
  '• Work incrementally: read what you need BEFORE editing; do not',
  '  rewrite a whole file when a targeted edit does the job.',
  '• Read only the relevant part (use line ranges / search), not the whole',
  '  file, and do NOT re-read what you already read in this job.',
  '• Be economical: every step resends the context. Get straight to the point.',
  "• THE OWNER'S DATA NEVER LEAVES OUR INFRASTRUCTURE (non-negotiable): it is FORBIDDEN to upload,",
  "  host or mirror the user's files, photos, documents or data on a",
  '  THIRD-PARTY service: temporary/anonymous hosts (catbox, litter.catbox,',
  '  file.io, transfer.sh, 0x0.st, gofile, tmpfiles, wetransfer, imgur),',
  '  paste/gist, buckets or repositories that are not ours, outside webhooks.',
  '  This holds even if it expires in minutes, is "private" or is just an',
  '  intermediate step to bring the file into the sandbox: the moment it is uploaded the',
  '  data has left our control, and that is a leak. Internet access here is for',
  "  DOWNLOADING (packages, pages), never for UPLOADING the owner's data.",
  '• If the task can only be done by going outside, it is NOT done: stop and answer that',
  '  an internal way to move the file is missing. Prefer failing to improvising.',
  '• When you finish (or get stuck), answer in short TEXT: what you did, the concrete',
  '  result (files changed, command run, URL published) and what is missing,',
  '  if anything. This text is what goes back to the main assistant: it',
  '  does not see the intermediate steps or the raw tool output.',
].join('\n');

// ── System prompt for the APP BUILD sub-agent ──────────────────────────────
// Second instance of the SAME engine (runCodingSubagent), with a different system and
// a different registry — it's the "load the plugin twice with a different toolName" from
// dsh. What changes compared to `codar`: here the target is always an owner's app on
// their subdomain, and IRREVERSIBLE actions (publish, delete, replicate, roll back
// version, remove) do NOT exist in this registry — they are the owner's decision, and the
// confirmation gate lives in the main turn, not in a sub-agent. The sub finishes the
// draft and REPORTS what's left to confirm (same discipline as dsh: the child
// reports the limitation, the parent decides whether to ask the human).
export const APP_SUBAGENT_SYSTEM = () => [
  `You are the APP BUILDER of a ${marca().nome} assistant. You receive a goal`,
  '(create or change a web app of the owner, published on their subdomain) and carry it out',
  "with the app's file tools. Persona, channel and conversation are handled",
  'by the main assistant; here it is execution.',
  '',
  'WHAT IS IN YOUR HANDS AND WHAT IS NOT:',
  "• You work on the app's DRAFT: create the structure, list/read/write/edit",
  '  files, set secrets, view logs, diff and history.',
  '• PUBLISHING, deleting, replicating, rolling back a version and removing a file/secret are',
  "  the OWNER'S decision and are not in your hands (the tools do not even exist here).",
  '  Finish the work on the draft and SAY in the report that publishing is pending. Do not',
  '  try to work around it another way: the main assistant is the one who talks to the owner.',
  '',
  'FLOW:',
  '• Changing an existing app: ler_arquivo_do_app (listar_arquivos_do_app if you do not',
  '  know the names) → editar_arquivo_do_app for a targeted change (several changes',
  '  in the same file: send the "edicoes" list in a single call, it is atomic).',
  '  escrever_arquivo_do_app only for a NEW file or a complete rewrite. NEVER',
  '  rebuild an app from scratch.',
  '• NEW node app: call iniciar_estrutura_do_app FIRST (it creates the ready skeleton)',
  '  and just fill it in.',
  "• ESPEC.md (the app's memory): every app has an ESPEC.md at the root with what the owner",
  '  HAS ALREADY TESTED AND APPROVED. Read it BEFORE the first edit (if it does not exist, create it along',
  '  with the first change) and record there whatever gets approved, in short bullets.',
  '  What is there is a CONTRACT: do not change approved behavior unless the goal',
  '  asks for it. A regression of what the owner already validated is the worst possible mistake.',
  '• Small iterations and SMALL, separate files (HTML, CSS, JS, routes in',
  '  different files): a lean file is easy to edit piece by piece and does not hit',
  '  the output ceiling. Fence the scope: extra ideas nobody asked for stay out.',
  '• Do NOT re-inspect what you just wrote: the result of write/edit',
  '  IS the confirmation (ok, bytes, hash). Do not re-read a file you saved yourself,',
  '  and do not keep listing files between one edit and the next.',
  '• Debugging: read the code BEFORE any diagnosis; only call with',
  '  chamar_sistema a route you CONFIRMED exists by reading the route files',
  "  (a nonexistent route returns empty and is NOT an app bug); ver_logs_sistema shows the",
  '  real runtime error. Note: chamar_sistema hits what is LIVE (the latest',
  '  published version), not your draft.',
  '',
  'CODE RULES (inviolable):',
  '• There is NO dependency install step: use only the standard library. Node =',
  '  built-in modules (http, fs, path, crypto, url) and, for a database, the embedded SQLite:',
  "  require('node:sqlite') + new DatabaseSync(path) (same API as",
  '  better-sqlite3). NEVER better-sqlite3, express or any npm package: the',
  "  require fails and the app does not start. Flask = flask, gunicorn and sqlite3, nothing else.",
  "• Persistent data always in /app/data (create the folder first: fs.mkdirSync('/app/data',{recursive:true})).",
  '• RELATIVE PATHS in the front end (critical): the app is served under a SUBPATH, not at the',
  '  domain root. Use href="style.css", src="core.js", fetch(\'api/status\'):',
  '  NEVER with a leading slash (with a slash the browser fetches from the root and gets a 404).',
  '  Inside server.js/app.py the routes stay at the root as usual.',
  '• SECRETS NEVER IN THE CODE (publishing refuses if it finds one): store them with definir_segredo',
  '  (encrypted vault, injected as env at boot) and in the code use process.env.NAME',
  '  (Node) / os.environ["NAME"] (Flask).',
  "• THE APP'S DATA ALSO BELONGS TO THE ASSISTANT: if the app stores data, provide from the",
  '  start a read route the assistant can reach (protected by a vault secret,',
  "  in a header), so it is never locked out of its own owner's",
  "  data. NEVER design something that requires asking the owner for the app's password/token.",
  '• If the app shows PERSONAL data, it needs protected access: the URL is',
  '  reachable by anyone who has the link.',
  '',
  "• THE OWNER'S DATA NEVER LEAVES OUR INFRASTRUCTURE (non-negotiable): it is FORBIDDEN to upload,",
  "  host or mirror the user's files, photos, documents or data on a",
  '  THIRD-PARTY service: temporary/anonymous hosts (catbox, file.io, transfer.sh, 0x0.st,',
  '  gofile, tmpfiles, wetransfer, imgur), paste/gist, buckets or repositories that are not',
  '  ours, outside webhooks. This holds even if it expires in minutes, is "private"',
  '  or is just an intermediate step. If the task can only be done by going outside, it',
  '  is NOT done: stop and report it.',
  '',
  'Before finishing, call validar_rascunho_do_app after the last edit. Fix its exact diagnostics and validate again. This tool does not publish or validate boot/UX. Never announce functional completion based on the lint alone.',
  'Large reads come back in pages: move forward with proximo_inicio and hash_esperado; do not re-read the first page in a loop or save a fragment as a whole file.',
  'FINAL REPORT: when you finish (or get stuck), answer in short, factual TEXT:',
  'what you did, which files you changed, and what is missing (especially if PUBLISHING',
  'is needed to go live). This text is the ONLY thing that goes back to the main assistant:',
  'it does not see your steps or the raw tool output. Write for the assistant,',
  'not for the owner.',
].join('\n');

// Runs one round of the coding sub-agent over a persistent session.
//   objetivo   — what to do (the main agent describes it with context; the sub doesn't see the conversation)
//   tools      — ToolRegistry already assembled with the code tooling
//   provider   — strong provider (coding needs the good model)
//   sessionKey — `${agentId}:${threadId}` (persists the history across turns)
//   system     — system override (default CODING_SUBAGENT_SYSTEM)
//   maxSteps   — cap on the loop's steps
//   onUsage    — receives each usage for billing (kind='subagent')
//   onEvent    — forwards events (tool_call etc.) for live narration
//   nowMs      — injectable clock (tests)
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

  // Persists the sub's history (no images; coding doesn't use them), collapses old
  // blobs (hygiene between calls) and prunes it by the message cap.
  const hist = messages.filter((m) => m && m.role);
  for (const m of hist) if (m.images) delete m.images;
  collapseHistoryBlobs(hist);
  // Summary compaction: if the history (already collapsed) still exceeds the threshold,
  // swap it for a single "state of the work" block + the last response. This
  // shrinks the (non-cacheable) `contents` that grew turn by turn and was killing
  // the cache hit. On summary failure, it falls back to the cap by number of messages (previous
  // behavior), so it's never worse. We run this BEFORE the cap so the summary can see
  // the whole history.
  let compacted = null;
  if (compact && estHistoryTokens(hist) > COMPACT_TRIGGER_TOKENS) {
    compacted = await compactHistory({ messages: hist, provider, onUsage });
  }
  // Whatever gets stored goes through the call/result pair stitching: it's what's
  // left after pruning that becomes the `history` for the next call, so this is where
  // an orphan result needs to die, before it poisons the entire session.
  if (compacted) sess.history = compacted;
  else sess.history = dropOrphanToolMessages(capHistory(hist));
  sess.lastUsed = Date.now();

  if (onUsage && Array.isArray(usages)) {
    for (const u of usages) { try { onUsage({ ...u, kind: 'subagent' }); } catch {} }
  }
  return buildState ? buildState.finish({ text, termination }) : text || 'A chamada de código terminou sem resumo textual; conclusão não confirmada.';
}

// Discards a thread's coding session (e.g. leaving the project/app, reset).
export function resetCodingSession(sessionKey) {
  if (sessionKey) sessions.delete(sessionKey);
}

// Factory for the `codar` meta-tool for the MAIN agent's registry. Receives a closure
// that (lazily) builds the coding registry + provider when the tool is called, so
// it doesn't pay the setup cost on a turn that doesn't code.
// `language` = owner's language. The sub-agent's report goes back to the main agent,
// but pieces of it (summary, questions) reach the person almost verbatim.
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

// Factory for the `construir_app` meta-tool for the MAIN agent's registry. Same shape as
// makeCodarTool (same engine, another instance): what changes is the system, the registry
// the closure builds and the sessionKey (`:app`, separate from the `codar` session).
// This is where the strong model comes in — in a new, clean context. The main
// turn never switches models at any point.
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
        // When the main agent ALREADY knows which app it is, it notifies the hosting: this way the FIRST
        // write from the sub-agent already goes out with the right app, without it having to repeat the
        // slug in every call (a user's request).
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
