// Offline test of web/sheet-google.mjs: the link store and the Google Drive calls
// that keep a library spreadsheet in sync with Google Sheets.
// Run with: node --test tests/sheet-google.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSheetLinks, sheetVersion, exportSheet, createSheet, replaceSheet, shareByLink, SHEETS_MIME, XLSX_MIME } from '../web/sheet-google.mjs';

const token = async () => 'tok';
function fakeFetch(reply = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, ...init });
    const { status = 200, json = {}, bytes = Buffer.from('') } = typeof reply === 'function' ? reply(url, init) : reply;
    return { ok: status < 400, status, json: async () => json, text: async () => JSON.stringify(json), arrayBuffer: async () => bytes };
  };
  return { calls, fetchImpl };
}

test('without the table, nothing is linked and writes are no-ops', async () => {
  const pool = { query: async () => { throw Object.assign(new Error('no table'), { code: '42P01' }); } };
  const orig = console.warn; console.warn = () => {};
  try {
    const links = createSheetLinks(pool);
    assert.equal(await links.get('u1', 'gastos.xlsx'), null);
    assert.equal(await links.link('u1', { family: 'gastos.xlsx', fileId: 'f', version: 1, baseAssetId: 'a' }), false);
    assert.equal(await links.synced('u1', 'gastos.xlsx', { version: 2, baseAssetId: 'b' }), false);
  } finally { console.warn = orig; }
});

test('the link is per user and family, and a new link replaces the old one', async () => {
  const seen = [];
  const links = createSheetLinks({ query: async (sql, params) => { seen.push({ sql, params }); return { rows: [], rowCount: 1 }; } });
  await links.get('u1', 'gastos.xlsx');
  assert.match(seen[0].sql, /WHERE user_id=\$1 AND family=\$2/);
  await links.link('u1', { family: 'gastos.xlsx', googleEmail: 'a@example.com', fileId: 'f1', link: 'https://x', version: 7, baseAssetId: 'a1' });
  assert.match(seen[1].sql, /ON CONFLICT\(user_id,family\) DO UPDATE/);
  assert.deepEqual(seen[1].params, ['u1', 'gastos.xlsx', 'a@example.com', 'f1', 'https://x', 7, 'a1']);
});

test('the version check reads only version and trashed', async () => {
  const f = fakeFetch({ json: { version: '42', trashed: false } });
  assert.deepEqual(await sheetVersion(token, 'f1', f), { version: 42, trashed: false });
  assert.match(f.calls[0].url, /files\/f1\?fields=version,trashed/);
  assert.equal(f.calls[0].headers.Authorization, 'Bearer tok');
});

test('export asks for .xlsx bytes', async () => {
  const f = fakeFetch({ bytes: Buffer.from('PK') });
  assert.equal((await exportSheet(token, 'f1', f)).toString(), 'PK');
  assert.ok(f.calls[0].url.includes(`/f1/export?mimeType=${encodeURIComponent(XLSX_MIME)}`));
});

test('create converts the .xlsx into a native Sheets file in the folder', async () => {
  const f = fakeFetch({ json: { id: 'f9', webViewLink: 'https://docs.google.com/x', version: '3' } });
  const r = await createSheet(token, { name: 'Gastos', buffer: Buffer.from('XLSXBYTES'), folderId: 'dir' }, f);
  assert.equal(r.id, 'f9');
  const body = f.calls[0].body.toString();
  assert.ok(body.includes(`"mimeType":"${SHEETS_MIME}"`) && body.includes('"parents":["dir"]'));
  assert.ok(body.includes(`Content-Type: ${XLSX_MIME}`) && body.includes('XLSXBYTES'));
  assert.equal(f.calls[0].method, 'POST');
});

test('replace rewrites the same file; share opens it to anyone with the link', async () => {
  const f = fakeFetch({ json: { id: 'f9', version: '8' } });
  await replaceSheet(token, 'f9', Buffer.from('X'), f);
  assert.equal(f.calls[0].method, 'PATCH');
  assert.match(f.calls[0].url, /upload\/drive\/v3\/files\/f9\?uploadType=media/);
  await shareByLink(token, 'f9', 'writer', f);
  assert.deepEqual(JSON.parse(f.calls[1].body), { type: 'anyone', role: 'writer', allowFileDiscovery: false });
  await assert.rejects(shareByLink(token, 'f9', 'owner', f));
});

test('a Google error keeps its status', async () => {
  const f = fakeFetch({ status: 404, json: { error: 'not found' } });
  await assert.rejects(sheetVersion(token, 'gone', f), (e) => e.status === 404);
});
