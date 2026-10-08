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

// publico: folders with the brand's site files (legal pages, logos), served
// on top of web/public. siteTextos: folders with en/es catalogs of those pages.
// resumoPrivacidade: prompt lines summarizing the brand's data policy.
// hostsDeSaida: domains of the infra itself that the server calls (they enter the
// egress.mjs list along with third-party ones). hostsCitaveis: brand domains that
// the assistant cites without having searched, because they come from the prompt (grounding-guard.mjs).
// templatesWhatsApp: names of the templates approved on Meta to message outside the 24h
// window; notificacao has 1 variable (the content), engajamento has 2 (first
// name and content). Whoever installs it creates both in their own Meta account.
// logo: site file with the logo for the screens (default is the one in web/public).
// icone: site file with the brand's square icon (the one for the Runner app).
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
// Site address, without a trailing slash.
export const siteDaMarca = () => atual.site;
// How the address appears in text to the user ("go to example.com").
export const hostDaMarca = () => new URL(atual.site).host;
// Short brand name (lowercase, letters and numbers only): prefix for the Runner's
// executables (brambs-runner-linux) and its variables (BRAMBS_RUNNER_TOKEN). The
// runner-go/build.sh uses the same rule, so the names match.
export const slugDaMarca = () => atual.nome.toLowerCase().replace(/[^a-z0-9]/g, '');
// In the screens, the product name comes as __MARCA__, the logo as __LOGO__ and the
// icon as __ICONE__ (in the HTML and on both ends of the site catalogs, so the
// key stays a fixed literal) and become the brand's here, after translation.
// The Runner's names too: __RUNNER__ is the executable (brambs-runner) and
// __RUNNERENV__ the variable prefix (__RUNNERENV___TOKEN = BRAMBS_RUNNER_TOKEN). `extra` brings others from the
// server ({ __APPS__: the apps domain }). An unknown placeholder stays as is.
export function marcaNaPagina(html, extra = {}) {
  const s = slugDaMarca();
  const v = { __MARCA__: atual.nome, __LOGO__: atual.logo, __ICONE__: atual.icone, __RUNNER__: `${s}-runner`, __RUNNERENV__: `${s.toUpperCase()}_RUNNER`, ...extra };
  return html.replace(/__[A-Z]+__/g, (k) => (k in v ? v[k] : k));
}
// Site folders besides the brand's (the plugins' and web/public), defined at
// boot. Whoever cites a page in text (prompt, tool) asks here whether it
// exists in this installation, so as not to send anyone to a 404.
let pastasDoSite = [];
export const definirPastasDoSite = (p) => (pastasDoSite = p);
// "host/name" if the page exists; null if not.
export const linkDaPagina = (nome) => (arquivoDoSite('/' + nome, pastasDoSite) ? `${hostDaMarca()}/${nome}` : null);
// Page reader (link preview, search, image): identifies itself as a bot.
export const uaBot = ({ comSite = true } = {}) => `Mozilla/5.0 (compatible; ${atual.nome}Bot/1.0${comSite ? `; +${atual.site}` : ''})`;
// Third-party API call: name + contact (or the site's host, without contact).
export const uaApi = ({ comContato = false } = {}) => `${atual.nome} (${comContato && atual.contato ? atual.contato : new URL(atual.site).host})`;

// Site file requested in `rel` (already normalized, starting with /): looks in the
// brand's folders and then in `base` (a folder or list: the plugins' and
// web/public). Without an extension, tries .html (clean URL: /privacidade →
// privacidade.html). Returns the path or null.
export function arquivoDoSite(rel, base) {
  for (const dir of [...atual.publico, ...[].concat(base)]) {
    let full = path.join(dir, rel);
    if (!full.startsWith(dir + path.sep)) continue;
    if (!path.extname(full) && fs.existsSync(full + '.html')) full += '.html';
    if (fs.existsSync(full) && fs.statSync(full).isFile()) return full;
  }
  return null;
}
