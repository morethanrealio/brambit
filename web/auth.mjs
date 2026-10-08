// ── Authentication helpers ──
// Password hashing with scrypt (native, no dependencies) and cookie parsing.

import crypto from 'crypto';

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password, stored) {
  const [salt, hash] = (stored || '').split(':');
  if (!salt || !hash) return false;
  const test = crypto.scryptSync(password, salt, 64);
  const known = Buffer.from(hash, 'hex');
  return test.length === known.length && crypto.timingSafeEqual(test, known);
}

export function newToken() {
  return crypto.randomBytes(32).toString('hex');
}

// Reads any cookie from the header.
export function readCookie(req, name) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) {
      // A cookie with invalid percent-encoding (%%, %zz) makes
      // decodeURIComponent throw a URIError. Since whoever reads the cookie
      // is inside the server's async handler, that throw used to become an
      // unhandled rejection and bring down the whole process (finding #21). A
      // broken value is worth less than the service staying up: returns the
      // raw text and whoever validates the format rejects it afterwards.
      const bruto = v.join('=');
      try { return decodeURIComponent(bruto); } catch { return bruto; }
    }
  }
  return null;
}
// The site keeps authenticating via the HttpOnly cookie. The mobile app, on
// the other hand, gets the session in the login body and keeps it in
// SecureStore: trying to manually rebuild `Cookie: sid=...` in React
// Native/iOS's fetch is not reliable. For a client that explicitly
// identifies as mobile, we accept the same token in Authorization: Bearer.
//
// The Bearer takes precedence over an old cookie. This way a session left in
// the native cookie jar cannot override the session the app just obtained.
// Outside of mobile the behavior stays byte-for-byte the same: only the
// cookie counts.
const SESSION_TOKEN_RE = /^[0-9a-f]{64}$/;
export function readSid(req) {
  const cookie = readCookie(req, 'sid');
  if (String(req?.headers?.['x-brambs-mobile'] || '') !== '1') return cookie;
  const authorization = String(req?.headers?.authorization || '');
  if (!authorization.startsWith('Bearer ')) return cookie;
  const bearer = authorization.slice(7).trim();
  return SESSION_TOKEN_RE.test(bearer) ? bearer : cookie;
}

// Session cookie: HttpOnly + Secure (https) + SameSite=Lax, valid 30 days.
export function sessionCookie(token) {
  const days = 30;
  return `sid=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${days * 86400}`;
}

export function clearCookie() {
  return 'sid=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0';
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
export const validEmail = (e) => typeof e === 'string' && EMAIL_RE.test(e);

// ── Google Login (OAuth 2.0, authorization code flow) ──
const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO = 'https://www.googleapis.com/oauth2/v3/userinfo';

export const googleEnabled = () =>
  !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_REDIRECT_URI);

// Connector scopes, per service: read + write.
// We request both together in "Connect Google"; old (read-only) tokens stay
// valid and keep reading only until the person reconnects.
// Gmail note: the "write" scope is gmail.compose (create/manage DRAFTS).
// SENDING is not a separate scope requested on connect; it's a permission the
// user enables explicitly in the app (column users.email_send_enabled). Without
// it, the agent only builds drafts and sends no e-mail.
// gmail: read (readonly) + write (compose = draft/send).
// REMOVED 12/08: `manage` (gmail.labels) and `settings`
// (gmail.settings.basic). They were OUTSIDE the verified set (LoV) and made the
// consent screen show "unverified app" to everyone connecting. Removing them
// from the Google console wasn't enough while the code still asked for them
// (the trigger is the list OUR code sends). Only reintroduce after resubmitting
// the consent screen for verification including the scope
// (see https://support.google.com/cloud/answer/13464018). Cost of removing:
// no managing Gmail labels and filters; read/draft/send still work.
export const GOOGLE_SCOPES = {
  gmail:    { read: 'https://www.googleapis.com/auth/gmail.readonly',     write: 'https://www.googleapis.com/auth/gmail.compose' },
  drive:    { read: 'https://www.googleapis.com/auth/drive.readonly',     write: 'https://www.googleapis.com/auth/drive.file' },
  docs:     { read: 'https://www.googleapis.com/auth/documents.readonly' },
  calendar: { read: 'https://www.googleapis.com/auth/calendar.readonly',  write: 'https://www.googleapis.com/auth/calendar.events' },
};
const BASE_SCOPE = 'openid email profile';

// URL where we send the user to authenticate with Google.
//  - simple login: only BASE_SCOPE, online, select_account.
//  - connecting services (incremental): BASE + requested scopes, offline +
//    consent (so the refresh_token comes back) and include_granted_scopes
//    (keeps what it already had).
export function googleAuthUrl(state, { scopes = [], loginHint = '' } = {}) {
  const connect = scopes.length > 0;
  const scope = connect ? [BASE_SCOPE, ...scopes].join(' ') : BASE_SCOPE;
  const p = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: process.env.GOOGLE_REDIRECT_URI,
    response_type: 'code',
    scope,
    state,
    access_type: connect ? 'offline' : 'online',
    // In connect we force the account selector + consent so the user can ADD
    // a different Google account (multi-account), not just reuse the active one.
    prompt: connect ? 'select_account consent' : 'select_account',
  });
  if (connect) p.set('include_granted_scopes', 'true');
  // RECONNECTING an existing account: pre-selects the email on Google.
  if (loginHint) p.set('login_hint', loginHint);
  return `${GOOGLE_AUTH}?${p.toString()}`;
}

// Resolves the list of requested services (e.g. ['gmail','drive']) into
// scopes (read + write for each one).
export const scopesFor = (services) =>
  services.flatMap((s) => {
    const def = GOOGLE_SCOPES[s];
    if (!def) return [];
    return Object.values(def).filter(Boolean);
  });

// Which services (gmail/drive/docs/calendar) a set of granted scopes covers
// (present if it has at least the read OR the write scope).
export function servicesFromScope(scope = '') {
  const granted = new Set(scope.split(/\s+/));
  return Object.entries(GOOGLE_SCOPES)
    .filter(([, def]) => (def.read && granted.has(def.read)) || (def.write && granted.has(def.write)))
    .map(([k]) => k);
}

// Read/write capabilities per service from the granted scopes.
// E.g.: { gmail: { read: true, write: true }, calendar: { read: true, write: false } }.
export function serviceCaps(scope = '') {
  const granted = new Set(scope.split(/\s+/));
  const caps = {};
  for (const [k, def] of Object.entries(GOOGLE_SCOPES)) {
    const c = {};
    for (const [op, sc] of Object.entries(def)) c[op] = !!(sc && granted.has(sc));
    if (Object.values(c).some(Boolean)) caps[k] = c;
  }
  return caps;
}

// Renova o access_token a partir do refresh_token.
export async function googleRefresh(refreshToken) {
  const body = new URLSearchParams({
    refresh_token: refreshToken,
    client_id: process.env.GOOGLE_CLIENT_ID,
    client_secret: process.env.GOOGLE_CLIENT_SECRET,
    grant_type: 'refresh_token',
  });
  const r = await fetch(GOOGLE_TOKEN, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body,
  });
  if (!r.ok) {
    const raw = await r.text();
    // invalid_grant = the refresh_token was revoked/expired (password change,
    // manual revocation, 6 months unused). It's irreversible: only
    // reconnecting fixes it. Signals the caller via .code instead of leaking
    // Google's raw JSON into the user's chat.
    const err = new Error(`google refresh ${r.status}`);
    if (/invalid_grant/i.test(raw)) err.code = 'invalid_grant';
    throw err;
  }
  return r.json(); // { access_token, expires_in, scope, ... } (no new refresh_token)
}

// Troca o code por tokens.
export async function googleExchange(code) {
  const body = new URLSearchParams({
    code,
    client_id: process.env.GOOGLE_CLIENT_ID,
    client_secret: process.env.GOOGLE_CLIENT_SECRET,
    redirect_uri: process.env.GOOGLE_REDIRECT_URI,
    grant_type: 'authorization_code',
  });
  const r = await fetch(GOOGLE_TOKEN, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body,
  });
  if (!r.ok) throw new Error(`token ${r.status}: ${await r.text()}`);
  return r.json(); // { access_token, id_token, ... }
}

// Fetches the user's name + email from the access_token.
export async function googleUserInfo(accessToken) {
  const r = await fetch(GOOGLE_USERINFO, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!r.ok) throw new Error(`userinfo ${r.status}: ${await r.text()}`);
  return r.json(); // { sub, email, email_verified, name, ... }
}

// Short-lived cookie to hold the state (CSRF protection) between start and
// callback. 30 min (was 10): 10 did not cover the real time it takes someone
// to create/confirm an account in the middle of consent. Case observed on
// Hotmail: 19min29s between start and callback, Microsoft returned a valid
// code and we silently discarded it. oflow follows the same TTL: it decides
// whether the return goes to the app's deep link or to the web home, and
// expiring before ostate would throw the mobile user to the wrong place.
export const stateCookie = (state) => `ostate=${state}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=1800`;
export const clearStateCookie = () => 'ostate=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0';

// Stores the PKCE code_verifier between /start and /callback (OAuth 2.1
// providers, like Canva). Only the challenge (SHA-256) travels in the
// authorization URL; the secret stays here, with the same TTL and conditions
// as ostate.
export const verifierCookie = (v) => `overif=${v}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=1800`;
export const clearVerifierCookie = () => 'overif=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0';

// Marks whether the OAuth flow in progress is 'login' or 'connect' (same callback).
export const flowCookie = (flow) => `oflow=${flow}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=1800`;
export const clearFlowCookie = () => 'oflow=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0';
