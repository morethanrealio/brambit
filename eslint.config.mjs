// One rule only: a name used without existing (no-undef). In JavaScript that only breaks
// when the line runs; a tool the model rarely calls can stay broken in production with no
// test noticing (the meu_convite case, 2026-10-03). Run in CI (Quick checks).
// Left out: browser code (web/public, the plugins' publico folder and what the
// *-browser.test.mjs files run in the page), which uses the HTML pages' own globals.
import globals from 'globals';

export default [
  { ignores: ['web/public/**', 'web/plugins/*/publico/**', '**/*-browser.test.mjs', 'node_modules/**', '.*-build/**'] },
  {
    files: ['**/*.mjs'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: { ...globals.node } },
    linterOptions: { reportUnusedDisableDirectives: 'off' },
    rules: { 'no-undef': 'error' },
  },
];
