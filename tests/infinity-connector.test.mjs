// Tests of the Vault's Infinity connector (StartInfinity). Pure: simulated fetch,
// no network and no database. Run: node tests/infinity-connector.test.mjs
import { readFileSync } from 'fs';
import { infinityTools, infinityValues, infinityWriteValue, infinityReadValue } from '../web/connectors-vault.mjs';
import { GATED_TOOLS, IRREVERSIBLE_TOOLS } from '../web/confirm.mjs';
import { actionEvidenceFor } from '../web/action-evidence.mjs';

let ok = 0, fail = 0;
const t = (nome, cond) => { if (cond) { ok++; } else { fail++; console.log(`FALHOU: ${nome}`); } };
const lança = (fn) => { try { fn(); return null; } catch (e) { return e.message; } };

const ATTRS = [
  { id: 'a-nome', name: 'Nome', type: 'text' },
  { id: 'a-status', name: 'Status', type: 'label', settings: { multiple: false, labels: [{ id: 'l1', name: 'A fazer' }, { id: 'l2', name: 'Concluído' }] } },
  { id: 'a-resp', name: 'Responsável', type: 'members' },
  { id: 'a-feito', name: 'Feito', type: 'checkbox' },
  { id: 'a-valor', name: 'Valor', type: 'number' },
  { id: 'a-notas', name: 'Notas', type: 'longtext' },
];
const MEMBERS = [{ id: 7, name: 'Ana Souza', email: 'ana@x.com' }, { id: 9, name: 'Beto', email: 'beto@x.com' }];
const FOLDERS = [{ id: 'f1', name: 'Backlog' }];

// Value conversion
const v = infinityValues(ATTRS, { nome: 'Ligar', status: 'concluido', 'Responsável': 'ana@x.com', Feito: 'sim', Valor: '12,5', Notas: 'a < b\nlinha 2' }, MEMBERS);
const por = Object.fromEntries(v.map((x) => [x.attribute_id, x.data]));
t('field name without case/accent finds the attribute', por['a-nome'] === 'Ligar');
t('label by name becomes id', JSON.stringify(por['a-status']) === '["l2"]');
t('member by email becomes id', JSON.stringify(por['a-resp']) === '[7]');
t('checkbox "sim" becomes true', por['a-feito'] === true);
t('number with comma', por['a-valor'] === 12.5);
t('long text becomes escaped html per line', por['a-notas'] === '<p>a &lt; b</p><p>linha 2</p>');
t('nonexistent label lists options', /Opções: A fazer, Concluído/.test(lança(() => infinityValues(ATTRS, { Status: 'Travado' }, MEMBERS))));
t('nonexistent field lists fields', /Campos: Nome, Status/.test(lança(() => infinityValues(ATTRS, { Prazo: 'x' }, MEMBERS))));
t('nonexistent member lists members', /Ana Souza, Beto/.test(lança(() => infinityValues(ATTRS, { 'Responsável': 'Zé' }, MEMBERS))));
t('invalid number is an error', /numérico/.test(lança(() => infinityWriteValue(ATTRS[4], 'abc'))));
t('reading label and member by name', JSON.stringify(infinityReadValue(ATTRS[1], ['l1'])) === '["A fazer"]' && JSON.stringify(infinityReadValue(ATTRS[2], [9], MEMBERS)) === '["Beto"]');

// fetch simulado
const chamadas = [];
function mockFetch(rotas) {
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    chamadas.push({ path: u.pathname.replace('/api/v2', ''), search: u.search, method: init.method || 'GET', headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined });
    const key = `${init.method || 'GET'} ${u.pathname.replace('/api/v2', '')}`;
    const r = rotas[key];
    const [status, json] = typeof r === 'function' ? r(u, init) : r || [404, { error: 'not found' }];
    return { ok: status >= 200 && status < 300, status, json: async () => json, text: async () => JSON.stringify(json) };
  };
}
const page = (data) => [200, { has_more: false, data }];
const BASE = '/workspaces/1/boards/b1';
const ROTAS = {
  'GET /workspaces': page([{ id: 1, name: 'Time' }]),
  'GET /workspaces/1/boards': page([{ id: 'b1', name: 'Projetos', description: '<p>Quadro</p>' }]),
  [`GET ${BASE}/attributes`]: page(ATTRS),
  [`GET ${BASE}/folders`]: page(FOLDERS),
  'GET /workspaces/1/members': page(MEMBERS),
  [`GET ${BASE}/items`]: page([
    { id: 'i1', folder_id: 'f1', created_at: '2026-09-28', values: [{ attribute_id: 'a-nome', data: 'Ligar fornecedor' }, { attribute_id: 'a-status', data: ['l1'] }] },
    { id: 'i2', folder_id: 'f1', created_at: '2026-09-27', values: [{ attribute_id: 'a-nome', data: 'Pagar aluguel' }] },
  ]),
  [`POST ${BASE}/items`]: [201, { id: 'novo' }],
  [`PUT ${BASE}/items/i1`]: [200, { id: 'i1' }],
  [`POST ${BASE}/items/i1/comments`]: [201, { id: 'c1' }],
};
mockFetch(ROTAS);
const tools = Object.fromEntries(infinityTools({ secret: async () => 'tok-test' }).map((x) => [x.name, x]));

const boards = JSON.parse(await tools.infinity_boards.run({}));
t('boards by workspace', boards[0].workspace_id === 1 && boards[0].boards[0].board_id === 'b1' && boards[0].boards[0].descricao === 'Quadro');
const h = chamadas[0].headers;
t('auth and version headers', h.Authorization === 'Bearer tok-test' && h['X-API-Version'] === '2026-04-20.morava' && h.Accept === 'application/json');

const lista = JSON.parse(await tools.infinity_itens.run({ workspace_id: 1, board_id: 'b1', busca: 'fornecedor' }));
t('search filters and translates fields', lista.itens.length === 1 && lista.itens[0].campos.Nome === 'Ligar fornecedor' && lista.itens[0].campos.Status[0] === 'A fazer' && lista.itens[0].pasta === 'Backlog');
t('items requests expand[]=values', chamadas.some((c) => c.path.endsWith('/items') && decodeURIComponent(c.search).includes('expand[]=values')));

chamadas.length = 0;
const criado = JSON.parse(await tools.infinity_criar_item.run({ workspace_id: 1, board_id: 'b1', folder_id: 'f1', campos: { Nome: 'Novo', Status: 'A fazer' } }));
const post = chamadas.find((c) => c.method === 'POST');
t('create sends folder_id and values with ids', post.body.folder_id === 'f1' && JSON.stringify(post.body.values) === JSON.stringify([{ attribute_id: 'a-nome', data: 'Novo' }, { attribute_id: 'a-status', data: ['l1'] }]));
t('create returns ok+id', criado.ok === true && criado.id === 'novo');

chamadas.length = 0;
await tools.infinity_editar_item.run({ workspace_id: 1, board_id: 'b1', item_id: 'i1', campos: { Status: 'Concluído' } });
const put = chamadas.find((c) => c.method === 'PUT');
t('edit sends only the changed field', JSON.stringify(put.body) === JSON.stringify({ values: [{ attribute_id: 'a-status', data: ['l2'] }] }));
t('edit with nothing does not call the API', (await tools.infinity_editar_item.run({ workspace_id: 1, board_id: 'b1', item_id: 'i1' })).startsWith('Nada pra alterar'));

chamadas.length = 0;
const com = JSON.parse(await tools.infinity_comentar.run({ workspace_id: 1, board_id: 'b1', item_id: 'i1', texto: 'Feito <ok>' }));
t('comment in escaped html', chamadas[0].body.text === '<p>Feito &lt;ok&gt;</p>' && com.id === 'c1');

// No token, bad token, 403 and 429
const semToken = Object.fromEntries(infinityTools({ secret: async () => null }).map((x) => [x.name, x]));
chamadas.length = 0;
t('no token returns step by step without calling the API', (await semToken.infinity_boards.run({})).includes('profile/developer/tokens') && chamadas.length === 0);
mockFetch({ 'GET /workspaces': [401, { error: 'Unauthenticated.' }] });
const bad = await tools.infinity_boards.run({});
t('401 turns into bad-credential text without asking in chat', bad.includes('NUNCA peça o token novo no chat') && bad.includes('salvar_credencial'));
mockFetch({ 'GET /workspaces': [403, {}] });
t('403 does not turn into "change the key"', /403: o token não tem acesso/.test(await tools.infinity_boards.run({}).catch((e) => e.message)));
mockFetch({ 'GET /workspaces': [429, {}] });
t('429 explains the limit', /180 por minuto/.test(await tools.infinity_boards.run({}).catch((e) => e.message)));

// Cursor-based pagination
let n = 0;
mockFetch({ 'GET /workspaces': (u) => { n++; return u.searchParams.get('after') ? [200, { has_more: false, data: [{ id: 2, name: 'B' }] }] : [200, { has_more: true, after: 'cur', data: [{ id: 1, name: 'A' }] }]; },
  'GET /workspaces/1/boards': page([]), 'GET /workspaces/2/boards': page([]) });
t('follows the after cursor', JSON.parse(await tools.infinity_boards.run({})).length === 2 && n === 2);

// Confirmation gate and evidence
t('writes go through the confirmation card', ['infinity_criar_item', 'infinity_editar_item', 'infinity_comentar'].every((x) => GATED_TOOLS.has(x)));
t('comment requires confirmation by text', IRREVERSIBLE_TOOLS.has('infinity_comentar') && !IRREVERSIBLE_TOOLS.has('infinity_itens'));
t('reads do not go through the confirmation card', !GATED_TOOLS.has('infinity_itens') && !GATED_TOOLS.has('infinity_boards'));
t('evidence with the item id', actionEvidenceFor('infinity_criar_item', { board_id: 'b1' }, { ok: true, id: 'novo' }).state !== 'unknown');

// Server wiring
const src = readFileSync(new URL('../web/server.mjs', import.meta.url), 'utf8');
t('connector registered in the vault', src.includes("{ provider: 'infinity', build: (secret) => infinityTools({ secret }) }"));
t('writes in the vault write list', src.includes("'infinity_criar_item', 'infinity_editar_item', 'infinity_comentar',"));
t('prompt explains the connection even with the group closed', src.includes("if (vaultEnabled() && tools.some((t) => t.name === 'abrir_ferramentas' || t.name === 'infinity_boards'))") && src.includes('app.startinfinity.com/profile/developer/tokens') && src.includes('Notion, Splitwise and Infinity/StartInfinity'));
const egress = readFileSync(new URL('../web/egress.mjs', import.meta.url), 'utf8');
t('host allowed in egress', egress.includes("'app.startinfinity.com'"));

console.log(`${ok} ok, ${fail} falharam`);
process.exit(fail ? 1 : 0);
