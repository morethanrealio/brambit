// Offline test of web/sheet-library.mjs: reading a spreadsheet by the id of an
// archived version opens the current version of the same spreadsheet.
// Run with: node --test tests/sheet-library.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { currentVersion, sheetForReading, createSheetLibrary } from '../web/sheet-library.mjs';

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
  assert.match(r.nota, /versão antiga/);
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
