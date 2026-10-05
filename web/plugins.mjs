// Formato de plugin (C2, passo 11b). O núcleo não importa nada da distribuição:
// quem instala põe a lista de plugins em web/plugins/ativos.mjs ou no arquivo
// de BRAMBIT_PLUGINS (`export default [plugin, ...]`), e o servidor carrega essa
// lista no boot. Sem o arquivo, o núcleo sobe sozinho com cada porta no padrão (createXSimples).
// Plugin = objeto com:
//  nome: texto curto, aparece no log e no erro de boot.
//  esquema({pool,S}): tabelas e colunas do plugin; o initDb roda depois das do
//   núcleo, na ordem da lista. Opcional.
//  portas(nucleo) → peças que respondem às portas do núcleo, todas opcionais:
//   permissoes (permissoes.mjs), contaPagadora (conta-pagadora.mjs), gasto
//   (gasto.mjs), ferramentas (ferramentas.mjs), contaPagamento
//   (conta-pagamento.mjs), ganchosDaEmpresa (empresa.mjs, store.ligar),
//   premiacaoDoConvite() → linha sobre o prêmio da indicação ou null,
//   assuntosConversados(userId) → assuntos da pessoa pra oferta de rotina
//   (rotina-oferta.mjs), diagnosticoDosFiltros(turno) → {removidas, corte}, que
//   observa o antes/depois dos filtros de verificação do turno, e
//   briefDaJornada() → texto que troca o brief padrão da devolutiva da jornada
//   (discovery/report-instructions.mts), e chaveDeepSeek() → chave da API oficial
//   do DeepSeek do modelo escolhível (sem a porta, vem de DEEPSEEK_API_KEY). Roda no começo do boot; nucleo traz só
//   o que já existe nessa hora (publicBase, notifyOwner).
//  ligar(servidor): rotas (rotas.mjs), inscrições e tarefas (eventos.mjs) e
//   mídia publicada (midia-publica.mjs). Roda com o servidor montado; servidor
//   traz as portas e os ajudantes de HTTP e de envio que o plugin usa.
//  semCsrf: caminhos EXATOS que chegam sem Origin de navegador (webhook com
//   assinatura, descadastro de um clique). A autenticação é do próprio plugin.
//  publico: pastas (caminho absoluto) com páginas e arquivos do site do plugin,
//   servidos como os de web/public: URL limpa, nonce e tradução (sendHtml), só
//   GET/HEAD. O servidor procura nas pastas da marca, depois nas dos plugins na
//   ordem da lista, e por último em web/public.
//  siteTextos: pastas com os catálogos de tradução (en.json, es.json) dessas
//   páginas, no formato de web/site-textos; completam o catálogo do núcleo.
//  textosServidor: pastas com os catálogos (en.json, es.json) das mensagens que
//   os módulos do plugin respondem por send/fail, no formato de web/textos-servidor;
//   completam o do núcleo. fontesMensagens: esses módulos (caminho absoluto), de
//   onde a conferência dos catálogos e o mensagens-i18n-pendentes tiram as chaves.
//  app: pastas com pedaços de tela do app logado (estilo, menu, painéis,
//   script), um arquivo por encaixe do index.html (ver app-encaixes.mjs).
// Duas peças pra mesma porta, porta desconhecida ou plugin sem nome falham no
// boot, e não no primeiro uso.
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {leitorDePagina} from './app-encaixes.mjs';

export const PORTAS_DE_PLUGIN=['permissoes','contaPagadora','gasto','ferramentas','contaPagamento','ganchosDaEmpresa','premiacaoDoConvite','assuntosConversados','diagnosticoDosFiltros','briefDaJornada','chaveDeepSeek'];
const CAMPOS=['nome','esquema','portas','ligar','semCsrf','publico','siteTextos','textosServidor','fontesMensagens','app'];

export function conferirPlugin(p){
 if(!p||typeof p!=='object')throw Error('Plugin precisa ser um objeto');
 if(typeof p.nome!=='string'||!p.nome)throw Error('Plugin sem nome');
 for(const k of Object.keys(p))if(!CAMPOS.includes(k))throw Error(`Plugin ${p.nome}: campo desconhecido ${k}`);
 for(const k of ['esquema','portas','ligar'])if(p[k]!=null&&typeof p[k]!=='function')throw Error(`Plugin ${p.nome}: ${k} precisa ser função`);
 for(const k of ['publico','siteTextos','textosServidor','fontesMensagens','app'])if(p[k]!=null&&!(Array.isArray(p[k])&&p[k].every(c=>typeof c==='string'&&path.isAbsolute(c))))throw Error(`Plugin ${p.nome}: ${k} precisa ser lista de caminhos absolutos`);
 if(p.semCsrf!=null&&!(Array.isArray(p.semCsrf)&&p.semCsrf.every(c=>typeof c==='string'&&c.startsWith('/'))))throw Error(`Plugin ${p.nome}: semCsrf precisa ser lista de caminhos`);
 return p;
}

// Onde está a lista: BRAMBIT_PLUGINS (caminho absoluto, ou relativo à pasta de
// onde o servidor sobe) pra quem instala o núcleo como pacote e guarda os plugins
// no próprio repositório; sem ela, web/plugins/ativos.mjs.
export function arquivoDosPlugins(env=process.env){
 return env.BRAMBIT_PLUGINS?pathToFileURL(path.resolve(env.BRAMBIT_PLUGINS)):new URL('./plugins/ativos.mjs',import.meta.url);
}

// arquivo existe = a lista tem que carregar; erro dentro dela derruba o boot. Com
// BRAMBIT_PLUGINS, o arquivo tem que existir: lista pedida e não achada não sobe
// em silêncio sem os plugins.
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

// Pastas do site e dos catálogos que os plugins trazem, na ordem da lista.
export function pastasDoSite(plugins){
 return plugins.flatMap(p=>p.publico||[]);
}

export function textosDoSite(plugins){
 return plugins.flatMap(p=>p.siteTextos||[]);
}

export function textosDoServidor(plugins){
 return plugins.flatMap(p=>p.textosServidor||[]);
}

export function pastasDoApp(plugins){
 return plugins.flatMap(p=>p.app||[]);
}

// Lê página do site; o app (index.html) já vem com os pedaços dos plugins.
export function leitorDoApp(plugins,app){
 return leitorDePagina(app,pastasDoApp(plugins));
}
