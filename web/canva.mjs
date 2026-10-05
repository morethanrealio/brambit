// ── Canva via MCP ──
// A Canva não entra aqui como cliente REST escrito na mão: ela publica um
// servidor MCP (https://mcp.canva.com/mcp) e o Brambs já tem cliente MCP
// genérico (mcp.mjs). O que este arquivo resolve são as duas coisas que o
// caminho genérico de servidor MCP cadastrado NÃO resolve:
//
//  1) Token dinâmico. `mcp_servers.headers` é um jsonb estático; o access_token
//     da Canva expira em ~1h. Aqui o Authorization é montado na hora da chamada,
//     a partir do token vivo do usuário (validProviderToken renova sozinho).
//  2) Piso de tokens de input. O servidor da Canva expõe ~34 tools. Injetar 34
//     schemas no registry a cada chamada estoura o piso documentado em
//     knowledge/input-tokens-e-cache.md. Aqui o agente principal vê SÓ TRÊS
//     tools de schema fixo (canva / canva_criar / canva_editar); a lista real é
//     buscada na HORA DA EXECUÇÃO e entregue a um sub-agente isolado.
//
// Efeito colateral bom do (2): não há conexão MCP nenhuma nos turnos em que a
// pessoa não fala de Canva. Conecta só quando uma das três tools roda.

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

const SYS_BASE = `Você é um sub-agente do conector Canva do usuário. Recebe um objetivo e usa as tools do Canva pra cumprir, devolvendo SÓ a resposta final.

Regras gerais:
• Trabalhe na conta Canva DO USUÁRIO. Ele já autorizou o acesso.
• Traga dados CONCRETOS: título do design, id, link pra abrir, nome da pasta. O id é o que permite uma ação depois, então sempre inclua.
• Nunca invente id, link ou conteúdo de design. Se não achou, diga que não achou.
• Se uma tool devolver erro, repasse o erro como veio. Não tente contornar por outro caminho sem dizer.
• Ao terminar, ENTREGUE o resultado. Não descreva o que você fez passo a passo.`;

const SYS_READ = `${SYS_BASE}

Você só tem tools de LEITURA (buscar, abrir, listar, exportar). Se o objetivo exigir criar ou alterar alguma coisa, levante tudo que for necessário e diga com clareza o que falta fazer, pra o agente principal executar com a confirmação do usuário.`;

const SYS_CREATE = `${SYS_BASE}

Você tem tools de leitura e de CRIAÇÃO (criar design, criar pasta, mover item, comentar, subir asset). O usuário JÁ CONFIRMOU este objetivo, então execute; mas faça exatamente o que foi pedido e nada além. Não apague nem sobrescreva nada que não estava no objetivo. No fim, devolva o link do que criou.`;

const SYS_EDIT = `${SYS_BASE}

Você tem tools de leitura e a TRANSAÇÃO DE EDIÇÃO do Canva. O usuário JÁ CONFIRMOU este objetivo.

A edição é transacional e o protocolo tem que ser respeitado até o fim:
1. abra a transação na tool de start;
2. aplique as operações;
3. FECHE: commit se deu certo, cancel se qualquer passo falhou ou se você desistiu.
Nunca termine sua resposta com uma transação aberta. Se não conseguiu concluir, cancele e explique o que impediu.`;

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
        objetivo: { type: 'string', description: `O que fazer no Canva, com todo o contexto (o sub-agente não vê a conversa). Ex: ${exemplo}.` },
        formato: { type: 'string', description: 'Opcional: como quer a resposta organizada.' },
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
    descricao: 'Consulta o Canva do usuário: procurar designs por nome ou assunto, abrir um design e ler o conteúdo/páginas/notas do apresentador, listar pastas e itens, ver assets, ler comentários e exportar um design existente (PDF, PNG, PPTX...). Use sempre que a pessoa perguntar algo sobre os designs dela. Só LÊ, não altera nada.',
    exemplo: '"procure os designs de posts do Instagram criados este mês e me diga o título e o link de cada um"',
    grupo: 'read',
    system: SYS_READ,
  })];

  const gated = [
    meta({
      nome: 'canva_criar',
      descricao: 'CRIA coisa nova no Canva do usuário: um design novo (a partir de uma descrição ou de um brand template), uma cópia de um design, uma pasta, um comentário, ou sobe um arquivo como asset. Descreva o objetivo inteiro num texto só; a criação acontece de uma vez. Não use para ALTERAR um design que já existe (isso é a canva_editar).',
      exemplo: '"crie um post de Instagram quadrado anunciando a promoção de setembro, com o texto \'50% OFF até 30/09\'"',
      grupo: 'create',
      system: SYS_CREATE,
    }),
    meta({
      nome: 'canva_editar',
      descricao: 'ALTERA um design que já existe no Canva do usuário (trocar texto, imagem, cor, mexer em elementos de uma página). Passe o id ou o nome do design e a mudança desejada. A edição roda como transação: ou aplica tudo, ou volta atrás.',
      exemplo: '"no design ABC123, troque o texto do título para \'Chegou a coleção nova\' e a data do rodapé para 30/09"',
      grupo: 'edit',
      system: SYS_EDIT,
    }),
  ];

  return { tools, gated };
}
