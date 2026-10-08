// Plugin format (C2, step 11b). The core doesn't import anything from the distribution:
// whoever installs it puts the plugin list in web/plugins/ativos.mjs or in the
// BRAMBIT_PLUGINS file (`export default [plugin, ...]`), and the server loads that
// list at boot. Without the file, the core comes up on its own with each port at default (createXSimples).
// Plugin = object with:
//  nome: short text, shows up in the log and in the boot error.
//  esquema({pool,S}): the plugin's tables and columns; initDb runs after the
//   core's, in the list's order. Optional.
//  portas(nucleo) → pieces that answer the core's ports, all optional:
//   permissoes (permissoes.mjs), contaPagadora (conta-pagadora.mjs), gasto
//   (gasto.mjs), ferramentas (ferramentas.mjs), contaPagamento
//   (conta-pagamento.mjs), ganchosDaEmpresa (empresa.mjs, store.ligar),
//   premiacaoDoConvite() → line about the referral reward or null,
//   assuntosConversados(userId) → the person's subjects for the routine offer
//   (rotina-oferta.mjs), diagnosticoDosFiltros(turno) → {removidas, corte}, which
//   observes the before/after of the turn's verification filters, and
//   briefDaJornada() → text that replaces the default brief of the journey
//   feedback (discovery/report-instructions.mts), and chaveDeepSeek() → key for the official
//   DeepSeek API of the selectable model (without the port, it comes from DEEPSEEK_API_KEY), and
//   atendimentoPublico → hooks for the public-support script
//   (publico.mjs: antesDoModelo, depoisDoModelo). Runs at the start of boot; the core brings only
//   what already exists at that time (publicBase, notifyOwner).
//  ligar(servidor): routes (rotas.mjs), subscriptions and tasks (eventos.mjs) and
//   published media (midia-publica.mjs). Runs with the server mounted; the server
//   brings the ports and the HTTP and sending helpers the plugin uses.
//  semCsrf: EXACT paths that arrive without a browser Origin (webhook with
//   signature, one-click unsubscribe). Authentication is the plugin's own.
//  publico: folders (absolute path) with pages and files of the plugin's site,
//   served like web/public's: clean URL, nonce and translation (sendHtml), only
//   GET/HEAD. The server looks in the brand folders, then the plugin ones in
//   list order, and last in web/public.
//  siteTextos: folders with the translation catalogs (en.json, es.json) of these
//   pages, in the web/site-textos format; they complete the core's catalog.
//  textosServidor: folders with the catalogs (en.json, es.json) of the messages that
//   the plugin's modules answer via send/fail ({tag}.json keyed by the Portuguese sentence);
//   an older format, new text goes in `locales`. fontesMensagens: those modules (absolute path), from
//   which the catalog check and mensagens-i18n-pendentes pull the keys.
//  app: folders with pieces of the logged-in app's screen (style, menu, panels,
//   script), one file per index.html slot (see app-encaixes.mjs).
//  locales: folders with the plugin's translation catalogs (<tag>.json, see
//   docs/i18n.md and i18n.mjs); they sit above the core's and the instance's.
//  csp: external origins the plugin's pages load (analytics, conversion tag),
//   {diretiva: [https://host, ...]}; only script-src, img-src,
//   connect-src and frame-src (csp.mjs). The core alone loads nothing from outside.
// Two pieces for the same port, an unknown port, or a plugin without a name fail at
// boot, not on first use.
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {leitorDePagina} from './app-encaixes.mjs';
import {conferirCsp} from './csp.mjs';
import {useLocalePlugins} from './i18n.mjs';

export const PORTAS_DE_PLUGIN=['permissoes','contaPagadora','gasto','ferramentas','contaPagamento','ganchosDaEmpresa','premiacaoDoConvite','assuntosConversados','diagnosticoDosFiltros','briefDaJornada','chaveDeepSeek','atendimentoPublico'];
const CAMPOS=['nome','esquema','portas','ligar','semCsrf','publico','siteTextos','textosServidor','fontesMensagens','app','locales','csp'];

export function conferirPlugin(p){
 if(!p||typeof p!=='object')throw Error('Plugin precisa ser um objeto');
 if(typeof p.nome!=='string'||!p.nome)throw Error('Plugin sem nome');
 for(const k of Object.keys(p))if(!CAMPOS.includes(k))throw Error(`Plugin ${p.nome}: campo desconhecido ${k}`);
 for(const k of ['esquema','portas','ligar'])if(p[k]!=null&&typeof p[k]!=='function')throw Error(`Plugin ${p.nome}: ${k} precisa ser função`);
 for(const k of ['publico','siteTextos','textosServidor','fontesMensagens','app','locales'])if(p[k]!=null&&!(Array.isArray(p[k])&&p[k].every(c=>typeof c==='string'&&path.isAbsolute(c))))throw Error(`Plugin ${p.nome}: ${k} precisa ser lista de caminhos absolutos`);
 if(p.csp!=null)conferirCsp(p.csp,`Plugin ${p.nome}: csp`);
 if(p.semCsrf!=null&&!(Array.isArray(p.semCsrf)&&p.semCsrf.every(c=>typeof c==='string'&&c.startsWith('/'))))throw Error(`Plugin ${p.nome}: semCsrf precisa ser lista de caminhos`);
 return p;
}

// Where the list is: BRAMBIT_PLUGINS (absolute path, or relative to the folder
// the server boots from) for whoever installs the core as a package and keeps the plugins
// in their own repository; without it, web/plugins/ativos.mjs.
export function arquivoDosPlugins(env=process.env){
 return env.BRAMBIT_PLUGINS?pathToFileURL(path.resolve(env.BRAMBIT_PLUGINS)):new URL('./plugins/ativos.mjs',import.meta.url);
}

// file exists = the list has to load; an error inside it brings down the boot. With
// BRAMBIT_PLUGINS, the file has to exist: a requested list not found doesn't come up
// silently without the plugins.
export async function carregarPlugins(arquivo=arquivoDosPlugins()){
 if(!fs.existsSync(arquivo)){
  if(process.env.BRAMBIT_PLUGINS&&arquivo.href===arquivoDosPlugins().href)throw Error('BRAMBIT_PLUGINS aponta pra um arquivo que não existe: '+process.env.BRAMBIT_PLUGINS);
  return [];
 }
 const lista=(await import(arquivo.href)).default;
 if(!Array.isArray(lista))throw Error(`${fileURLToPath(arquivo)} precisa exportar uma lista de plugins`);
 const nomes=new Set();
 for(const p of lista){
  conferirPlugin(p);
  if(nomes.has(p.nome))throw Error('Plugin repetido: '+p.nome);
  nomes.add(p.nome);
 }
 useLocalePlugins(lista);
 return lista;
}

export function juntarPortas(plugins,nucleo){
 const pecas={};
 for(const p of plugins){
  const r=p.portas?.(nucleo)||{};
  for(const [k,v] of Object.entries(r)){
   if(!PORTAS_DE_PLUGIN.includes(k))throw Error(`Plugin ${p.nome}: porta desconhecida ${k}`);
   if(k in pecas)throw Error(`Porta ${k} pedida por dois plugins`);
   pecas[k]=v;
  }
 }
 return pecas;
}

export function caminhosSemCsrf(plugins){
 return new Set(plugins.flatMap(p=>p.semCsrf||[]));
}

// Site and catalog folders brought by the plugins, in the list's order.
export function pastasDoSite(plugins){
 return plugins.flatMap(p=>p.publico||[]);
}

export function textosDoSite(plugins){
 return plugins.flatMap(p=>p.siteTextos||[]);
}

export function textosDoServidor(plugins){
 return plugins.flatMap(p=>p.textosServidor||[]);
}

// CSP origins of all plugins, by directive.
export function cspDosPlugins(plugins){
 const r={};
 for(const p of plugins)for(const [k,v] of Object.entries(p.csp||{}))(r[k]||=[]).push(...v);
 return r;
}

export function pastasDoApp(plugins){
 return plugins.flatMap(p=>p.app||[]);
}

// Reads a site page; the app (index.html) already comes with the plugins' pieces.
export function leitorDoApp(plugins,app){
 return leitorDePagina(app,pastasDoApp(plugins));
}
