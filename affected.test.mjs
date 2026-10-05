import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGraph, closure, selectAffected } from './test-support/affected.mjs';
import { check } from './test-support/fragile-guard.mjs';

const repo = {
  'web/server.mjs': "import { a } from './a.mjs';\nconst page = 'web/public/index.html';",
  'web/a.mjs': "import { b } from './b.mjs';",
  'web/b.mjs': 'export const b = 1;',
  'web/c.mjs': 'export const c = 1;',
  'web/public/index.html': '<html></html>',
  'a.test.mjs': "import { a } from './web/a.mjs';",
  'texto.test.mjs': "const src = readFileSync(new URL('./web/server.mjs', import.meta.url), 'utf8');",
  'boot.test.mjs': "spawn(process.execPath, ['web/server.mjs']);",
  'c.test.mjs': "const { c } = await import('./web/c.mjs');",
};
const deps = buildGraph(Object.keys(repo), (f) => repo[f]);
const tests = Object.keys(repo).filter((f) => f.endsWith('.test.mjs'));
const pick = (...changed) => selectAffected({ changed, tests, deps }).tests.sort();

test('import é transitivo: mudar b alcança quem importa a, e quem sobe o server', () => {
  assert.deepEqual(pick('web/b.mjs'), ['a.test.mjs', 'boot.test.mjs']);
});

test('quem só lê o texto do server não depende do que o server importa', () => {
  assert.deepEqual(pick('web/server.mjs'), ['boot.test.mjs', 'texto.test.mjs']);
  assert.ok(!closure('texto.test.mjs', deps).has('web/a.mjs'));
});

test('import dinâmico conta, o próprio teste roda, e package.json roda tudo', () => {
  assert.deepEqual(pick('web/c.mjs'), ['c.test.mjs']);
  assert.deepEqual(pick('a.test.mjs'), ['a.test.mjs']);
  assert.equal(selectAffected({ changed: ['package.json'], tests, deps }).all, true);
});

test('arquivo que nenhum teste alcança aparece como descoberto', () => {
  const r = selectAffected({ changed: ['web/nada.mjs'], tests, deps });
  assert.deepEqual(r.tests, []);
});

test('trava de frágeis: novo reprova, reescrito tem que sair da lista', () => {
  const set = new Set(tests);
  assert.deepEqual(check({ tests: set, deps, listed: new Set() }).news, ['texto.test.mjs']);
  assert.deepEqual(check({ tests: set, deps, listed: new Set(['texto.test.mjs', 'a.test.mjs']) }).gone, ['a.test.mjs']);
});
