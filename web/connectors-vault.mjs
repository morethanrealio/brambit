// Here "marca" is already the operation's mark on Asaas (externalReference); the
// product's name comes as marcaDoProduto so it isn't shadowed by it.
import { hostDaMarca, marca as marcaDoProduto, uaApi } from './marca.mjs';
import { createHash, timingSafeEqual } from 'node:crypto';

// ── Connectors by VAULT API key/token (Notion, Splitwise, Infinity) ──
//
// Unlike OAuth connectors (connectors-ext.mjs, GitHub/Slack/Microsoft), there's
// no OAuth flow here: the user themselves generates a token on the service and
// stores it in the credentials Vault (Connections › Vault, kind 'apikey'/'token').
// Each function receives an async `secret()` that returns the token decrypted
// from the vault (or null if it hasn't been stored yet). Same shape as the other
// tools: { name, description, parameters, async run(args) } -> string.
//
// Reading runs directly; WRITING (creating a page, logging an expense) is gated
// in server.mjs (the confirmation gate in confirm.mjs). When there's no token in
// the vault, each tool returns a step-by-step on how to connect (the Vault's
// "technical path") instead of throwing an error.

// Extracts plain text from a Notion rich_text snippet.
const rich = (arr) => (Array.isArray(arr) ? arr.map((t) => t?.plain_text || t?.text?.content || '').join('') : '');

// ── Notion ──
const NOTION = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

const NOTION_SETUP = () => [
  'Pra eu usar seu Notion, preciso de um token de integração (o "caminho técnico", guardado com segurança no Cofre):',
  '',
  '1. Acesse notion.so/my-integrations e crie uma *integração interna* (New integration). Copie o "Internal Integration Secret".',
  '2. No Notion, abra a página ou base que você quer que eu acesse, menu ••• › *Connections* › conecte a integração que você criou (senão eu não enxergo nada).',
  `3. Aqui no ${marcaDoProduto().nome}, vá em *Conexões › Cofre de credenciais* e adicione: serviço \`notion\`, tipo \`apikey\`, e cole o token.`,
  '',
  'Depois me avisa que eu já consigo ler e escrever no seu Notion. O token fica cifrado no cofre; nunca aparece no chat.',
].join('\n');

// When the instance has Notion's OAuth enabled, the step-by-step above becomes
// unnecessary: the click alone resolves the token AND the page access grant (the
// page picker shows up right in Notion's own authorization screen).
const NOTION_SETUP_OAUTH = () => [
  'Seu Notion ainda não está conectado. É um clique:',
  '',
  `1. Abra *${hostDaMarca()}* › *Conexões* › *Notion* › *Conectar*.`,
  '2. O Notion vai pedir sua autorização e mostrar a lista das suas páginas e bases: marque ali as que você quer que eu enxergue.',
  '',
  'Só o que você marcar fica visível pra mim. Depois é só me avisar que eu já leio e escrevo por lá.',
].join('\n');

async function nReq(secret, path, { method = 'GET', body } = {}) {
  const key = await secret();
  if (!key) return { __notConnected: true };
  const r = await fetch(NOTION + path, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      'Notion-Version': NOTION_VERSION,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  // A stored key no longer authenticates (invalid/revoked/expired): signals the
  // assistant to ask for a new one instead of throwing a raw error and giving up.
  if (r.status === 401 || r.status === 403) return { __badCredential: true };
  if (!r.ok) throw new Error(`${r.status}: ${(await r.text()).slice(0, 300)}`);
  return r.json();
}

const NOTION_BAD = () => [
  'O token do Notion guardado no cofre não autentica mais (o Notion recusou o acesso, sinal de token inválido, revogado ou expirado).',
  '',
  'NUNCA peça a chave nova no chat: segredo colado em conversa fica gravado no histórico, aparece em notificação e pode ser lido depois. A troca é pela tela do Cofre.',
  'Oriente o usuário assim:',
  '1. Gerar de novo o "Internal Integration Secret" em notion.so/my-integrations (e reconectar a página/base em ••• › Connections, senão eu não enxergo nada).',
  `2. No ${marcaDoProduto().nome}, *Conexões › Cofre de credenciais*, serviço \`notion\`, atualizar a chave por lá.`,
  '',
  'Quando ele avisar que atualizou, tente de novo. Se ele colar a chave no chat por conta própria (sem você pedir), guarde com `salvar_credencial` (servico: "notion"), avise que ele apague a mensagem e não repita a chave.',
].join('\n');

const NOTION_BAD_OAUTH = () => [
  'O Notion recusou o acesso (autorização revogada ou expirada).',
  '',
  `Peça ao usuário pra reconectar em *${hostDaMarca()}* › *Conexões* › *Notion* › *Reconectar*.`,
  'Se ele já tinha conectado e parou de funcionar só numa página específica, o mais provável é que a página não esteja marcada na autorização: reconectar e marcá-la resolve.',
].join('\n');

// Title of a page/database from its properties (finds the title-type property).
function notionTitle(obj) {
  if (!obj) return '(sem título)';
  const props = obj.properties || {};
  for (const k of Object.keys(props)) {
    const p = props[k];
    if (p?.type === 'title') return rich(p.title) || '(sem título)';
  }
  // Databases have the title at the top.
  if (Array.isArray(obj.title)) return rich(obj.title) || '(sem título)';
  return '(sem título)';
}

// Text of a block (the most common types).
function blockText(b) {
  const t = b?.type;
  if (!t) return '';
  const node = b[t];
  const txt = rich(node?.rich_text);
  switch (t) {
    case 'heading_1': return txt ? `# ${txt}` : '';
    case 'heading_2': return txt ? `## ${txt}` : '';
    case 'heading_3': return txt ? `### ${txt}` : '';
    case 'bulleted_list_item': return txt ? `• ${txt}` : '';
    case 'numbered_list_item': return txt ? `- ${txt}` : '';
    case 'to_do': return txt ? `[${node?.checked ? 'x' : ' '}] ${txt}` : '';
    case 'quote': return txt ? `> ${txt}` : '';
    case 'callout': return txt ? `💡 ${txt}` : '';
    case 'code': return txt ? `\`\`\`\n${txt}\n\`\`\`` : '';
    case 'paragraph': return txt;
    default: return txt;
  }
}

// Turns text (lines) into Notion paragraph blocks.
function textToBlocks(texto) {
  return String(texto || '')
    .split('\n')
    .map((line) => ({
      object: 'block',
      type: 'paragraph',
      paragraph: { rich_text: line ? [{ type: 'text', text: { content: line.slice(0, 1900) } }] : [] },
    }));
}

// `oneClick` = this instance has Notion's OAuth configured. Only changes the
// text for when it's NOT connected: no point telling the person to create an
// integration by hand if it's solved in one click. The tools are the same on
// both paths (Notion's API accepts both tokens as Bearer).
export function notionTools({ secret, oneClick = false }) {
  const setup = oneClick ? NOTION_SETUP_OAUTH() : NOTION_SETUP();
  const bad = oneClick ? NOTION_BAD_OAUTH() : NOTION_BAD();
  return [
    {
      name: 'notion_search',
      description: 'Searches pages and databases in the user\'s Notion that their integration has access to. Returns title, type, id and link of each result. Without "query" it brings the most recently edited items. Use to find the id of a page before reading or writing to it.',
      parameters: { type: 'object', properties: { query: { type: 'string', description: 'Text to search for (optional).' }, tipo: { type: 'string', description: 'Filters by "page" or "database" (optional).' }, max: { type: 'integer', description: 'Default 10 (max 30).' } } },
      async run({ query, tipo, max = 10 } = {}) {
        const body = { page_size: Math.min(max, 30), sort: { direction: 'descending', timestamp: 'last_edited_time' } };
        if (query) body.query = query;
        if (tipo === 'page' || tipo === 'database') body.filter = { property: 'object', value: tipo };
        const j = await nReq(secret, '/search', { method: 'POST', body });
        if (j.__notConnected) return setup;
        if (j.__badCredential) return bad;
        const out = (j.results || []).map((o) => ({
          id: o.id,
          tipo: o.object,
          titulo: notionTitle(o),
          editado: o.last_edited_time,
          url: o.url,
        }));
        return out.length ? JSON.stringify(out) : 'Nada encontrado no Notion (confira se a página foi conectada à integração).';
      },
    },
    {
      name: 'notion_read_page',
      description: 'Reads a Notion page by id (use notion_search to find the id). Returns the title and the content as text (the blocks: paragraphs, headings, lists, to-dos).',
      parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      async run({ id }) {
        const page = await nReq(secret, `/pages/${encodeURIComponent(id)}`);
        if (page.__notConnected) return setup;
        if (page.__badCredential) return bad;
        // Notion returns at most 100 blocks per call, and reading used to stop
        // at the first one: a long page (project doc, meeting minutes) came back
        // only halfway, and `clipped` only talked about the character cut, never
        // about the blocks that weren't even fetched. Now it follows the cursor
        // to the end, with a safety ceiling so it doesn't sweep through a giant
        // page endlessly.
        const MAX_PAGINAS_BLOCOS = 10;
        const linhas = [];
        let cursor = null, paginas = 0, faltaramBlocos = false;
        for (;;) {
          const qs = `?page_size=100${cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : ''}`;
          const kids = await nReq(secret, `/blocks/${encodeURIComponent(id)}/children${qs}`);
          if (kids.__notConnected) return setup;
          if (kids.__badCredential) return bad;
          for (const b of kids.results || []) { const t = blockText(b); if (t) linhas.push(t); }
          paginas += 1;
          cursor = kids.has_more ? kids.next_cursor : null;
          if (!cursor) break;
          if (paginas >= MAX_PAGINAS_BLOCOS) { faltaramBlocos = true; break; }
        }
        const conteudo = recortar(linhas.join('\n'), 8000, 'conteúdo da página');
        return JSON.stringify({
          id: page.id,
          titulo: notionTitle(page),
          url: page.url,
          editado: page.last_edited_time,
          conteudo: conteudo.corpo,
          clipped: conteudo.truncado,
          blocosOmitidos: faltaramBlocos || undefined,
          nota: (conteudo.truncado || faltaramBlocos)
            ? 'Li só uma parte desta página do Notion. Diga ao usuário que a leitura foi parcial em vez de resumir como se fosse a página inteira.'
            : undefined,
        });
      },
    },
    {
      name: 'notion_create_page',
      description: 'Creates a NEW page in Notion inside a parent page (parent_id). Pass the title and, optionally, the content as text (each line becomes a paragraph). ALWAYS confirm where and what with the user BEFORE; do not create without their explicit ok.',
      parameters: { type: 'object', properties: { parent_id: { type: 'string', description: 'Id of the parent page where the new page will be created (find it with notion_search).' }, titulo: { type: 'string' }, conteudo: { type: 'string', description: 'Body text (optional). Each line becomes a paragraph.' } }, required: ['parent_id', 'titulo'] },
      async run({ parent_id, titulo, conteudo }) {
        const body = {
          parent: { page_id: parent_id },
          properties: { title: { title: [{ type: 'text', text: { content: String(titulo).slice(0, 1900) } }] } },
        };
        if (conteudo) body.children = textToBlocks(conteudo).slice(0, 90);
        const page = await nReq(secret, '/pages', { method: 'POST', body });
        if (page.__notConnected) return setup;
        if (page.__badCredential) return bad;
        return JSON.stringify({ ok: true, id: page.id, url: page.url,
          partial: !!conteudo && (textToBlocks(conteudo).length > 90 || String(conteudo).split('\n').some(line => line.length > 1900)), note: 'Página criada no Notion.' });
      },
    },
    {
      name: 'notion_append',
      description: 'Appends text to the END of an existing Notion page (page id; each line becomes a paragraph). Does not delete anything that already exists. ALWAYS confirm the text and the page with the user BEFORE; do not write without their explicit ok.',
      parameters: { type: 'object', properties: { id: { type: 'string', description: 'Id of the page to append to.' }, conteudo: { type: 'string' } }, required: ['id', 'conteudo'] },
      async run({ id, conteudo }) {
        const r = await nReq(secret, `/blocks/${encodeURIComponent(id)}/children`, { method: 'PATCH', body: { children: textToBlocks(conteudo).slice(0, 90) } });
        if (r.__notConnected) return setup;
        if (r.__badCredential) return bad;
        return JSON.stringify({ ok: true, id, blockIds: r.results?.map(block => block.id),
          partial: textToBlocks(conteudo).length > 90 || String(conteudo).split('\n').some(line => line.length > 1900)
            || r.results?.length !== Math.min(90,textToBlocks(conteudo).length), note: 'Texto acrescentado à página do Notion.' });
      },
    },
  ];
}

// ── Splitwise ──
const SW = 'https://secure.splitwise.com/api/v3.0';

const SW_SETUP = () => [
  'Pra eu usar seu Splitwise, preciso de uma API key (o "caminho técnico", guardada com segurança no Cofre):',
  '',
  '1. Acesse secure.splitwise.com/apps, registre um app (Register your application) e copie a *API key* que aparece.',
  `2. Aqui no ${marcaDoProduto().nome}, vá em *Conexões › Cofre de credenciais* e adicione: serviço \`splitwise\`, tipo \`apikey\`, e cole a key.`,
  '',
  'Depois me avisa que eu já consigo ver seus grupos, despesas e lançar gastos. A key fica cifrada no cofre; nunca aparece no chat.',
].join('\n');

async function swReq(secret, path, { method = 'GET', body } = {}) {
  const key = await secret();
  if (!key) return { __notConnected: true };
  const r = await fetch(SW + path, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  // A stored key no longer authenticates: signals the assistant to ask for a new one.
  if (r.status === 401 || r.status === 403) return { __badCredential: true };
  if (!r.ok) throw new Error(`${r.status}: ${(await r.text()).slice(0, 300)}`);
  return r.json();
}

const SW_BAD = () => [
  'A API key do Splitwise guardada no cofre não autentica mais (a Splitwise respondeu que não estou logado, sinal de chave inválida, trocada ou expirada).',
  '',
  'NUNCA peça a chave nova no chat: segredo colado em conversa fica gravado no histórico, aparece em notificação e pode ser lido depois. A troca é pela tela do Cofre.',
  'Oriente o usuário assim:',
  '1. Copiar de novo a *API key* pessoal em secure.splitwise.com/apps (atenção: é a "API key", NÃO a "Consumer Key").',
  `2. No ${marcaDoProduto().nome}, *Conexões › Cofre de credenciais*, serviço \`splitwise\`, atualizar a chave por lá.`,
  '',
  'Quando ele avisar que atualizou, tente de novo. Se ele colar a chave no chat por conta própria (sem você pedir), guarde com `salvar_credencial` (servico: "splitwise"), avise que ele apague a mensagem e não repita a chave.',
].join('\n');

const swGroupBrief = (g) => ({
  id: g.id,
  nome: g.name,
  membros: (g.members || []).map((m) => ({ id: m.id, nome: [m.first_name, m.last_name].filter(Boolean).join(' ') })),
  simplifica: g.simplify_by_default,
});

const swExpenseBrief = (e) => ({
  id: e.id,
  descricao: e.description,
  valor: e.cost,
  moeda: e.currency_code,
  data: e.date,
  criado_por: e.created_by ? [e.created_by.first_name, e.created_by.last_name].filter(Boolean).join(' ') : undefined,
  pagamento: e.payment,
  apagado: !!e.deleted_at,
});

export function splitwiseTools({ secret }) {
  return [
    {
      name: 'splitwise_groups',
      description: 'Lists the user\'s Splitwise groups (trips, home, etc.), with id, name and members. Use to find the id of a group before viewing expenses or adding an expense.',
      parameters: { type: 'object', properties: {} },
      async run() {
        const j = await swReq(secret, '/get_groups');
        if (j.__notConnected) return SW_SETUP();
        if (j.__badCredential) return SW_BAD();
        const out = (j.groups || []).map(swGroupBrief);
        return out.length ? JSON.stringify(out) : 'Nenhum grupo no Splitwise.';
      },
    },
    {
      name: 'splitwise_expenses',
      description: 'Lists recent Splitwise expenses, optionally of a specific group (group_id, find it with splitwise_groups). Returns description, amount, currency, date and who added it.',
      parameters: { type: 'object', properties: { group_id: { type: 'integer', description: 'Group id (optional; without it, brings from all).' }, max: { type: 'integer', description: 'Default 20 (max 50).' } } },
      async run({ group_id, max = 20 } = {}) {
        const params = new URLSearchParams({ limit: String(Math.min(max, 50)) });
        if (group_id != null) params.set('group_id', String(group_id));
        const j = await swReq(secret, `/get_expenses?${params.toString()}`);
        if (j.__notConnected) return SW_SETUP();
        if (j.__badCredential) return SW_BAD();
        const out = (j.expenses || []).filter((e) => !e.deleted_at).map(swExpenseBrief);
        return out.length ? JSON.stringify(out) : 'Nenhuma despesa encontrada.';
      },
    },
    {
      name: 'splitwise_add_expense',
      description: 'Adds a NEW expense to a Splitwise group, split EQUALLY among the group members. Pass the group_id, a description and the total amount. This changes a shared account of third parties: ALWAYS confirm group, description and amount with the user BEFORE; do not add it without their explicit ok.',
      parameters: { type: 'object', properties: { group_id: { type: 'integer', description: 'Group id (find it with splitwise_groups).' }, descricao: { type: 'string' }, valor: { type: 'number', description: 'Total amount of the expense.' }, moeda: { type: 'string', description: 'Currency code (default BRL).' } }, required: ['group_id', 'descricao', 'valor'] },
      async run({ group_id, descricao, valor, moeda = 'BRL' }) {
        const body = {
          group_id,
          description: String(descricao).slice(0, 200),
          cost: Number(valor).toFixed(2),
          currency_code: moeda,
          split_equally: true,
        };
        const j = await swReq(secret, '/create_expense', { method: 'POST', body });
        if (j.__notConnected) return SW_SETUP();
        if (j.__badCredential) return SW_BAD();
        const errs = j.errors && Object.keys(j.errors).length ? j.errors : null;
        if (errs || !(j.expenses && j.expenses.length)) {
          throw new Error(`Splitwise recusou: ${JSON.stringify(errs || j).slice(0, 300)}`);
        }
        const e = j.expenses[0];
        return JSON.stringify({ ok: true, id: e.id, valor: e.cost, moeda: e.currency_code, note: 'Despesa lançada no Splitwise, dividida igualmente.' });
      },
    },
  ];
}

// ── Infinity (StartInfinity) ──
// API v2 with version by header (X-API-Version). Authentication by Personal
// Access Token as Bearer. Hierarchy: workspace (integer id) › board (string
// id) › folder › item. An item has no fixed title field: everything is `values`,
// a list of { attribute_id, data } where the shape of `data` depends on the
// attribute's type (label = tag ids, members = user ids, etc.).
// That's why the tools talk about field and tag NAMES with the assistant and
// the translation to id happens here, with the attributes read from the board itself.
// API limit: 180 requests per minute.
const INF = 'https://app.startinfinity.com/api/v2';
const INF_VERSION = '2026-04-20.morava';

const INF_SETUP = () => [
  'Pra eu usar seu Infinity, preciso de um token pessoal (o "caminho técnico", guardado com segurança no Cofre):',
  '',
  '1. No Infinity, abra seu perfil em app.startinfinity.com/profile/settings e ative os recursos de desenvolvedor (developer features).',
  '2. Vá em app.startinfinity.com/profile/developer/tokens e crie um token novo. Copie o token.',
  `3. Aqui no ${marcaDoProduto().nome}, vá em *Conexões › Cofre de credenciais* e adicione: serviço \`infinity\`, tipo \`token\`, e cole o token.`,
  '',
  'Depois me avisa que eu já consigo ver seus boards e itens, criar e editar itens e comentar. O token fica cifrado no cofre; nunca aparece no chat.',
].join('\n');

const INF_BAD = () => [
  'O token do Infinity guardado no cofre não autentica mais (o Infinity respondeu "Unauthenticated", sinal de token inválido, apagado ou expirado).',
  '',
  'NUNCA peça o token novo no chat: segredo colado em conversa fica gravado no histórico, aparece em notificação e pode ser lido depois. A troca é pela tela do Cofre.',
  'Oriente o usuário assim:',
  '1. Criar um token novo em app.startinfinity.com/profile/developer/tokens.',
  `2. No ${marcaDoProduto().nome}, *Conexões › Cofre de credenciais*, serviço \`infinity\`, atualizar o token por lá.`,
  '',
  'Quando ele avisar que atualizou, tente de novo. Se ele colar o token no chat por conta própria (sem você pedir), guarde com `salvar_credencial` (servico: "infinity"), avise que ele apague a mensagem e não repita o token.',
].join('\n');

async function infReq(secret, path, { method = 'GET', body, query } = {}) {
  const key = await secret();
  if (!key) return { __notConnected: true };
  let url = INF + path;
  if (query) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v == null || v === '') continue;
      if (Array.isArray(v)) v.forEach((x) => qs.append(`${k}[]`, String(x)));
      else qs.set(k, String(v));
    }
    const s = qs.toString();
    if (s) url += `?${s}`;
  }
  const r = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      Accept: 'application/json',
      'X-API-Version': INF_VERSION,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  // 401 = token doesn't authenticate (checked: an invalid token returns 401
  // "Unauthenticated."). 403 is something else: good token, but no access to
  // that workspace/board; can't turn into "change the key".
  if (r.status === 401) return { __badCredential: true };
  if (r.status === 403) throw new Error('403: o token não tem acesso a esse workspace ou board no Infinity.');
  if (r.status === 429) throw new Error('429: limite de requisições do Infinity (180 por minuto). Espere um pouco e tente de novo.');
  if (!r.ok) throw new Error(`${r.status}: ${(await r.text()).slice(0, 300)}`);
  if (r.status === 204) return {};
  return r.json();
}

// One page, or several following the `after` cursor while `has_more`.
async function infList(secret, path, { query = {}, pages = 1, limit = 100 } = {}) {
  const out = [];
  let after = null;
  for (let i = 0; i < pages; i++) {
    const j = await infReq(secret, path, { query: { ...query, limit, after } });
    if (j.__notConnected || j.__badCredential) return j;
    out.push(...(j.data || []));
    if (!j.has_more || !j.after) return { data: out, has_more: false };
    after = j.after;
  }
  return { data: out, has_more: true };
}

const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();
const stripHtml = (h) => String(h ?? '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>\s*<p[^>]*>/gi, '\n').replace(/<[^>]+>/g, '')
  .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&').trim();
const escHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const textToHtml = (t) => {
  const s = String(t ?? '');
  // Already came as block HTML (the model sometimes formats it): passes as is.
  // Any other `<` is user text and gets escaped.
  if (/^\s*<(p|div|ul|ol|h[1-6]|blockquote)[\s>]/i.test(s)) return s;
  return s.split('\n').map((l) => `<p>${escHtml(l)}</p>`).join('');
};
const memberName = (m) => m?.name || m?.email || (m?.id != null ? `#${m.id}` : '');

// Value stored in Infinity → something readable for the assistant.
export function infinityReadValue(attr, data, members = []) {
  const type = attr?.type;
  if (data == null) return null;
  switch (type) {
    case 'label': {
      const labels = attr?.settings?.labels || [];
      const ids = Array.isArray(data) ? data : [data];
      return ids.map((id) => labels.find((l) => l.id === id)?.name || id);
    }
    case 'members': {
      const ids = Array.isArray(data) ? data : [data];
      return ids.map((id) => memberName(members.find((m) => m.id === id)) || `#${id}`);
    }
    case 'longtext': return stripHtml(data);
    case 'checklist': return Array.isArray(data) ? data.map((c) => `[${c?.done ? 'x' : ' '}] ${c?.name ?? ''}`) : data;
    case 'links': return Array.isArray(data) ? data.map((l) => l?.url || l) : data;
    default: return data;
  }
}

// Finds the attribute by id or by name (accent- and case-insensitive).
export function infinityFindAttr(attrs, chave) {
  const k = norm(chave);
  return attrs.find((a) => a.id === chave) || attrs.find((a) => norm(a.name) === k) || null;
}

// Value in the user's language → `data` in the attribute's type format.
// Throws an Error with the list of options when it can't translate (a tag or
// member that doesn't exist), so the assistant can correct it instead of
// writing garbage.
export function infinityWriteValue(attr, valor, members = []) {
  const type = attr?.type;
  const lista = (v) => (Array.isArray(v) ? v : v == null || v === '' ? [] : [v]);
  switch (type) {
    case 'label': {
      const labels = attr?.settings?.labels || [];
      return lista(valor).map((v) => {
        const hit = labels.find((l) => l.id === v) || labels.find((l) => norm(l.name) === norm(v));
        if (!hit) throw new Error(`O campo "${attr.name}" não tem a etiqueta "${v}". Opções: ${labels.map((l) => l.name).join(', ') || '(nenhuma)'}.`);
        return hit.id;
      });
    }
    case 'members':
      return lista(valor).map((v) => {
        const n = Number(v);
        const hit = members.find((m) => m.id === n) || members.find((m) => norm(m.name) === norm(v) || norm(m.email) === norm(v));
        if (!hit) throw new Error(`"${v}" não é membro deste workspace. Membros: ${members.map(memberName).join(', ') || '(nenhum)'}.`);
        return hit.id;
      });
    case 'checkbox':
      if (typeof valor === 'boolean') return valor;
      return ['true', 'sim', 'yes', 'si', 'x', '1', 'feito', 'done'].includes(norm(valor));
    case 'number':
    case 'progress':
    case 'rating': {
      const n = Number(String(valor).replace(',', '.'));
      if (!Number.isFinite(n)) throw new Error(`O campo "${attr.name}" é numérico e recebeu "${valor}".`);
      return n;
    }
    case 'longtext': return textToHtml(valor);
    case 'checklist':
      return lista(valor).map((c) => (typeof c === 'object' ? c : { name: String(c), done: false }));
    case 'links':
      return lista(valor).map((l) => (typeof l === 'object' ? l : { url: String(l) }));
    case 'text':
    case 'email':
    case 'phone':
      return String(valor ?? '');
    default:
      return valor;
  }
}

// `campos` ({ field_name_or_id: value }) → API's `values`.
export function infinityValues(attrs, campos = {}, members = []) {
  const values = [];
  for (const [chave, valor] of Object.entries(campos || {})) {
    const attr = infinityFindAttr(attrs, chave);
    if (!attr) throw new Error(`Este board não tem o campo "${chave}". Campos: ${attrs.map((a) => a.name).join(', ')}.`);
    values.push({ attribute_id: attr.id, data: infinityWriteValue(attr, valor, members) });
  }
  return values;
}

export function infinityItemBrief(item, attrs, members = [], folders = []) {
  const campos = {};
  for (const v of item?.values || []) {
    if (v?.deleted) continue;
    const attr = attrs.find((a) => a.id === v.attribute_id);
    if (!attr) continue;
    const lido = infinityReadValue(attr, v.data, members);
    if (lido == null || lido === '' || (Array.isArray(lido) && !lido.length)) continue;
    campos[attr.name] = lido;
  }
  return {
    id: item.id,
    pasta: folders.find((f) => f.id === item.folder_id)?.name || item.folder_id,
    ...(item.parent_id ? { item_pai: item.parent_id } : {}),
    criado_em: item.created_at,
    campos,
  };
}

const infAttrBrief = (a) => ({
  id: a.id,
  nome: a.name,
  tipo: a.type,
  ...(a.type === 'label' ? { etiquetas: (a.settings?.labels || []).map((l) => l.name) } : {}),
});

export function infinityTools({ secret }) {
  const guard = (j) => (j.__notConnected ? INF_SETUP() : j.__badCredential ? INF_BAD() : null);
  // Context of a board: attributes, folders and workspace members. This is what
  // translates id ↔ name in both directions.
  async function boardCtx(ws, board) {
    const base = `/workspaces/${encodeURIComponent(ws)}`;
    const attrs = await infList(secret, `${base}/boards/${encodeURIComponent(board)}/attributes`, { pages: 3 });
    if (guard(attrs)) return attrs;
    const folders = await infList(secret, `${base}/boards/${encodeURIComponent(board)}/folders`, { pages: 3 });
    if (guard(folders)) return folders;
    const members = await infList(secret, `${base}/members`, { pages: 3 });
    if (guard(members)) return members;
    return {
      attrs: attrs.data.filter((a) => !a.deleted),
      folders: folders.data.filter((f) => !f.deleted),
      members: members.data,
    };
  }
  const wsParam = { type: 'integer', description: 'Workspace id (find it with infinity_boards).' };
  const boardParam = { type: 'string', description: 'Board id (find it with infinity_boards).' };
  const camposParam = {
    type: 'object',
    additionalProperties: true,
    description: 'Item fields by NAME (as they appear in infinity_board_estrutura) or id, with the value. Label: label name (or list of names). Member: name or email. Checkbox: true/false. Long text: plain text. E.g. {"Nome": "Ligar pro fornecedor", "Status": "Em andamento"}.',
  };
  return [
    {
      name: 'infinity_boards',
      description: 'Lists the user\'s Infinity (StartInfinity) workspaces and the boards of each one, with the ids. Start here to find workspace_id and board_id.',
      parameters: { type: 'object', properties: { workspace_id: { type: 'integer', description: 'Optional: only the boards of this workspace.' } } },
      async run({ workspace_id } = {}) {
        let wss;
        if (workspace_id != null) wss = [{ id: workspace_id }];
        else {
          const w = await infList(secret, '/workspaces', { pages: 2 });
          if (guard(w)) return guard(w);
          wss = w.data.filter((x) => !x.deleted);
        }
        const out = [];
        for (const ws of wss.slice(0, 10)) {
          const b = await infList(secret, `/workspaces/${encodeURIComponent(ws.id)}/boards`, { pages: 2 });
          if (guard(b)) return guard(b);
          out.push({
            workspace_id: ws.id,
            workspace: ws.name,
            boards: b.data.filter((x) => !x.deleted).map((x) => ({ board_id: x.id, nome: x.name, ...(x.description ? { descricao: stripHtml(x.description).slice(0, 200) } : {}) })),
          });
        }
        return out.length ? JSON.stringify(out) : 'Nenhum workspace no Infinity.';
      },
    },
    {
      name: 'infinity_board_estrutura',
      description: 'Shows the structure of an Infinity board: folders, fields (attributes, with type and the possible labels) and workspace members. Use BEFORE creating or editing an item, to use the right folder, field and label names.',
      parameters: { type: 'object', properties: { workspace_id: wsParam, board_id: boardParam }, required: ['workspace_id', 'board_id'] },
      async run({ workspace_id, board_id }) {
        const ctx = await boardCtx(workspace_id, board_id);
        if (guard(ctx)) return guard(ctx);
        return JSON.stringify({
          pastas: ctx.folders.map((f) => ({ folder_id: f.id, nome: f.name })),
          campos: ctx.attrs.map(infAttrBrief),
          membros: ctx.members.map((m) => ({ id: m.id, nome: memberName(m) })),
        });
      },
    },
    {
      name: 'infinity_itens',
      description: 'Lists items of an Infinity board with the fields already readable (field and label name, not id). Filters by folder (folder_id) and/or by a search text that is looked up in all fields. Without search, brings the most recent ones.',
      parameters: {
        type: 'object',
        properties: {
          workspace_id: wsParam,
          board_id: boardParam,
          folder_id: { type: 'string', description: 'Optional: only items in this folder.' },
          busca: { type: 'string', description: 'Optional: text to look for in the item fields.' },
          max: { type: 'integer', description: 'Default 20 (max 50).' },
        },
        required: ['workspace_id', 'board_id'],
      },
      async run({ workspace_id, board_id, folder_id, busca, max = 20 }) {
        const ctx = await boardCtx(workspace_id, board_id);
        if (guard(ctx)) return guard(ctx);
        const lim = Math.max(1, Math.min(Number(max) || 20, 50));
        // Without search, one page is enough. With search, the API doesn't filter
        // by text: sweeps up to 5 pages (500 items) and filters here.
        const j = await infList(secret, `/workspaces/${encodeURIComponent(workspace_id)}/boards/${encodeURIComponent(board_id)}/items`, {
          query: { folder_id, expand: ['values'] },
          pages: busca ? 5 : 1,
          limit: busca ? 100 : lim,
        });
        if (guard(j)) return guard(j);
        let itens = j.data.filter((i) => !i.deleted).map((i) => infinityItemBrief(i, ctx.attrs, ctx.members, ctx.folders));
        if (busca) {
          const q = norm(busca);
          itens = itens.filter((i) => norm(JSON.stringify(i.campos)).includes(q));
        }
        const total = itens.length;
        itens = itens.slice(0, lim);
        if (!itens.length) return busca ? `Nenhum item com "${busca}" nesse board.` : 'Nenhum item nesse board.';
        return JSON.stringify({ itens, ...(total > itens.length || j.has_more ? { observacao: 'Há mais itens além destes; refine com busca ou pasta.' } : {}) });
      },
    },
    {
      name: 'infinity_item',
      description: 'Opens an Infinity item: all readable fields and the comments.',
      parameters: { type: 'object', properties: { workspace_id: wsParam, board_id: boardParam, item_id: { type: 'string' } }, required: ['workspace_id', 'board_id', 'item_id'] },
      async run({ workspace_id, board_id, item_id }) {
        const ctx = await boardCtx(workspace_id, board_id);
        if (guard(ctx)) return guard(ctx);
        const path = `/workspaces/${encodeURIComponent(workspace_id)}/boards/${encodeURIComponent(board_id)}/items/${encodeURIComponent(item_id)}`;
        const item = await infReq(secret, path, { query: { expand: ['values'] } });
        if (guard(item)) return guard(item);
        const c = await infList(secret, `${path}/comments`, { pages: 1, limit: 30 });
        if (guard(c)) return guard(c);
        const comentarios = c.data.filter((x) => !x.deleted).map((x) => ({
          autor: memberName(ctx.members.find((m) => m.id === x.created_by)) || x.created_by,
          em: x.created_at,
          texto: stripHtml(x.text).slice(0, 1500),
        }));
        return JSON.stringify({ ...infinityItemBrief(item, ctx.attrs, ctx.members, ctx.folders), comentarios });
      },
    },
    {
      name: 'infinity_criar_item',
      description: 'Creates a NEW item in an Infinity board, in a folder (folder_id, required). Run infinity_board_estrutura first to know the folder and the names of the fields and labels. This writes to the board (which may be shared with the team): confirm folder and fields with the user BEFORE.',
      parameters: {
        type: 'object',
        properties: { workspace_id: wsParam, board_id: boardParam, folder_id: { type: 'string', description: 'Id of the folder the item goes into.' }, campos: camposParam, parent_id: { type: 'string', description: 'Optional: parent item id, to create it as a subitem.' } },
        required: ['workspace_id', 'board_id', 'folder_id', 'campos'],
      },
      async run({ workspace_id, board_id, folder_id, campos, parent_id }) {
        const ctx = await boardCtx(workspace_id, board_id);
        if (guard(ctx)) return guard(ctx);
        const values = infinityValues(ctx.attrs, campos, ctx.members);
        const j = await infReq(secret, `/workspaces/${encodeURIComponent(workspace_id)}/boards/${encodeURIComponent(board_id)}/items`, {
          method: 'POST',
          body: { folder_id, values, ...(parent_id ? { parent_id } : {}) },
        });
        if (guard(j)) return guard(j);
        return JSON.stringify({ ok: true, id: j.id, note: 'Item criado no Infinity.' });
      },
    },
    {
      name: 'infinity_editar_item',
      description: 'Changes fields of an EXISTING Infinity item (only the fields passed) and/or moves it to another folder. This changes the board (which may be shared with the team): confirm the item and the fields with the user BEFORE.',
      parameters: {
        type: 'object',
        properties: { workspace_id: wsParam, board_id: boardParam, item_id: { type: 'string' }, campos: camposParam, folder_id: { type: 'string', description: 'Optional: move the item to this folder.' } },
        required: ['workspace_id', 'board_id', 'item_id'],
      },
      async run({ workspace_id, board_id, item_id, campos = {}, folder_id }) {
        const ctx = await boardCtx(workspace_id, board_id);
        if (guard(ctx)) return guard(ctx);
        const values = infinityValues(ctx.attrs, campos, ctx.members);
        if (!values.length && !folder_id) return 'Nada pra alterar: passe campos e/ou folder_id.';
        const j = await infReq(secret, `/workspaces/${encodeURIComponent(workspace_id)}/boards/${encodeURIComponent(board_id)}/items/${encodeURIComponent(item_id)}`, {
          method: 'PUT',
          body: { ...(values.length ? { values } : {}), ...(folder_id ? { folder_id } : {}) },
        });
        if (guard(j)) return guard(j);
        return JSON.stringify({ ok: true, id: j.id || item_id, note: 'Item atualizado no Infinity.' });
      },
    },
    {
      name: 'infinity_comentar',
      description: 'Comments on an Infinity item on behalf of the user. The comment is visible to whoever has access to the board: confirm the text with the user BEFORE.',
      parameters: { type: 'object', properties: { workspace_id: wsParam, board_id: boardParam, item_id: { type: 'string' }, texto: { type: 'string' } }, required: ['workspace_id', 'board_id', 'item_id', 'texto'] },
      async run({ workspace_id, board_id, item_id, texto }) {
        const j = await infReq(secret, `/workspaces/${encodeURIComponent(workspace_id)}/boards/${encodeURIComponent(board_id)}/items/${encodeURIComponent(item_id)}/comments`, {
          method: 'POST',
          body: { text: textToHtml(String(texto || '').slice(0, 10000)) },
        });
        if (guard(j)) return guard(j);
        return JSON.stringify({ ok: true, id: j.id, note: 'Comentário publicado no Infinity.' });
      },
    },
  ];
}

// ── Asaas (digital account: balance, pay boleto, PIX) ──
// API v3. Authentication by `access_token` header (not Bearer). The environment
// (production x sandbox) comes from the key's own PREFIX: `$aact_prod_` =
// production, `$aact_hmlg_` = sandbox; anything else falls back to production
// (legacy keys are production keys). User-Agent is required for new accounts.
const ASAAS_PROD = 'https://api.asaas.com';
const ASAAS_SBX = 'https://api-sandbox.asaas.com';
function asaasBase(key) {
  return /\$aact_hmlg_/i.test(key || '') ? ASAAS_SBX : ASAAS_PROD;
}

const ASAAS_SETUP = () => [
  'Pra eu movimentar sua conta Asaas (saldo, boleto, PIX), preciso da sua API key da Asaas guardada no Cofre:',
  '',
  '1. No painel da Asaas, vá em *Configurações › Integrações › Chave de API* e gere/copie a chave (começa com `$aact_...`).',
  `2. Aqui no ${marcaDoProduto().nome}, vá em *Conexões › Cofre de credenciais* e adicione: serviço \`asaas\`, tipo \`apikey\`, e cole a chave.`,
  '',
  'Depois me avisa. A chave fica cifrada no cofre e nunca aparece no chat. O ambiente (produção ou sandbox) é detectado pelo prefixo da própria chave.',
].join('\n');

const ASAAS_BAD = [
  'A Asaas recusou a chave (401/403). Ela pode ter sido revogada, estar incompleta ou ser de outro ambiente.',
  'Gere uma nova em *Configurações › Integrações › Chave de API* no painel da Asaas e atualize no *Cofre de credenciais* (serviço `asaas`).',
].join('\n');

// Raw call to the Asaas API, given the plaintext key. Exported because a
// plugin that opens a managed payment account for the user talks to the SAME
// API with the operator's ROOT key, which doesn't come from the user's vault:
// environment detection by key prefix and the error format live in one place.
// `form` (FormData) is the UPLOAD path: sending an account document is
// multipart, not JSON. It goes through the SAME asaasCall on purpose, to
// inherit the base, auth and 401/error handling, instead of a second way of
// talking to Asaas. With form the content-type isn't written by hand: fetch
// builds the boundary.
export async function asaasCall(key, path, { method = 'GET', body, form, query } = {}) {
  let url = asaasBase(key) + path;
  if (query) {
    const qs = new URLSearchParams(query).toString();
    if (qs) url += (path.includes('?') ? '&' : '?') + qs;
  }
  const r = await fetch(url, {
    method,
    headers: {
      access_token: key,
      'User-Agent': uaApi(),
      ...(body && !form ? { 'content-type': 'application/json' } : {}),
    },
    body: form || (body ? JSON.stringify(body) : undefined),
  });
  if (r.status === 401 || r.status === 403) return { __badCredential: true };
  const text = await r.text();
  let json = null;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { __raw: text }; }
  if (!r.ok) {
    // Asaas returns validation errors as { errors: [{ code, description }] } (HTTP 400).
    const msg = Array.isArray(json?.errors)
      ? json.errors.map((e) => e.description || e.code).filter(Boolean).join('; ')
      : (json?.__raw || `HTTP ${r.status}`);
    return { __apiError: String(msg).slice(0, 400), __status: r.status };
  }
  return json;
}

// Same call, with the key coming from the user's vault (might not exist).
async function aReq(secret, path, opts = {}) {
  const key = await secret();
  if (!key) return { __notConnected: true };
  return asaasCall(key, path, opts);
}

// Strips spaces/dots from a typeable line / barcode.
const onlyDigitsish = (s) => String(s || '').replace(/[\s.]/g, '');

// Synchronous by design: used both on the POST path and the HTTP webhook.
export function asaasAuthorizationHash(payload = {}) {
  const type = String(payload.type || '').toUpperCase();
  const op = type === 'BILL' ? payload.bill : type === 'TRANSFER' ? payload.transfer : null;
  if (!op?.id || !['BILL', 'TRANSFER'].includes(type)) return null;
  const canonical = type === 'BILL'
    ? {
        type, id: String(op.id), value: Number(op.value),
        identificationField: onlyDigitsish(op.identificationField),
        dueDate: op.dueDate || null, scheduleDate: op.scheduleDate || null,
        description: op.description || null,
      }
    : {
        type, id: String(op.id), value: Number(op.value),
        operationType: op.operationType || op.type || null,
        scheduleDate: op.scheduleDate || null, description: op.description || null,
        destination: {
          pixAddressKey: op.bankAccount?.pixAddressKey || null,
          cpfCnpj: onlyDigitsish(op.bankAccount?.cpfCnpj),
          agency: op.bankAccount?.agency || null,
          account: op.bankAccount?.account || null,
          accountDigit: op.bankAccount?.accountDigit || null,
        },
      };
  if (!Number.isFinite(canonical.value)) return null;
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

export function secureAsaasTokenMatch(received, expected) {
  const a = Buffer.from(String(received || ''));
  const b = Buffer.from(String(expected || ''));
  return a.length > 0 && a.length === b.length && timingSafeEqual(a, b);
}

export function asaasBillScheduleHash(args = {}, resumo = {}) {
  const canonical = {
    identificationField: onlyDigitsish(args.linha_digitavel),
    barCode: onlyDigitsish(args.codigo_de_barras),
    value: Number(args.valor != null ? args.valor : resumo.valor),
    dueDate: resumo.vencimento || null,
    beneficiary: resumo.beneficiario || null,
    beneficiaryTaxId: onlyDigitsish(resumo.cpf_cnpj_beneficiario),
  };
  if (!Number.isFinite(canonical.value) || (!canonical.identificationField && !canonical.barCode)) return null;
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

// ── Idempotency mark for financial actions (finding #10) ──
// Asaas doesn't offer an idempotency header on /v3/bill or /v3/transfers:
// sending the same POST twice pays twice. What it does offer is
// `externalReference`, an identifier OF OURS that goes along with the POST and
// comes back on every read of that operation. So the mark is generated ONCE,
// at the moment the confirmation is built, and becomes the request's proof of
// identity: if the POST's response gets lost along the way (connection dropped,
// server error, timeout), we can SEARCH for the operation by the mark instead of
// resending blindly.
const novaMarca = (prefixo) => `brambs-${prefixo}-${Date.now().toString(36)}-${globalThis.crypto.randomUUID().slice(0, 8)}`;

// An outcome that can't be read as "nothing happened": no response, server error
// or timeout. In these cases the request MAY have been applied on the other
// side. A validation refusal (HTTP 400) doesn't belong here: that one Asaas
// actually rejected, and the money didn't go out.
const desfechoIncerto = (j) => {
  if (j?.__semResposta) return true;
  if (!j?.__apiError) return false;
  const s = Number(j.__status);
  return !Number.isFinite(s) || s === 408 || s >= 500;
};

// Looks for an already-created operation, by the mark. Asaas's listing does NOT
// filter by `externalReference` (only by date), so it sweeps the recent window
// and compares here. NOT finding it doesn't prove the operation doesn't exist,
// which is why the caller treats "didn't find it" as uncertainty, never as
// permission to send it again.
const procurarPorMarca = async (request, caminho, marca) => {
  const dia = (off) => new Date(Date.now() + off * 86400000).toISOString().slice(0, 10);
  const base = { limit: '100' };
  if (caminho === '/v3/transfers') {
    base['dateCreated[ge]'] = dia(-1);
    base['dateCreated[le]'] = dia(1);
  }
  for (let pagina = 0; pagina < 3; pagina++) {
    let j;
    try { j = await request(caminho, { query: { ...base, offset: String(pagina * 100) } }); }
    catch { return null; }
    if (!j || j.__apiError || j.__badCredential || j.__notConnected) return null;
    const lista = Array.isArray(j.data) ? j.data : [];
    const achada = lista.find((o) => o && o.externalReference === marca);
    if (achada) return achada;
    if (!j.hasMore) return null;
  }
  return null;
};

// POST of a financial action. Never lets a transport failure become "Asaas
// refused": when the outcome is uncertain, checks by the mark before responding
// anything. If the operation is there, follows the normal flow with its REAL
// state; if it isn't, returns explicit uncertainty.
const postComMarca = async (request, caminho, body, marca) => {
  let j;
  try { j = await request(caminho, { method: 'POST', body: { ...body, externalReference: marca } }); }
  catch (e) { j = { __semResposta: true, __motivo: String(e?.message || e).slice(0, 200) }; }
  if (!desfechoIncerto(j)) return j;
  const achada = await procurarPorMarca(request, caminho, marca);
  return achada || { __incerto: true };
};

export function asaasResponseError(j, contexto) {
  if (j?.__notConnected) return ASAAS_SETUP();
  if (j?.__badCredential) return ASAAS_BAD;
  if (j?.__apiError) return `A Asaas recusou ${contexto}: ${j.__apiError}`;
  return '';
}

export async function simulateAsaasBill(request, args = {}) {
  const body = {};
  const id = onlyDigitsish(args.linha_digitavel);
  if (id) body.identificationField = id;
  const bc = onlyDigitsish(args.codigo_de_barras);
  if (bc) body.barCode = bc;
  if (!body.identificationField && !body.barCode) throw new Error('Informe a linha digitável ou o código de barras do boleto.');
  const j = await request('/v3/bill/simulate', { method: 'POST', body });
  const erro = asaasResponseError(j, 'a validação do boleto');
  if (erro) throw new Error(erro);
  const b = j.bankSlipInfo || {};
  const minimumScheduleDate = /^\d{4}-\d{2}-\d{2}$/.test(String(j.minimumScheduleDate || ''))
    ? String(j.minimumScheduleDate) : null;
  const resumo = {
    valor: Number(b.value ?? j.value),
    vencimento: b.dueDate ?? j.dueDate ?? null,
    beneficiario: b.beneficiaryName || j.beneficiaryName || null,
    cpf_cnpj_beneficiario: b.beneficiaryCpfCnpj || j.beneficiaryCpfCnpj || null,
    empresa: b.companyName || j.companyName || null,
    vencido: !!(b.isOverdue ?? j.isOverdue),
    permite_alterar_valor: !!(b.allowChangeValue ?? j.allowChangeValue),
    valor_min: Number(b.minValue ?? j.minValue),
    valor_max: Number(b.maxValue ?? j.maxValue),
    taxa_asaas: Number(j.fee),
    data_minima_pagamento: minimumScheduleDate,
  };
  if (!Number.isFinite(resumo.valor) || resumo.valor <= 0 || !resumo.beneficiario) {
    throw new Error('A Asaas não devolveu valor e beneficiário verificáveis para este boleto. Não propus o pagamento.');
  }
  if (args.valor != null) {
    const v = Number(args.valor);
    if (!Number.isFinite(v) || v <= 0) throw new Error('Informe um valor de pagamento válido.');
    if (!resumo.permite_alterar_valor && Math.abs(v - resumo.valor) >= 0.005) {
      throw new Error(`O boleto não permite alterar o valor verificado de R$ ${resumo.valor.toFixed(2)}.`);
    }
    if (Number.isFinite(resumo.valor_min) && v < resumo.valor_min) throw new Error(`O valor mínimo é R$ ${resumo.valor_min.toFixed(2)}.`);
    if (Number.isFinite(resumo.valor_max) && v > resumo.valor_max) throw new Error(`O valor máximo é R$ ${resumo.valor_max.toFixed(2)}.`);
  }
  return { body, resumo, assinatura: createHash('sha256').update(JSON.stringify(resumo)).digest('hex') };
}

export async function submitAsaasBillImmediate(request, args, marca, expectedScheduleHash = null) {
  const sim = await simulateAsaasBill(request, args);
  if (expectedScheduleHash && asaasBillScheduleHash(args, sim.resumo) !== expectedScheduleHash) {
    return { sim, result: { __changedBeforeSubmit: true } };
  }
  const body = { ...sim.body };
  if (args.valor != null) body.value = Number(args.valor);
  if (args.descricao) body.description = String(args.descricao).slice(0, 500);
  // Asaas's API may assume the due date when scheduleDate is omitted, even when
  // the person asked to pay now. The simulation returns the first date accepted
  // by the provider; in the worker it needs to be the execution day itself. This
  // doesn't create an early schedule in Asaas.
  if (!sim.resumo.data_minima_pagamento) {
    return { sim, result: { __apiError: 'A Asaas não informou a primeira data em que aceita processar este boleto.' } };
  }
  body.scheduleDate = sim.resumo.data_minima_pagamento;
  const result = await postComMarca(request, '/v3/bill', body, marca);
  return { sim, result };
}

export function asaasTools({
  secret,
  conta = null,
  registrarOperacao = null,
  obterOperacao = null,
  aguardarOperacao = null,
  garantirWebhookComprovante = null,
  registrarIntencaoFinanceira = null,
  criarAgendamentoBoleto = null,
  obterAgendamentoBoleto = null,
  listarAgendamentosBoleto = null,
  cancelarAgendamentoBoleto = null,
  emailDisponivel = null,
  enviarComprovanteEmail = null,
}) {
  // A person can have TWO Asaas accounts stored (the managed payment account a
  // plugin opened for them and their own). The server's resolver picks which one
  // counts; here the duty is to SAY which account the tool acted on, or the owner
  // moves money thinking it's the other. Only shown when there really is more
  // than one: with one, it's noise.
  const emQualConta = async () => {
    if (!conta) return '';
    try {
      const c = await conta();
      return c?.ambigua ? `\n(conta usada: *${c.rotulo}*; você tem mais de uma conta Asaas conectada)` : '';
    } catch { return ''; }
  };

  const erroAsaas = asaasResponseError;

  const registrar = async (dados) => {
    if (typeof registrarOperacao !== 'function' || !dados?.id) return;
    try { await registrarOperacao(dados); }
    catch (e) { console.error('[asaas] não consegui registrar a operação:', e?.message || e); }
  };

  // Asaas's POST response may be PENDING and the webhook may arrive a few
  // seconds later with DONE/PAID. The turn waits a short window for the state
  // already persisted by the webhook; it never repeats the financial POST. If
  // the window runs out, a single query by id is scheduled for 60s later as a
  // safety reconciliation. The timer doesn't keep the process alive.
  const agendarReconciliacaoSaida = ({
    id, tipo = 'pix', request, accountId = '', contaUsada = null,
    modoExecucao = null, agendadaParaSolicitada = null,
  } = {}) => {
    if (!id || typeof obterOperacao !== 'function') return;
    const boleto = tipo === 'boleto';
    const finais = boleto
      ? ['PAID', 'DONE', 'FAILED', 'CANCELLED', 'REFUNDED']
      : ['DONE', 'FAILED', 'CANCELLED', 'REFUNDED'];
    const caminho = boleto ? `/v3/bill/${encodeURIComponent(id)}` : `/v3/transfers/${encodeURIComponent(id)}`;
    const nome = boleto ? 'pagamento de conta' : 'Pix';
    const timer = setTimeout(async () => {
      try {
        const local = await obterOperacao(id);
        const localStatus = String(local?.status || '').toUpperCase();
        if (finais.includes(localStatus)) return;
        const j = await request(caminho);
        const erro = erroAsaas(j, `a reconciliação do ${nome}`);
        if (erro) {
          console.error(`[asaas] reconciliação ${nome} falhou:`, erro);
          return;
        }
        const status = String(j.status || '').toUpperCase();
        const concluido = boleto ? ['PAID', 'DONE'].includes(status) : status === 'DONE';
        await registrar({
          id,
          tipo,
          accountId,
          status,
          valor: j.value,
          comprovante: concluido ? (j.transactionReceiptUrl || null) : null,
          // The reconciliation didn't talk to the user; lets the outbox deliver it.
          comprovanteEntregue: false,
          contaUsada,
          modoExecucao,
          agendadaParaSolicitada,
          agendadaParaProvedor: j.scheduleDate || null,
          vencimento: j.dueDate || null,
        });
        if (!finais.includes(status)) {
          console.warn(`[asaas] ${nome} ${id} segue ${status || 'sem status'} após 60 segundos`);
        }
      } catch (e) {
        console.error(`[asaas] reconciliação ${nome} falhou:`, e?.message || e);
      }
    }, 60_000);
    timer.unref?.();
  };

  const tipoComprovante = (tipo) => {
    const t = String(tipo || '').trim().toLowerCase();
    if (['pix', 'transferencia', 'transferência', 'transfer'].includes(t)) return 'pix';
    if (['boleto', 'conta', 'pagamento', 'bill'].includes(t)) return 'boleto';
    return null;
  };

  const emailUnico = (valor) => {
    const e = String(valor || '').trim().toLowerCase();
    if (!/^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(e)) return null;
    return e;
  };

  const comprovantePorId = async ({ tipo, id } = {}, request = (path, opts) => aReq(secret, path, opts)) => {
    const kind = tipoComprovante(tipo);
    const operationId = String(id || '').trim();
    if (!kind) throw new Error('Informe se o comprovante é de Pix ou de boleto.');
    if (!operationId || operationId.length > 180) throw new Error('Informe o id da operação na Asaas.');
    const path = kind === 'pix' ? `/v3/transfers/${encodeURIComponent(operationId)}` : `/v3/bill/${encodeURIComponent(operationId)}`;
    const j = await request(path);
    const erro = erroAsaas(j, 'a consulta do comprovante');
    if (erro) throw new Error(erro);
    const status = String(j.status || '').toUpperCase();
    const concluido = kind === 'pix' ? status === 'DONE' : ['PAID', 'DONE'].includes(status);
    if (!concluido) throw new Error(`A operação ainda não está concluída (status ${status || 'desconhecido'}). Não existe comprovante final para enviar.`);
    let url;
    try {
      url = new URL(String(j.transactionReceiptUrl || ''));
      if (url.protocol !== 'https:' || !(url.hostname === 'asaas.com' || url.hostname.endsWith('.asaas.com'))) throw new Error('url');
    } catch {
      throw new Error('A Asaas confirmou a operação, mas ainda não disponibilizou o comprovante. Tente novamente em instantes.');
    }
    const data = kind === 'pix' ? (j.effectiveDate || j.confirmedDate || j.dateCreated) : (j.paymentDate || j.scheduleDate || j.dateCreated);
    const resumo = {
      tipo: kind,
      id: operationId,
      status,
      valor: Number(j.value),
      data: data || null,
      para: kind === 'pix' ? (j.bankAccount?.ownerName || null) : (j.companyName || null),
      comprovante: url.href,
    };
    resumo.assinatura = JSON.stringify(resumo);
    return resumo;
  };

  const emailDoComprovante = (r, para) => {
    const valor = Number.isFinite(r.valor) ? ` de R$ ${r.valor.toFixed(2).replace('.', ',')}` : '';
    const nome = r.tipo === 'pix' ? 'Pix' : 'pagamento de conta';
    return {
      to: para,
      subject: `Comprovante de ${nome}${valor}`,
      body: [
        'Olá,',
        '',
        `Segue o comprovante do ${nome}${valor}${r.data ? `, concluído em ${r.data}` : ''}.`,
        `Identificador da operação: ${r.id}`,
        `Comprovante oficial: ${r.comprovante}`,
        '',
        'Este e-mail foi enviado pelo assistente a pedido do titular da conta.',
      ].join('\n'),
    };
  };

  // Financial actions don't rely solely on the tool's name within the registry.
  // The connector itself separates read-only preparation from the mutable
  // execution: a direct `run` refuses, and only the closure returned by
  // prepareConfirmation can POST after the deterministic gate consumes human
  // confirmation.
  const confirmacaoObrigatoria = () => JSON.stringify({
    ok: false,
    error: 'Esta ação financeira exige confirmação explícita do usuário no turno seguinte. Nenhuma operação foi executada.',
  });

  // The credential is also part of the proposal. Without this link, swapping the
  // selected account between the card and the "yes" could execute the same
  // action on a different Asaas account. The secret stays only in the in-memory
  // closure and never enters the arguments, the label, or the persisted descriptor.
  const vincularContaFinanceira = async () => {
    let escolhida = null;
    if (conta) {
      try { escolhida = await conta(); } catch { /* tenta o resolvedor simples abaixo */ }
    }
    const key = escolhida?.key || await secret();
    if (!key) throw new Error(ASAAS_SETUP());
    return {
      request: (path, opts = {}) => asaasCall(key, path, opts),
      rotulo: escolhida?.ambigua ? String(escolhida.rotulo || 'conta selecionada') : null,
      descriptor: { accountId: escolhida?.accountId || null, credentialHash: createHash('sha256').update(key).digest('hex') },
      boundAccount: {
        key,
        contaBrambs: !!escolhida?.contaBrambs,
        accountId: escolhida?.accountId || null,
        rotulo: escolhida?.rotulo || null,
      },
    };
  };

  const validarRecebimento = ({ valor } = {}) => {
    if (valor == null) return null;
    const v = Number(valor);
    return Number.isFinite(v) && v > 0 ? null : 'Valor inválido: informe quanto vai ser recebido, em reais.';
  };

  const estadoChavePix = async (request = (path, opts) => aReq(secret, path, opts)) => {
    const lista = await request('/v3/pix/addressKeys', { query: { limit: '20' } });
    const erro = erroAsaas(lista, 'a consulta das chaves Pix');
    if (erro) throw new Error(erro);
    const chaves = Array.isArray(lista.data) ? lista.data : [];
    const porStatus = (s) => chaves.find((k) => String(k.status).toUpperCase() === s);
    const ativa = porStatus('ACTIVE') || null;
    const ativando = porStatus('AWAITING_ACTIVATION') || null;
    return {
      ativa,
      ativando,
      // The confirmation stays bound to the queried state. If the key changes
      // between the proposal and the "yes", it fails closed and asks for a new confirmation.
      assinatura: ativa
        ? `active:${ativa.id || ''}:${ativa.key || ''}`
        : ativando
          ? `awaiting:${ativando.id || ''}:${ativando.key || ''}`
          : 'none',
    };
  };

  const executarRecebimentoPix = async ({ valor, descricao } = {}, esperado, request, contaUsada = null) => {
    const invalido = validarRecebimento({ valor });
    if (invalido) return JSON.stringify({ ok: false, error: invalido });
    let estado;
    try { estado = await estadoChavePix(request); }
    catch (e) { return JSON.stringify({ ok: false, error: String(e?.message || e) }); }
    if (!esperado || estado.assinatura !== esperado.assinatura) {
      return JSON.stringify({
        ok: false,
        error: 'O estado das chaves Pix mudou depois da proposta. Nenhuma chave ou QR foi criado; confira novamente e peça uma nova confirmação.',
      });
    }
    if (!estado.ativa && estado.ativando) {
      return JSON.stringify({ ok: false, error: 'A chave Pix ainda está sendo ativada. Nenhuma nova chave foi criada.' });
    }

    let chave = estado.ativa;
    let criada = false;
    if (!chave) {
      const nova = await request('/v3/pix/addressKeys', { method: 'POST', body: { type: 'EVP' } });
      const erro = erroAsaas(nova, 'a criação da chave Pix');
      if (erro) return JSON.stringify({ ok: false, error: erro });
      chave = nova;
      criada = true;
    }

    let copiaECola = chave.qrCode?.payload || null;
    let qrId = null;
    if (valor != null) {
      const qr = await request('/v3/pix/qrCodes/static', { method: 'POST', body: {
        addressKey: chave.key,
        value: Number(valor),
        description: descricao || undefined,
        format: 'PAYLOAD',
        allowsMultiplePayments: false,
      } });
      const erro = erroAsaas(qr, 'a criação do QR Pix');
      if (erro) return JSON.stringify({ ok: false, error: erro });
      copiaECola = qr.payload || copiaECola;
      qrId = qr.id || null;
    }
    if (!copiaECola) {
      return JSON.stringify({ ok: false, error: 'A conta tem chave Pix ativa, mas a Asaas não devolveu o copia-e-cola. Nenhuma conclusão foi presumida.' });
    }
    return JSON.stringify({
      ok: true,
      chave_pix: chave.key,
      chave_criada_agora: criada,
      copia_e_cola: copiaECola,
      valor: valor != null ? Number(valor) : null,
      qr_id: qrId,
      conta_usada: contaUsada,
    });
  };

  const hojeBrasil = () => new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());

  const simularBoleto = async (args = {}, request = (path, opts) => aReq(secret, path, opts)) => {
    return simulateAsaasBill(request, args);
  };

  const dataIsoValida = (valor) => {
    const s = String(valor || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
    const d = new Date(`${s}T12:00:00Z`);
    return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === s ? s : null;
  };

  // A future date can only be born from a literal request from the owner in this
  // turn. The due date the simulation returns is information, it doesn't
  // authorize the model to turn it into `scheduleDate`.
  const pediuAgendamentoDeBoleto = (texto) => {
    const s = String(texto || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
    if (/\b(?:agend\w*|program\w*|no vencimento|na data (?:de|do) vencimento|on (?:the )?due date|al vencimiento|en la fecha de vencimiento|amanha|tomorrow|mañana|depois de amanha|day after tomorrow|pasado mañana)\b/.test(s)) return true;
    return /\b(?:paga|pague|pagar|pay|pagarlo|pagalo)\b[^\n]{0,60}\b(?:no dia|dia|em|para|on|el)\s+\d{1,2}(?:[\/.\-]\d{1,2})?\b/.test(s);
  };

  const pediuNoVencimento = (texto) => {
    const s = String(texto || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
    return /\b(?:no vencimento|na data (?:de|do) vencimento|on (?:the )?due date|al vencimiento|en la fecha de vencimiento)\b/.test(s);
  };

  const proximoDiaUtilSeFimDeSemana = (iso) => {
    const valid = dataIsoValida(iso);
    if (!valid) return null;
    const d = new Date(`${valid}T12:00:00Z`);
    const weekday = d.getUTCDay();
    if (weekday !== 0 && weekday !== 6) return null;
    d.setUTCDate(d.getUTCDate() + (weekday === 6 ? 2 : 1));
    return d.toISOString().slice(0, 10);
  };

  const formatarData = (iso, lang = 'pt-BR') => {
    const valid = dataIsoValida(iso);
    if (!valid) return iso || 'não informada';
    const locale = String(lang || '').startsWith('en') ? 'en-US' : String(lang || '').startsWith('es') ? 'es-ES' : 'pt-BR';
    return new Intl.DateTimeFormat(locale, { timeZone: 'UTC', day: '2-digit', month: '2-digit', year: 'numeric' })
      .format(new Date(`${valid}T12:00:00Z`));
  };

  const confirmacaoPagamento = ({ resumo, efetivo, args, contaUsada, lang = 'pt-BR' }) => {
    const agendada = dataIsoValida(args.agendar_para);
    const primeiraData = dataIsoValida(resumo.data_minima_pagamento);
    const hoje = hojeBrasil();
    const proximoUtil = agendada ? proximoDiaUtilSeFimDeSemana(agendada) : null;
    const documento = resumo.cpf_cnpj_beneficiario || 'não informado';
    if (String(lang).startsWith('en')) {
      const execution = agendada
        ? `Scheduled for ${formatarData(agendada, lang)}${proximoUtil ? `. This date is not a business day; Asaas will process it on the next business day, ${formatarData(proximoUtil, lang)}` : ''}`
        : primeiraData === hoje
          ? `Today (${formatarData(primeiraData, lang)}), the earliest date accepted by Asaas`
          : `Earliest date accepted by Asaas: ${formatarData(primeiraData, lang)}`;
      return `*Bill payment*\nBeneficiary: ${resumo.beneficiario}\nTax ID: ${documento}\nAmount: BRL ${efetivo.toFixed(2)}\nDue date: ${formatarData(resumo.vencimento, lang)}\nExecution: ${execution}\nAccount: ${contaUsada || 'Asaas'}\n\nMay I proceed? Please confirm in text.`;
    }
    if (String(lang).startsWith('es')) {
      const execution = agendada
        ? `Programado para ${formatarData(agendada, lang)}${proximoUtil ? `. La fecha no es hábil; Asaas lo procesará el próximo día hábil, ${formatarData(proximoUtil, lang)}` : ''}`
        : primeiraData === hoje
          ? `Hoy (${formatarData(primeiraData, lang)}), la primera fecha aceptada por Asaas`
          : `Primera fecha aceptada por Asaas: ${formatarData(primeiraData, lang)}`;
      return `*Pago de cuenta*\nBeneficiario: ${resumo.beneficiario}\nDocumento: ${documento}\nImporte: R$ ${efetivo.toFixed(2).replace('.', ',')}\nVencimiento: ${formatarData(resumo.vencimento, lang)}\nEjecución: ${execution}\nCuenta: ${contaUsada || 'Asaas'}\n\n¿Puedo realizarlo? Confirma por texto.`;
    }
    const execucao = agendada
      ? `Agendada para ${formatarData(agendada, lang)}${proximoUtil ? `. Essa data não é útil; a Asaas processará no próximo dia útil, ${formatarData(proximoUtil, lang)}` : ''}`
      : primeiraData === hoje
        ? `Hoje (${formatarData(primeiraData, lang)}), primeira data aceita pela Asaas`
        : `Primeira data aceita pela Asaas: ${formatarData(primeiraData, lang)}`;
    return `*Pagamento de conta*\nBeneficiário: ${resumo.beneficiario}\nDocumento: ${documento}\nValor: R$ ${efetivo.toFixed(2).replace('.', ',')}\nVencimento: ${formatarData(resumo.vencimento, lang)}\nExecução: ${execucao}\nConta: ${contaUsada || 'Asaas'}\n\nPosso realizar? Confirme por texto.`;
  };

  const consultarPagamento = async (id, request = (path, opts) => aReq(secret, path, opts)) => {
    const operationId = String(id || '').trim();
    if (!operationId || operationId.length > 180) throw new Error('Informe o id real do pagamento de conta na Asaas.');
    const j = await request(`/v3/bill/${encodeURIComponent(operationId)}`);
    const erro = erroAsaas(j, 'a consulta do pagamento de conta');
    if (erro) throw new Error(erro);
    if (!j?.id || String(j.id) !== operationId) throw new Error('A Asaas não devolveu o pagamento solicitado de forma verificável.');
    const resumo = {
      id: operationId,
      status: String(j.status || '').toUpperCase(),
      valor: Number.isFinite(Number(j.value)) ? Number(j.value) : null,
      agendado_para: dataIsoValida(j.scheduleDate),
      vencimento: dataIsoValida(j.dueDate),
      descricao: j.description ? String(j.description).slice(0, 300) : null,
      pode_cancelar: j.canBeCancelled === true,
      autorizacao_critica_pendente: j.awaitingCriticalActionAuthorization === true,
    };
    return { raw: j, resumo, assinatura: JSON.stringify(resumo) };
  };

  const confirmacaoCancelamento = ({ resumo, contaUsada, lang = 'pt-BR' }) => {
    const valor = Number.isFinite(resumo.valor)
      ? `R$ ${resumo.valor.toFixed(2).replace('.', ',')}`
      : (String(lang).startsWith('en') ? 'amount not provided' : String(lang).startsWith('es') ? 'importe no informado' : 'valor não informado');
    const data = resumo.agendado_para ? formatarData(resumo.agendado_para, lang) : null;
    if (String(lang).startsWith('en')) {
      return `*Cancel bill payment*\nAmount: ${valor}\nScheduled date: ${data || 'not provided'}\nDescription: ${resumo.descricao || 'not provided'}\nAccount: ${contaUsada || 'Asaas'}\n\nThis cancellation is irreversible. If Asaas confirms it, the payment will not be executed. May I cancel it? Please confirm in text.`;
    }
    if (String(lang).startsWith('es')) {
      return `*Cancelar pago de cuenta*\nImporte: ${valor}\nFecha programada: ${data || 'no informada'}\nDescripción: ${resumo.descricao || 'no informada'}\nCuenta: ${contaUsada || 'Asaas'}\n\nLa cancelación es irreversible. Si Asaas la confirma, el pago no se ejecutará. ¿Puedo cancelarlo? Confirma por texto.`;
    }
    return `*Cancelar pagamento de conta*\nValor: ${valor}\nData agendada: ${data || 'não informada'}\nDescrição: ${resumo.descricao || 'não informada'}\nConta: ${contaUsada || 'Asaas'}\n\nO cancelamento é irreversível. Se a Asaas confirmar, o pagamento não será executado. Posso cancelar? Confirme por texto.`;
  };

  const executarPagamento = async (args, esperado, request, contaUsada = null, boundAccount = null, marca = novaMarca('bill')) => {
    let atual;
    try { atual = await simularBoleto(args, request); }
    catch (e) { return JSON.stringify({ ok: false, error: String(e?.message || e) }); }
    if (!esperado || atual.assinatura !== esperado.assinatura) {
      return JSON.stringify({ ok: false, error: 'Valor, vencimento ou beneficiário do boleto mudou depois da confirmação. Nada foi pago; faça uma nova conferência.' });
    }
    if (args.agendar_para) {
      if (typeof criarAgendamentoBoleto !== 'function') {
        return JSON.stringify({ ok: false, error: `O agendamento seguro do ${marcaDoProduto().nome} não está disponível. Nada foi criado na Asaas.` });
      }
      const schedule = await criarAgendamentoBoleto({
        executeOn: args.agendar_para,
        accountId: boundAccount?.accountId || '',
        payload: {
          linha_digitavel: args.linha_digitavel || null,
          codigo_de_barras: args.codigo_de_barras || null,
          valor: args.valor ?? null,
          descricao: args.descricao || null,
          resumo_confirmado: atual.resumo,
        },
        expectedHash: asaasBillScheduleHash(args, atual.resumo),
        externalReference: marca,
      });
      if (!schedule?.id) return JSON.stringify({ ok: false, error: 'Não consegui registrar o agendamento com segurança. Nada foi criado na Asaas.' });
      return JSON.stringify({
        ok: true, agendado: true, id: schedule.id, status: schedule.status,
        executar_em: String(schedule.execute_on || args.agendar_para).slice(0, 10),
        valor: args.valor != null ? Number(args.valor) : atual.resumo.valor,
        beneficiario: atual.resumo.beneficiario,
        conta_usada: contaUsada,
        aviso: `Agendamento salvo no ${marcaDoProduto().nome}. A Asaas só receberá o pagamento no dia da execução, depois de uma nova conferência do boleto. Você pode cancelar este agendamento aqui na conversa até ele começar a ser executado.`,
      });
    }
    if (typeof garantirWebhookComprovante === 'function') {
      try { await garantirWebhookComprovante(boundAccount); }
      catch (e) { return JSON.stringify({ ok: false, error: `Não consegui preparar o acompanhamento do comprovante. Nada foi pago. ${String(e?.message || e)}` }); }
    }
    const body = { ...atual.body };
    if (args.valor != null) body.value = Number(args.valor);
    if (args.descricao) body.description = String(args.descricao).slice(0, 500);
    if (!atual.resumo.data_minima_pagamento) {
      return JSON.stringify({ ok: false, error: 'A Asaas não informou a primeira data em que aceita processar este boleto. Nada foi criado.' });
    }
    // The date comes from the simulation shown in the confirmation and takes
    // part in the revalidated signature. So "pay now" requests the first
    // accepted date, instead of letting Asaas silently assume the due date.
    body.scheduleDate = atual.resumo.data_minima_pagamento;
    let j = await postComMarca(request, '/v3/bill', body, marca);
    if (j.__incerto) {
      return JSON.stringify({
        ok: true,
        pending: true,
        incerto: true,
        pago: false,
        referencia: marca,
        conta_usada: contaUsada,
        aviso: 'Não consegui confirmar o que aconteceu com esse pagamento: a instituição não respondeu e a conferência que fiz logo em seguida também não encontrou o lançamento. Ele pode ter sido feito. Não peça de novo antes de conferir: daqui a pouco me peça os pagamentos recentes da conta, ou veja o extrato.',
      });
    }
    const erro = erroAsaas(j, 'o pagamento do boleto');
    if (erro) return JSON.stringify({ ok: false, error: erro });
    const authorizationHash = asaasAuthorizationHash({ type: 'BILL', bill: j });
    if (typeof registrarIntencaoFinanceira === 'function' && authorizationHash) {
      try {
        await registrarIntencaoFinanceira({
          providerOperationId: j.id, accountId: boundAccount?.accountId || '', kind: 'BILL',
          externalReference: marca, expectedHash: authorizationHash,
        });
      } catch (e) {
        console.error('[asaas] falha fechada ao registrar intenção do boleto:', e?.message || e);
        return JSON.stringify({
          ok: false, pending: true, id: j.id,
          error: `A Asaas recebeu o pagamento, mas o ${marcaDoProduto().nome} não conseguiu registrar a autorização segura. A validação será recusada; não repita o pagamento e consulte este id depois.`,
        });
      }
    }
    let st = String(j.status || '').toUpperCase();
    let falhou = ['FAILED', 'CANCELLED', 'REFUNDED'].includes(st);
    let pago = ['PAID', 'DONE'].includes(st);
    let pendenteAuth = j.awaitingCriticalActionAuthorization === true || j.authorized === false;

    // Registers before the wait so the webhook keeps the link to the
    // conversation even when BILL_PAID arrives during these ten seconds.
    await registrar({
      id: j.id,
      tipo: 'boleto',
      accountId: boundAccount?.accountId || '',
      status: st,
      valor: j.value,
      comprovante: pago ? (j.transactionReceiptUrl || null) : null,
      comprovanteEntregue: pago && !!j.transactionReceiptUrl,
      modoExecucao: 'immediate',
      agendadaParaSolicitada: null,
      agendadaParaProvedor: j.scheduleDate || null,
      vencimento: j.dueDate || atual.resumo.vencimento || null,
    });

    // Immediate payment accepted and still pending: only watches the local
    // state written by the webhook. Doesn't redo the POST nor poll Asaas in a loop.
    if (!args.agendar_para && !falhou && !pago && !pendenteAuth && j.id
        && typeof aguardarOperacao === 'function') {
      let final = null;
      try { final = await aguardarOperacao(j.id, 10_000); }
      catch (e) { console.error('[asaas] espera curta do pagamento falhou:', e?.message || e); }
      if (final) {
        j = {
          ...j,
          status: final.status || j.status,
          value: final.value ?? j.value,
          transactionReceiptUrl: final.receipt_url || final.transactionReceiptUrl || j.transactionReceiptUrl,
        };
        st = String(j.status || '').toUpperCase();
        falhou = ['FAILED', 'CANCELLED', 'REFUNDED'].includes(st);
        pago = ['PAID', 'DONE'].includes(st);
        pendenteAuth = j.awaitingCriticalActionAuthorization === true || j.authorized === false;
      }
    }
    const dataConfirmada = dataIsoValida(atual.resumo.data_minima_pagamento);
    const dataProvedor = dataIsoValida(j.scheduleDate);
    const dataDesviada = !!(dataConfirmada && dataProvedor && dataConfirmada !== dataProvedor);
    const resultado = {
      ok: !falhou,
      id: j.id,
      status: st,
      autorizada: pendenteAuth ? false : j.authorized,
      valor: j.value,
      agendado_para: j.scheduleDate,
      pago_em: j.paymentDate,
      taxa: j.fee,
      comprovante: pago ? (j.transactionReceiptUrl || null) : null,
      conta_usada: contaUsada,
      pago,
      pending: !falhou && !pago,
      data_processamento_confirmada: dataConfirmada,
      data_processamento_provedor: dataProvedor,
      data_processamento_divergente: dataDesviada,
      error: falhou ? `O pagamento não foi concluído (status ${st || 'desconhecido'}).` : undefined,
      aviso: pendenteAuth
        ? 'O pagamento foi criado, mas ainda NÃO foi feito: a Asaas exige autorização do titular por token no app ou painel. Não repita o pagamento; autorize e depois consulte o status.'
        : falhou
          ? `O pagamento não foi concluído (status ${st || 'desconhecido'}).`
          : pago
            ? 'Pagamento concluído pela Asaas.'
            : undefined,
    };
    await registrar({
      id: j.id,
      tipo: 'boleto',
      accountId: boundAccount?.accountId || '',
      status: st,
      valor: j.value,
      comprovante: pago ? (j.transactionReceiptUrl || null) : null,
      comprovanteEntregue: pago && !!j.transactionReceiptUrl,
      modoExecucao: 'immediate',
      agendadaParaSolicitada: null,
      agendadaParaProvedor: j.scheduleDate || null,
      vencimento: j.dueDate || atual.resumo.vencimento || null,
    });
    if (!falhou && !pago && !pendenteAuth) {
      agendarReconciliacaoSaida({
        id: j.id,
        tipo: 'boleto',
        request,
        accountId: boundAccount?.accountId || '',
        contaUsada,
        modoExecucao: 'immediate',
        agendadaParaSolicitada: null,
      });
    }
    return JSON.stringify(resultado);
  };

  const validarTransferencia = ({ valor, chave_pix, tipo_chave } = {}) => {
    const tipo = String(tipo_chave || '').trim().toUpperCase();
    if (!['CPF', 'CNPJ', 'EMAIL', 'PHONE', 'EVP'].includes(tipo)) return 'Tipo de chave Pix inválido.';
    if (!(Number(valor) > 0)) return 'Informe um valor maior que zero.';
    if (!String(chave_pix || '').trim()) return 'Informe a chave Pix de destino.';
    return null;
  };

  const titularChave = async (args = {}, request = (path, opts) => aReq(secret, path, opts)) => {
    const invalido = validarTransferencia(args);
    if (invalido) throw new Error(invalido);
    const tipo = String(args.tipo_chave).trim().toUpperCase();
    const chave = String(args.chave_pix).trim();
    const j = await request('/v3/pix/addressKeys/external', { query: { type: tipo, key: chave } });
    const erro = erroAsaas(j, 'a conferência da chave Pix');
    if (erro) throw new Error(erro);
    // The external query's current contract returns the holder and institution
    // in nested objects (`owner` and `financialInstitution`). The fallbacks
    // preserve old/alternative responses without turning a successful shape
    // change into "key not registered".
    const nome = j.owner?.name || j.name || j.ownerName || j.account?.name || j.bankAccount?.ownerName || null;
    const documento = j.owner?.cpfCnpj || j.cpfCnpj || j.account?.cpfCnpj || j.bankAccount?.cpfCnpj || null;
    const instituicao = j.financialInstitution?.name || j.ispbName || j.bank?.name || j.institutionName || j.account?.bank?.name || null;
    if (!nome) {
      throw new Error('A Asaas respondeu à consulta, mas o sistema não reconheceu os dados do titular. Isso não prova que a chave esteja inválida ou não cadastrada. Não propus a transferência.');
    }
    const resumo = { tipo, chave, nome, documento, instituicao };
    return { resumo, assinatura: JSON.stringify(resumo) };
  };

  const executarTransferencia = async (args, esperado, request, contaUsada = null, boundAccount = null, marca = novaMarca('pix')) => {
    let atual;
    try { atual = await titularChave(args, request); }
    catch (e) { return JSON.stringify({ ok: false, error: String(e?.message || e) }); }
    if (!esperado || atual.assinatura !== esperado.assinatura) {
      return JSON.stringify({ ok: false, error: 'A titularidade da chave Pix mudou depois da confirmação. Nenhuma transferência foi criada; confira e confirme novamente.' });
    }
    if (typeof garantirWebhookComprovante === 'function') {
      try { await garantirWebhookComprovante(boundAccount); }
      catch (e) { return JSON.stringify({ ok: false, error: `Não consegui preparar o acompanhamento do comprovante. Nenhum Pix foi criado. ${String(e?.message || e)}` }); }
    }
    const body = {
      operationType: 'PIX',
      value: Number(args.valor),
      pixAddressKey: atual.resumo.chave,
      pixAddressKeyType: atual.resumo.tipo,
    };
    if (args.descricao) body.description = String(args.descricao).slice(0, 500);
    if (args.agendar_para) body.scheduleDate = String(args.agendar_para).slice(0, 10);
    let j = await postComMarca(request, '/v3/transfers', body, marca);
    if (j.__incerto) {
      return JSON.stringify({
        ok: true,
        pending: true,
        incerto: true,
        saiu: false,
        referencia: marca,
        conta_usada: contaUsada,
        aviso: 'Não consegui confirmar o que aconteceu com esse Pix: a instituição não respondeu e a conferência que fiz logo em seguida também não encontrou o lançamento. Ele pode ter saído. Não peça de novo antes de conferir: daqui a pouco me peça as transferências recentes da conta, ou veja o extrato.',
      });
    }
    const erro = erroAsaas(j, 'a transferência Pix');
    if (erro) return JSON.stringify({ ok: false, error: erro });
    const authorizationHash = asaasAuthorizationHash({ type: 'TRANSFER', transfer: j });
    if (typeof registrarIntencaoFinanceira === 'function' && authorizationHash) {
      try {
        await registrarIntencaoFinanceira({
          providerOperationId: j.id, accountId: boundAccount?.accountId || '', kind: 'TRANSFER',
          externalReference: marca, expectedHash: authorizationHash,
        });
      } catch (e) {
        console.error('[asaas] falha fechada ao registrar intenção do Pix:', e?.message || e);
        return JSON.stringify({
          ok: false, pending: true, id: j.id,
          error: `A Asaas recebeu o Pix, mas o ${marcaDoProduto().nome} não conseguiu registrar a autorização segura. A validação será recusada; não repita e consulte este id depois.`,
        });
      }
    }
    let st = String(j.status || '').toUpperCase();
    let falhou = ['FAILED', 'CANCELLED', 'REFUNDED'].includes(st);
    let concluido = st === 'DONE';
    let pendenteAuth = j.awaitingCriticalActionAuthorization === true || j.authorized === false;

    // Registers the id before waiting: this way the webhook that arrives during
    // this window keeps the link to the user, assistant and originating conversation.
    await registrar({
      id: j.id,
      tipo: 'pix',
      accountId: boundAccount?.accountId || '',
      status: st,
      valor: j.value,
      comprovante: concluido ? (j.transactionReceiptUrl || null) : null,
      comprovanteEntregue: concluido && !!j.transactionReceiptUrl,
    });

    // Immediate Pix, accepted and still pending: waits only for the webhook/
    // local state for up to 10s. No creation call is redone.
    if (!args.agendar_para && !falhou && !concluido && !pendenteAuth && j.id
        && typeof aguardarOperacao === 'function') {
      let final = null;
      try { final = await aguardarOperacao(j.id, 10_000); }
      catch (e) { console.error('[asaas] espera curta do Pix falhou:', e?.message || e); }
      if (final) {
        j = {
          ...j,
          status: final.status || j.status,
          value: final.value ?? j.value,
          transactionReceiptUrl: final.receipt_url || final.transactionReceiptUrl || j.transactionReceiptUrl,
        };
        st = String(j.status || '').toUpperCase();
        falhou = ['FAILED', 'CANCELLED', 'REFUNDED'].includes(st);
        concluido = st === 'DONE';
        pendenteAuth = j.awaitingCriticalActionAuthorization === true || j.authorized === false;
      }
    }
    const resultado = {
      ok: !falhou,
      id: j.id,
      status: st,
      autorizada: pendenteAuth ? false : j.authorized,
      valor: j.value,
      taxa: j.transferFee,
      efetivada: j.effectiveDate,
      motivo_falha: j.failReason,
      comprovante: concluido ? (j.transactionReceiptUrl || null) : null,
      conta_usada: contaUsada,
      saiu: concluido,
      pending: !falhou && !concluido,
      error: falhou ? `O Pix não foi efetivado (status ${st || 'desconhecido'}).${j.failReason ? ` Motivo: ${j.failReason}` : ''}` : undefined,
      aviso: pendenteAuth
        ? 'O Pix foi criado, mas ainda NÃO saiu: a Asaas exige autorização do titular por token no app ou painel. Não repita; autorize e depois consulte o status.'
        : falhou
          ? `O Pix não foi efetivado (status ${st || 'desconhecido'}).${j.failReason ? ` Motivo: ${j.failReason}` : ''}`
          : concluido
            ? 'Pix concluído pela Asaas.'
            : 'O Pix está em processamento. Avisarei aqui quando concluir.',
    };
    await registrar({
      id: j.id,
      tipo: 'pix',
      accountId: boundAccount?.accountId || '',
      status: st,
      valor: j.value,
      comprovante: concluido ? (j.transactionReceiptUrl || null) : null,
      // If the short wait saw DONE, this response already delivers the receipt
      // and marks the notification as done so the webhook doesn't duplicate it.
      comprovanteEntregue: concluido && !!j.transactionReceiptUrl,
    });
    if (!falhou && !concluido && !pendenteAuth && !args.agendar_para) {
      agendarReconciliacaoSaida({
        id: j.id,
        tipo: 'pix',
        request,
        accountId: boundAccount?.accountId || '',
        contaUsada,
      });
    }
    return JSON.stringify(resultado);
  };

  return [
    {
      name: 'asaas_saldo',
      description: 'Checks the current balance of the user\'s Asaas account, in reais. Read-only.',
      parameters: { type: 'object', properties: {} },
      async run() {
        const j = await aReq(secret, '/v3/finance/balance');
        if (j.__notConnected) return ASAAS_SETUP();
        if (j.__badCredential) return ASAAS_BAD;
        if (j.__apiError) return `A Asaas recusou a consulta de saldo: ${j.__apiError}`;
        return JSON.stringify({
          saldo: j.balance,
          moeda: 'BRL',
          confirma_deposito_especifico: false,
          aviso: 'O saldo atual isolado não prova que um depósito específico entrou. Para confirmar um Pix recebido, use asaas_verificar_recebimento_pix e confira o lançamento no extrato.',
        }) + await emQualConta();
      },
    },
    {
      name: 'asaas_receber_pix',
      description: 'Proposes generating a Pix copia-e-cola code to RECEIVE money. If there is no active Pix key, the confirmation also authorizes creating a random key. It is a FINANCIAL ACTION and never executes in the same turn, nor in automations: the user must confirm in text in the following turn. If they only ask how it works, explain without calling this tool.',
      parameters: { type: 'object', properties: {
        valor: { type: 'number', description: 'Deposit amount in reais (optional). Without it, the payer chooses the amount.' },
        descricao: { type: 'string', description: 'Description shown to the payer (optional).' },
      } },
      run: confirmacaoObrigatoria,
      async prepareConfirmation(args = {}) {
        const invalido = validarRecebimento(args);
        if (invalido) throw new Error(invalido);
        const vinculada = await vincularContaFinanceira();
        const estado = await estadoChavePix(vinculada.request);
        if (!estado.ativa && estado.ativando) throw new Error('A chave Pix da conta ainda está sendo ativada; não propus criar outra.');
        const valor = args.valor != null ? ` de R$ ${Number(args.valor).toFixed(2).replace('.', ',')}` : ' sem valor fixo';
        const efeito = estado.ativa
          ? `usar a chave Pix ativa terminada em ${String(estado.ativa.key || '').slice(-8)} e gerar o copia-e-cola${valor}; nenhuma nova chave será criada`
          : `criar uma chave Pix aleatória na conta e gerar o copia-e-cola${valor}`;
        const contaPt = vinculada.rotulo ? `. Conta que será usada: ${vinculada.rotulo}` : '';
        const contaEn = vinculada.rotulo ? `. Account to be used: ${vinculada.rotulo}` : '';
        const contaEs = vinculada.rotulo ? `. Cuenta que se usará: ${vinculada.rotulo}` : '';
        const label = `AÇÃO FINANCEIRA: ${efeito}. Ao cadastrar ou usar a chave, o pagador verá o nome completo do titular e o CPF mascarado para conferir o destinatário${contaPt}`;
        const valorEn = args.valor != null ? ` for BRL ${Number(args.valor).toFixed(2)}` : ' with no fixed amount';
        const valorEs = args.valor != null ? ` por R$ ${Number(args.valor).toFixed(2).replace('.', ',')}` : ' sin importe fijo';
        const efeitoEn = estado.ativa
          ? `use the active PIX key ending in ${String(estado.ativa.key || '').slice(-8)} and generate the copy-and-paste code${valorEn}; no new key will be created`
          : `create a random PIX key in the account and generate the copy-and-paste code${valorEn}`;
        const efeitoEs = estado.ativa
          ? `usar la clave PIX activa terminada en ${String(estado.ativa.key || '').slice(-8)} y generar el código copia y pega${valorEs}; no se creará una clave nueva`
          : `crear una clave PIX aleatoria en la cuenta y generar el código copia y pega${valorEs}`;
        let consumida = false;
        return {
          descriptor: { account: vinculada.descriptor, target: estado.assinatura },
          label,
          labels: {
            en: `FINANCIAL ACTION: ${efeitoEn}. When the key is registered or used, the payer will see the holder's full name and masked tax ID to verify the recipient${contaEn}`,
            es: `ACCIÓN FINANCIERA: ${efeitoEs}. Al registrar o usar la clave, el pagador verá el nombre completo del titular y su documento enmascarado para verificar el destinatario${contaEs}`,
          },
          run: async () => {
            if (consumida) return JSON.stringify({ ok: false, error: 'Esta confirmação já foi consumida; não repeti a ação financeira.' });
            consumida = true;
            return executarRecebimentoPix(args, estado, vinculada.request, vinculada.rotulo);
          },
        };
      },
    },
    {
      name: 'asaas_verificar_recebimento_pix',
      description: 'Checks in the Asaas STATEMENT whether a received Pix really came in. Never conclude from the balance alone. Without an amount, returns recent candidates and requires the user to identify the deposit; with an amount, only confirms when there is a single matching PIX_TRANSACTION_CREDIT entry in the period.',
      parameters: { type: 'object', properties: {
        valor: { type: 'number', description: 'Exact amount of the deposit the user says they made. Without it, the check does not confirm which deposit is theirs.' },
        desde: { type: 'string', description: 'Start date YYYY-MM-DD. Default: today in Brasília time.' },
      } },
      async run({ valor, desde } = {}) {
        const inicio = String(desde || hojeBrasil()).slice(0, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(inicio)) return JSON.stringify({ confirmado: false, motivo: 'data_invalida' });
        if (valor != null && !(Number(valor) > 0)) return JSON.stringify({ confirmado: false, motivo: 'valor_invalido' });
        const j = await aReq(secret, '/v3/financialTransactions', { query: {
          startDate: inicio, finishDate: hojeBrasil(), limit: '100', order: 'desc',
        } });
        if (j.__notConnected) return ASAAS_SETUP();
        if (j.__badCredential) return ASAAS_BAD;
        if (j.__apiError) return `Não consegui consultar o extrato da Asaas: ${j.__apiError}`;
        const creditos = (Array.isArray(j.data) ? j.data : [])
          .filter((x) => String(x.type).toUpperCase() === 'PIX_TRANSACTION_CREDIT' && Number(x.value) > 0)
          .map((x) => ({ id: x.id, valor: Number(x.value), data: x.date, tipo: x.type, descricao: x.description || null }));
        if (valor == null) {
          return JSON.stringify({
            confirmado: false,
            motivo: 'valor_nao_informado',
            aviso: 'Encontrei os créditos Pix recentes, mas sem o valor informado não posso afirmar qual deles é o depósito do usuário.',
            creditos_pix_recentes: creditos.slice(0, 10),
          }) + await emQualConta();
        }
        const v = Number(valor);
        const iguais = creditos.filter((x) => Math.abs(x.valor - v) < 0.005);
        if (iguais.length !== 1) {
          return JSON.stringify({
            confirmado: false,
            motivo: iguais.length ? 'mais_de_um_lancamento_compativel' : 'lancamento_nao_encontrado',
            aviso: iguais.length
              ? 'Há mais de um crédito Pix com esse valor no período; não dá para atribuir um deles ao depósito sem outra referência.'
              : 'Não encontrei crédito Pix com esse valor no período. O saldo atual não substitui esse lançamento.',
            candidatos: iguais,
          }) + await emQualConta();
        }
        return JSON.stringify({ confirmado: true, evidencia: iguais[0] }) + await emQualConta();
      },
    },
    {
      name: 'asaas_simular_conta',
      description: 'Validates/simulates the payment of a boleto or bill by its linha digitável (or barcode), WITHOUT paying. Returns the real amount, the due date, the payee and whether it is overdue. ALWAYS use it before paying, to check amount and due date with the user.',
      parameters: { type: 'object', properties: {
        linha_digitavel: { type: 'string', description: 'Boleto linha digitável (with or without spaces/dots).' },
        codigo_de_barras: { type: 'string', description: 'Barcode (alternative to the linha digitável).' },
      } },
      async run({ linha_digitavel, codigo_de_barras } = {}) {
        const body = {};
        const id = onlyDigitsish(linha_digitavel);
        if (id) body.identificationField = id;
        const bc = onlyDigitsish(codigo_de_barras);
        if (bc) body.barCode = bc;
        if (!body.identificationField && !body.barCode) return 'Informe a linha digitável (ou o código de barras) do boleto.';
        const j = await aReq(secret, '/v3/bill/simulate', { method: 'POST', body });
        if (j.__notConnected) return ASAAS_SETUP();
        if (j.__badCredential) return ASAAS_BAD;
        if (j.__apiError) return `Não consegui validar esse boleto na Asaas: ${j.__apiError}`;
        const b = j.bankSlipInfo || {};
        return JSON.stringify({
          valor: b.value ?? j.value,
          vencimento: b.dueDate ?? j.dueDate,
          beneficiario: b.beneficiaryName,
          cpf_cnpj_beneficiario: b.beneficiaryCpfCnpj,
          empresa: b.companyName,
          vencido: b.isOverdue,
          permite_alterar_valor: b.allowChangeValue,
          valor_min: b.minValue,
          valor_max: b.maxValue,
          taxa_asaas: j.fee,
          agendamento_minimo: j.minimumScheduleDate,
        });
      },
    },
    {
      name: 'asaas_transferencias',
      description: 'Lists the recent transfers (PIX/TED) of the Asaas account, with amount, status, destination and dates. Use to check whether a PIX you sent has already completed.',
      parameters: { type: 'object', properties: { max: { type: 'integer', description: 'Default 10 (max 50).' } } },
      async run({ max = 10 } = {}) {
        const j = await aReq(secret, '/v3/transfers', { query: { limit: String(Math.min(Math.max(max, 1), 50)) } });
        if (j.__notConnected) return ASAAS_SETUP();
        if (j.__badCredential) return ASAAS_BAD;
        if (j.__apiError) return `A Asaas recusou a consulta: ${j.__apiError}`;
        const out = (j.data || []).map((t) => ({
          id: t.id, valor: t.value, status: t.status,
          tipo: t.operationType || t.type,
          chave_pix: t.bankAccount?.pixAddressKey, para: t.bankAccount?.ownerName,
          criada: t.dateCreated, efetivada: t.effectiveDate, motivo_falha: t.failReason,
          comprovante: t.transactionReceiptUrl || null,
        }));
        return out.length ? JSON.stringify(out) : 'Nenhuma transferência encontrada.';
      },
    },
    {
      name: 'asaas_obter_comprovante',
      description: 'Retrieves the OFFICIAL receipt of an already completed Pix or boleto payment, by the real operation id in Asaas. It is read-only. If the user says “o último”, first list the transfers or payments and choose without ambiguity; never make up an id nor use a pending operation.',
      parameters: { type: 'object', properties: {
        tipo: { type: 'string', enum: ['pix', 'boleto'], description: 'pix for a Pix transfer; boleto for a bill payment.' },
        id: { type: 'string', description: 'Real id returned by Asaas.' },
      }, required: ['tipo', 'id'] },
      async run(args = {}) {
        try {
          const r = await comprovantePorId(args);
          const { assinatura, ...publico } = r;
          return JSON.stringify({ ok: true, ...publico });
        } catch (e) {
          return JSON.stringify({ ok: false, error: String(e?.message || e) });
        }
      },
    },
    {
      name: 'asaas_enviar_comprovante_email',
      description: 'PROPOSES emailing the official receipt of a completed Pix or boleto. Fetches the status and the URL from Asaas again, builds a deterministic subject and body, and requires textual confirmation in the following turn. Do not use gmail_send/hotmail_send for Asaas receipts: use this tool to prevent a made-up id, amount, link or recipient.',
      parameters: { type: 'object', properties: {
        tipo: { type: 'string', enum: ['pix', 'boleto'], description: 'pix for a Pix transfer; boleto for a bill payment.' },
        id: { type: 'string', description: 'Real id returned by Asaas.' },
        para: { type: 'string', description: 'A single recipient email address.' },
      }, required: ['tipo', 'id', 'para'] },
      run: confirmacaoObrigatoria,
      async prepareConfirmation(args = {}) {
        const para = emailUnico(args.para);
        if (!para) throw new Error('Informe um único endereço de e-mail válido para receber o comprovante.');
        if (typeof emailDisponivel !== 'function' || typeof enviarComprovanteEmail !== 'function') {
          throw new Error('O envio de comprovante por e-mail não está disponível nesta conversa.');
        }
        const via = await emailDisponivel();
        if (!via) throw new Error('Conecte um Gmail com o envio avulso ligado, ou um Outlook com permissão de envio, antes de pedir o comprovante.');
        const vinculada = await vincularContaFinanceira();
        const r = await comprovantePorId(args, vinculada.request);
        const valor = Number.isFinite(r.valor) ? ` de R$ ${r.valor.toFixed(2).replace('.', ',')}` : '';
        const operacao = r.tipo === 'pix' ? 'Pix' : 'pagamento de conta';
        const label = `enviar por ${via === 'gmail' ? 'Gmail' : 'Outlook'} para ${para} o comprovante oficial do ${operacao}${valor}, operação ${r.id}. O status e o link foram conferidos agora na Asaas e serão conferidos novamente antes do envio`;
        let consumida = false;
        return {
          descriptor: { account: vinculada.descriptor, via, receipt: { id:r.id, tipo:r.tipo, valor:r.valor } },
          label,
          labels: {
            en: `send via ${via === 'gmail' ? 'Gmail' : 'Outlook'} to ${para} the official receipt for the ${r.tipo === 'pix' ? 'PIX transfer' : 'bill payment'}${Number.isFinite(r.valor) ? ` of BRL ${r.valor.toFixed(2)}` : ''}, operation ${r.id}. Its status and link were just checked at Asaas and will be checked again before sending`,
            es: `enviar por ${via === 'gmail' ? 'Gmail' : 'Outlook'} a ${para} el comprobante oficial de la ${r.tipo === 'pix' ? 'transferencia PIX' : 'cuenta pagada'}${valor}, operación ${r.id}. El estado y el enlace se comprobaron ahora en Asaas y se volverán a comprobar antes del envío`,
          },
          run: async () => {
            if (consumida) return JSON.stringify({ ok: false, error: 'Esta confirmação já foi consumida; não repeti o envio do e-mail.' });
            consumida = true;
            let atual;
            try { atual = await comprovantePorId(args, vinculada.request); }
            catch (e) { return JSON.stringify({ ok: false, error: String(e?.message || e) }); }
            if (atual.assinatura !== r.assinatura) {
              return JSON.stringify({ ok: false, error: 'Os dados ou o link do comprovante mudaram depois da confirmação. Nada foi enviado; confira e confirme novamente.' });
            }
            const mail = emailDoComprovante(atual, para);
            try {
              const enviado = await enviarComprovanteEmail({ ...mail, via, operacao: atual });
              if (typeof enviado === 'string') return enviado;
              return JSON.stringify(enviado || { ok: false, error: 'O provedor de e-mail não confirmou o envio.' });
            } catch (e) {
              return JSON.stringify({ ok: false, error: String(e?.message || e) });
            }
          },
        };
      },
    },
    {
      name: 'asaas_pagamentos_conta',
      description: `Lists the recent bill/boleto payments and also the future scheduled payments kept by ${marcaDoProduto().nome}, with amount, status and dates. Use to check execution or to get the id of a scheduled payment before cancelling it.`,
      parameters: { type: 'object', properties: { max: { type: 'integer', description: 'Default 10 (max 50).' } } },
      async run({ max = 10 } = {}) {
        const out = [];
        if (typeof listarAgendamentosBoleto === 'function') {
          const local = await listarAgendamentosBoleto(Math.min(Math.max(max, 1), 50));
          for (const s of Array.isArray(local) ? local : []) {
            out.push({
              id: s.id, valor: s.payload?.valor ?? s.payload?.resumo_confirmado?.valor ?? s.outcome?.valor ?? null, status: s.status,
              agendado: String(s.execute_on || '').slice(0, 10), pago_em: null,
              descricao: s.payload?.descricao || s.outcome?.descricao || null,
              beneficiario: s.payload?.resumo_confirmado?.beneficiario || null,
              pode_cancelar: s.status === 'scheduled',
              autorizacao_critica_pendente: s.status === 'awaiting_authorization',
              origem_agendamento: 'brambs', provider_id: s.provider_operation_id || null,
            });
          }
        }
        const j = await aReq(secret, '/v3/bill', { query: { limit: String(Math.min(Math.max(max, 1), 50)) } });
        const providerError = j.__notConnected ? ASAAS_SETUP()
          : j.__badCredential ? ASAAS_BAD
            : j.__apiError ? `A Asaas recusou a consulta: ${j.__apiError}` : null;
        if (providerError) {
          return out.length ? JSON.stringify({ pagamentos: out, aviso_provider: providerError }) : providerError;
        }
        out.push(...(j.data || []).map((b) => ({
          id: b.id, valor: b.value, status: b.status,
          agendado: b.scheduleDate, pago_em: b.paymentDate,
          descricao: b.description || null, pode_cancelar: b.canBeCancelled === true,
          autorizacao_critica_pendente: b.awaitingCriticalActionAuthorization === true,
          origem_agendamento: 'asaas_legado',
          comprovante: b.transactionReceiptUrl,
        })));
        return out.length ? JSON.stringify(out) : 'Nenhum pagamento de conta encontrado.';
      },
    },
    {
      name: 'asaas_cancelar_pagamento_conta',
      description: `PROPOSES cancelling a scheduled bill payment. New ${marcaDoProduto().nome} scheduled payments are cancelled internally through the conversation, without calling Asaas or asking for external approval. Legacy ids already created in Asaas follow the provider's cancellation. First check asaas_pagamentos_conta when the user did not give an unambiguous id. It is an irreversible FINANCIAL ACTION and requires textual confirmation in the following turn.`,
      parameters: { type: 'object', properties: {
        id: { type: 'string', description: 'Real id of the bill payment returned by Asaas.' },
      }, required: ['id'] },
      run: confirmacaoObrigatoria,
      async prepareConfirmation(args = {}) {
        const local = typeof obterAgendamentoBoleto === 'function'
          ? await obterAgendamentoBoleto(args.id)
          : null;
        if (local) {
          if (local.status !== 'scheduled') {
            throw new Error(`O agendamento está ${local.status} e já não pode ser cancelado como agenda local.`);
          }
          const valor = Number(local.payload?.valor ?? local.payload?.resumo_confirmado?.valor);
          const beneficiario = local.payload?.resumo_confirmado?.beneficiario || 'beneficiário confirmado';
          const data = String(local.execute_on || '').slice(0, 10);
          const label = `AÇÃO FINANCEIRA: cancelar o agendamento ${marcaDoProduto().nome} ${local.id}${Number.isFinite(valor) ? ` de R$ ${valor.toFixed(2).replace('.', ',')}` : ''} para ${beneficiario}, previsto para ${data}. Como ainda não foi enviado à Asaas, o cancelamento acontece aqui e não exige aprovação externa`;
          let consumida = false;
          return {
            descriptor: { scheduleId:local.id, expectedHash:local.expected_hash },
            label,
            labels: {
              en: `FINANCIAL ACTION: cancel ${marcaDoProduto().nome} schedule ${local.id}${Number.isFinite(valor) ? ` of BRL ${valor.toFixed(2)}` : ''}, due on ${data}. It has not been sent to Asaas and needs no external approval`,
              es: `ACCIÓN FINANCIERA: cancelar la programación ${marcaDoProduto().nome} ${local.id}${Number.isFinite(valor) ? ` de R$ ${valor.toFixed(2).replace('.', ',')}` : ''}, prevista para ${data}. Aún no se envió a Asaas y no requiere aprobación externa`,
            },
            run: async () => {
              if (consumida) return JSON.stringify({ ok: false, error: 'Esta confirmação já foi consumida; não repeti o cancelamento.' });
              consumida = true;
              const cancelled = await cancelarAgendamentoBoleto?.(local.id, local.expected_hash);
              if (!cancelled) return JSON.stringify({ ok: false, error: 'O estado do agendamento mudou antes da confirmação. Não cancelei nada; consulte novamente.' });
              return JSON.stringify({ ok: true, cancelado: true, origem_agendamento: 'brambs', id: local.id, status: 'cancelled' });
            },
          };
        }
        const vinculada = await vincularContaFinanceira();
        const consultado = await consultarPagamento(args.id, vinculada.request);
        if (!consultado.resumo.pode_cancelar) {
          throw new Error(`O pagamento está ${consultado.resumo.status || 'em estado desconhecido'} e a Asaas informou que ele não pode mais ser cancelado.`);
        }
        const label = `AÇÃO FINANCEIRA: cancelar o pagamento de conta ${consultado.resumo.id}${Number.isFinite(consultado.resumo.valor) ? ` de R$ ${consultado.resumo.valor.toFixed(2).replace('.', ',')}` : ''}${consultado.resumo.agendado_para ? `, agendado para ${consultado.resumo.agendado_para}` : ''}. A Asaas confirmou agora que ele ainda pode ser cancelado; os dados serão conferidos novamente antes do pedido`;
        let consumida = false;
        return {
          descriptor: { account: vinculada.descriptor, target: consultado.assinatura },
          label,
          labels: {
            en: `FINANCIAL ACTION: cancel bill payment ${consultado.resumo.id}${Number.isFinite(consultado.resumo.valor) ? ` of BRL ${consultado.resumo.valor.toFixed(2)}` : ''}${consultado.resumo.agendado_para ? `, scheduled for ${consultado.resumo.agendado_para}` : ''}. Asaas just confirmed it can still be cancelled; the data will be checked again before the request`,
            es: `ACCIÓN FINANCIERA: cancelar el pago de cuenta ${consultado.resumo.id}${Number.isFinite(consultado.resumo.valor) ? ` de R$ ${consultado.resumo.valor.toFixed(2).replace('.', ',')}` : ''}${consultado.resumo.agendado_para ? `, programado para ${consultado.resumo.agendado_para}` : ''}. Asaas confirmó ahora que aún puede cancelarse; los datos se comprobarán nuevamente antes de solicitarlo`,
          },
          confirmationTexts: {
            'pt-BR': confirmacaoCancelamento({ resumo: consultado.resumo, contaUsada: vinculada.boundAccount?.rotulo || vinculada.rotulo, lang: 'pt-BR' }),
            en: confirmacaoCancelamento({ resumo: consultado.resumo, contaUsada: vinculada.boundAccount?.rotulo || vinculada.rotulo, lang: 'en' }),
            es: confirmacaoCancelamento({ resumo: consultado.resumo, contaUsada: vinculada.boundAccount?.rotulo || vinculada.rotulo, lang: 'es' }),
          },
          run: async () => {
            if (consumida) return JSON.stringify({ ok: false, error: 'Esta confirmação já foi consumida; não repeti o cancelamento.' });
            consumida = true;
            let atual;
            try { atual = await consultarPagamento(args.id, vinculada.request); }
            catch (e) { return JSON.stringify({ ok: false, error: String(e?.message || e) }); }
            if (atual.assinatura !== consultado.assinatura) {
              return JSON.stringify({ ok: false, error: 'O estado, valor ou agendamento mudou depois da confirmação. Não pedi o cancelamento; confira e confirme novamente.' });
            }
            if (!atual.resumo.pode_cancelar) {
              return JSON.stringify({ ok: false, error: `A Asaas informou que o pagamento está ${atual.resumo.status || 'em estado desconhecido'} e não pode mais ser cancelado.` });
            }
            if (typeof garantirWebhookComprovante === 'function') {
              try { await garantirWebhookComprovante(vinculada.boundAccount); }
              catch (e) {
                // Cancelling can't be blocked by a channel failure. The single
                // query at 60s still closes the loop; the webhook's error stays
                // observable in the log, without requiring another POST.
                console.error('[asaas] não consegui preparar o webhook antes do cancelamento:', e?.message || e);
              }
            }
            let j;
            try { j = await vinculada.request(`/v3/bill/${encodeURIComponent(atual.resumo.id)}/cancel`, { method: 'POST' }); }
            catch (e) {
              return JSON.stringify({
                ok: false,
                incerto: true,
                error: `A instituição não respondeu ao pedido de cancelamento. Não repeti a solicitação. Consulte o pagamento ${atual.resumo.id} antes de tentar qualquer nova ação.`,
              });
            }
            if (desfechoIncerto(j)) {
              return JSON.stringify({
                ok: false,
                incerto: true,
                error: `A instituição não confirmou o pedido de cancelamento. Não repeti a solicitação. Consulte o pagamento ${atual.resumo.id} antes de tentar qualquer nova ação.`,
              });
            }
            const erro = erroAsaas(j, 'o cancelamento do pagamento de conta');
            if (erro) return JSON.stringify({ ok: false, error: erro });
            let status = String(j.status || atual.resumo.status || '').toUpperCase();
            await registrar({
              id: atual.resumo.id,
              tipo: 'boleto',
              accountId: vinculada.boundAccount?.accountId || '',
              status,
              valor: j.value ?? atual.resumo.valor,
              comprovanteEntregue: status === 'CANCELLED',
              agendadaParaProvedor: j.scheduleDate || atual.resumo.agendado_para,
              vencimento: j.dueDate || atual.resumo.vencimento,
            });
            if (status !== 'CANCELLED' && typeof aguardarOperacao === 'function') {
              let final = null;
              try { final = await aguardarOperacao(atual.resumo.id, 10_000); }
              catch (e) { console.error('[asaas] espera curta do cancelamento falhou:', e?.message || e); }
              status = String(final?.status || status).toUpperCase();
            }
            if (status === 'CANCELLED') {
              await registrar({
                id: atual.resumo.id,
                tipo: 'boleto',
                accountId: vinculada.boundAccount?.accountId || '',
                status,
                valor: j.value ?? atual.resumo.valor,
                comprovanteEntregue: true,
                agendadaParaProvedor: j.scheduleDate || atual.resumo.agendado_para,
                vencimento: j.dueDate || atual.resumo.vencimento,
              });
              return JSON.stringify({ ok: true, cancelado: true, status, id: atual.resumo.id, valor: j.value ?? atual.resumo.valor, conta_usada: vinculada.rotulo });
            }
            agendarReconciliacaoSaida({
              id: atual.resumo.id,
              tipo: 'boleto',
              request: vinculada.request,
              accountId: vinculada.boundAccount?.accountId || '',
              contaUsada: vinculada.rotulo,
            });
            const awaitingCritical = j.awaitingCriticalActionAuthorization === true;
            return JSON.stringify({
              ok: true,
              pending: true,
              cancelamento_solicitado: true,
              autorizacao_critica_pendente: awaitingCritical,
              status: status || 'PENDING',
              id: atual.resumo.id,
              valor: j.value ?? atual.resumo.valor,
              conta_usada: vinculada.rotulo,
              aviso: awaitingCritical
                ? 'A Asaas recebeu o cancelamento legado, mas exige uma autorização crítica externa para excluir esse agendamento criado no provedor. Ele ainda não foi cancelado. Não repita o pedido.'
                : 'O cancelamento foi solicitado à Asaas e está em processamento. Avisarei aqui quando for confirmado. Não repita o pedido.',
            });
          },
        };
      },
    },
    {
      name: 'asaas_pagar_conta',
      description: `PROPOSES paying a boleto/bill through the Asaas account. It is a FINANCIAL ACTION: never executes in the same turn nor by automation; first checks the real amount, due date and payee in Asaas, shows this data to the user and requires textual confirmation in the following turn. When the user asks for a future date, the scheduled payment stays in ${marcaDoProduto().nome} and is only sent to Asaas on the day, after a new check; it can be cancelled through the conversation before execution.`,
      parameters: { type: 'object', properties: {
        linha_digitavel: { type: 'string', description: 'Boleto linha digitável (with or without spaces/dots).' },
        codigo_de_barras: { type: 'string', description: 'Barcode (alternative to the linha digitável).' },
        valor: { type: 'number', description: 'Amount to pay. Only use it when the boleto allows changing the amount; otherwise Asaas charges the boleto\'s own amount.' },
        agendar_para: { type: 'string', description: 'Scheduling date YYYY-MM-DD. ONLY use it when the user explicitly asks for a future date or payment on the due date. If they only ask to pay, omit it: processing is immediate.' },
        descricao: { type: 'string', description: 'Payment note (optional).' },
      } },
      run: confirmacaoObrigatoria,
      normalizeConfirmationArgs(args = {}, { ownerText = '' } = {}) {
        const explicit = pediuAgendamentoDeBoleto(ownerText);
        if (!explicit) {
          delete args.agendar_para;
          return args;
        }
        const data = dataIsoValida(args.agendar_para);
        if (!data && pediuNoVencimento(ownerText)) {
          // The date will come from the boleto's own official simulation. Don't
          // ask the user to retype data the institution already provides.
          args.__agendar_no_vencimento = true;
          return args;
        }
        if (!data) return { erro: 'Você pediu um agendamento, mas falta uma data válida no formato AAAA-MM-DD. Pergunte a data antes de propor o pagamento.' };
        if (data < hojeBrasil()) return { erro: 'A data de agendamento já passou. Confirme com o usuário uma data futura antes de propor o pagamento.' };
        args.agendar_para = data;
        return args;
      },
      async prepareConfirmation(args = {}) {
        const vinculada = await vincularContaFinanceira();
        const sim = await simularBoleto(args, vinculada.request);
        if (args.__agendar_no_vencimento) {
          const vencimento = dataIsoValida(sim.resumo.vencimento);
          delete args.__agendar_no_vencimento;
          if (!vencimento) throw new Error('A Asaas não devolveu uma data de vencimento válida; pergunte ao usuário em qual data deseja agendar.');
          if (vencimento < hojeBrasil()) throw new Error('O boleto já venceu; confirme com o usuário se o pagamento deve ser imediato ou em outra data.');
          args.agendar_para = vencimento;
        }
        if (!args.agendar_para && !dataIsoValida(sim.resumo.data_minima_pagamento)) {
          throw new Error('A Asaas não informou a primeira data em que aceita processar este boleto; não propus o pagamento. Tente novamente mais tarde.');
        }
        const efetivo = args.valor != null ? Number(args.valor) : sim.resumo.valor;
        const doc = sim.resumo.cpf_cnpj_beneficiario ? `, documento ${sim.resumo.cpf_cnpj_beneficiario}` : '';
        const quando = args.agendar_para ? `, agendado para ${String(args.agendar_para).slice(0, 10)}` : '';
        const contaPt = vinculada.rotulo ? ` Conta que será usada: ${vinculada.rotulo}.` : '';
        const contaEn = vinculada.rotulo ? ` Account to be used: ${vinculada.rotulo}.` : '';
        const contaEs = vinculada.rotulo ? ` Cuenta que se usará: ${vinculada.rotulo}.` : '';
        const label = `AÇÃO FINANCEIRA: pagar R$ ${efetivo.toFixed(2).replace('.', ',')} para ${sim.resumo.beneficiario}${doc}, vencimento ${sim.resumo.vencimento || 'não informado pela Asaas'}${quando}.${contaPt} Os dados foram consultados agora na Asaas e serão conferidos de novo antes do pagamento`;
        const whenEn = args.agendar_para ? `, scheduled for ${String(args.agendar_para).slice(0, 10)}` : '';
        const whenEs = args.agendar_para ? `, programado para ${String(args.agendar_para).slice(0, 10)}` : '';
        const docEn = sim.resumo.cpf_cnpj_beneficiario ? `, tax ID ${sim.resumo.cpf_cnpj_beneficiario}` : '';
        const docEs = sim.resumo.cpf_cnpj_beneficiario ? `, documento ${sim.resumo.cpf_cnpj_beneficiario}` : '';
        // The mark is born together with the confirmation (not at POST time): this
        // way, if the send fails and is redone, it carries the SAME mark and we
        // can recognize the operation that already exists instead of paying again
        // (finding #10).
        const marca = novaMarca('bill');
        let consumida = false;
        return {
          descriptor: { account: vinculada.descriptor, target: sim.assinatura },
          label,
          labels: {
            en: `FINANCIAL ACTION: pay BRL ${efetivo.toFixed(2)} to ${sim.resumo.beneficiario}${docEn}, due ${sim.resumo.vencimento || 'not provided by Asaas'}${whenEn}.${contaEn} The data was just retrieved from Asaas and will be checked again before payment`,
            es: `ACCIÓN FINANCIERA: pagar R$ ${efetivo.toFixed(2).replace('.', ',')} a ${sim.resumo.beneficiario}${docEs}, vencimiento ${sim.resumo.vencimento || 'no informado por Asaas'}${whenEs}.${contaEs} Los datos se consultaron ahora en Asaas y se volverán a verificar antes del pago`,
          },
          confirmationTexts: {
            'pt-BR': confirmacaoPagamento({ resumo: sim.resumo, efetivo, args, contaUsada: vinculada.boundAccount?.rotulo || vinculada.rotulo, lang: 'pt-BR' }),
            en: confirmacaoPagamento({ resumo: sim.resumo, efetivo, args, contaUsada: vinculada.boundAccount?.rotulo || vinculada.rotulo, lang: 'en' }),
            es: confirmacaoPagamento({ resumo: sim.resumo, efetivo, args, contaUsada: vinculada.boundAccount?.rotulo || vinculada.rotulo, lang: 'es' }),
          },
          run: async () => {
            if (consumida) return JSON.stringify({ ok: false, error: 'Esta confirmação já foi consumida; não repeti o pagamento.' });
            consumida = true;
            return executarPagamento(args, sim, vinculada.request, vinculada.rotulo, vinculada.boundAccount, marca);
          },
        };
      },
    },
    {
      name: 'asaas_transferir_pix',
      description: 'PROPOSES sending money via Pix through the Asaas account. It is a FINANCIAL ACTION: never executes in the same turn nor by automation; looks up the real key holder, shows amount, key, name and masked document, and requires textual confirmation in the following turn.',
      parameters: { type: 'object', properties: {
        valor: { type: 'number', description: 'Amount in reais to transfer.' },
        chave_pix: { type: 'string', description: 'The destination PIX key.' },
        tipo_chave: { type: 'string', description: 'Key type: CPF, CNPJ, EMAIL, PHONE (phone with +55) or EVP (random key).' },
        descricao: { type: 'string', description: 'Transfer description (optional).' },
        agendar_para: { type: 'string', description: 'Scheduling date YYYY-MM-DD (optional).' },
      }, required: ['valor', 'chave_pix', 'tipo_chave'] },
      run: confirmacaoObrigatoria,
      async prepareConfirmation(args = {}) {
        const vinculada = await vincularContaFinanceira();
        const titular = await titularChave(args, vinculada.request);
        const doc = titular.resumo.documento ? `, documento ${titular.resumo.documento}` : '';
        const banco = titular.resumo.instituicao ? `, instituição ${titular.resumo.instituicao}` : '';
        const quando = args.agendar_para ? `, agendado para ${String(args.agendar_para).slice(0, 10)}` : '';
        const contaPt = vinculada.rotulo ? ` Conta que será usada: ${vinculada.rotulo}.` : '';
        const contaEn = vinculada.rotulo ? ` Account to be used: ${vinculada.rotulo}.` : '';
        const contaEs = vinculada.rotulo ? ` Cuenta que se usará: ${vinculada.rotulo}.` : '';
        const label = `AÇÃO FINANCEIRA: transferir R$ ${Number(args.valor).toFixed(2).replace('.', ',')} via Pix para ${titular.resumo.nome}${doc}${banco}, chave ${titular.resumo.chave} (${titular.resumo.tipo})${quando}.${contaPt} A titularidade foi consultada agora na Asaas e será conferida de novo antes da transferência`;
        const whenEn = args.agendar_para ? `, scheduled for ${String(args.agendar_para).slice(0, 10)}` : '';
        const whenEs = args.agendar_para ? `, programado para ${String(args.agendar_para).slice(0, 10)}` : '';
        const docEn = titular.resumo.documento ? `, tax ID ${titular.resumo.documento}` : '';
        const docEs = titular.resumo.documento ? `, documento ${titular.resumo.documento}` : '';
        const bankEn = titular.resumo.instituicao ? `, institution ${titular.resumo.instituicao}` : '';
        const bankEs = titular.resumo.instituicao ? `, institución ${titular.resumo.instituicao}` : '';
        // The mark is born together with the confirmation (not at POST time): this
        // way, if the send fails and is redone, it carries the SAME mark and we
        // can recognize the operation that already exists instead of paying again
        // (finding #10).
        const marca = novaMarca('pix');
        let consumida = false;
        return {
          descriptor: { account: vinculada.descriptor, target: titular.assinatura },
          label,
          labels: {
            en: `FINANCIAL ACTION: transfer BRL ${Number(args.valor).toFixed(2)} via PIX to ${titular.resumo.nome}${docEn}${bankEn}, key ${titular.resumo.chave} (${titular.resumo.tipo})${whenEn}.${contaEn} Ownership was just retrieved from Asaas and will be checked again before the transfer`,
            es: `ACCIÓN FINANCIERA: transferir R$ ${Number(args.valor).toFixed(2).replace('.', ',')} por PIX a ${titular.resumo.nome}${docEs}${bankEs}, clave ${titular.resumo.chave} (${titular.resumo.tipo})${whenEs}.${contaEs} La titularidad se consultó ahora en Asaas y se volverá a verificar antes de la transferencia`,
          },
          run: async () => {
            if (consumida) return JSON.stringify({ ok: false, error: 'Esta confirmação já foi consumida; não repeti a transferência.' });
            consumida = true;
            return executarTransferencia(args, titular, vinculada.request, vinculada.rotulo, vinculada.boundAccount, marca);
          },
        };
      },
    },
  ];
}
import { recortar } from './recorte.mjs';
