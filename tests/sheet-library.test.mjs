// Offline test of web/sheet-library.mjs: reading a spreadsheet by the id of an
// archived version opens the current version of the same spreadsheet.
// Run with: node --test tests/sheet-library.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { currentVersion, sheetForReading, createSheetLibrary, currentLoaded, autoLoadSheet, openVersionForAnalysis, openIdForAnalysis, editTarget } from '../web/sheet-library.mjs';
import { findByName } from '../web/media-list.mjs';

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const a = (id, caption, created_at, mime = XLSX) => ({ id, caption, created_at, mime, s3_key: `k/${id}` });

// Library as listSheets returns it (newest first): two edits of "Gastos" and an
// unrelated, newer spreadsheet.
const v1 = a('11111111-1111-4111-8111-111111111111', 'Gastos_20261028152439.xlsx', '2026-10-28T15:24:39Z');
const v2 = a('22222222-2222-4222-8222-222222222222', 'Gastos_20261105100000.xlsx', '2026-11-05T10:00:00Z');
const v3 = a('33333333-3333-4333-8333-333333333333', 'Gastos.xlsx', '2026-11-07T12:00:00Z');
const todo = a('44444444-4444-4444-8444-444444444444', 'To-Do.xlsx', '2026-11-08T09:00:00Z');
const lib = [todo, v3, v2, v1];

test('an archived id resolves to the current version of its family', () => {
  assert.equal(currentVersion(v1, lib).id, v3.id);
  assert.equal(currentVersion(v2, [...lib].reverse()).id, v3.id);
});

test('the current version and other spreadsheets stay as they are', () => {
  assert.equal(currentVersion(v3, lib).id, v3.id);
  assert.equal(currentVersion(todo, lib).id, todo.id);
});

test('a document that is not a spreadsheet is never swapped', () => {
  const pdf = a('55555555-5555-4555-8555-555555555555', 'Gastos.pdf', '2026-10-01T00:00:00Z', 'application/pdf');
  assert.equal(currentVersion(pdf, lib).id, pdf.id);
});

test('sheetForReading opens the current version and tells the model the new id', async () => {
  const r = await sheetForReading('u1', v1, { listSheets: async () => lib, timeZone: 'America/Sao_Paulo' });
  assert.equal(r.asset.id, v3.id);
  assert.match(r.nota, /is an older version/);
  assert.ok(r.nota.includes(v3.id));
});

test('sheetForReading keeps the asset when it is current or the listing fails', async () => {
  assert.deepEqual(await sheetForReading('u1', v3, { listSheets: async () => lib }), { asset: v3, nota: '' });
  const failing = { listSheets: async () => { throw new Error('db down'); } };
  const orig = console.error; console.error = () => {};
  try { assert.deepEqual(await sheetForReading('u1', v1, failing), { asset: v1, nota: '' }); }
  finally { console.error = orig; }
});

test('listSheets asks only for this user\'s spreadsheets, newest first, capped', async () => {
  let sql, params;
  const lib2 = createSheetLibrary({ query: async (s, p) => { sql = s; params = p; return { rows: [v3] }; } });
  assert.deepEqual(await lib2.listSheets('u1', { limit: 10_000 }), [v3]);
  assert.match(sql, /WHERE user_id = \$1/);
  assert.match(sql, /ORDER BY created_at DESC/);
  assert.equal(params[0], 'u1');
  assert.equal(params[3], 500);
});

test('the analyst gets one loaded copy per spreadsheet, the current one', () => {
  const old = { filename: 'Gastos_20261028152439.xlsx', path: '/w/old', ts: 2 };
  const cur = { filename: 'Gastos.xlsx', path: '/w/cur', ts: 1 };
  const drive = { filename: 'Pendencias.xlsx', path: '/w/drive', ts: 3 };
  assert.deepEqual(currentLoaded([old, cur, drive]).map((e) => e.path).sort(), ['/w/cur', '/w/drive']);
  assert.deepEqual(currentLoaded([cur, old]).map((e) => e.path), ['/w/cur']);
});

test('with nothing loaded, the only spreadsheet opens; several become a question', async () => {
  let opened;
  const deps = { fetchBytes: async () => ({ buffer: Buffer.from('x') }), load: async (_u, _b, name) => { opened = name; return { ok: true, filename: name, path: '/w/' + name }; } };
  const one = await autoLoadSheet('u1', { ...deps, listSheets: async () => [v3, v2, v1] });
  assert.equal(opened, v3.caption);
  assert.equal(one.sheet.filename, v3.caption);
  const many = await autoLoadSheet('u1', { ...deps, listSheets: async () => lib });
  assert.equal(many.sheet, undefined);
  assert.ok(many.note.includes('"To-Do.xlsx"') && many.note.includes('"Gastos.xlsx"') && !many.note.includes('Gastos_2026'));
  assert.deepEqual(await autoLoadSheet('u1', { ...deps, listSheets: async () => [] }), {});
});

test('a file sent from outside with the same name is its own spreadsheet until edited here', async () => {
  const up = (id, caption, created_at) => ({ ...a(id, caption, created_at), source: 'upload' });
  const marco = up('66666666-6666-4666-8666-666666666666', 'fatura.xlsx', '2026-03-05T10:00:00Z');
  const outubro = up('77777777-7777-4777-8777-777777777777', 'fatura.xlsx', '2026-10-05T10:00:00Z');
  const sheets = [outubro, marco];
  // Opening March's opens March's.
  assert.equal(currentVersion(marco, sheets).id, marco.id);
  assert.deepEqual(await sheetForReading('u1', marco, { listSheets: async () => sheets }), { asset: marco, nota: '' });
  // An edited upload is archived with a stamp: from then on it is a version of the generated one.
  const archived = { ...marco, caption: 'fatura_20260305100000.xlsx' };
  const edited = { ...a('88888888-8888-4888-8888-888888888888', 'fatura.xlsx', '2026-03-06T10:00:00Z'), source: 'generated' };
  assert.equal(currentVersion(archived, [outubro, edited, archived]).id, edited.id);
  assert.equal(currentVersion(outubro, [outubro, edited, archived]).id, outubro.id);
  // With nothing loaded, the two are two choices, not one spreadsheet.
  const many = await autoLoadSheet('u1', { listSheets: async () => sheets, fetchBytes: async () => ({ buffer: Buffer.from('PK') }), load: async () => ({ ok: true }) });
  assert.match(many.note, /library has 2/);
});

test('versao_id analyzes exactly an older version, without syncing or keeping it loaded', async () => {
  const calls = [];
  const deps = {
    getAsset: async (_u, id) => lib.find((x) => x.id === id) || null,
    listSheets: async () => lib,
    fetchBytes: async (key) => ({ buffer: Buffer.from(key) }),
    load: async (_u, _b, name, opts) => { calls.push({ name, register: opts.register }); return { ok: true, filename: name }; },
    prepare: async (asset) => { calls.push({ prepare: asset.id }); return { asset, note: '' }; },
    timeZone: 'America/Sao_Paulo',
  };
  const old = await openVersionForAnalysis('u1', v1.id, deps);
  assert.equal(old.sheet.filename, v1.caption);
  assert.deepEqual(calls, [{ name: v1.caption, register: false }]);
  assert.ok(old.sync.includes('OLDER version') && old.sync.includes(v3.id));
  // The current version's id opens it like a name does: synced and kept loaded.
  calls.length = 0;
  const cur = await openVersionForAnalysis('u1', v3.id, deps);
  assert.equal(cur.sheet.filename, v3.caption);
  assert.deepEqual(calls, [{ prepare: v3.id }, { name: v3.caption, register: undefined }]);
  assert.match((await openVersionForAnalysis('u1', 'nope', deps)).note, /not in the user's library/);
});

test('arquivo_id analyzes the current version of that spreadsheet, synced and kept loaded', async () => {
  const csv = a('55555555-5555-4555-8555-555555555555', 'extrato.csv', '2026-11-08T10:00:00Z', 'text/csv');
  const all = [...lib, csv];
  const calls = [];
  const deps = {
    getAsset: async (_u, id) => all.find((x) => x.id === id) || null,
    listSheets: async () => lib,
    fetchBytes: async (key) => ({ buffer: Buffer.from(key) }),
    load: async (_u, _b, name, opts) => { calls.push({ name, register: opts.register }); return { ok: true, filename: name }; },
    prepare: async (asset) => { calls.push({ prepare: asset.id }); return { asset, note: '' }; },
  };
  const o = await openIdForAnalysis('u1', v1.id, deps);
  assert.equal(o.sheet.filename, v3.caption);
  assert.deepEqual(calls, [{ prepare: v3.id }, { name: v3.caption, register: undefined }]);
  assert.equal((await openIdForAnalysis('u1', csv.id, deps)).sheet.filename, 'extrato.csv');
  assert.match((await openIdForAnalysis('u1', 'nope', deps)).note, /not in the user's library/);
});

test('an uploaded .xlsx that is not a zip stays out of a choice, but opens when it is the only one', async () => {
  const gastos = { ...a('88888888-8888-4888-8888-888888888888', 'Controle de Gastos.xlsx', '2026-11-07T15:32:00Z'), source: 'generated' };
  const fatura = { ...a('99999999-9999-4999-8999-999999999999', 'Controle de Gastos fatura.xlsx', '2026-11-07T15:08:00Z'), source: 'upload' };
  const fetched = [];
  const fetchBytes = async (s3) => { fetched.push(s3); return { buffer: Buffer.from(s3 === fatura.s3_key ? 'not a zip' : 'PK\x03\x04') }; };
  let opened = null;
  const load = async (_u, _b, name) => { opened = name; return { ok: true, filename: name }; };
  const r = await autoLoadSheet('u1', { listSheets: async () => [gastos, fatura], fetchBytes, load });
  assert.equal(r.sheet.filename, gastos.caption);
  assert.deepEqual(fetched.filter((k) => k === gastos.s3_key).length, 1, 'a generated one is not checked, only opened');
  const byName = await findByName('u1', 'controle de gastos', { searchMedia: async () => [gastos, fatura], listSheets: async () => [gastos, fatura], fetchBytes });
  assert.equal(byName.asset.id, gastos.id);
  const alone = await autoLoadSheet('u1', { listSheets: async () => [fatura], fetchBytes, load });
  assert.equal(alone.sheet.filename, fatura.caption);
  assert.equal(opened, fatura.caption);
});

test('editing with neither id nor name: the loaded spreadsheet, never just the newest one', async () => {
  const saved = [];
  const deps = (loaded, files = {}) => ({
    loaded, listSheets: async () => lib, fetchBytes: async () => null,
    readBytes: async (_u, path) => (files[path] ? { ok: true, buffer: files[path] } : { ok: false, error: 'missing' }),
    saveAsset: async (x) => { saved.push(x); return { assetId: 'novo-id', key: 'k/novo' }; },
  });
  const zip = Buffer.from('PK\x03\x04 resto');

  // Loaded from the library: edits that one, not To-Do (the newest).
  let r = await editTarget('u1', deps([{ path: '/w/Gastos.xlsx', filename: 'Gastos.xlsx', assetId: v3.id, ts: 1 }]));
  assert.equal(r.asset.id, v3.id);

  // Opened by link: saved in the library under its own name first, then edited.
  r = await editTarget('u1', deps([{ path: '/w/Ano_Novo.xlsx', filename: 'Ano_Novo.xlsx', name: 'Ano Novo.xlsx', ts: 1 }], { '/w/Ano_Novo.xlsx': zip }));
  assert.equal(r.asset.id, 'novo-id');
  assert.equal(saved.length, 1);
  assert.equal(saved[0].caption, 'Ano Novo.xlsx');
  assert.equal(saved[0].ext, 'xlsx');
  assert.ok(saved[0].buffer.equals(zip));
  assert.match(r.note, /NOT changed/);

  // Not editable or not readable: a reply, nothing saved.
  for (const [loaded, files] of [
    [[{ path: '/w/c.csv', filename: 'c.csv', ts: 1 }], {}],
    [[{ path: '/w/x.xlsx', filename: 'x.xlsx', ts: 1 }], { '/w/x.xlsx': Buffer.from('not a zip') }],
    [[{ path: '/w/y.xlsx', filename: 'y.xlsx', ts: 1 }], {}],
  ]) {
    r = await editTarget('u1', deps(loaded, files));
    assert.ok(r.reply && !r.asset);
  }
  assert.equal(saved.length, 1);

  // Two loaded: asks which, citing both.
  r = await editTarget('u1', deps([{ path: '/w/Gastos.xlsx', filename: 'Gastos.xlsx', assetId: v3.id, ts: 1 }, { path: '/w/To-Do.xlsx', filename: 'To-Do.xlsx', assetId: todo.id, ts: 2 }]));
  assert.ok(!r.asset);
  assert.match(r.reply, /"Gastos\.xlsx"/);
  assert.match(r.reply, /"To-Do\.xlsx"/);

  // Nothing loaded: two spreadsheets in the library ask; a single one is edited (current version).
  r = await editTarget('u1', deps([]));
  assert.ok(!r.asset);
  assert.match(r.reply, /has 2/);
  r = await editTarget('u1', { ...deps([]), listSheets: async () => [v3, v2, v1] });
  assert.equal(r.asset.id, v3.id);
});

test('editing by the name of a spreadsheet opened by link saves it in the library first', async () => {
  const saved = [];
  const zip = Buffer.from('PK\x03\x04 resto');
  const notFound = { notFound: true, reply: 'No file of this kind' };
  const deps = (byName) => ({
    byName, listSheets: async () => lib, fetchBytes: async () => null,
    loaded: [{ path: '/w/calendar-1900.xlsx', filename: 'calendar-1900.xlsx', name: 'calendar-1900.xlsx', ts: 1 }, { path: '/w/Gastos.xlsx', filename: 'Gastos.xlsx', assetId: v3.id, ts: 2 }],
    readBytes: async () => ({ ok: true, buffer: zip }),
    saveAsset: async (x) => { saved.push(x); return { assetId: 'novo-id' }; },
  });
  // In the library: the library answer, nothing saved.
  let r = await editTarget('u1', { nome: 'Gastos', ...deps(async () => ({ asset: v3 })) });
  assert.equal(r.asset.id, v3.id);
  // Not in the library, but loaded from a link: saved, then edited.
  r = await editTarget('u1', { nome: 'calendar-1900', ...deps(async () => notFound) });
  assert.equal(r.asset.id, 'novo-id');
  assert.equal(saved[0].caption, 'calendar-1900.xlsx');
  // Nowhere: the not-found answer.
  r = await editTarget('u1', { nome: 'Orçamento', ...deps(async () => notFound) });
  assert.equal(r, notFound);
  assert.equal(saved.length, 1);
});
