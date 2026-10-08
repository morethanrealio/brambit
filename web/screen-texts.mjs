// Texts of screens built in the browser, served in one language so a page module
// carries only what it shows: GET /api/texts/<area>?lang=<tag> answers
// {key: text} for the `<area>.*` keys of the catalogs (web/locales, plugins and
// the instance overlay), with the usual fallback to English.
import { defaultLanguage } from './locale.mjs';
import { matchLanguage, productI18n } from './i18n.mjs';

export const SCREEN_AREAS = ['onboarding', 'routines'];

export function screenTexts(area, language, i18n = productI18n()) {
  const prefix = `${area}.`;
  return Object.fromEntries(i18n.keys(area).map((key) => [key.slice(prefix.length), i18n.t(key, language)]));
}

export function registerScreenTexts(rotas, i18n = productI18n) {
  for (const area of SCREEN_AREAS) {
    rotas.registrar('GET', `/api/texts/${area}`, async (req, res, url, ctx) => {
      const texts = i18n();
      const language = matchLanguage(url.searchParams.get('lang'), texts.languages)
        || await ctx.idiomaDaPagina?.() || defaultLanguage();
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' });
      res.end(JSON.stringify(screenTexts(area, language, texts)));
    });
  }
}
