// Offline test of web/media-list.mjs: listar_midia shows a spreadsheet once, as
// its current version, and lists its versions on request.
// Run with: node --test tests/media-list.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { formatMediaList, formatVersions, mediaListTool, createMediaSearch, findByName, isDocumentAsset } from '../web/media-list.mjs';
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
  assert.match(gastos[0], /3 versões guardadas/);
  assert.doesNotMatch(out.find((l) => l.includes('To-Do')), /versões/);
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
  assert.ok(lines[1].includes(v3.id) && lines[1].includes('VERSÃO ATUAL'));
  assert.deepEqual(lines.slice(2).map((l) => l.slice(5, 41)), [v2.id, v1.id]);
  const tool = mediaListTool({ userId: 'u1', timeZone: 'UTC', getMediaAsset: async () => foto, listSheets: async () => sheets });
  assert.match(await tool.run({ versoes_de: foto.id }), /não é uma planilha/);
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
