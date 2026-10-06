// Port 5 (brand): what changes from one install to another without being a
// secret or env config: the product name, the site address and the signature
// (User-Agent) the server uses on outbound calls, the contacts and the folders
// with the brand's own pages, images and translations. The core reads from here;
// whoever installs it sets it once at boot (e.g. in a brand plugin). Everything is
// read at use time, never kept in a module constant, so import order doesn't
// matter. PUBLIC_BASE_URL and APP_BASE_URL from the env still override the
// brand's site where they already did.
import fs from 'node:fs';
import path from 'node:path';

// publico: pastas com arquivos do site da marca (páginas legais, logos), servidas
// por cima de web/public. siteTextos: pastas com catálogos en/es dessas páginas.
// resumoPrivacidade: linhas do prompt que resumem a política de dados da marca.
// hostsDeSaida: domínios da própria infra que o servidor chama (entram na lista
// do egress.mjs junto com os de terceiros). hostsCitaveis: domínios da marca que
// o assistente cita sem ter buscado, porque vêm do prompt (grounding-guard.mjs).
// templatesWhatsApp: nomes dos modelos aprovados na Meta pra falar fora da janela
// de 24h; notificacao tem 1 variável (o conteúdo), engajamento tem 2 (primeiro
// nome e conteúdo). Quem instala cria os dois na própria conta da Meta.
// logo: arquivo do site com o logo das telas (o padrão é o de web/public).
// icone: arquivo do site com o ícone quadrado da marca (o do app do Runner).
const TEMPLATES_NEUTROS = Object.freeze({ notificacao: 'notificacao', engajamento: 'engajamento' });
const NEUTRA = Object.freeze({ nome: 'Brambit', site: 'http://localhost:8080', contato: '', suporte: '', privacidade: '', logo: 'logo.svg', icone: 'logo.svg', publico: [], siteTextos: [], resumoPrivacidade: [], hostsDeSaida: [], hostsCitaveis: [], templatesWhatsApp: TEMPLATES_NEUTROS });
let atual = NEUTRA;
export function definirMarca(m = {}) {
  atual = Object.freeze({
    ...NEUTRA, ...m, site: String(m.site || NEUTRA.site).replace(/\/+$/, ''),
    templatesWhatsApp: Object.freeze({ ...TEMPLATES_NEUTROS, ...m.templatesWhatsApp }),
  });
  return atual;
}
export const marca = () => atual;
// Endereço do site, sem barra no fim.
export const siteDaMarca = () => atual.site;
// How the address appears in text to the user ("go to example.com").
export const hostDaMarca = () => new URL(atual.site).host;
// Nome curto da marca (minúsculas, só letras e números): prefixo dos executáveis
// do Runner (brambs-runner-linux) e das variáveis dele (BRAMBS_RUNNER_TOKEN). O
// runner-go/build.sh usa a mesma regra, pra os nomes baterem.
export const slugDaMarca = () => atual.nome.toLowerCase().replace(/[^a-z0-9]/g, '');
// Nas telas, o nome do produto vem como __MARCA__, o logo como __LOGO__ e o
// ícone como __ICONE__ (no HTML e nas duas pontas dos catálogos do site, pra a
// chave seguir um literal fixo) e viram os da marca aqui, depois da tradução.
// Os nomes do Runner também: __RUNNER__ é o executável (brambs-runner) e
// __RUNNERENV__ o prefixo das variáveis (__RUNNERENV___TOKEN = BRAMBS_RUNNER_TOKEN). `extra` traz outros do
// servidor ({ __APPS__: domínio dos apps }). Marcador desconhecido fica como está.
export function marcaNaPagina(html, extra = {}) {
  const s = slugDaMarca();
  const v = { __MARCA__: atual.nome, __LOGO__: atual.logo, __ICONE__: atual.icone, __RUNNER__: `${s}-runner`, __RUNNERENV__: `${s.toUpperCase()}_RUNNER`, ...extra };
  return html.replace(/__[A-Z]+__/g, (k) => (k in v ? v[k] : k));
}
// Pastas do site além das da marca (as dos plugins e web/public), definidas no
// boot. Quem cita uma página no texto (prompt, ferramenta) pergunta aqui se ela
// existe nesta instalação, pra não mandar ninguém pra um 404.
let pastasDoSite = [];
export const definirPastasDoSite = (p) => (pastasDoSite = p);
// "host/nome" se a página existe; null se não.
export const linkDaPagina = (nome) => (arquivoDoSite('/' + nome, pastasDoSite) ? `${hostDaMarca()}/${nome}` : null);
// Leitor de páginas (prévia de link, busca, imagem): se identifica como bot.
export const uaBot = ({ comSite = true } = {}) => `Mozilla/5.0 (compatible; ${atual.nome}Bot/1.0${comSite ? `; +${atual.site}` : ''})`;
// Chamada de API de terceiro: nome + contato (ou o host do site, sem contato).
export const uaApi = ({ comContato = false } = {}) => `${atual.nome} (${comContato && atual.contato ? atual.contato : new URL(atual.site).host})`;

// Arquivo do site pedido em `rel` (já normalizado, começando com /): procura nas
// pastas da marca e depois em `base` (uma pasta ou lista: as dos plugins e
// web/public). Sem extensão, tenta o .html (URL limpa: /privacidade →
// privacidade.html). Devolve o caminho ou null.
export function arquivoDoSite(rel, base) {
  for (const dir of [...atual.publico, ...[].concat(base)]) {
    let full = path.join(dir, rel);
    if (!full.startsWith(dir + path.sep)) continue;
    if (!path.extname(full) && fs.existsSync(full + '.html')) full += '.html';
    if (fs.existsSync(full) && fs.statSync(full).isFile()) return full;
  }
  return null;
}
