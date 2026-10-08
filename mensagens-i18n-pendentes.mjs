// Lists what the plugins' server messages still don't translate. The core emits
// `server.*` keys instead (checked by mensagens-i18n.test and i18n-guard).
//
// It exists for the same reason as site-i18n-pendentes: the mechanism is deliberately
// silent. A message without translation stays in Portuguese and nothing complains, which is
// right for whoever is using it and terrible for whoever maintains it, because writing a
// new `fail()` adds text with no warning at all. This script is the warning.
//
// The second list is the one that has no fix via the catalog: a message assembled with a
// template (`${}`) only exists at runtime, so there's no stable key
// to store. They stay in Portuguese, and they're here so no one looks
// in the catalog for an entry that cannot exist.
//
// run: node mensagens-i18n-pendentes.mjs [en|es]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extraiMensagens, FONTES_MENSAGENS } from './web/mensagens-i18n.mjs';
import { fatiaJs, carregaCatalogos } from './web/site-i18n.mjs';
import { carregarPlugins, textosDoServidor } from './web/plugins.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.join(__dirname, 'web');
// Core and plugins of this installation: each plugin brings its own modules and catalog.
const plugins = await carregarPlugins();
const arquivos = [...FONTES_MENSAGENS.map((f) => path.join(WEB, f)), ...plugins.flatMap((p) => p.fontesMensagens || [])];
const fontes = arquivos.map((a) => ({ nome: path.relative(WEB, a), js: fs.readFileSync(a, 'utf8') }));

const mensagens = [...new Set(fontes.flatMap((f) => extraiMensagens(f.js)))];
const catalogos = carregaCatalogos(textosDoServidor(plugins));
const idiomas = process.argv[2] ? [process.argv[2]] : Object.keys(catalogos);

for (const idioma of idiomas) {
  const cat = catalogos[idioma] || {};
  const faltam = mensagens.filter((m) => !cat[m]);
  console.log(`\n── ${idioma}: ${mensagens.length - faltam.length} translated, ${faltam.length} untranslated (of ${mensagens.length})`);
  for (const m of faltam) console.log(`  ${JSON.stringify(m.slice(0, 110))}`);
}

// Same emission points as the extraction, just hunting for a backtick instead of a quote.
const EMISSORES = [
  /\bfail\s*\(\s*res\s*,\s*\d+\s*,\s*$/,
  /\bsend\s*\(\s*res\s*,\s*\d+\s*,\s*\{\s*error\s*:\s*$/,
  /\bsend\s*\(\s*res\s*,\s*\d+\s*,\s*\{[^{}]*\bmessage\s*:\s*$/,
];
const templates = [];
for (const { nome, js } of fontes) for (const p of fatiaJs(js)) {
  if (p.tipo !== 'template') continue;
  if (!EMISSORES.some((re) => re.test(js.slice(Math.max(0, p.ini - 90), p.ini)))) continue;
  templates.push({ onde: `${nome}:${js.slice(0, p.ini).split('\n').length}`, texto: js.slice(p.ini, p.fim) });
}

console.log(`\n── no key possible: ${templates.length} message(s) built with a template`);
for (const tpl of templates) console.log(`  ${tpl.onde}  ${tpl.texto.slice(0, 110)}`);

console.log('\nUntranslated is not a bug by itself: field names, error codes and e-mail addresses stay the same anyway.');
