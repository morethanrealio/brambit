// 2026-09-25 frustration: a whole app built on the Básico plan (cap 0) and the
// limit only showed up when publishing. The cap now applies starting with the first
// draft file of a NEW app. Source trimmed, dependencies stubbed, no database.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const src = readFileSync(new URL('../web/hosting.mjs', import.meta.url), 'utf8');
const cut = name => { const i = src.indexOf(`async function ${name}`); return src.slice(i, src.indexOf('\n}\n', i) + 3); };

function guard({ draft = {}, apps = 0, teto = 0 } = {}) {
  // The refusal text comes from the plan plugin; here only when the cap is checked matters.
  const perm = () => ({ bloqueioDeApp: async ({ atuais }) => atuais >= teto ? { ok: false, error: 'Criar app é um recurso dos planos Pro (2 apps).' } : null });
  return new Function('getAppRow', 'listAppsForUser', 'perm', 'getAppDraft',
    `${cut('appQuotaBlock')}${cut('newDraftQuotaBlock')}; return newDraftQuotaBlock;`)(
    async () => null, async () => Array.from({ length: apps }), perm, async () => draft);
}

test('the first file of a new app on a plan with no app slot is blocked with the cap message', async () => {
  const r = await guard()('u1', 'fichas-de-contatos', null, {});
  assert.equal(r.ok, false); assert.match(r.error, /Criar app é um recurso dos planos Pro/);
});

test('a draft already started, a published app, or a plan with a free slot stay editable', async () => {
  assert.equal(await guard({ draft: { 'server.js': 'x' } })('u1', 'fichas', null, {}), null);
  assert.equal(await guard()('u1', 'fichas', { system: 'fichas' }, {}), null);
  assert.equal(await guard({ teto: 2, apps: 1 })('u1', 'fichas', null, {}), null);
});

test('both draft-creation entry points check the cap before writing', () => {
  const tool = name => { const i = src.indexOf(`name: '${name}'`); return src.slice(i, src.indexOf("\n    {\n      name: '", i + 10)); };
  const ini = tool('iniciar_estrutura_do_app');
  assert.ok(ini.indexOf('appQuotaBlock(') > 0 && ini.indexOf('appQuotaBlock(') < ini.indexOf('putAppDraftFile('));
  const esc = tool('escrever_arquivo_do_app');
  assert.ok(esc.indexOf('newDraftQuotaBlock(') > 0 && esc.indexOf('newDraftQuotaBlock(') < esc.indexOf('ensureDraftSeeded('));
});
