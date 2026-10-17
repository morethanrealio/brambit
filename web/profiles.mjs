// Usage profiles (BRAMBIT_PROFILE): which parts of Brambit an installation runs.
//  complete (default): everything.
//  personal: everything except public support: /public-support, the public web
//   channel and the replies to WhatsApp numbers that have no account.
//  public-support: only public support. The owner signs in, sets the assistant
//   up in /public-support and follows usage; the public talks to it on WhatsApp and
//   on the website. The owner doesn't chat with the assistant in the app, and
//   sign-up is always closed (BRAMBIT_SIGNUP=closed).
// Read once when the server starts, so a change applies on the next start.
// What a profile turns off answers 404 and its background jobs don't start;
// nothing is deleted.
import { APP_PAGES, PUBLIC_SUPPORT_PAGE } from './page-paths.mjs';

export const PROFILES = ['complete', 'personal', 'public-support'];

export function readProfile(value = process.env.BRAMBIT_PROFILE) {
  const profile = String(value ?? '').trim().toLowerCase() || 'complete';
  if (!PROFILES.includes(profile)) throw new Error(`BRAMBIT_PROFILE must be one of: ${PROFILES.join(', ')} (got "${value}")`);
  return profile;
}

export const profile = readProfile();
export const publicSupportOn = profile !== 'personal';
export const ownerFeaturesOn = profile !== 'public-support';

const PUBLIC_SUPPORT = [PUBLIC_SUPPORT_PAGE, `${PUBLIC_SUPPORT_PAGE}.html`, '/api/publico/', '/api/public/'];
const startsWithAny = (pathname, list) => list.some((p) => (p.endsWith('/') ? pathname.startsWith(p) : pathname === p));

// What the owner still uses in public-support, besides the routes registered
// through rotas.registrar (screen texts, settings, sign-up, the public channels
// and the plugins' routes).
const PUBLIC_SUPPORT_API = new Set([
  '/api/config', '/api/me', '/api/login', '/api/logout', '/api/forgot', '/api/reset', '/api/account/delete',
  '/api/auth/google/start', '/api/auth/google/callback', '/api/site/idioma', '/api/prefs/idioma',
  '/api/usage', '/api/usage/credits', '/api/wa/webhook', '/api/img',
]);
// Registered routes that belong to the owner's app (phone app, first-run chat).
const PUBLIC_SUPPORT_REGISTERED_OFF = ['/api/mobile/', '/api/onboard/'];
// Pages of the owner's app.
const OWNER_PAGES = [...APP_PAGES, '/runner', '/runner.html', '/runner/', '/extension', '/app-return.html'];

// false = the request answers 404. registered: the path is an exact route of
// rotas.registrar (rotas.registrada).
export function routeAllowed(method, pathname, { registered = false, current = profile } = {}) {
  if (current === 'complete') return true;
  if (current === 'personal') return !startsWithAny(pathname, PUBLIC_SUPPORT);
  if (pathname.startsWith('/api/')) {
    if (pathname === '/api/agent') return method === 'POST'; // creates the assistant from /public-support
    if (PUBLIC_SUPPORT_API.has(pathname)) return true;
    return registered && !startsWithAny(pathname, PUBLIC_SUPPORT_REGISTERED_OFF);
  }
  return !startsWithAny(pathname, OWNER_PAGES);
}

// In public-support the owner's pages lead to /public-support (the Google sign-in
// and the sign-in screen land on them) instead of answering 404.
export function redirectFor(method, pathname, current = profile) {
  if (current !== 'public-support' || (method !== 'GET' && method !== 'HEAD')) return null;
  return startsWithAny(pathname, OWNER_PAGES) ? PUBLIC_SUPPORT_PAGE : null;
}
