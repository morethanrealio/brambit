// Finding 3a: a page on a subdomain of the site (a hosted app) could plant its
// own `sid`/`ostate` for the whole domain and get the "Connect Gmail" callback
// to run as the attacker. The login cookies are now __Host- and the plain name
// is not read; the OAuth state also names who started a connect flow.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readSid, sessionCookie, stateCookie, oauthStateOk } from '../web/auth.mjs';

const victim = 'a'.repeat(64);
const attacker = 'b'.repeat(64);
const req = (cookie, remoteAddress = '10.0.0.5', host = 'brambs.example') => ({ headers: { cookie, host }, socket: { remoteAddress } });
// What the browser sends back for a Set-Cookie we emitted: just name=value.
const sent = (setCookie) => setCookie.split(';')[0];

test('a planted plain sid is ignored, even when it comes first', () => {
  assert.equal(readSid(req(`sid=${attacker}; ${sent(sessionCookie(victim))}`)), victim);
  assert.equal(readSid(req(`sid=${attacker}`)), null);
});

test('on a local install the session goes by the plain name and still logs in', (t) => {
  const before = process.env.BRAMBS_LOCAL;
  process.env.BRAMBS_LOCAL = '1';
  t.after(() => { if (before === undefined) delete process.env.BRAMBS_LOCAL; else process.env.BRAMBS_LOCAL = before; });
  assert.equal(readSid(req(`sid=${victim}`, '127.0.0.1', 'localhost:8080')), victim);
});

test('the OAuth state only matches for whoever started the flow', () => {
  const s = 'c'.repeat(64);
  const connect = req(sent(stateCookie(s, 'user-1')));
  assert.equal(oauthStateOk(connect, s, 'user-1'), true);
  assert.equal(oauthStateOk(connect, s, 'user-2'), false);
  assert.equal(oauthStateOk(connect, s, undefined), false);
  assert.equal(oauthStateOk(connect, 'd'.repeat(64), 'user-1'), false);
  const login = req(sent(stateCookie(s)));
  assert.equal(oauthStateOk(login, s, ''), true);
  assert.equal(oauthStateOk(req(`ostate=${s}.`), s, ''), false);
  assert.equal(oauthStateOk(req(''), null, ''), false);
});
