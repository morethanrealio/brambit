#!/usr/bin/env node
// Page text check (docs/i18n.md, "Pages"). Fails when a page in web/public:
//  - marks a key (data-i18n, data-i18n-<attribute>) or an area (data-i18n-texts)
//    that English does not have;
//  - has a catalog text, in any language, that names a child tag the element
//    does not have ("<2>" where there are two children);
//  - shows a text that is not marked and not in the list of texts still on the
//    old Portuguese-keyed catalogs (test-support/legacy-page-texts.json).
//
// That list only exists while the pages move to data-i18n: it may only shrink.
// A text of a migrated page has to leave it (the check fails while it is there),
// and new text goes in the catalogs with a mark, never in the list. Given the
// base commit, the check also fails if the list grew.
//
// Usage: node test-support/page-i18n-guard.mjs [base-sha]
//        node test-support/page-i18n-guard.mjs --write   (rewrites the list; for the migration PRs)
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CORE_LOCALES_DIR, SOURCE_LANGUAGE, createI18n } from '../web/i18n.mjs';
import { fillPage, pageKeys } from '../web/page-i18n.mjs';
import { extraiTextos } from '../web/site-i18n.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PAGES_DIR = path.join(ROOT, 'web', 'public');
const LEGACY = 'test-support/legacy-page-texts.json';

// Marked text blanked: what the old mechanism still finds is the unmarked text.
const BLANK = { t: () => '', keys: () => [], has: () => true };

export function unmarkedTexts(html) {
  return extraiTextos(fillPage(html, SOURCE_LANGUAGE, { i18n: BLANK })).map((x) => x.texto);
}

export function checkPage(name, html, { i18n, legacy = [] }) {
  const errors = [];
  const { keys, areas } = pageKeys(html);
  for (const key of keys) if (!i18n.has(key, SOURCE_LANGUAGE)) errors.push(`${name}: key ${key} is not in ${SOURCE_LANGUAGE}`);
  for (const area of areas) if (!i18n.keys(area).length) errors.push(`${name}: area ${area} has no texts in ${SOURCE_LANGUAGE}`);
  for (const language of i18n.languages) {
    fillPage(html, language, { i18n, onProblem: (problem) => errors.push(`${name} (${language}): ${problem}`) });
  }
  const allowed = new Set(legacy);
  const found = unmarkedTexts(html);
  for (const text of found) if (!allowed.has(text)) errors.push(`${name}: text without data-i18n: ${JSON.stringify(text.slice(0, 120))}`);
  const present = new Set(found);
  for (const text of legacy) if (!present.has(text)) errors.push(`${name}: ${LEGACY} still lists ${JSON.stringify(text.slice(0, 120))}, which the page no longer shows; remove it`);
  return errors;
}

const pages = () => fs.readdirSync(PAGES_DIR).filter((f) => f.endsWith('.html')).sort();
const count = (list) => Object.values(list).reduce((n, texts) => n + texts.length, 0);

function legacyAt(sha) {
  try { return JSON.parse(execFileSync('git', ['show', `${sha}:${LEGACY}`], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })); }
  catch { return null; }
}

export function run({ baseSha, write = false, log = console.log, error = console.error } = {}) {
  const read = (f) => fs.readFileSync(path.join(PAGES_DIR, f), 'utf8');
  if (write) {
    const list = Object.fromEntries(pages().map((f) => [f, unmarkedTexts(read(f))]).filter(([, texts]) => texts.length));
    fs.writeFileSync(path.join(ROOT, LEGACY), JSON.stringify(list, null, 1) + '\n');
    log(`[page-i18n-guard] wrote ${LEGACY}: ${count(list)} text(s)`);
    return 0;
  }
  const legacy = JSON.parse(fs.readFileSync(path.join(ROOT, LEGACY), 'utf8'));
  const i18n = createI18n({ layers: [CORE_LOCALES_DIR] });
  const errors = pages().flatMap((f) => checkPage(f, read(f), { i18n, legacy: legacy[f] || [] }));
  for (const f of Object.keys(legacy)) if (!pages().includes(f)) errors.push(`${LEGACY} lists ${f}, which is not a page`);
  const before = baseSha ? legacyAt(baseSha) : null;
  if (before && count(legacy) > count(before)) {
    errors.push(`${LEGACY} grew (${count(before)} -> ${count(legacy)}): mark new text with data-i18n and put it in web/locales instead`);
  }
  for (const e of errors) error(`[page-i18n-guard] ${e}`);
  if (errors.length) return 1;
  log(`[page-i18n-guard] ok: ${pages().length} page(s), ${count(legacy)} text(s) left on the old catalogs`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = process.argv[2];
  process.exit(run({ baseSha: arg && arg !== '--write' ? arg : null, write: arg === '--write' }));
}
