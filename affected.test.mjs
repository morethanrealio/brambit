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

test('import is transitive: changing b reaches whoever imports a, and whoever boots the server', () => {
  assert.deepEqual(pick('web/b.mjs'), ['a.test.mjs', 'boot.test.mjs']);
});

test("whoever only reads the server's text does not depend on what the server imports", () => {
  assert.deepEqual(pick('web/server.mjs'), ['boot.test.mjs', 'texto.test.mjs']);
  assert.ok(!closure('texto.test.mjs', deps).has('web/a.mjs'));
});

test('dynamic import counts, the test itself runs, and package.json runs everything', () => {
  assert.deepEqual(pick('web/c.mjs'), ['c.test.mjs']);
  assert.deepEqual(pick('a.test.mjs'), ['a.test.mjs']);
  assert.equal(selectAffected({ changed: ['package.json'], tests, deps }).all, true);
});

test('a file no test reaches shows up as uncovered', () => {
  const r = selectAffected({ changed: ['web/nada.mjs'], tests, deps });
  assert.deepEqual(r.tests, []);
});

test('fragile-guard: new fails, rewritten one must leave the list', () => {
  const set = new Set(tests);
  assert.deepEqual(check({ tests: set, deps, listed: new Set() }).news, ['texto.test.mjs']);
  assert.deepEqual(check({ tests: set, deps, listed: new Set(['texto.test.mjs', 'a.test.mjs']) }).gone, ['a.test.mjs']);
});
