// Lista o que o servidor responde e o catálogo ainda não traduz.
//
// Existe pelo mesmo motivo do site-i18n-pendentes: o mecanismo é silencioso de
// propósito. Mensagem sem tradução continua em português e nada reclama, que é
// o certo pra quem está usando e péssimo pra quem mantém, porque escrever um
// `fail()` novo acrescenta texto sem aviso nenhum. Este script é o aviso.
//
// A segunda lista é a que não tem conserto pelo catálogo: mensagem montada com
// template (`${}`) só existe em tempo de execução, então não há chave estável
// pra guardar. Elas ficam em português mesmo, e estão aqui pra ninguém procurar
// no catálogo uma entrada que não pode existir.
//
// rodar: node mensagens-i18n-pendentes.mjs [en|es]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extraiMensagens, FONTES_MENSAGENS } from './web/mensagens-i18n.mjs';
import { fatiaJs, carregaCatalogos } from './web/site-i18n.mjs';
import { carregarPlugins, textosDoServidor } from './web/plugins.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.join(__dirname, 'web');
// Núcleo e plugins desta instalação: cada plugin traz os módulos e o catálogo dele.
const plugins = await carregarPlugins();
const arquivos = [...FONTES_MENSAGENS.map((f) => path.join(WEB, f)), ...plugins.flatMap((p) => p.fontesMensagens || [])];
const fontes = arquivos.map((a) => ({ nome: path.relative(WEB, a), js: fs.readFileSync(a, 'utf8') }));

const mensagens = [...new Set(fontes.flatMap((f) => extraiMensagens(f.js)))];
const catalogos = carregaCatalogos([path.join(WEB, 'textos-servidor'), ...textosDoServidor(plugins)]);
const idiomas = process.argv[2] ? [process.argv[2]] : Object.keys(catalogos);

for (const idioma of idiomas) {
  const cat = catalogos[idioma] || {};
  const faltam = mensagens.filter((m) => !cat[m]);
  console.log(`\n── ${idioma}: ${mensagens.length - faltam.length} traduzidas, ${faltam.length} sem tradução (de ${mensagens.length})`);
  for (const m of faltam) console.log(`  ${JSON.stringify(m.slice(0, 110))}`);
}

// Mesmos pontos de emissão da extração, só que caçando crase em vez de aspa.
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

console.log(`\n── sem chave possível: ${templates.length} mensagem(ns) montada(s) com template`);
for (const tpl of templates) console.log(`  ${tpl.onde}  ${tpl.texto.slice(0, 110)}`);

console.log('\nSem tradução não é bug por si: nome de campo, código de erro e e-mail ficam iguais mesmo.');
