// Frustração 25/09: app inteiro construído no Básico (teto 0) e o
// limite só apareceu ao publicar. O teto agora vale já no primeiro arquivo de
// rascunho de app NOVO. Fonte recortada, dependências dubladas, sem banco.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const src = readFileSync(new URL('./web/hosting.mjs', import.meta.url), 'utf8');
const cut = name => { const i = src.indexOf(`async function ${name}`); return src.slice(i, src.indexOf('\n}\n', i) + 3); };

function guard({ draft = {}, apps = 0, teto = 0 } = {}) {
  // The refusal text comes from the plan plugin; here only when the cap is checked matters.
  const perm = () => ({ bloqueioDeApp: async ({ atuais }) => atuais >= teto ? { ok: false, error: 'Criar app é um recurso dos planos Pro (2 apps).' } : null });
  return new Function('getAppRow', 'listAppsForUser', 'perm', 'getAppDraft',
    `${cut('appQuotaBlock')}${cut('newDraftQuotaBlock')}; return newDraftQuotaBlock;`)(
    async () => null, async () => Array.from({ length: apps }), perm, async () => draft);
}

test('primeiro arquivo de app novo no plano sem app é barrado com a mensagem do teto', async () => {
  const r = await guard()('u1', 'fichas-de-contatos', null, {});
  assert.equal(r.ok, false); assert.match(r.error, /Criar app é um recurso dos planos Pro/);
});

test('rascunho já começado, app publicado ou plano com vaga seguem editáveis', async () => {
  assert.equal(await guard({ draft: { 'server.js': 'x' } })('u1', 'fichas', null, {}), null);
  assert.equal(await guard()('u1', 'fichas', { system: 'fichas' }, {}), null);
  assert.equal(await guard({ teto: 2, apps: 1 })('u1', 'fichas', null, {}), null);
});

test('as duas portas de criação de rascunho checam o teto antes de gravar', () => {
  const tool = name => { const i = src.indexOf(`name: '${name}'`); return src.slice(i, src.indexOf("\n    {\n      name: '", i + 10)); };
  const ini = tool('iniciar_estrutura_do_app');
  assert.ok(ini.indexOf('appQuotaBlock(') > 0 && ini.indexOf('appQuotaBlock(') < ini.indexOf('putAppDraftFile('));
  const esc = tool('escrever_arquivo_do_app');
  assert.ok(esc.indexOf('newDraftQuotaBlock(') > 0 && esc.indexOf('newDraftQuotaBlock(') < esc.indexOf('ensureDraftSeeded('));
});
