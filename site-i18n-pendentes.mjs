// Lists what the public pages show and the catalog doesn't translate yet.
//
// Exists because the rest of the mechanism is silent on purpose: a key without
// translation stays in Portuguese and nothing complains. That's the right fallback for
// whoever is browsing, and it's terrible for whoever maintains it, because touching the HTML
// adds new text with no notice at all. This script is the notice.
//
// run: node site-i18n-pendentes.mjs [en|es]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extraiTextos, carregaCatalogos } from './web/site-i18n.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, 'web', 'public');
// Same list that the server translates. cockpit/metrics/broadcast are left out: they are
// internal pages, not end-user ones.
const PAGINAS = ['home', 'precos', 'apps', 'habilidades', 'feed', 'runner', 'suporte', 'usage', 'index', 'termos', 'privacidade'];

const catalogos = carregaCatalogos(path.join(__dirname, 'web', 'site-textos'));
const idiomas = process.argv[2] ? [process.argv[2]] : Object.keys(catalogos);

const porTexto = new Map();
for (const n of PAGINAS) {
  for (const c of extraiTextos(fs.readFileSync(path.join(PUBLIC, `${n}.html`), 'utf8'))) {
    if (!porTexto.has(c.texto)) porTexto.set(c.texto, { tipo: c.tipo, paginas: [] });
    porTexto.get(c.texto).paginas.push(n);
  }
}

for (const idioma of idiomas) {
  const cat = catalogos[idioma] || {};
  const faltam = [...porTexto].filter(([texto]) => !cat[texto]);
  console.log(`\n── ${idioma}: ${Object.keys(cat).length} translated, ${faltam.length} untranslated (of ${porTexto.size})`);
  for (const [texto, m] of faltam) console.log(`  [${m.paginas.join(',')}] ${JSON.stringify(texto.slice(0, 100))}`);
}
console.log('\nUntranslated is not a bug by itself: brand, e-mail, commands and plan names stay the same anyway.');
