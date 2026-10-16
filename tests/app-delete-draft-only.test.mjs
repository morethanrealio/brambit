// Case Carlos ("compras-casa"): deleting an app that was never published
// used to fail, because apagar_sistema only checked the `apps` table and
// never app_drafts. The draft-only path must stay scoped to the caller.
import assert from 'node:assert/strict';
import test from 'node:test';
import { draftOnlyNotice, deleteDraftOnly } from '../web/app-draft-delete.mjs';

function deps(draft) {
  const seen = [];
  return {
    seen,
    getAppDraft: async (u, s) => { seen.push(['get', u, s]); return draft; },
    clearAppDraft: async (u, s) => { seen.push(['clear', u, s]); },
  };
}

test('a draft-only app is deleted by discarding only that user\'s draft', async () => {
  const d = deps({ 'server.js': 'x' });
  const out = await deleteDraftOnly({ userId: 'carlos', system: 'compras-casa', ...d });
  assert.equal(out.ok, true);
  assert.equal(out.rascunho, true);
  assert.deepEqual(d.seen, [['get', 'carlos', 'compras-casa'], ['clear', 'carlos', 'compras-casa']]);
});

test('a system with neither a publication nor a draft is still not found', async () => {
  const d = deps({});
  const out = await deleteDraftOnly({ userId: 'u1', system: 'never-existed', ...d });
  assert.equal(out.ok, false);
  assert.deepEqual(d.seen, [['get', 'u1', 'never-existed']]);
  assert.equal(await draftOnlyNotice({ userId: 'u1', system: 'never-existed', ...d }), null);
});

test('the draft-only notice on the card follows the person\'s language', async () => {
  const d = deps({ 'server.js': 'x' });
  const en = await draftOnlyNotice({ userId: 'u1', system: 's', ...d, language: 'en' });
  const pt = await draftOnlyNotice({ userId: 'u1', system: 's', ...d, language: 'pt-BR' });
  assert.match(en.aviso, /draft/);
  assert.match(pt.aviso, /rascunho/);
});
