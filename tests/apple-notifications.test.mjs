import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createSign, generateKeyPairSync } from 'node:crypto';
import { createRotas } from '../web/rotas.mjs';
import { applyAppleEvent, registerAppleNotifications, APPLE_NOTIFICATIONS_PATH } from '../web/apple-notifications.mjs';

const RELAY = 'abc123@privaterelay.appleid.com';
const CLIENT_ID = 'com.example.app';

function fakeStore() {
  const calls = [];
  return {
    calls,
    suppress: async (email, entry) => { calls.push(['suppress', email, entry.reason]); return true; },
    lift: async (email) => { calls.push(['lift', email]); return true; },
  };
}

test('relay turned off is suppressed, turned back on is lifted', async () => {
  const suppressions = fakeStore();
  await applyAppleEvent({ events: { type: 'email-disabled', sub: 's1', email: RELAY, is_private_email: 'true' } }, { suppressions });
  // `events` documented as an object, also read as a JSON string.
  await applyAppleEvent({ events: JSON.stringify({ type: 'email-enabled', sub: 's1', email: RELAY }) }, { suppressions });
  assert.deepEqual(suppressions.calls, [['suppress', RELAY, 'email-disabled'], ['lift', RELAY]]);
});

test('app access ended: the account relay is suppressed, a real address is left alone', async () => {
  const suppressions = fakeStore();
  const users = { relay: { email: RELAY }, real: { email: 'person@example.com' } };
  const getUserByAppleSub = async (sub) => users[sub] || null;
  assert.equal(await applyAppleEvent({ events: { type: 'consent-revoked', sub: 'relay' } }, { suppressions, getUserByAppleSub }), 'suppressed');
  assert.equal(await applyAppleEvent({ events: { type: 'account-deleted', sub: 'real' } }, { suppressions, getUserByAppleSub }), 'ignored');
  assert.equal(await applyAppleEvent({ events: { type: 'something-new', sub: 'relay' } }, { suppressions, getUserByAppleSub }), 'ignored');
  assert.deepEqual(suppressions.calls, [['suppress', RELAY, 'consent-revoked']]);
});

// The route with the real verifier: Apple's key set is served by a stubbed fetch.
test('the route acts only on a notification signed by Apple for this app', async (t) => {
  const env = { ...process.env };
  t.after(() => { process.env = env; });
  process.env.APPLE_CLIENT_ID = CLIENT_ID;
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const other = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => ({ keys: [jwk] }) }));
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});

  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const jwt = (claims, key = privateKey) => {
    const head = `${b64({ alg: 'RS256', kid: 'k1' })}.${b64(claims)}`;
    return `${head}.${createSign('RSA-SHA256').update(head).sign(key).toString('base64url')}`;
  };
  const claims = (over = {}) => ({
    iss: 'https://appleid.apple.com', aud: CLIENT_ID, iat: Math.floor(Date.now() / 1000), jti: 'j1',
    events: JSON.stringify({ type: 'email-disabled', sub: 's1', email: RELAY, is_private_email: 'true', event_time: Date.now() }),
    ...over,
  });

  const suppressions = fakeStore();
  const rotas = createRotas();
  registerAppleNotifications(rotas, { suppressions });
  const post = async (payload) => {
    const body = Buffer.from(JSON.stringify({ payload }));
    const req = Object.assign(Readable.from([body]), { method: 'POST', headers: { 'content-length': String(body.length) } });
    const res = { status: 0, writeHead(code) { this.status = code; }, end() {} };
    await rotas.atender(req, res, new URL(`https://host${APPLE_NOTIFICATIONS_PATH}`));
    return res.status;
  };

  assert.equal(await post(jwt(claims(), other)), 400, 'signed by someone else');
  assert.equal(await post(jwt(claims({ aud: 'com.other.app' }))), 400, 'another app');
  assert.equal(await post(jwt(claims({ iss: 'https://evil.example' }))), 400, 'another issuer');
  assert.equal(await post('not-a-jwt'), 400);
  assert.deepEqual(suppressions.calls, []);
  assert.equal(await post(jwt(claims())), 200);
  assert.deepEqual(suppressions.calls, [['suppress', RELAY, 'email-disabled']]);
});
