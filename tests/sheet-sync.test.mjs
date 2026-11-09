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

async function world({ link = {}, remote = { version: 5, trashed: false }, google = null, local = null, merge, replace } = {}) {
  const ours = local || await xlsx([['Luz', 120]]);
  const theirs = google || ours;
  const cur = { id: 'a1', caption: 'Gastos.xlsx', mime: XLSX, s3_key: 'k/a1', created_at: '2026-11-08T10:00:00Z' };
  const s = {
    lib: [cur], files: { 'k/a1': ours }, saved: [], renamed: [], synced: [], pushed: [], merges: [], exports: 0, versions: 0,
    link: link === null ? null : { family: 'gastos.xlsx', google_email: 'eu@x.com', file_id: 'f1', link: 'https://docs/f1', synced_version: 3, base_asset_id: 'a1', ...link },
  };
  const sync = createSheetSync({
    userId: 'u1',
    links: {
      get: async (_u, fam, ids = []) => (s.link && (fam === s.link.family || ids.includes(s.link.base_asset_id)) ? s.link : null),
      synced: async (_u, fam, v) => { s.synced.push({ fam, ...v }); return true; },
    },
    tokenFor: (email) => () => `token-of-${email}`,
    listSheets: async () => [...s.lib].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))),
    getAsset: async (_u, id) => s.lib.find((a) => a.id === id) || null,
    fetchBytes: async (key) => ({ buffer: s.files[key] }),
    merge: merge && (async (b) => { s.merges.push(b); return merge(b); }),
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
      replaceSheet: replace || (async (_t, fileId, buffer) => { s.pushed.push({ fileId, buffer }); return { id: fileId, version: 8 }; }),
    },
  });
  return { s, sync, cur };
}

test('an unlinked spreadsheet is not touched and Google is not called', async () => {
  const { s, sync, cur } = await world({ link: null });
  assert.deepEqual(await sync.sync(cur), { asset: cur, note: '' });
  assert.equal(s.versions, 0);
});

test('same Sheets version: nothing is exported, with the token of the linked account', async () => {
  const { s, sync, cur } = await world({ remote: { version: 3, trashed: false } });
  assert.deepEqual(await sync.sync(cur), { asset: cur, note: '' });
  assert.equal(s.exports, 0);
  assert.equal(s.token, 'token-of-eu@x.com');
});

test('a version bump with the same cells creates no version, only moves the synced one', async () => {
  const { s, sync, cur } = await world({ google: await xlsx([['Luz', 120]]) });
  const r = await sync.sync(cur);
  assert.equal(r.asset.id, 'a1');
  assert.equal(s.saved.length, 0);
  assert.deepEqual(s.synced, [{ fam: 'gastos.xlsx', version: 5, baseAssetId: 'a1' }]);
});

test('cells changed in Google become the current library version', async () => {
  const { s, sync, cur } = await world({ google: await xlsx([['Luz', 120], ['Água', 80]]) });
  const r = await sync.sync(cur);
  assert.equal(r.newVersion, true);
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
  assert.match(r.nota, /is an older version/);
  assert.match(r.nota, /changed in Google Sheets/);
});

test('an .xlsm spreadsheet with macros is never synced, even when linked', async () => {
  const { s, sync, cur } = await world();
  cur.caption = 'Gastos.xlsm';
  const r = await sync.sync(cur);
  assert.match(r.note, /NOT synced.*\.xlsm spreadsheet with macros/);
  assert.deepEqual([s.versions, s.exports, s.pushed.length, s.synced.length], [0, 0, 0, 0]);
});

test('a Google failure keeps the library copy and says it is not synced', async () => {
  const gone = Object.assign(new Error('Google 404: not found'), { status: 404 });
  for (const [remote, why] of [[new Error('Google não conectado.'), /Google error/], [gone, /no longer exists/], [{ version: 9, trashed: true }, /trash/]]) {
    const { s, sync, cur } = await world({ remote });
    const r = await sync.sync(cur);
    assert.equal(r.asset, cur);
    assert.match(r.note, /^NOT synced/);
    assert.match(r.note, why);
    assert.equal(s.saved.length + s.synced.length, 0);
  }
});

test('changed only here: the library version goes to the same Sheets file', async () => {
  const { s, sync, cur } = await world({ link: { base_asset_id: 'a0' }, remote: { version: 3, trashed: false } });
  const r = await sync.sync(cur);
  assert.equal(r.asset, cur);
  assert.equal(s.exports, 0);
  assert.equal(s.pushed.length, 1);
  assert.equal(s.pushed[0].fileId, 'f1');
  assert.equal(s.pushed[0].buffer, s.files['k/a1']);
  assert.deepEqual(s.synced, [{ fam: 'gastos.xlsx', version: 8, baseAssetId: 'a1' }]);
  assert.match(r.note, /sent to Google Sheets/);
});

async function bothChanged(opts = {}) {
  const w = await world({ link: { base_asset_id: 'a0' }, google: await xlsx([['Luz', 120], ['Gás', 50]]), local: await xlsx([['Luz', 130]]), ...opts });
  w.s.lib.push({ id: 'a0', caption: 'Gastos_20261101000000.xlsx', mime: XLSX, s3_key: 'k/a0', created_at: '2026-11-01T00:00:00Z' });
  w.s.files['k/a0'] = await xlsx([['Luz', 120]]);
  return w;
}

test('changed on both sides: merged from the last synced version, saved, then sent', async () => {
  const mergedBytes = await xlsx([['Luz', 130], ['Gás', 50]]);
  const { s, sync, cur } = await bothChanged({ merge: async () => ({ ok: true, buffer: mergedBytes, cells: 0, rows: 1, sheets: 0, conflicts: [], kept: [] }) });
  const r = await sync.sync(cur);
  assert.equal(s.merges.length, 1);
  assert.ok(sameCells(s.merges[0].base, s.files['k/a0']) && s.merges[0].ours === s.files['k/a1']);
  assert.equal(r.newVersion, true);
  assert.equal(s.saved.length, 1);
  assert.equal(s.pushed[0].buffer, mergedBytes);
  assert.deepEqual(s.synced, [{ fam: 'gastos.xlsx', version: 8, baseAssetId: r.asset.id }]);
  assert.match(r.note, /merged with what changed in Google Sheets/);
});

test('changed on both sides without a way to merge: nothing is overwritten on either side', async () => {
  for (const opts of [{}, { merge: async () => ({ ok: false, error: 'boom' }) }]) {
    const { s, sync, cur } = await bothChanged(opts);
    const r = await sync.sync(cur);
    assert.equal(r.asset, cur);
    assert.match(r.note, /^NOT synced/);
    assert.equal(s.saved.length + s.pushed.length + s.synced.length, 0);
  }
});

test('changed on both sides with the common version gone: Google Sheets wins and the version from here is kept', async () => {
  const { s, sync, cur } = await bothChanged({ merge: async () => assert.fail('no merge without base') });
  s.lib = s.lib.filter((a) => a.id !== 'a0');
  const r = await sync.sync(cur);
  assert.notEqual(r.asset.id, cur.id);
  assert.equal(r.newVersion, true);
  assert.equal(s.pushed.length, 0);
  assert.deepEqual(s.synced, [{ fam: 'gastos.xlsx', version: 5, baseAssetId: r.asset.id }]);
  assert.equal(s.renamed[0][0], cur.id, 'the version from here is archived, not deleted');
  assert.ok(r.note.includes(r.asset.id) && r.note.includes(cur.id));
  // A second read finds both sides equal and does nothing more.
  assert.equal((await sync.sync(r.asset)).note, '');
});

test('a Sheets bump with no cell change while the library changed: just sent, no merge', async () => {
  const { s, sync, cur } = await bothChanged({ google: await xlsx([['Luz', 120]]), merge: async () => assert.fail('no merge needed') });
  const r = await sync.sync(cur);
  assert.equal(r.asset, cur);
  assert.equal(s.pushed[0].buffer, s.files['k/a1']);
});

test('a failed upload says the two may differ and records no sync', async () => {
  const { s, sync, cur } = await world({ link: { base_asset_id: 'a0' }, remote: { version: 3, trashed: false }, replace: async () => { throw new Error('Google 403: forbidden'); } });
  const r = await sync.sync(cur);
  assert.match(r.note, /^NOT synced.*403/);
  assert.equal(s.synced.length, 0);
});

test('an export that does not open is not saved', async () => {
  const { s, sync, cur } = await world({ google: Buffer.from('<html>quota</html>') });
  const r = await sync.sync(cur);
  assert.equal(r.asset, cur);
  assert.match(r.note, /could not bring it from Google/);
  assert.equal(s.saved.length, 0);
});

test('analysis: a named spreadsheet is pulled before it is loaded', async () => {
  const { sync, cur } = await world({ google: await xlsx([['Gás', 50]]) });
  let loaded;
  const o = await openForAnalysis('u1', cur, { fetchBytes: async (k) => ({ buffer: Buffer.from(k) }), load: async (_u, buf, name) => { loaded = String(buf); return { ok: true, filename: name, path: '/w/' + name }; }, prepare: sync.sync });
  assert.equal(loaded, 'k/a2');
  assert.match(o.sync, /changed in Google Sheets/);
});

test('analysis: a loaded linked spreadsheet is reloaded when Google changed, others stay', async () => {
  const { s, sync, cur } = await world({ google: await xlsx([['Gás', 50]]) });
  // The sandbox name has spaces and accents replaced; the copy is known by its library file.
  cur.caption = 'Controle Financeiro - Março.xlsx';
  s.link.family = 'controle financeiro - março.xlsx';
  const entries = [{ filename: 'Controle_Financeiro_-_Mar_o.xlsx', path: '/w/old', assetId: 'a1' }, { filename: 'Outra.xlsx', path: '/w/outra' }];
  const r = await sync.refreshLoaded(entries, { fetchBytes: async (k) => ({ buffer: Buffer.from(k) }), load: async (_u, _b, name) => ({ ok: true, filename: name, path: '/w/new' }) });
  assert.deepEqual(r.sheets.map((e) => e.path), ['/w/new', '/w/outra']);
  assert.match(r.sync, /id=a2/);
});

test('a renamed spreadsheet keeps syncing, and the sync is recorded under the link it found', async () => {
  const { s, sync, cur } = await world({ google: await xlsx([['Luz', 120]]) });
  cur.caption = 'Despesas.xlsx';
  const r = await sync.sync(cur);
  assert.equal(r.asset.id, 'a1');
  assert.deepEqual(s.synced, [{ fam: 'gastos.xlsx', version: 5, baseAssetId: 'a1' }]);
});
