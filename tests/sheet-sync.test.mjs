// Offline test of web/sheet-sync.mjs: before a read, analysis or edit, a library
// spreadsheet linked to Google Sheets takes what changed there.
// Google, the link table and the library are fakes; the spreadsheets are real .xlsx.
// Run with: node --test tests/sheet-sync.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSheetSync, sameCells } from '../web/sheet-sync.mjs';
import { openForAnalysis } from '../web/sheet-library.mjs';
import { generateDocument } from '../web/docgen.mjs';

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const xlsx = async (rows) => (await generateDocument({ format: 'xlsx', content: ['| Item | Valor |', '|---|---|', ...rows.map((r) => `| ${r[0]} | ${r[1]} |`)].join('\n') })).buffer;

async function world({ link = {}, remote = { version: 5, trashed: false }, google = null, local = null } = {}) {
  const ours = local || await xlsx([['Luz', 120]]);
  const theirs = google || ours;
  const cur = { id: 'a1', caption: 'Gastos.xlsx', mime: XLSX, s3_key: 'k/a1', created_at: '2026-11-08T10:00:00Z' };
  const s = {
    lib: [cur], files: { 'k/a1': ours }, saved: [], renamed: [], synced: [], exports: 0, versions: 0,
    link: link === null ? null : { family: 'gastos.xlsx', google_email: 'eu@x.com', file_id: 'f1', link: 'https://docs/f1', synced_version: 3, base_asset_id: 'a1', ...link },
  };
  const sync = createSheetSync({
    userId: 'u1',
    links: {
      get: async (_u, fam) => (s.link && fam === s.link.family ? s.link : null),
      synced: async (_u, fam, v) => { s.synced.push({ fam, ...v }); return true; },
    },
    tokenFor: (email) => () => `token-of-${email}`,
    listSheets: async () => [...s.lib].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))),
    fetchBytes: async (key) => ({ buffer: s.files[key] }),
    saveAsset: async ({ buffer, caption, mime, ext }) => {
      const id = `a${s.lib.length + 1}`;
      s.files[`k/${id}`] = buffer;
      s.lib.push({ id, caption, mime, s3_key: `k/${id}`, created_at: '2026-11-09T12:00:00Z' });
      s.saved.push({ id, caption, ext });
      return { assetId: id, key: `k/${id}`, url: `https://x/${id}` };
    },
    renameAsset: async (_u, id, caption) => { s.renamed.push([id, caption]); s.lib.find((a) => a.id === id).caption = caption; },
    drive: {
      sheetVersion: async (token, fileId) => {
        s.versions++; s.token = await token();
        if (remote instanceof Error) throw remote;
        assert.equal(fileId, 'f1');
        return remote;
      },
      exportSheet: async () => { s.exports++; return theirs; },
    },
  });
  return { s, sync, cur };
}

test('an unlinked spreadsheet is not touched and Google is not called', async () => {
  const { s, sync, cur } = await world({ link: null });
  assert.deepEqual(await sync.pull(cur), { asset: cur, note: '' });
  assert.equal(s.versions, 0);
});

test('same Sheets version: nothing is exported, with the token of the linked account', async () => {
  const { s, sync, cur } = await world({ remote: { version: 3, trashed: false } });
  assert.deepEqual(await sync.pull(cur), { asset: cur, note: '' });
  assert.equal(s.exports, 0);
  assert.equal(s.token, 'token-of-eu@x.com');
});

test('a version bump with the same cells creates no version, only moves the synced one', async () => {
  const { s, sync, cur } = await world({ google: await xlsx([['Luz', 120]]) });
  const r = await sync.pull(cur);
  assert.equal(r.asset.id, 'a1');
  assert.equal(s.saved.length, 0);
  assert.deepEqual(s.synced, [{ fam: 'gastos.xlsx', version: 5, baseAssetId: 'a1' }]);
});

test('cells changed in Google become the current library version', async () => {
  const { s, sync, cur } = await world({ google: await xlsx([['Luz', 120], ['Água', 80]]) });
  const r = await sync.pull(cur);
  assert.equal(r.pulled, true);
  assert.equal(r.asset.id, 'a2');
  assert.equal(r.asset.s3_key, 'k/a2');
  assert.deepEqual(s.saved, [{ id: 'a2', caption: 'Gastos.xlsx', ext: 'xlsx' }]);
  assert.deepEqual(s.renamed, [['a1', 'Gastos_20261108100000.xlsx']]);
  assert.deepEqual(s.synced, [{ fam: 'gastos.xlsx', version: 5, baseAssetId: 'a2' }]);
  assert.ok(sameCells(s.files['k/a2'], await xlsx([['Luz', 120], ['Água', 80]])));
  assert.ok(r.note.includes('id=a2'));
});

test('an archived id is synced through the current version', async () => {
  const { s, sync, cur } = await world({ google: await xlsx([['Gás', 50]]) });
  const old = { ...cur, id: 'a0', caption: 'Gastos_20261101000000.xlsx', s3_key: 'k/a0', created_at: '2026-11-01T00:00:00Z' };
  s.lib.push(old);
  const r = await sync.forReading(old, { listSheets: async () => s.lib });
  assert.equal(r.asset.id, s.saved[0].id);
  assert.deepEqual(s.renamed, [['a1', 'Gastos_20261108100000.xlsx']]);
  assert.match(r.nota, /versão antiga/);
  assert.match(r.nota, /changed in Google Sheets/);
});

test('a Google failure keeps the library copy and says it is not synced', async () => {
  const gone = Object.assign(new Error('Google 404: not found'), { status: 404 });
  for (const [remote, why] of [[new Error('Google não conectado.'), /Google error/], [gone, /no longer exists/], [{ version: 9, trashed: true }, /trash/]]) {
    const { s, sync, cur } = await world({ remote });
    const r = await sync.pull(cur);
    assert.equal(r.asset, cur);
    assert.match(r.note, /^NOT synced/);
    assert.match(r.note, why);
    assert.equal(s.saved.length + s.synced.length, 0);
  }
});

test('changed on both sides since the last sync: nothing is overwritten', async () => {
  const { s, sync, cur } = await world({ link: { base_asset_id: 'a0' }, google: await xlsx([['Gás', 50]]) });
  const r = await sync.pull(cur);
  assert.equal(r.asset, cur);
  assert.match(r.note, /changed both here and in Google Sheets/);
  assert.equal(s.exports + s.saved.length, 0);
});

test('an export that does not open is not saved', async () => {
  const { s, sync, cur } = await world({ google: Buffer.from('<html>quota</html>') });
  const r = await sync.pull(cur);
  assert.equal(r.asset, cur);
  assert.match(r.note, /did not open/);
  assert.equal(s.saved.length, 0);
});

test('analysis: a named spreadsheet is pulled before it is loaded', async () => {
  const { sync, cur } = await world({ google: await xlsx([['Gás', 50]]) });
  let loaded;
  const o = await openForAnalysis('u1', cur, { fetchBytes: async (k) => ({ buffer: Buffer.from(k) }), load: async (_u, buf, name) => { loaded = String(buf); return { ok: true, filename: name, path: '/w/' + name }; }, prepare: sync.pull });
  assert.equal(loaded, 'k/a2');
  assert.match(o.sync, /changed in Google Sheets/);
});

test('analysis: a loaded linked spreadsheet is reloaded when Google changed, others stay', async () => {
  const { sync } = await world({ google: await xlsx([['Gás', 50]]) });
  const entries = [{ filename: 'Gastos.xlsx', path: '/w/old' }, { filename: 'Outra.xlsx', path: '/w/outra' }];
  const r = await sync.refreshLoaded(entries, { fetchBytes: async (k) => ({ buffer: Buffer.from(k) }), load: async (_u, _b, name) => ({ ok: true, filename: name, path: '/w/new' }) });
  assert.deepEqual(r.sheets.map((e) => e.path), ['/w/new', '/w/outra']);
  assert.match(r.sync, /id=a2/);
});
