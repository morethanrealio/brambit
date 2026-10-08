#!/usr/bin/env node
// Translation catalog check (docs/i18n.md, "Checks"). Fails when a catalog:
//  - is not a valid catalog (file name not a BCP 47 tag, broken JSON, a value
//    that is neither text nor an object);
//  - has a key that English does not have (plural forms of an English plural key
//    are allowed: a language may need _few or _many);
//  - uses {placeholders} different from the English text.
// Keys missing from a non-English catalog are only reported: they fall back to English.
//
// Usage: node test-support/i18n-guard.mjs [folder...]
// Always checks web/locales; extra folders (a plugin's locales) are checked
// against the English of all the folders given.
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {CORE_LOCALES_DIR, SOURCE_LANGUAGE, flattenCatalog, placeholdersOf, readCatalogDir} from '../web/i18n.mjs';

const PLURAL = /_(zero|one|two|few|many|other)$/;

// English text a key is compared against: the same key, or for a plural form the
// English _other (or any English form of that plural).
function englishFor(key, en) {
  if (key in en) return en[key];
  if (!PLURAL.test(key)) return undefined;
  const base = key.replace(PLURAL, '');
  return en[`${base}_other`] ?? Object.entries(en).find(([k]) => k.replace(PLURAL, '') === base && PLURAL.test(k))?.[1];
}

export function checkCatalogs(dirs) {
  const errors = [], missing = [];
  const byDir = [];
  for (const dir of dirs) {
    try { byDir.push([dir, readCatalogDir(dir)]); } catch (e) { errors.push(e.message); }
  }
  const flat = byDir.map(([dir, catalogs]) => [dir, Object.fromEntries(Object.entries(catalogs).flatMap(([tag, c]) => {
    try { return [[tag, flattenCatalog(c, '', path.join(dir, `${tag}.json`))]]; } catch (e) { errors.push(e.message); return []; }
  }))]);
  const en = Object.assign({}, ...flat.map(([, c]) => c[SOURCE_LANGUAGE] || {}));
  for (const [dir, catalogs] of flat) {
    for (const [tag, texts] of Object.entries(catalogs)) {
      if (tag === SOURCE_LANGUAGE) continue;
      const file = path.join(dir, `${tag}.json`);
      for (const [key, text] of Object.entries(texts)) {
        const source = englishFor(key, en);
        if (source === undefined) { errors.push(`${file}: ${key} is not in ${SOURCE_LANGUAGE}`); continue; }
        const want = placeholdersOf(source).join(','), got = placeholdersOf(text).join(',');
        if (want !== got) errors.push(`${file}: ${key} uses {${got}}, ${SOURCE_LANGUAGE} uses {${want}}`);
      }
      for (const key of Object.keys(en)) {
        if (!(key in texts) && !(PLURAL.test(key) && Object.keys(texts).some((k) => k.replace(PLURAL, '') === key.replace(PLURAL, '')))) missing.push(`${file}: ${key}`);
      }
    }
  }
  return {errors, missing};
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dirs = [CORE_LOCALES_DIR, ...process.argv.slice(2).map((d) => path.resolve(d))];
  const {errors, missing} = checkCatalogs(dirs);
  for (const m of missing) console.log(`[i18n-guard] missing (falls back to ${SOURCE_LANGUAGE}): ${m}`);
  for (const e of errors) console.error(`[i18n-guard] ${e}`);
  if (errors.length) process.exit(1);
  console.log(`[i18n-guard] ok: ${dirs.length} folder(s)`);
}
