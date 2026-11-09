// Offline test of web/drive-copy.mjs (enviar_para_drive): a library spreadsheet
// becomes a Google Sheets file linked to it, and the link opens only when asked.
// Run with: node --test tests/drive-copy.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { driveCopyTool } from '../web/drive-copy.mjs';

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const old = { id: 'a1', caption: 'Cardapio_20261105184400.xlsx', mime: XLSX, s3_key: 'k1', created_at: '2026-11-05T18:44:00Z' };
const cur = { id: 'a2', caption: 'Cardapio.xlsx', mime: XLSX, s3_key: 'k2', created_at: '2026-11-06T10:00:00Z' };
const pdf = { id: 'p1', caption: 'Contrato.pdf', mime: 'application/pdf', s3_key: 'kp', created_at: '2026-11-07T10:00:00Z' };

function setup({ available = true, linked = null, shareFails = false } = {}) {
  const calls = { create: [], link: [], share: [], upload: [] };
  const assets = new Map([[old.id, old], [cur.id, cur], [pdf.id, pdf]]);
  const tool = driveCopyTool({
    userId: 'u1', folderName: 'Assistente', token: async () => 'tok',
    getMediaAsset: async (_u, id) => assets.get(id) || null,
    listMediaAssets: async () => [pdf],
    listSheets: async () => [cur, old],
    fetchMedia: async (key) => ({ buffer: Buffer.from(`bytes-${key}`) }),
    ensureFolder: async () => 'dir',
    upload: async (a) => { calls.upload.push(a); return { id: 'd1', name: a.name, webViewLink: 'https://drive/d1' }; },
    googleEmail: 'g@example.com',
    links: {
      available: async () => available,
      get: async () => linked,
      link: async (_u, l) => { calls.link.push(l); return true; },
    },
    createSheet: async (_t, a) => { calls.create.push(a); return { id: 's1', webViewLink: 'https://docs/s1', version: '5' }; },
    sheetVersion: async () => ({ version: 9, trashed: false }),
    shareByLink: async (_t, id, role) => { calls.share.push({ id, role }); if (shareFails) throw new Error('Google 403: sharing restricted'); },
  });
  return { tool, calls };
}

test('only a spreadsheet becomes Google Sheets, and only where links are stored', async () => {
  assert.match((await setup().tool.normalizeConfirmationArgs({ id: 'p1', planilha_google: true })).erro, /is not an .xlsx spreadsheet/);
  assert.match((await setup({ available: false }).tool.normalizeConfirmationArgs({ id: 'a2', planilha_google: true })).erro, /is not on in this server/);
});

test('an archived id is confirmed as the current version, with sharing only when asked', async () => {
  const { tool } = setup();
  const { args } = await tool.normalizeConfirmationArgs({ id: 'a1', planilha_google: true, compartilhar: 'editar' });
  assert.deepEqual([args.id, args.assetKey, args.nome, args.compartilhar], ['a2', 'k2', 'Cardapio', 'editar']);
  assert.equal((await tool.normalizeConfirmationArgs({ id: 'a2', compartilhar: 'editar' })).args.compartilhar, undefined);
});

test('creates a native Sheets file, links it to the family and opens the link', async () => {
  const { tool, calls } = setup();
  const r = JSON.parse(await tool.run({ id: 'a2', assetKey: 'k2', planilha_google: true, compartilhar: 'editar' }));
  assert.equal(r.ok, true);
  assert.equal(r.link, 'https://docs/s1');
  assert.equal(calls.create[0].name, 'Cardapio');
  assert.equal(calls.create[0].buffer.toString(), 'bytes-k2');
  assert.deepEqual(calls.link[0], { family: 'cardapio.xlsx', googleEmail: 'g@example.com', fileId: 's1', link: 'https://docs/s1', version: 5, baseAssetId: 'a2' });
  assert.deepEqual(calls.share, [{ id: 's1', role: 'writer' }]);
  assert.equal(r.compartilhada, 'editar');
});

test('a refused share keeps the file and says the link is private', async () => {
  const { tool } = setup({ shareFails: true });
  const r = JSON.parse(await tool.run({ id: 'a2', assetKey: 'k2', planilha_google: true, compartilhar: 'ler' }));
  assert.equal(r.ok, true);
  assert.equal(r.compartilhada, null);
  assert.match(r.note, /Could NOT open the link to anyone/);
});

test('an already linked spreadsheet returns its file instead of creating another', async () => {
  const { tool, calls } = setup({ linked: { file_id: 's0', link: 'https://docs/s0' } });
  const r = JSON.parse(await tool.run({ id: 'a2', assetKey: 'k2', planilha_google: true }));
  assert.equal(r.link, 'https://docs/s0');
  assert.equal(calls.create.length, 0);
  assert.equal(calls.share.length, 0);
});

test('without planilha_google it is still a plain copy in the folder', async () => {
  const { tool, calls } = setup();
  const r = JSON.parse(await tool.run({ id: 'p1', assetKey: 'kp' }));
  assert.equal(r.ok, true);
  assert.deepEqual([calls.upload[0].name, calls.upload[0].folderId, calls.create.length], ['Contrato.pdf', 'dir', 0]);
});
