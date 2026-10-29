// Account scope: an extension can hold some accounts to its own part of the
// app, whatever the installation's usage profile (profiles.mjs). Public support
// holds the people a client area invites: they reach the owner's screen for
// their area and nothing that chats, creates assistants or spends.
//
// register({ name, active(), holds(userId), api(method, pathname), home }):
//  active() → whether the extension holds anyone at all now; false skips the
//   session lookup, so an installation without held accounts pays nothing.
//  holds(userId) → whether this account is held.
//  api(method, pathname) → the extension's own /api/ routes a held account reaches.
//  home: the page the owner's app pages send a held account to.
// A held account also reaches the core's account routes (sign-in, password,
// language, deleting the account), the public channels and every page except
// the owner's app. Anything else answers 404.
import { OWNER_PAGES, startsWithAny } from './profiles.mjs';

const ACCOUNT_API = new Set(['/api/config', '/api/me', '/api/login', '/api/logout', '/api/forgot', '/api/reset', '/api/account/delete',
  '/api/auth/google/start', '/api/auth/google/callback', '/api/site/idioma', '/api/prefs/idioma']);
const PUBLIC_API = ['/api/public/'];

// → null when a held account may go on, or { status, location? }.
export function heldVerdict(scope, method, pathname) {
  if (pathname.startsWith('/api/')) {
    return ACCOUNT_API.has(pathname) || startsWithAny(pathname, PUBLIC_API) || scope.api(method, pathname) ? null : { status: 404 };
  }
  if (!startsWithAny(pathname, OWNER_PAGES)) return null;
  return method === 'GET' || method === 'HEAD' ? { status: 302, location: scope.home } : { status: 404 };
}

export function createAccountScope() {
  const scopes = [];
  return {
    register(scope) {
      for (const k of ['active', 'holds', 'api']) if (typeof scope?.[k] !== 'function') throw new Error(`Account scope ${scope?.name}: ${k} needs to be a function`);
      if (typeof scope.home !== 'string' || !scope.home.startsWith('/')) throw new Error(`Account scope ${scope.name}: home needs to be a path`);
      scopes.push(scope);
    },
    // currentUser() → the signed-in account or null (server.mjs).
    async check(method, pathname, currentUser) {
      const live = scopes.filter((s) => s.active());
      if (!live.length) return null;
      const user = await currentUser();
      if (!user) return null;
      for (const s of live) if (await s.holds(user.id)) return heldVerdict(s, method, pathname);
      return null;
    },
  };
}
