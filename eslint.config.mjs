// Só uma regra: nome usado sem existir (no-undef). Em JavaScript isso só quebra quando a
// linha roda; uma ferramenta que o modelo chama raramente pode ficar quebrada em prod sem
// teste nenhum perceber (caso meu_convite, 03/10/2026). Rodado no CI (Checagem rápida).
// Fora: código de navegador (web/public, a pasta publico dos plugins e o que os
// *-browser.test.mjs rodam na página), que usa variáveis globais das próprias páginas HTML.
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
