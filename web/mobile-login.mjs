// ── Google login in the APP (deep link) ──
// The app opens /api/auth/google/start?mobile=1 in an ASWebAuthenticationSession. The
// callback (login_mobile flow) does NOT return the session via cookie (the app has no
// cookie jar): it creates the session, stores a single-use code here in memory and
// hands the app brambs://auth?code=CODE. The app exchanges the code for the session at
// POST /api/auth/mobile/exchange. Codes expire in 10min and are consumed once.
//
// App versions up to 1.0 (build 22) also open this login from the "Connect Google"
// button, in the system browser instead of the auth session, so a redirect to the
// deep link lands nowhere and the data connection never happens. That's why, for
// them (mobile=1), the callback answers with a page (app-return.html) instead: "Back
// to the app" carries the session code, and "Connect Google here" carries a
// browser-login code that logs that browser in (GET /api/auth/google/app-connect) and
// goes on to the normal connect flow. The 10min cover the time someone takes to read
// that page. Newer builds only open it in the auth session and connect through
// mobile-connect.mjs: they send mobile=2 and get the deep link straight away.
import { newToken } from './auth.mjs';

const TTL_MS = 600_000;
const codes = new Map(); // code -> { token, exp } (app) or { userId, exp } (browser)

function put(entry) {
  const code = newToken();
  codes.set(code, { ...entry, exp: Date.now() + TTL_MS });
  return code;
}
function take(code, field) {
  const e = code && codes.get(code);
  if (!e?.[field]) return null;
  codes.delete(code);
  return Date.now() > e.exp ? null : e[field];
}

export const putMobileAuthCode = (sessionToken) => put({ token: sessionToken });
export const appLoginLink = (sessionToken) => `brambs://auth?code=${putMobileAuthCode(sessionToken)}`;
// The login flow for /api/auth/google/start?mobile=: null when it isn't the app's.
export const appLoginFlow = (mobile) => (mobile === '1' ? 'login_mobile' : mobile === '2' ? 'login_app' : null);
export const takeMobileAuthCode = (code) => take(code, 'token');
export const putBrowserLoginCode = (userId) => put({ userId });
export const takeBrowserLoginCode = (code) => take(code, 'userId');

setInterval(() => {
  const now = Date.now();
  for (const [k, e] of codes) if (now > e.exp) codes.delete(k);
}, 5 * 60_000).unref();

// Text going into a page placeholder (marcaNaPagina doesn't escape).
export const escapeHtmlText = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// Vars for app-return.html, the page the mobile login callback shows (marcaNaPagina
// only fills placeholders made of capital letters, hence no underscore inside).
export function appReturnVars({ home, sessionToken, user }) {
  return {
    __APPLINK__: appLoginLink(sessionToken),
    __CONNECTLINK__: `${home}api/auth/google/app-connect?c=${putBrowserLoginCode(user.id)}`,
    __ACCOUNT__: escapeHtmlText(user.email),
  };
}

// GET /api/auth/google/app-connect?c=: "Connect Google here" on app-return.html. Logs
// this browser in as the person who just signed in and goes on to the connect flow.
// Without a valid code it falls back to the site, where they can sign in by hand.
export async function handleAppConnect(res, { home, code, createSession, sessionCookie }) {
  const userId = takeBrowserLoginCode(code);
  if (!userId) { res.writeHead(302, { Location: home }); return res.end(); }
  const token = newToken();
  await createSession(token, userId);
  res.writeHead(302, { Location: home + 'api/connect/google/start', 'set-cookie': sessionCookie(token) });
  return res.end();
}
