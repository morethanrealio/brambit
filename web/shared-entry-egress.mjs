// Egress guard for community-assistant entries (type C).
//
// In a type-C entry the assistant's ROLE (name, goal, instructions, skills) comes
// from someone else, the creator, while the DATA in the turn (email, Drive,
// memory, files, the person's own message) belongs to the person using it. So a
// tool must not carry that data out to an address the person never chose. Two
// rules, applied only to entries (agent.shared):
//
//  A. URL provenance. For the tools that reach an address through their arguments
//     (open a link, embed a remote image in a document, put a link on the home, a
//     shopping URL, product cards), every absolute URL in the arguments must
//     already appear, exactly, in the MATERIAL of this turn: the person's own
//     message, their earlier messages in the thread, the published assistant's own
//     text, or the output of a public web tool used in this turn (with that call's
//     own argument URLs removed, so a tool that echoes its input can't be used to
//     launder a made-up address into the material). Otherwise the call is refused
//     and nothing goes out. This is the response-text link guard (links.mjs)
//     applied to tool INPUTS, where it was missing.
//
//  B. A card for model-written code that has internet (sandbox shell/python,
//     spreadsheet analysis/edit, which run code the model wrote in the sandbox).
//     Code can reach any address with no URL in its arguments, so provenance can't
//     help; instead the person confirms on a card that shows the command/code and
//     says the environment has internet access. The real fix for this is a sandbox
//     with no network for entry turns; until then, the card is the guard. App
//     building/running (codar, construir_app, provar_app, chamar_sistema) is NOT
//     carded here: inside a build the file-write and command tools are already
//     gated in padrao mode (the mode an entry is forced into), and those flows
//     carry their own approval/continuation machinery.
//
// Tools that already go through a card (MCP connectors, falar_com_agente,
// gmail_send, pay, publish...) are left as they are: confirm.mjs already gates
// them, and the URL check still runs on their arguments (defense in depth).
import { gateTool } from './confirm.mjs';
import { urlsDoArgumento, enderecoNaMaterial } from './links.mjs';
import { productI18n } from './i18n.mjs';

// Rule A: arguments carry an address to the open internet.
const URL_TOOLS = new Set([
  'abrir_link', 'gerar_documento', 'docs_create', 'adicionar_na_home',
  'analisar_produto', 'montar_carrinho', 'mostrar_produtos',
]);
// Outputs that are a public web source: their addresses may be opened later in
// the turn. A private read (email, Drive, memory, a sandbox file) never feeds the
// material.
const PUBLIC_SOURCE = new Set([
  'buscar_web', 'abrir_link', 'buscar_voos', 'buscar_produtos', 'buscar_produto_por_imagem', 'analisar_produto',
]);
// Rule B: run model-written code that has internet.
const CARD_WITH_INTERNET = new Set([
  'sandbox_shell', 'sandbox_python', 'analisar_planilha', 'editar_planilha',
]);

const MAX_MATERIAL_BYTES = 4_000_000;
const MAX_OUTPUT_BYTES = 60_000;
const LABEL_CAP = 3500;

// Model-facing (English): explains why the address was not used and what to do.
function refusal(url) {
  return `[NOT DONE: in a community assistant a web address is only used when it came from the person's message, from a web search or a page read in this turn, or from the published assistant's own text. ${JSON.stringify(String(url).slice(0, 200))} was in none of those, so it was NOT used: a made-up address can carry the person's private data out. Find the page with buscar_web and use the address it returns, or ask the person to paste the link. Nothing was sent.]`;
}

// Card label for a code-with-internet tool, translated (pt/en/es).
function cardLabel(name, args, lang) {
  const { t } = productI18n();
  let what = '';
  if (name === 'sandbox_shell') what = String(args?.command ?? '');
  else if (name === 'sandbox_python') what = String(args?.code ?? '');
  else {
    what = [args?.pergunta, args?.instrucao, args?.arquivo_id, args?.arquivo]
      .filter((v) => typeof v === 'string' && v.trim()).join(' · ');
    if (!what) { try { what = JSON.stringify(args ?? {}); } catch { what = ''; } }
  }
  what = what.trim();
  if (what.length > LABEL_CAP) what = `${what.slice(0, LABEL_CAP)} […] ${t('confirm.community_entry.too_long', lang)}`;
  return t('confirm.community_entry.run_with_internet', lang, { what: what || t('confirm.community_entry.a_task', lang) });
}

// Installs both rules on a turn's registry. ctx:
//   material            seed strings that are trusted sources of URLs (person's
//                       message and earlier messages, the creator's published text);
//   threadId, gateOpts  passed through to gateTool for the card.
export function installEntryEgressGuard(registry, ctx = {}) {
  const { material: seed = [], threadId = null, gateOpts = {} } = ctx;
  const material = [];
  let materialBytes = 0;
  const addMaterial = (value) => {
    const s = typeof value === 'string' ? value : String(value ?? '');
    if (!s || materialBytes + s.length > MAX_MATERIAL_BYTES) return;
    materialBytes += s.length; material.push(s);
  };
  for (const s of seed) addMaterial(s);

  // A public source feeds the material, minus the URLs this very call carried in
  // its arguments: without that, a search that echoes its query would launder a
  // made-up address ("search for https://evil/?d=secret") into the material.
  const capturePublic = (out, args) => {
    let txt;
    try { txt = typeof out === 'string' ? out : JSON.stringify(out); } catch { return; }
    if (!txt) return;
    txt = txt.slice(0, MAX_OUTPUT_BYTES);
    for (const u of urlsDoArgumento(args)) if (u) txt = txt.split(u).join(' ');
    addMaterial(txt);
  };

  // First URL in the args without provenance, or null.
  const firstForeignUrl = (args) => {
    for (const u of urlsDoArgumento(args)) if (!enderecoNaMaterial(u, material)) return u;
    return null;
  };

  // Wraps one tool with whichever rule applies. Returns the (possibly new) tool.
  const wrap = (tool) => {
    if (!tool || typeof tool.run !== 'function') return tool;
    const name = tool.name;
    if (CARD_WITH_INTERNET.has(name)) {
      // A tool turnGate already wrapped exposes the original as confirmationTool.
      const inner = tool.confirmationTool || tool;
      return gateTool({
        ...inner,
        requiresConfirmation: true,
        describeConfirmation: (a, lang) => cardLabel(name, a, lang),
      }, threadId, gateOpts);
    }
    if (URL_TOOLS.has(name) || PUBLIC_SOURCE.has(name)) {
      const run = tool.run.bind(tool);
      return {
        ...tool,
        run: async (args) => {
          if (URL_TOOLS.has(name)) { const bad = firstForeignUrl(args); if (bad) return refusal(bad); }
          const out = await run(args);
          if (PUBLIC_SOURCE.has(name)) capturePublic(out, args);
          return out;
        },
      };
    }
    return tool;
  };

  // Re-wrap what is already registered, and everything added later in the turn
  // (abrir_ferramentas opens tool groups mid-turn).
  for (const [name, tool] of [...registry.map]) registry.map.set(name, wrap(tool));
  const add = registry.add.bind(registry);
  registry.add = (tool) => add(wrap(tool));
  // The research sub-agent builds its own registry; it gets the same wrapper so
  // its abrir_link/buscar_web share this material and these rules.
  registry.guardLinks = wrap;
  return registry;
}
