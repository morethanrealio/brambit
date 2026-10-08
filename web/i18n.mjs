// Translation catalogs for the text a person reads in the product (contract in
// docs/i18n.md). Code, prompts and logs stay in English and never go through here.
//
// Catalogs are JSON files named after a BCP 47 tag (en.json, pt-BR.json), nested
// by key segment. Layers, top wins: plugin folders (in list order, the last one
// wins), the instance overlay (BRAMBIT_LOCALES_DIR), then the core (web/locales).
// Every layer may be partial; a missing text falls back pt-BR -> pt -> en -> key.
//
// Translations are plain text: variables are NOT HTML-escaped. Whoever puts a
// translated text into HTML escapes it there, like any other text.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import i18next from 'i18next';

export const SOURCE_LANGUAGE = 'en';
export const CORE_LOCALES_DIR = fileURLToPath(new URL('./locales/', import.meta.url));

// BCP 47 tag in its canonical form (pt-br -> pt-BR), or null if it isn't one.
export function canonicalTag(tag) {
  if (typeof tag !== 'string' || !tag.trim()) return null;
  try { return Intl.getCanonicalLocales(tag.trim())[0] || null; } catch { return null; }
}

// {tag: catalog} from the *.json files of a folder. A missing folder is an empty
// layer; a badly named or broken file fails at boot, not when the text is shown.
export function readCatalogDir(dir) {
  const out = {};
  if (!dir || !fs.existsSync(dir)) return out;
  for (const file of fs.readdirSync(dir).sort()) {
    if (!file.endsWith('.json')) continue;
    const tag = file.slice(0, -5);
    if (canonicalTag(tag) !== tag) throw Error(`${path.join(dir, file)}: file name must be a BCP 47 tag in canonical form (en.json, pt-BR.json)`);
    let catalog;
    try { catalog = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')); }
    catch (e) { throw Error(`${path.join(dir, file)}: invalid JSON (${e.message})`); }
    if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) throw Error(`${path.join(dir, file)}: must be a JSON object`);
    out[tag] = catalog;
  }
  return out;
}

// {'a.b.c': text} from a nested catalog. Anything other than text or an object
// is an error, so a typo in a catalog shows up in the check, not on screen.
export function flattenCatalog(catalog, prefix = '', where = 'catalog') {
  const out = {};
  for (const [k, v] of Object.entries(catalog)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'string') out[key] = v;
    else if (v && typeof v === 'object' && !Array.isArray(v)) Object.assign(out, flattenCatalog(v, key, where));
    else throw Error(`${where}: ${key} must be text or an object`);
  }
  return out;
}

// Names of the {placeholders} of a text, sorted and without repeats.
export function placeholdersOf(text) {
  return [...new Set([...text.matchAll(/\{\s*([A-Za-z_][\w]*)\s*(?:,[^}]*)?\}/g)].map((m) => m[1]))].sort();
}

// Plugin folders listed in their `locales` field, in the list's order.
export function pluginLocaleDirs(plugins = []) {
  return plugins.flatMap((p) => p.locales || []);
}

// Layer folders bottom to top: core, instance overlay, plugins.
export function localeLayers({plugins = [], overlayDir = process.env.BRAMBIT_LOCALES_DIR, coreDir = CORE_LOCALES_DIR} = {}) {
  return [coreDir, overlayDir ? path.resolve(overlayDir) : null, ...pluginLocaleDirs(plugins)].filter(Boolean);
}

// Catalogs of all layers merged in a fresh i18next instance (never the global
// one, so a plugin or test can't change another's texts).
//  t(key, language, vars): translated text; vars.count picks the plural form
//   (key_one, key_other... by the language's Intl.PluralRules).
//  has(key, language): the key exists in that language or along its fallback.
//  languages: tags with a catalog in some layer, sorted.
export function createI18n({layers = localeLayers()} = {}) {
  const inst = i18next.createInstance();
  inst.init({
    initAsync: false,
    resources: {},
    lng: SOURCE_LANGUAGE,
    fallbackLng: SOURCE_LANGUAGE,
    interpolation: {prefix: '{', suffix: '}', escapeValue: false},
    returnNull: false,
    returnEmptyString: false,
  });
  const languages = new Set();
  for (const dir of layers) {
    for (const [tag, catalog] of Object.entries(readCatalogDir(dir))) {
      flattenCatalog(catalog, '', path.join(dir, `${tag}.json`));
      inst.addResourceBundle(tag, 'translation', catalog, true, true);
      languages.add(tag);
    }
  }
  const lng = (language) => canonicalTag(language) || SOURCE_LANGUAGE;
  return {
    t: (key, language, vars = {}) => inst.t(key, {...vars, lng: lng(language)}),
    has: (key, language) => inst.exists(key, {lng: lng(language)}),
    languages: [...languages].sort(),
  };
}

// Tags of an Accept-Language header, best first (q=0 drops the tag).
export function parseAcceptLanguage(header) {
  if (typeof header !== 'string') return [];
  return header.split(',').map((part, i) => {
    const [tag, ...params] = part.trim().split(';');
    const q = params.map((p) => p.trim().match(/^q=([\d.]+)$/)).find(Boolean);
    return {tag: canonicalTag(tag === '*' ? '' : tag), q: q ? Number(q[1]) : 1, i};
  }).filter((x) => x.tag && x.q > 0).sort((a, b) => b.q - a.q || a.i - b.i).map((x) => x.tag);
}

// Supported tag closest to a requested one: the same tag, else the same language
// (pt-PT -> pt-BR, es-AR -> es), else null.
export function matchLanguage(tag, supported) {
  const want = canonicalTag(tag);
  if (!want) return null;
  if (supported.includes(want)) return want;
  const base = want.split('-')[0];
  return supported.find((s) => s === base) || supported.find((s) => s.split('-')[0] === base) || null;
}

// Language for a request or turn, in the docs/i18n.md order: the person's saved
// setting, the channel's language, Accept-Language (only a first guess), the
// instance default.
export function resolveLanguage({saved, channel, acceptLanguage, instanceDefault = SOURCE_LANGUAGE, supported = [SOURCE_LANGUAGE]} = {}) {
  for (const tag of [saved, channel, ...parseAcceptLanguage(acceptLanguage)]) {
    const hit = matchLanguage(tag, supported);
    if (hit) return hit;
  }
  return matchLanguage(instanceDefault, supported) || SOURCE_LANGUAGE;
}

// Shared instance for text built away from a request handler (confirmation
// cards, notices): core and overlay catalogs, plus the plugins' folders once
// carregarPlugins() has registered them. Built on first use.
let shared = null;
let sharedPlugins = [];
export function useLocalePlugins(plugins = []) {
  sharedPlugins = plugins;
  shared = null;
}
export function productI18n() {
  return shared ||= createI18n({layers: localeLayers({plugins: sharedPlugins})});
}
