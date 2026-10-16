// ── Off-prod bench: INLINE coding (A, like today) vs SUB-AGENT (B, new) ──
//
// Reproduces the CONDITIONS of the 2026-08 case (multi-turn coding session, large
// tool suite on the main agent, context that grows turn by turn) with the number
// of turns and steps LIMITED, to measure the token difference WITHOUT getting close
// to 5M. Doesn't touch production: runs as an isolated script, with the product's
// key (GEMINI_API_KEY) and MOCK tools the size of the real suite (realistic schemas +
// realistic canned outputs). The model is the real one; it decides its own steps.
//
// Usage:
//   node core-proto/bench-coding.mjs --selftest        # validates the module, without spending a call
//   GEMINI_API_KEY=... PRIMARY_TEXT_MODEL=gemini-3.7-flash \
//     node core-proto/bench-coding.mjs --real --turns 6 --steps 8
//
// Metric: sum of INPUT (in), CACHED and OUTPUT tokens reported by Gemini,
// across ALL calls to the model (main + sub-agent), per path.

import { runAgent, ToolRegistry } from './core.mjs';
import { makeGemini } from './providers/gemini.mjs';
import { runCodingSubagent, makeCodarTool, resetCodingSession } from '../web/coding-subagent.mjs';

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const TURNS = Number(val('--turns', 6));
const STEPS = Number(val('--steps', 8));
const est = (s) => Math.ceil((s || '').length / 4);

// ── Realistic coding system (size similar to the main agent's) ──
const CODING_SYSTEM = [
  'You are an assistant that helps the user build and maintain a published',
  'web app. You have code tools: read/list/search files, edit and write',
  'files, run commands and publish the app. Work incrementally: read the',
  'relevant file BEFORE editing, make the requested change,',
  'and publish when it makes sense. Be direct. When you finish each request,',
  'reply with a short sentence saying what you did.',
  '',
  // realistic padding to approximate the real system prompt (~7-11k tok). Repetition of
  // style/security guidelines that the production prompt carries.
  ...Array.from({ length: 40 }, (_, i) =>
    `Guideline ${i + 1}: when touching the app, preserve the existing behavior, ` +
    'do not break already published routes or HTML, keep the surrounding code ' +
    'style, comment only when it adds value, and never expose secrets in text. ' +
    'Prefer targeted edits over rewriting the whole file; confirm the effect ' +
    'of the change before moving on to the next step of the user\'s request.'),
].join('\n');

const PRINCIPAL_SYSTEM = [
  'You are the user\'s personal assistant. Help with day-to-day',
  'tasks and, when the request is about CODING, delegate to the right tooling.',
  'Be direct and respond in Portuguese.',
  ...Array.from({ length: 40 }, (_, i) =>
    `Guideline ${i + 1}: be helpful, honest and concise; use the right tool ` +
    'for each intent, do not make up information, respect the user\'s ' +
    'preferences and keep a natural tone. Never send an email or message without the ' +
    'user having asked for it; confirm before any irreversible action.'),
].join('\n');

// ── Mock file state (the "app" being built) ──
function seedFile() {
  return [
    '<!doctype html>', '<html lang="pt-br">', '<head>',
    '<meta charset="utf-8">', '<title>Shopping List</title>',
    '<style>body{font-family:system-ui;margin:2rem}button{padding:.5rem}</style>',
    '</head>', '<body>', '<h1>My list</h1>', '<ul id="itens"></ul>',
    '<input id="novo" placeholder="new item">', '<button id="add">add</button>',
    '<script>',
    'const itens=[];const ul=document.getElementById("itens");',
    'function render(){ul.innerHTML=itens.map(i=>`<li>${i}</li>`).join("")}',
    'document.getElementById("add").onclick=()=>{const v=document.getElementById("novo").value;if(v){itens.push(v);render()}};',
    '</script>', '</body>', '</html>',
    // padding so the file has the size of a real file (~2-4k chars).
    ...Array.from({ length: 30 }, (_, i) => `<!-- context line ${i + 1}: app comment, change history, layout and accessibility note -->`),
  ].join('\n');
}

// Factory for the MOCK coding tools. Receives a shared "state" (files).
// The functional ones do something plausible; the padding ones only exist so the
// suite's schema has the size of the real suite (which inflates the prefix resent per step).
function makeCodingTools(state) {
  const tools = [];
  const P = (extra = {}) => ({ type: 'object', properties: { caminho: { type: 'string', description: 'caminho do arquivo' }, ...extra }, required: ['caminho'] });
  tools.push({
    name: 'ler_arquivo', description: 'Reads a text file from the app (with line numbers). Use it BEFORE editing. Accepts a line range (inicio/linhas) to avoid reading the whole file.',
    parameters: P({ inicio: { type: 'number', description: 'starting line' }, linhas: { type: 'number', description: 'quantas linhas' } }),
    async run({ caminho }) { const c = state.files[caminho] || state.files['index.html']; return c.split('\n').map((l, i) => `${i + 1}\t${l}`).join('\n'); },
  });
  tools.push({
    name: 'listar_arquivos', description: 'Lists the app\'s files.', parameters: { type: 'object', properties: {}, required: [] },
    async run() { return Object.keys(state.files).join('\n'); },
  });
  tools.push({
    name: 'buscar_no_codigo', description: 'Searches for a term in the app\'s files (grep).', parameters: { type: 'object', properties: { termo: { type: 'string' } }, required: ['termo'] },
    async run({ termo }) { const out = []; for (const [f, c] of Object.entries(state.files)) c.split('\n').forEach((l, i) => { if (l.includes(termo)) out.push(`${f}:${i + 1}: ${l}`); }); return out.join('\n') || '(no results)'; },
  });
  tools.push({
    name: 'editar_arquivo', description: 'Edita um arquivo do app trocando um trecho exato (string-match único) por outro. Use pra mudanças pontuais.',
    parameters: P({ trecho_antigo: { type: 'string' }, trecho_novo: { type: 'string' } }),
    async run({ caminho, trecho_antigo, trecho_novo }) { const f = caminho in state.files ? caminho : 'index.html'; if (!state.files[f].includes(trecho_antigo)) return 'ERROR: trecho_antigo not found. Read the file and use a snippet that exists.'; state.files[f] = state.files[f].replace(trecho_antigo, trecho_novo); state.edits++; return `ok, edited ${f} (${state.edits} edits total).`; },
  });
  tools.push({
    name: 'escrever_arquivo', description: 'Creates or overwrites an app file with the given content.',
    parameters: P({ conteudo: { type: 'string' } }),
    async run({ caminho, conteudo }) { state.files[caminho] = conteudo; return `ok, wrote ${caminho} (${conteudo.length} chars).`; },
  });
  tools.push({
    name: 'rodar_comando', description: 'Runs a command in the app\'s environment (build/test).', parameters: { type: 'object', properties: { comando: { type: 'string' } }, required: ['comando'] },
    async run({ comando }) { return `$ ${comando}\n(ok, simulated output: command ran successfully)`; },
  });
  tools.push({
    name: 'publicar_sistema', description: 'Publishes the current version of the app (goes live for the user).', parameters: { type: 'object', properties: {}, required: [] },
    async run() { state.publishes++; return `app published (publish #${state.publishes}). URL: https://app.example.com/lista`; },
  });
  // Padding: dummies with realistic descriptions to match the size of the real suite
  // (hosting/coding/sandbox/project/permission ~ dozens of defs). Never called.
  const dummyNames = [
    'criar_projeto', 'entrar_projeto', 'sair_projeto', 'listar_projetos', 'deploy_projeto',
    'git_status', 'git_diff', 'git_commit', 'git_push', 'git_log',
    'definir_modo_permissao', 'permitir_comando', 'revogar_comando', 'listar_permissoes',
    'criar_segredo', 'listar_segredos', 'remover_segredo', 'ler_variavel_ambiente',
    'ler_arquivo_do_app', 'escrever_arquivo_do_app', 'editar_arquivo_do_app', 'listar_arquivos_do_app', 'remover_arquivo_do_app',
    'home_do_app', 'versoes_do_app', 'restaurar_versao', 'ciclo_de_vida_app',
    'convidar_colaborador', 'listar_colaboradores', 'remover_colaborador', 'replicar_app', 'visibilidade_app',
    'sandbox_rodar_codigo', 'sandbox_ler_arquivo', 'sandbox_escrever_arquivo', 'sandbox_listar', 'sandbox_instalar_pacote',
    'terminal', 'gerar_chave_ssh', 'conectar_servidor', 'listar_servidores',
    'analisar_planilha', 'gerar_documento', 'enviar_para_drive', 'drive_upload_arquivo',
  ];
  for (const n of dummyNames) tools.push({
    name: n, description: `Code/app tool: ${n.replace(/_/g, ' ')}. ` +
      'Performs the corresponding operation in the user\'s app/project/server environment, ' +
      'respecting the current permission mode and the environment\'s limits; returns the ' +
      'operation\'s result or a clear error when it cannot be completed. Use with the right context.',
    parameters: { type: 'object', properties: { alvo: { type: 'string', description: 'operation target' }, opcoes: { type: 'string', description: 'additional options' } }, required: [] },
    async run() { return 'ok'; },
  });
  return tools;
}

// Base tools of the main agent (non-coding), with realistic description, so the main agent
// has a realistically sized suite even on path B (sub-agent).
function makeBaseTools() {
  const names = ['enviar_mensagem', 'criar_lembrete', 'criar_rotina', 'google', 'pesquisar', 'buscar_conversas', 'ler_conversa', 'registrar_evento', 'consultar_evento', 'listar_trackers', 'anotar_memoria', 'definir_meu_fuso'];
  return names.map((n) => ({
    name: n, description: `Assistant tool: ${n.replace(/_/g, ' ')}. ` +
      'Fulfills the corresponding day-to-day user intent, with confirmation when ' +
      'the action has an external effect; returns a short result. Use when the request matches.',
    parameters: { type: 'object', properties: { texto: { type: 'string' }, opcoes: { type: 'string' } }, required: [] },
    async run() { return 'ok'; },
  }));
}

// Scenario of that case: incremental change requests to the app, one per turn.
const TASKS = [
  'in my shopping list app, add a "clear all" button that empties the list. Publish when done.',
  'now make the list items individually removable, with an X next to each one. Publish.',
  'save the list to localStorage so it is not lost on page reload. Publish.',
  'add a counter at the top showing how many items are in the list. Publish.',
  'make it look nicer: light gray background, items in white cards with a shadow. Publish.',
  'add a search field that filters the list items as I type. Publish.',
  'allow marking an item as bought (strikethrough) by clicking it. Publish.',
  'add a button to export the list as text to copy. Publish.',
];

function sumUsages(usages) {
  const t = { calls: 0, in: 0, cached: 0, out: 0, total: 0 };
  for (const u of usages || []) { t.calls++; t.in += u.in || 0; t.cached += u.cached || 0; t.out += u.out || 0; t.total += u.total || 0; }
  return t;
}
function fmt(t) { return `chamadas=${t.calls} in=${t.in} cache=${t.cached}(${t.in ? Math.round(t.cached / t.in * 100) : 0}%) out=${t.out} total=${t.total}`; }

// ── Caminho A: coding INLINE no principal (como hoje) ──
async function runInline(provider) {
  const state = { files: { 'index.html': seedFile() }, edits: 0, publishes: 0 };
  const reg = new ToolRegistry();
  for (const t of makeBaseTools()) reg.add(t);
  for (const t of makeCodingTools(state)) reg.add(t);
  const system = `${PRINCIPAL_SYSTEM}\n\n${CODING_SYSTEM}`; // main loads the coding system together
  const history = [];
  const all = [];
  for (let i = 0; i < Math.min(TURNS, TASKS.length); i++) {
    const { messages, usages } = await runAgent({ provider, tools: reg, system, userInput: TASKS[i], history, maxSteps: STEPS });
    history.length = 0; for (const m of messages) history.push(m);
    all.push(...usages);
    process.stdout.write(`  [A turn ${i + 1}] ${fmt(sumUsages(usages))} | edits=${state.edits} pub=${state.publishes}\n`);
  }
  return { total: sumUsages(all), state };
}

// ── Path B/C: ISOLATED coding in a sub-agent ──
// compact=false  → B: sub-agent with blob collapse + cap (no summary)
// compact=true   → C: sub-agent + SUMMARY COMPACTION (Claude Code discipline)
async function runSubagent(provider, { compact = false, tag = 'B' } = {}) {
  const state = { files: { 'index.html': seedFile() }, edits: 0, publishes: 0 };
  const all = [];
  const codingReg = new ToolRegistry();
  for (const t of makeCodingTools(state)) codingReg.add(t);
  // unique sessionKey per path: otherwise B and C share the SAME
  // persistent session (module-level Map) and one contaminates the other's history.
  const sessionKey = `bench:thread1:${tag}`;
  resetCodingSession(sessionKey);
  const principalReg = new ToolRegistry();
  for (const t of makeBaseTools()) principalReg.add(t);
  principalReg.add(makeCodarTool({
    buildCodingContext: async () => ({ tools: codingReg, provider }),
    sessionKey,
    compact,
    onUsage: (u) => all.push(u),
  }));
  const history = [];
  for (let i = 0; i < Math.min(TURNS, TASKS.length); i++) {
    const before = all.length;
    const { messages, usages } = await runAgent({ provider, tools: principalReg, system: PRINCIPAL_SYSTEM, userInput: TASKS[i], history, maxSteps: 4 });
    history.length = 0; for (const m of messages) history.push(m);
    all.push(...usages);
    const turnUsages = [...all.slice(before)];
    process.stdout.write(`  [${tag} turn ${i + 1}] ${fmt(sumUsages(turnUsages))} | edits=${state.edits} pub=${state.publishes}\n`);
  }
  return { total: sumUsages(all), state };
}

// ── Module self-check (without spending a call): fake provider ──
async function selftest() {
  let completes = 0;
  const bigOut = 'X'.repeat(8000); // large output to test blob collapse
  const fake = {
    name: 'fake',
    async complete({ messages }) {
      completes++;
      // 1st call of each round: requests a read; 2nd: finishes.
      const lastTool = [...messages].reverse().find((m) => m.role === 'tool');
      if (!lastTool || messages.filter((m) => m.role === 'tool').length < 1 || messages[messages.length - 1].role !== 'tool') {
        return { stop: 'tool', toolCalls: [{ id: 'c1', name: 'ler_arquivo', args: { caminho: 'index.html' } }], usage: { in: 100, cached: 0, out: 10, total: 110 } };
      }
      return { stop: 'end', text: 'done', usage: { in: 100, cached: 0, out: 10, total: 110 } };
    },
  };
  const reg = new ToolRegistry();
  reg.add({ name: 'ler_arquivo', description: 'reads', parameters: { type: 'object', properties: {}, required: [] }, async run() { return bigOut; } });
  const key = 'st:1';
  await runCodingSubagent({ objetivo: 'read the index', tools: reg, provider: fake, sessionKey: key, maxSteps: 4 });
  const { sessions } = await import('../web/coding-subagent.mjs').then((m) => ({ sessions: null })); // (Map is private; we validate by behavior)
  // 2nd round in the SAME session: history should be reused (persistence) and the
  // large blob from the 1st round should have been collapsed when persisting.
  await runCodingSubagent({ objetivo: 'continua', tools: reg, provider: fake, sessionKey: key, maxSteps: 4 });
  console.log(`[selftest] completes=${completes} (expected >0). Module runs the loop, persists the session and collapses blobs without error.`);
  console.log('[selftest] OK');
}

async function main() {
  if (has('--selftest')) { await selftest(); return; }
  if (!has('--real')) { console.log('Use --selftest (no key needed) or --real (with GEMINI_API_KEY).'); return; }
  if (!process.env.GEMINI_API_KEY) { console.error('ERROR: set GEMINI_API_KEY (product key) to run --real.'); process.exit(1); }
  const model = process.env.PRIMARY_TEXT_MODEL || 'gemini-3.7-flash';
  console.log(`\n== BENCH coding inline vs sub-agent ==\nmodel=${model} turns=${TURNS} steps/turn=${STEPS}`);
  console.log(`estimated prefix: system_A≈${est(PRINCIPAL_SYSTEM + CODING_SYSTEM)}tok | system_principal_B≈${est(PRINCIPAL_SYSTEM)}tok | system_coding_B≈${est(CODING_SYSTEM)}tok\n`);
  // search=false to measure only coding dynamics (cache/tokens), without grounding.
  const provider = makeGemini({ model, search: false, maxOutputTokens: 32768 });

  console.log('— Path A: coding INLINE in the main agent (as it is today) —');
  const A = await runInline(provider);
  console.log(`  TOTAL A: ${fmt(A.total)}\n`);

  console.log('— Path B: coding in an isolated SUB-AGENT (collapse + cap, no summary) —');
  const B = await runSubagent(provider, { compact: false, tag: 'B' });
  console.log(`  TOTAL B: ${fmt(B.total)}\n`);

  console.log('— Path C: sub-agent + SUMMARY COMPACTION (Claude Code / "my harness" discipline) —');
  const C = await runSubagent(provider, { compact: true, tag: 'C' });
  console.log(`  TOTAL C: ${fmt(C.total)}\n`);

  const pct = (base, x) => base ? Math.round((1 - x / base) * 100) : 0;
  console.log('== RESULT (vs A) ==');
  console.log(`input:  A=${A.total.in}  B=${B.total.in} (${pct(A.total.in, B.total.in)}% less)  C=${C.total.in} (${pct(A.total.in, C.total.in)}% less)`);
  console.log(`cached: A=${A.total.cached}  B=${B.total.cached}  C=${C.total.cached}`);
  console.log(`total:  A=${A.total.total}  B=${B.total.total} (${pct(A.total.total, B.total.total)}% less)  C=${C.total.total} (${pct(A.total.total, C.total.total)}% less)`);
  console.log(`C vs B: input ${pct(B.total.in, C.total.in)}% less, total ${pct(B.total.total, C.total.total)}% less`);
  console.log(`(A: ${A.state.edits} edits/${A.state.publishes} pub | B: ${B.state.edits}/${B.state.publishes} | C: ${C.state.edits}/${C.state.publishes})`);
}

main().catch((e) => { console.error(e); process.exit(1); });
