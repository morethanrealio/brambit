// ── Canva via MCP ──
// Canva isn't a hand-written REST client here: it publishes an MCP server
// (https://mcp.canva.com/mcp) and the platform already has a generic MCP
// client (mcp.mjs). This file solves the two things the generic registered
// MCP server path does NOT:
//
//  1) Dynamic token. `mcp_servers.headers` is static jsonb; Canva's access_token
//     expires in ~1h. Here Authorization is built at call time, from the user's
//     live token (validProviderToken refreshes it on its own).
//  2) Input token floor. Canva's server exposes ~34 tools. Injecting 34 schemas
//     into the registry on every call blows the per-call input token floor.
//     Here the main agent sees ONLY THREE fixed-schema tools (canva /
//     canva_criar / canva_editar); the real list is fetched AT RUN TIME and
//     handed to an isolated sub-agent.
//
// Good side effect of (2): no MCP connection at all in turns where the person
// doesn't talk about Canva. It connects only when one of the three tools runs.

import { mcpConnect } from './mcp.mjs';

export const CANVA_MCP_URL = process.env.CANVA_MCP_URL || 'https://mcp.canva.com/mcp';

// Nomes CRUS como a Canva expõe no tools/list. A classificação é por ALLOWLIST,
// nunca por heurística de prefixo: chutar que "get-*" não escreve seria apostar
// o gate de confirmação numa convenção de nome. Tool que não estiver em nenhuma
// das três listas NÃO é exposta ao modelo, e o nome dela é logado (é assim que a
// lista se completa quando a Canva mexer no catálogo).
const READ = [
  'search-designs', 'get-design', 'get-design-content', 'get-design-pages',
  'get-presenter-notes', 'get-design-thumbnail', 'get-export-formats',
  'list-folder-items', 'search-folders', 'get-folder',
  'get-assets', 'get-asset', 'list-comments', 'list-replies',
  'resolve-shortlink', 'get-user-profile', 'get-user', 'get-me',
  'search-brand-templates', 'list-brand-kits', 'get-brand-template',
  'get-brand-template-dataset',
  // export-design NÃO altera nada na conta da pessoa: gera um link de download
  // do design que já existe. Fica na leitura de propósito (é o que faz "me manda
  // esse design em PDF" funcionar sem virar uma confirmação a cada pedido).
  'export-design',
];
const CREATE = [
  'generate-design', 'create-design', 'create-design-from-brand-template',
  'autofill-design', 'resize-design', 'copy-design',
  'create-folder', 'move-folder-item',
  'create-comment', 'create-reply',
  'upload-asset', 'create-asset-upload-job', 'get-asset-upload-job',
];
const EDIT = [
  'start-editing-transaction', 'perform-editing-operations',
  'commit-editing-transaction', 'cancel-editing-transaction',
  'get-editing-transaction',
];

// Mesma normalização que o mcp.mjs aplica ao nome antes de entregar a tool.
const san = (raw) => `canva_${raw}`.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 64);
const setOf = (list) => new Set(list.map(san));
const READ_N = setOf(READ), CREATE_N = setOf(CREATE), EDIT_N = setOf(EDIT);

let jaLogou = false;

// Traduz falha de transporte em frase honesta. O que dá pra afirmar aqui é o
// código HTTP (mcp.mjs joga o status na mensagem); a CAUSA de um 403 a gente não
// sabe, então a frase diz "pode ser" em vez de inventar.
function erroHumano(e) {
  const m = String(e?.message ?? e);
  if (/\b401\b/.test(m)) return 'Sessão do Canva expirada. Peça pro usuário reconectar o Canva em Conexões.';
  if (/\b403\b/.test(m)) return 'O Canva recusou (403). Pode ser um recurso que exige Canva Pro ou Enterprise (brand template, brand kit, autofill, redimensionar), ou um escopo que a conexão atual não tem. Não afirme qual dos dois é.';
  if (/\b429\b/.test(m)) return 'Você bateu no limite de chamadas do Canva. Espere um pouco e tente de novo.';
  return `Falha ao falar com o Canva: ${m}`;
}

// Conecta e devolve as tools já separadas por finalidade. Uma conexão por
// EXECUÇÃO: as tools de um mesmo mcpConnect compartilham a sessão MCP (o
// mcp-session-id fica no closure), que é o que permite a transação de edição
// (start → perform → commit) rodar inteira dentro de uma chamada só.
async function conectar(token) {
  const { tools } = await mcpConnect({
    url: CANVA_MCP_URL,
    headers: { Authorization: `Bearer ${token}` },
    label: 'canva',
  });
  const grupos = { read: [], create: [], edit: [], desconhecidas: [] };
  for (const t of tools) {
    if (READ_N.has(t.name)) grupos.read.push(t);
    else if (CREATE_N.has(t.name)) grupos.create.push(t);
    else if (EDIT_N.has(t.name)) grupos.edit.push(t);
    else grupos.desconhecidas.push(t.name);
  }
  if (grupos.desconhecidas.length && !jaLogou) {
    jaLogou = true;
    console.warn(`[canva] tools não classificadas (não expostas ao modelo): ${grupos.desconhecidas.join(', ')}`);
  }
  return grupos;
}

const SYS_BASE = `You are a sub-agent for the user's Canva connector. You receive a goal and use the Canva tools to accomplish it, returning ONLY the final answer.

General rules:
• Work in the USER'S Canva account. They have already authorized access.
• Bring CONCRETE data: design title, id, link to open it, folder name. The id is what allows a later action, so always include it.
• Never invent an id, link or design content. If you did not find it, say you did not find it.
• If a tool returns an error, pass the error on as it came. Do not try to work around it another way without saying so.
• When done, DELIVER the result. Do not describe what you did step by step.`;

const SYS_READ = `${SYS_BASE}

You only have READ tools (search, open, list, export). If the goal requires creating or changing something, gather everything needed and say clearly what remains to be done, so the main agent can carry it out with the user's confirmation.`;

const SYS_CREATE = `${SYS_BASE}

You have read and CREATE tools (create design, create folder, move item, comment, upload asset). The user HAS ALREADY CONFIRMED this goal, so carry it out; but do exactly what was asked and nothing more. Do not delete or overwrite anything that was not in the goal. At the end, return the link to what you created.`;

const SYS_EDIT = `${SYS_BASE}

You have read tools and the Canva EDIT TRANSACTION. The user HAS ALREADY CONFIRMED this goal.

Editing is transactional and the protocol must be followed to the end:
1. open the transaction with the start tool;
2. apply the operations;
3. CLOSE it: commit if it worked, cancel if any step failed or if you gave up.
Never end your answer with an open transaction. If you could not finish, cancel and explain what prevented it.`;

/**
 * As três tools do Canva no agente principal.
 * @param {{ tokenFn:()=>Promise<string>, runSubagent:Function }} deps
 *   tokenFn      → devolve um access_token vivo (validProviderToken).
 *   runSubagent  → runConnectorSubagent do server.mjs (roda o sub-agente e cobra o uso).
 * @returns {{ tools:object[], gated:object[] }} `gated` PRECISA passar pelo addGated.
 */
export function canvaTools({ tokenFn, runSubagent }) {
  const meta = ({ nome, descricao, exemplo, grupo, system }) => ({
    name: nome,
    description: descricao,
    parameters: {
      type: 'object',
      properties: {
        objetivo: { type: 'string', description: `What to do in Canva, with all the context (the sub-agent does not see the conversation). E.g.: ${exemplo}.` },
        formato: { type: 'string', description: 'Optional: how you want the answer organized.' },
      },
      required: ['objetivo'],
    },
    run: async ({ objetivo, formato }) => {
      if (!objetivo || !String(objetivo).trim()) return 'ERRO: objetivo vazio.';
      let grupos;
      try {
        grupos = await conectar(await tokenFn());
      } catch (e) {
        return `ERRO: ${erroHumano(e)}`;
      }
      const disponiveis = [...grupos.read, ...(grupo === 'read' ? [] : grupos[grupo])];
      if (!grupos[grupo].length && grupo !== 'read') {
        return `ERRO: o servidor do Canva não expôs nenhuma tool de ${grupo === 'create' ? 'criação' : 'edição'} nesta conexão.`;
      }
      if (!disponiveis.length) return 'ERRO: o servidor do Canva não expôs nenhuma tool nesta conexão.';
      try {
        return await runSubagent({
          objetivo, formato, readTools: disponiveis, system,
          fallback: 'Não consegui concluir isso no Canva.',
        });
      } catch (e) {
        return `ERRO: ${erroHumano(e)}`;
      }
    },
  });

  const tools = [meta({
    nome: 'canva',
    descricao: 'Queries the user\'s Canva: search designs by name or subject, open a design and read its content/pages/presenter notes, list folders and items, view assets, read comments and export an existing design (PDF, PNG, PPTX...). Use whenever the person asks something about their designs. Only READS, changes nothing.',
    exemplo: '"find the Instagram post designs created this month and tell me the title and link of each one"',
    grupo: 'read',
    system: SYS_READ,
  })];

  const gated = [
    meta({
      nome: 'canva_criar',
      descricao: 'CREATES something new in the user\'s Canva: a new design (from a description or a brand template), a copy of a design, a folder, a comment, or uploads a file as an asset. Describe the whole objective in a single text; the creation happens all at once. Do not use to MODIFY a design that already exists (that is canva_editar).',
      exemplo: '"create a square Instagram post announcing the September sale, with the text \'50% OFF até 30/09\'"',
      grupo: 'create',
      system: SYS_CREATE,
    }),
    meta({
      nome: 'canva_editar',
      descricao: 'MODIFIES a design that already exists in the user\'s Canva (change text, image, color, move elements on a page). Pass the design id or name and the desired change. The edit runs as a transaction: either it applies everything, or it rolls back.',
      exemplo: '"in design ABC123, change the title text to \'Chegou a coleção nova\' and the footer date to 30/09"',
      grupo: 'edit',
      system: SYS_EDIT,
    }),
  ];

  return { tools, gated };
}
