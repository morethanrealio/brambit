// Offline test of web/media-list.mjs: listar_midia shows a spreadsheet once, as
// its current version, and lists its versions on request.
// Run with: node --test tests/media-list.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { formatMediaList, formatVersions, mediaListTool, createMediaSearch, findByName, isDocumentAsset, onlyDocument, idNotFound } from '../web/media-list.mjs';
import { isSheetAsset } from '../web/sheet-edit.mjs';

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const a = (id, caption, created_at, mime = XLSX, kind = 'document') => ({ id, caption, created_at, mime, kind, source: 'generated', s3_key: `k/${id}` });

const v1 = a('11111111-1111-4111-8111-111111111111', 'Gastos_20261028152439.xlsx', '2026-10-28T15:24:39Z');
const v2 = a('22222222-2222-4222-8222-222222222222', 'Gastos_20261105100000.xlsx', '2026-11-05T10:00:00Z');
const v3 = a('33333333-3333-4333-8333-333333333333', 'Gastos.xlsx', '2026-11-07T12:00:00Z');
const todo = a('44444444-4444-4444-8444-444444444444', 'To-Do.xlsx', '2026-11-08T09:00:00Z');
const foto = a('55555555-5555-4555-8555-555555555555', 'foto de um tênis', '2026-11-09T09:00:00Z', 'image/jpeg', 'image');
const rows = [foto, todo, v3, v2, v1];
const sheets = [todo, v3, v2, v1];

test('a spreadsheet shows once, with its current id and how many versions are kept', () => {
  const out = formatMediaList(rows, { sheets, timeZone: 'UTC' });
  assert.equal(out.length, 3);
  const gastos = out.filter((l) => l.includes('Gastos'));
  assert.equal(gastos.length, 1);
  assert.ok(gastos[0].startsWith(`- id=${v3.id}`));
  assert.match(gastos[0], /3 kept versions/);
  assert.doesNotMatch(out.find((l) => l.includes('To-Do')), /versions/);
});

test('an archived version alone in the rows is shown as the current one', () => {
  const [l] = formatMediaList([v1], { sheets, timeZone: 'UTC' });
  assert.ok(l.startsWith(`- id=${v3.id}`));
});

test('the limit counts items, not the archived rows skipped', () => {
  assert.equal(formatMediaList(rows, { sheets, timeZone: 'UTC', limit: 2 }).length, 2);
  assert.ok(formatMediaList(rows, { sheets, timeZone: 'UTC', limit: 3 }).some((l) => l.includes(v3.id)));
});

test('versoes_de lists the versions newest first, the current one marked', async () => {
  const lines = formatVersions(v1, sheets, { timeZone: 'UTC' }).split('\n');
  assert.ok(lines[1].includes(v3.id) && lines[1].includes('CURRENT VERSION'));
  assert.deepEqual(lines.slice(2).map((l) => l.slice(5, 41)), [v2.id, v1.id]);
  const tool = mediaListTool({ userId: 'u1', timeZone: 'UTC', getMediaAsset: async () => foto, listSheets: async () => sheets });
  assert.match(await tool.run({ versoes_de: foto.id }), /is not an .xlsx spreadsheet/);
});

test('busca matches without accents or wildcards from the term', async () => {
  let params;
  const { searchMedia } = createMediaSearch({ query: async (_s, p) => { params = p; return { rows: [] }; } });
  await searchMedia('u1', ' Orçamento 100%_ ');
  assert.equal(params[0], 'u1');
  assert.equal(params[3], '%orcamento 100\\%\\_%');
  assert.equal(params[1].length, params[2].length);
});

const viagem = a('66666666-6666-4666-8666-666666666666', 'Gastos Viagem.xlsx', '2026-11-01T09:00:00Z');
const contrato = a('77777777-7777-4777-8777-777777777777', 'Contrato de Gastos.pdf', '2026-11-02T09:00:00Z', 'application/pdf');
const byName = (nome, hits, accept) => findByName('u1', nome, { searchMedia: async () => hits, listSheets: async () => [...sheets, viagem], accept });

test('a name opens the current version of the one spreadsheet it matches', async () => {
  assert.equal((await byName('gastos', [v2, v1], isSheetAsset)).asset.id, v3.id);
});

test('a name that matches two files is a question with their names, not a guess', async () => {
  const r = await byName('gast', [v3, viagem, contrato, v1], isDocumentAsset);
  assert.equal(r.asset, undefined);
  for (const c of ['"Gastos.xlsx"', '"Gastos Viagem.xlsx"', '"Contrato de Gastos.pdf"']) assert.equal(r.reply.split(c).length, 2);
});

test('the exact name wins over names that only contain it; no match says so', async () => {
  assert.equal((await byName('Gastos.xlsx', [v3, viagem], isSheetAsset)).asset.id, v3.id);
  assert.equal((await byName('gastos', [foto], isDocumentAsset)).notFound, true);
});

test('two files sent with the same name are two lines, and asking by name is a question', async () => {
  const up = (id, created_at) => ({ ...a(id, 'fatura.xlsx', created_at), source: 'upload' });
  const marco = up('66666666-6666-4666-8666-666666666666', '2026-03-05T10:00:00Z');
  const outubro = up('77777777-7777-4777-8777-777777777777', '2026-10-05T10:00:00Z');
  const out = formatMediaList([outubro, marco], { sheets: [outubro, marco], timeZone: 'UTC' });
  assert.equal(out.length, 2);
  assert.ok(out.every((l) => !/kept versions/.test(l)));
  const r = await findByName('u1', 'fatura', { searchMedia: async () => [outubro, marco], listSheets: async () => [outubro, marco] });
  assert.equal(r.asset, undefined);
  assert.match(r.reply, /Found 2 files/);
});

test('without id and nome, only a library with a single document opens it', async () => {
  const lister = (list) => ({ listMediaAssets: async () => list });
  // Versions of one spreadsheet and a photo: one document, its current version.
  assert.equal((await onlyDocument('u1', lister([foto, v3, v2, v1]))).asset.id, v3.id);
  // Two spreadsheets: nothing opens, the newest names come back to choose from.
  const many = await onlyDocument('u1', lister(rows));
  assert.equal(many.asset, undefined);
  assert.ok(many.reply.includes(todo.id) && many.reply.includes(v3.id) && !many.reply.includes(v1.id));
  assert.match((await onlyDocument('u1', lister([foto]))).reply, /no document/);
});

test('an id copied wrong lists the files that start or end the same way, opening none', async () => {
  const X = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  const atual = { id: 'fd7ff88c-a6f6-4a09-b791-b8622f8da0c4', kind: 'document', mime: X, caption: 'Controle de Gastos.xlsx', created_at: '2026-11-07T12:00:00Z', source: 'generated' };
  const velha = { id: '8e6b2750-a585-4772-9960-092ea4173116', kind: 'document', mime: X, caption: 'Controle de Gastos_20261028152439.xlsx', created_at: '2026-10-28T15:24:39Z', source: 'generated' };
  const pdf = { id: '13fbdee7-8455-4fea-b9ed-e07c5a579787', kind: 'document', mime: 'application/pdf', caption: 'Contrato.pdf', created_at: '2026-10-19T10:00:00Z', source: 'upload' };
  const deps = { listMediaAssets: async () => [atual, velha, pdf], listSheets: async () => [atual, velha], timeZone: 'America/Sao_Paulo' };
  const btg = await idNotFound('u1', 'fd7ff88c-a585-4772-9960-092ea4173116', deps);
  assert.ok(btg.startsWith('ERROR') && btg.includes('Nothing was opened'));
  assert.ok(btg.includes(`id=${atual.id}`) && btg.includes('current version'));
  assert.ok(btg.includes(`id=${velha.id}`) && btg.includes(`older version; the current one is id=${atual.id}`));
  assert.ok(!btg.includes(pdf.id));
  const contrato = await idNotFound('u1', '13ab7c1e-8455-4fea-b9ed-e07c5a579787', deps);
  assert.ok(contrato.includes(`id=${pdf.id}`) && !contrato.includes(atual.id));
  const nada = await idNotFound('u1', '4af9a12b-62bd-4b0c-9c0c-8da6f4b6ba1e', deps);
  assert.ok(nada.includes('listar_midia') && !nada.includes('id='));
  assert.ok((await idNotFound('u1', 'abc', { ...deps, listMediaAssets: async () => { throw new Error('not called'); } })).includes('listar_midia'));
});
