// Texts of the onboarding screens: the onboarding.* keys of the catalogs
// (web/locales), fetched once in the page's language (web/screen-texts.mjs).
// A failed fetch fails this module's import, so the page shows its load error
// and tries again later instead of showing keys.
const language = document.documentElement.lang || 'en';
const response = await fetch('/api/texts/onboarding?lang=' + encodeURIComponent(language), { credentials: 'same-origin' });
if (!response.ok)
    throw new Error('Onboarding texts unavailable: ' + response.status);
const texts = await response.json();
export function t(key, vars = {}) { return (texts[key] ?? key).replace(/\{(\w+)\}/g, (m, name) => name in vars ? vars[name] : m); }
