// Sign in with Apple — identity token verification and revocation.
//
// Why by hand: the repo has no JWT library, and pulling in a new dependency to
// verify ONE kind of token (RS256 with a published public key) doesn't pay
// for the audit cost. It's ~60 lines of native `crypto`.
//
// The identity token is a JWT signed by Apple. Verifying means, in this
// order: finding the public key by the header's `kid`, checking the signature
// over `header.payload`, and ONLY THEN trusting the content. Checking a claim
// of an unverified token is the classic mistake — here the payload parsing
// only happens after the signature has passed.
import { createPublicKey, createVerify, createSign, createHash, timingSafeEqual } from 'node:crypto';

const APPLE_ISS = 'https://appleid.apple.com';
const JWKS_URL = `${APPLE_ISS}/auth/keys`;
const TOKEN_URL = `${APPLE_ISS}/auth/token`;
const REVOKE_URL = `${APPLE_ISS}/auth/revoke`;

// Apple login is the bare minimum to work: just the client_id (app bundle).
// Revocation requires the .p8 key and is checked separately (see
// appleRevokeReady), because its absence must NOT keep someone from logging
// in — it only changes what we're able to do at the moment of account deletion.
export function appleEnabled() {
  return !!process.env.APPLE_CLIENT_ID;
}

export function appleRevokeReady() {
  return !!(process.env.APPLE_CLIENT_ID && process.env.APPLE_TEAM_ID
    && process.env.APPLE_KEY_ID && process.env.APPLE_PRIVATE_KEY);
}

// Accepts more than one audience (iOS app bundle + the site's Services ID, if
// web login ever exists). Comma-separated.
function allowedAudiences() {
  return String(process.env.APPLE_CLIENT_ID || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
}

function b64urlToBuf(s) {
  return Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function jsonFromB64url(s) {
  return JSON.parse(b64urlToBuf(s).toString('utf8'));
}

// Public key cache. Apple rotates keys, so the cache has a TTL and, faced
// with an unknown `kid`, redoes the fetch right away (once) instead of
// refusing the login of whoever got the new key.
let jwksCache = { keys: [], at: 0 };
const JWKS_TTL_MS = 60 * 60 * 1000;

async function fetchJwks() {
  const r = await fetch(JWKS_URL);
  if (!r.ok) throw new Error(`JWKS da Apple respondeu ${r.status}`);
  const body = await r.json();
  if (!Array.isArray(body?.keys) || !body.keys.length) throw new Error('JWKS da Apple veio vazio');
  jwksCache = { keys: body.keys, at: Date.now() };
  return jwksCache.keys;
}

async function appleKeyFor(kid, { refetch = true } = {}) {
  let keys = jwksCache.keys;
  if (!keys.length || Date.now() - jwksCache.at > JWKS_TTL_MS) keys = await fetchJwks();
  let jwk = keys.find((k) => k.kid === kid);
  if (!jwk && refetch) {
    keys = await fetchJwks(); // key rotation: tries once with the fresh list
    jwk = keys.find((k) => k.kid === kid);
  }
  if (!jwk) throw new Error('chave da Apple não encontrada para este token');
  return createPublicKey({ key: jwk, format: 'jwk' });
}

function sameString(a, b) {
  const ba = Buffer.from(String(a), 'utf8'), bb = Buffer.from(String(b), 'utf8');
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export function sha256Hex(s) {
  return createHash('sha256').update(String(s), 'utf8').digest('hex');
}

// Verifies the identity token and returns the identity. Throws on any
// deviation — the caller treats it as "did not log in". Never returns data
// from an invalid token.
//
// `expectedNonce` is the RAW nonce the app received from us; the token
// carries its SHA-256 (it's the app that hashes it before sending to Apple).
// Without this binding, an identity token captured elsewhere would turn into
// a session here.
export async function verifyAppleIdentityToken(idToken, { expectedNonce } = {}) {
  const parts = String(idToken || '').split('.');
  if (parts.length !== 3) throw new Error('identity token malformado');
  const [h, p, s] = parts;

  const header = jsonFromB64url(h);
  if (header.alg !== 'RS256') throw new Error(`algoritmo inesperado: ${header.alg}`);
  const key = await appleKeyFor(header.kid);

  const ok = createVerify('RSA-SHA256').update(`${h}.${p}`).verify(key, b64urlToBuf(s));
  if (!ok) throw new Error('assinatura do identity token não confere');

  // From here down the content is trusted.
  const claims = jsonFromB64url(p);
  if (claims.iss !== APPLE_ISS) throw new Error('emissor inesperado');
  const auds = allowedAudiences();
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.some((a) => auds.includes(a))) throw new Error('audience inesperada');
  const agora = Math.floor(Date.now() / 1000);
  if (!claims.exp || claims.exp <= agora) throw new Error('identity token expirado');
  if (claims.iat && claims.iat > agora + 300) throw new Error('identity token do futuro');
  if (!claims.sub) throw new Error('identity token sem sub');

  if (expectedNonce) {
    if (!claims.nonce || !sameString(claims.nonce, sha256Hex(expectedNonce)))
      throw new Error('nonce não confere');
  }

  const email = claims.email ? String(claims.email).toLowerCase() : null;
  return {
    sub: String(claims.sub),
    email,
    // `email_verified` and `is_private_email` come as boolean OR string ("true").
    emailVerified: claims.email_verified === true || claims.email_verified === 'true',
    isPrivateEmail: claims.is_private_email === true || claims.is_private_email === 'true',
  };
}

// The .p8 is a multi-line PEM and systemd's EnvironmentFile is not a shell:
// the handling of `\n` inside quotes varies by version and an error here only
// shows up at account-deletion time. So we accept three forms and normalize:
// raw PEM (if the .env file has real line breaks), PEM with literal `\n`, or
// base64 of the whole PEM — this last one is the one that can't go wrong,
// because it's a single line with no quotes or escaping.
function applePrivateKeyPem() {
  const raw = String(process.env.APPLE_PRIVATE_KEY || '').trim();
  if (raw.includes('BEGIN')) return raw.replace(/\\n/g, '\n');
  const pem = Buffer.from(raw, 'base64').toString('utf8');
  if (!pem.includes('BEGIN')) throw new Error('APPLE_PRIVATE_KEY não é um PEM nem base64 de um PEM');
  return pem;
}

// Apple client_secret: an ES256 JWT signed with the portal's .p8 key, valid
// for a few minutes. Generated on every call because the cost is negligible
// and keeping a live secret in memory buys nothing.
function appleClientSecret() {
  if (!appleRevokeReady()) throw new Error('chave privada da Apple não configurada');
  const teamId = process.env.APPLE_TEAM_ID;
  const keyId = process.env.APPLE_KEY_ID;
  const pem = applePrivateKeyPem();
  const clientId = allowedAudiences()[0];

  const iat = Math.floor(Date.now() / 1000);
  const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = b64url({ alg: 'ES256', kid: keyId });
  const body = b64url({ iss: teamId, iat, exp: iat + 300, aud: APPLE_ISS, sub: clientId });
  // ieee-p1363 = raw r||s, which is the JWS format. Node's default is DER,
  // and DER here produces a token Apple refuses without explaining why.
  const sig = createSign('SHA256')
    .update(`${head}.${body}`)
    .sign({ key: pem, dsaEncoding: 'ieee-p1363' })
    .toString('base64url');
  return `${head}.${body}.${sig}`;
}

async function applePostForm(url, params) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
  const txt = await r.text();
  let json = null;
  try { json = txt ? JSON.parse(txt) : null; } catch { /* Apple sometimes returns empty */ }
  if (!r.ok) throw new Error(`Apple ${url} respondeu ${r.status}: ${txt.slice(0, 200)}`);
  return json;
}

// Exchanges the authorization code (from native login) for the refresh_token.
// It's the only moment this token exists: without storing it now, there is no
// way to revoke it later, and account deletion stops complying with 5.1.1(v).
export async function appleExchangeCode(code) {
  const out = await applePostForm(TOKEN_URL, {
    client_id: allowedAudiences()[0],
    client_secret: appleClientSecret(),
    code,
    grant_type: 'authorization_code',
  });
  return { refreshToken: out?.refresh_token || null };
}

// Revokes access on Apple when the person deletes their account. Required by
// 5.1.1(v): deleting only on our side is not enough — while the token lives,
// the account stays listed under Settings > Apple ID > Sign in with Apple.
export async function appleRevoke(refreshToken) {
  if (!refreshToken) throw new Error('sem refresh token da Apple');
  await applePostForm(REVOKE_URL, {
    client_id: allowedAudiences()[0],
    client_secret: appleClientSecret(),
    token: refreshToken,
    token_type_hint: 'refresh_token',
  });
  return true;
}
