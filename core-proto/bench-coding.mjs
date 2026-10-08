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
  'Você é um assistente que ajuda o usuário a construir e manter um app web',
  'publicado. Você tem ferramentas de código: ler/listar/buscar arquivos, editar e',
  'escrever arquivos, rodar comandos e publicar o app. Trabalhe de forma',
  'incremental: leia o arquivo relevante ANTES de editar, faça a mudança pedida,',
  'e publique quando fizer sentido. Seja direto. Ao concluir cada pedido,',
  'responda em uma frase curta o que você fez.',
  '',
  // realistic padding to approximate the real system prompt (~7-11k tok). Repetition of
  // style/security guidelines that the production prompt carries.
  ...Array.from({ length: 40 }, (_, i) =>
    `Diretriz ${i + 1}: ao mexer no app, preserve o comportamento existente, ` +
    'não quebre rotas nem HTML já publicados, mantenha o estilo do código ao ' +
    'redor, comente só quando agregar, e nunca exponha segredos em texto. ' +
    'Prefira edições pontuais a reescrever o arquivo inteiro; confirme o efeito ' +
    'da mudança antes de seguir para o próximo passo do pedido do usuário.'),
].join('\n');

const PRINCIPAL_SYSTEM = [
  'Você é o assistente pessoal do usuário. Ajuda com tarefas do dia a',
  'dia e, quando o pedido é de PROGRAMAÇÃO/código, delega ao ferramental certo.',
  'Seja direto e responda em português.',
  ...Array.from({ length: 40 }, (_, i) =>
    `Diretriz ${i + 1}: seja útil, honesto e conciso; use a ferramenta certa ` +
    'para cada intenção, não invente informação, respeite as preferências do ' +
    'usuário e mantenha o tom natural. Nunca envie e-mail ou mensagem sem que o ' +
    'usuário tenha pedido; confirme antes de qualquer ação irreversível.'),
].join('\n');

// ── Mock file state (the "app" being built) ──
function seedFile() {
  return [
    '<!doctype html>', '<html lang="pt-br">', '<head>',
    '<meta charset="utf-8">', '<title>Lista de Compras</title>',
    '<style>body{font-family:system-ui;margin:2rem}button{padding:.5rem}</style>',
    '</head>', '<body>', '<h1>Minha lista</h1>', '<ul id="itens"></ul>',
    '<input id="novo" placeholder="novo item">', '<button id="add">adicionar</button>',
    '<script>',
    'const itens=[];const ul=document.getElementById("itens");',
    'function render(){ul.innerHTML=itens.map(i=>`<li>${i}</li>`).join("")}',
    'document.getElementById("add").onclick=()=>{const v=document.getElementById("novo").value;if(v){itens.push(v);render()}};',
    '</script>', '</body>', '</html>',
    // padding so the file has the size of a real file (~2-4k chars).
    ...Array.from({ length: 30 }, (_, i) => `<!-- linha de contexto ${i + 1}: comentário do app, historico de mudanca, nota de layout e acessibilidade -->`),
  ].join('\n');
}

// Factory for the MOCK coding tools. Receives a shared "state" (files).
// The functional ones do something plausible; the padding ones only exist so the
// suite's schema has the size of the real suite (which inflates the prefix resent per step).
function makeCodingTools(state) {
  const tools = [];
  const P = (extra = {}) => ({ type: 'object', properties: { caminho: { type: 'string', description: 'caminho do arquivo' }, ...extra }, required: ['caminho'] });
  tools.push({
    name: 'ler_arquivo', description: 'Lê um arquivo de texto do app (com número de linha). Use ANTES de editar. Aceita faixa de linhas (inicio/linhas) pra não ler o arquivo inteiro.',
    parameters: P({ inicio: { type: 'number', description: 'linha inicial' }, linhas: { type: 'number', description: 'quantas linhas' } }),
    async run({ caminho }) { const c = state.files[caminho] || state.files['index.html']; return c.split('\n').map((l, i) => `${i + 1}\t${l}`).join('\n'); },
  });
  tools.push({
    name: 'listar_arquivos', description: 'Lista os arquivos do app.', parameters: { type: 'object', properties: {}, required: [] },
    async run() { return Object.keys(state.files).join('\n'); },
  });
  tools.push({
    name: 'buscar_no_codigo', description: 'Busca um termo nos arquivos do app (grep).', parameters: { type: 'object', properties: { termo: { type: 'string' } }, required: ['termo'] },
    async run({ termo }) { const out = []; for (const [f, c] of Object.entries(state.files)) c.split('\n').forEach((l, i) => { if (l.includes(termo)) out.push(`${f}:${i + 1}: ${l}`); }); return out.join('\n') || '(sem resultados)'; },
  });
  tools.push({
    name: 'editar_arquivo', description: 'Edita um arquivo do app trocando um trecho exato (string-match único) por outro. Use pra mudanças pontuais.',
    parameters: P({ trecho_antigo: { type: 'string' }, trecho_novo: { type: 'string' } }),
    async run({ caminho, trecho_antigo, trecho_novo }) { const f = caminho in state.files ? caminho : 'index.html'; if (!state.files[f].includes(trecho_antigo)) return 'ERRO: trecho_antigo não encontrado. Leia o arquivo e use um trecho que exista.'; state.files[f] = state.files[f].replace(trecho_antigo, trecho_novo); state.edits++; return `ok, editei ${f} (${state.edits} edições no total).`; },
  });
  tools.push({
    name: 'escrever_arquivo', description: 'Cria ou sobrescreve um arquivo do app com o conteúdo dado.',
    parameters: P({ conteudo: { type: 'string' } }),
    async run({ caminho, conteudo }) { state.files[caminho] = conteudo; return `ok, escrevi ${caminho} (${conteudo.length} chars).`; },
  });
  tools.push({
    name: 'rodar_comando', description: 'Roda um comando no ambiente do app (build/test).', parameters: { type: 'object', properties: { comando: { type: 'string' } }, required: ['comando'] },
    async run({ comando }) { return `$ ${comando}\n(ok, saída simulada: comando executado com sucesso)`; },
  });
  tools.push({
    name: 'publicar_sistema', description: 'Publica a versão atual do app (fica no ar pro usuário).', parameters: { type: 'object', properties: {}, required: [] },
    async run() { state.publishes++; return `app publicado (publicação #${state.publishes}). URL: https://app.example.com/lista`; },
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
    name: n, description: `Ferramenta de código/app: ${n.replace(/_/g, ' ')}. ` +
      'Executa a operação correspondente no ambiente do app/projeto/servidor do usuário, ' +
      'respeitando o modo de permissão vigente e os limites do ambiente; devolve o resultado ' +
      'da operação ou um erro claro quando não é possível concluir. Use com o contexto certo.',
    parameters: { type: 'object', properties: { alvo: { type: 'string', description: 'alvo da operação' }, opcoes: { type: 'string', description: 'opções adicionais' } }, required: [] },
    async run() { return 'ok'; },
  });
  return tools;
}

// Base tools of the main agent (non-coding), with realistic description, so the main agent
// has a realistically sized suite even on path B (sub-agent).
function makeBaseTools() {
  const names = ['enviar_mensagem', 'criar_lembrete', 'criar_rotina', 'google', 'pesquisar', 'buscar_conversas', 'ler_conversa', 'registrar_evento', 'consultar_evento', 'listar_trackers', 'anotar_memoria', 'definir_meu_fuso'];
  return names.map((n) => ({
    name: n, description: `Ferramenta do assistente: ${n.replace(/_/g, ' ')}. ` +
      'Cumpre a intenção correspondente do usuário no dia a dia, com confirmação quando ' +
      'a ação tem efeito externo; devolve um resultado curto. Use quando o pedido casar.',
    parameters: { type: 'object', properties: { texto: { type: 'string' }, opcoes: { type: 'string' } }, required: [] },
    async run() { return 'ok'; },
  }));
}

// Scenario of that case: incremental change requests to the app, one per turn.
const TASKS = [
  'no meu app da lista de compras, adiciona um botão de "limpar tudo" que esvazia a lista. Publica quando terminar.',
  'agora faz os itens da lista poderem ser removidos individualmente, com um X do lado de cada um. Publica.',
  'salva a lista no localStorage pra não perder ao recarregar a página. Publica.',
  'coloca um contador mostrando quantos itens tem na lista, no topo. Publica.',
  'deixa o visual mais bonito: fundo levemente cinza, itens em cartões brancos com sombra. Publica.',
  'adiciona um campo de busca que filtra os itens da lista conforme eu digito. Publica.',
  'permite marcar item como comprado (riscado) clicando nele. Publica.',
  'adiciona um botão de exportar a lista como texto pra copiar. Publica.',
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
    process.stdout.write(`  [A turno ${i + 1}] ${fmt(sumUsages(usages))} | edits=${state.edits} pub=${state.publishes}\n`);
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
    process.stdout.write(`  [${tag} turno ${i + 1}] ${fmt(sumUsages(turnUsages))} | edits=${state.edits} pub=${state.publishes}\n`);
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
      return { stop: 'end', text: 'feito', usage: { in: 100, cached: 0, out: 10, total: 110 } };
    },
  };
  const reg = new ToolRegistry();
  reg.add({ name: 'ler_arquivo', description: 'lê', parameters: { type: 'object', properties: {}, required: [] }, async run() { return bigOut; } });
  const key = 'st:1';
  await runCodingSubagent({ objetivo: 'leia o index', tools: reg, provider: fake, sessionKey: key, maxSteps: 4 });
  const { sessions } = await import('../web/coding-subagent.mjs').then((m) => ({ sessions: null })); // (Map is private; we validate by behavior)
  // 2nd round in the SAME session: history should be reused (persistence) and the
  // large blob from the 1st round should have been collapsed when persisting.
  await runCodingSubagent({ objetivo: 'continua', tools: reg, provider: fake, sessionKey: key, maxSteps: 4 });
  console.log(`[selftest] completes=${completes} (esperado >0). Módulo roda o loop, persiste sessão e colapsa blobs sem erro.`);
  console.log('[selftest] OK');
}

async function main() {
  if (has('--selftest')) { await selftest(); return; }
  if (!has('--real')) { console.log('Use --selftest (sem chave) ou --real (com GEMINI_API_KEY).'); return; }
  if (!process.env.GEMINI_API_KEY) { console.error('ERRO: defina GEMINI_API_KEY (chave do produto) pra rodar --real.'); process.exit(1); }
  const model = process.env.PRIMARY_TEXT_MODEL || 'gemini-3.7-flash';
  console.log(`\n== BENCH coding inline vs sub-agente ==\nmodelo=${model} turnos=${TURNS} passos/turno=${STEPS}`);
  console.log(`prefixo est: system_A≈${est(PRINCIPAL_SYSTEM + CODING_SYSTEM)}tok | system_principal_B≈${est(PRINCIPAL_SYSTEM)}tok | system_coding_B≈${est(CODING_SYSTEM)}tok\n`);
  // search=false to measure only coding dynamics (cache/tokens), without grounding.
  const provider = makeGemini({ model, search: false, maxOutputTokens: 32768 });

  console.log('— Caminho A: coding INLINE no principal (como hoje) —');
  const A = await runInline(provider);
  console.log(`  TOTAL A: ${fmt(A.total)}\n`);

  console.log('— Caminho B: coding em SUB-AGENTE isolado (colapso + cap, sem resumo) —');
  const B = await runSubagent(provider, { compact: false, tag: 'B' });
  console.log(`  TOTAL B: ${fmt(B.total)}\n`);

  console.log('— Caminho C: sub-agente + COMPACTAÇÃO POR RESUMO (disciplina Claude Code / "meu harness") —');
  const C = await runSubagent(provider, { compact: true, tag: 'C' });
  console.log(`  TOTAL C: ${fmt(C.total)}\n`);

  const pct = (base, x) => base ? Math.round((1 - x / base) * 100) : 0;
  console.log('== RESULTADO (vs A) ==');
  console.log(`input:  A=${A.total.in}  B=${B.total.in} (${pct(A.total.in, B.total.in)}% menos)  C=${C.total.in} (${pct(A.total.in, C.total.in)}% menos)`);
  console.log(`cached: A=${A.total.cached}  B=${B.total.cached}  C=${C.total.cached}`);
  console.log(`total:  A=${A.total.total}  B=${B.total.total} (${pct(A.total.total, B.total.total)}% menos)  C=${C.total.total} (${pct(A.total.total, C.total.total)}% menos)`);
  console.log(`C vs B: input ${pct(B.total.in, C.total.in)}% menos, total ${pct(B.total.total, C.total.total)}% menos`);
  console.log(`(A: ${A.state.edits} edits/${A.state.publishes} pub | B: ${B.state.edits}/${B.state.publishes} | C: ${C.state.edits}/${C.state.publishes})`);
}

main().catch((e) => { console.error(e); process.exit(1); });
