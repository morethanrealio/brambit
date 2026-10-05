// Lista o que as páginas públicas mostram e o catálogo ainda não traduz.
//
// Existe porque o resto do mecanismo é silencioso de propósito: chave sem
// tradução continua em português e nada reclama. Isso é o fallback certo pra
// quem está navegando, e é péssimo pra quem mantém, porque mexer no HTML
// acrescenta texto novo sem aviso nenhum. Este script é o aviso.
//
// rodar: node site-i18n-pendentes.mjs [en|es]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extraiTextos, carregaCatalogos } from './web/site-i18n.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, 'web', 'public');
// Mesma lista que o server traduz. cockpit/metrics/broadcast ficam fora: são
// páginas internas, não de usuário final.
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
  console.log(`\n── ${idioma}: ${Object.keys(cat).length} traduzidas, ${faltam.length} sem tradução (de ${porTexto.size})`);
  for (const [texto, m] of faltam) console.log(`  [${m.paginas.join(',')}] ${JSON.stringify(texto.slice(0, 100))}`);
}
console.log('\nSem tradução não é bug por si: marca, e-mail, comando e nome de plano ficam iguais mesmo.');
