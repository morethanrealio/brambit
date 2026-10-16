// The app's connect flow (web/mobile-connect.mjs): the provider's callback only
// hands the app a finish code, and only the session that started the flow can
// turn it into a saved connection. Without that check, a start link sent to
// someone else would attach their account to the sender's.
import test from 'node:test';
import assert from 'node:assert/strict';
import { registerMobileConnect } from '../web/mobile-connect.mjs';

process.env.GITHUB_CLIENT_ID = 'client';
process.env.GITHUB_CLIENT_SECRET = 'secret';
process.env.GITHUB_REDIRECT_URI = 'https://brambit.example/api/connect/github/callback';

function setup() {
  const routes = new Map();
  const saved = [];
  const rotas = { registrar: (m, p, fn) => routes.set(`${m} ${p}`, fn) };
  const send = (res, status, body) => { res.status = status; res.body = body; };
  const mc = registerMobileConnect(rotas, {
    send,
    fail: (res, status, key) => send(res, status, { error: key }),
    readBody: async (req) => req.body,
    save: { provider: async (userId, prov, tok) => { saved.push({ userId, prov, tok }); return 'ok'; } },
    exchange: { provider: async (prov, code) => ({ access_token: `token-for-${code}` }) },
  });
  const res = () => ({
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end() {},
  });
  const call = async (method, path, { user, body, cookie } = {}) => {
    const url = new URL(path, 'https://brambit.example');
    const req = { method, body, headers: { host: 'brambit.example', ...(cookie ? { cookie } : {}) } };
    const r = res();
    const fn = routes.get(`${method} ${url.pathname}`);
    if (fn) await fn(req, r, url, { currentUser: async () => user });
    else r.handled = await mc.handleCallback(req, r, url);
    return r;
  };
  // Start -> provider -> callback; returns the finish code the app gets.
  const connect = async (user) => {
    const { body } = await call('POST', '/api/mobile/connect', { user, body: { provider: 'github' } });
    const start = await call('GET', `/api/mobile/connect/start?c=${body.code}`);
    const state = new URL(start.headers.Location).searchParams.get('state');
    const cookie = start.headers['set-cookie'].split(';')[0];
    const back = await call('GET', `/api/connect/github/callback?code=c-${user.id}&state=${state}`, { cookie });
    assert.equal(back.status, 302);
    return new URL(back.headers.Location).searchParams.get('f');
  };
  return { call, connect, saved };
}

const alice = { id: 1 };
const bob = { id: 2 };

test('only the session that started the flow can finish it', async () => {
  const { call, connect, saved } = setup();
  const f = await connect(alice);
  assert.ok(f);
  assert.equal(saved.length, 0, 'the callback saves nothing');

  const stolen = await call('POST', '/api/mobile/connect/finish', { user: bob, body: { f } });
  assert.equal(stolen.status, 400);
  assert.equal(saved.length, 0);
  // Single use: a refused finish code is gone.
  assert.equal((await call('POST', '/api/mobile/connect/finish', { user: alice, body: { f } })).status, 400);

  const ok = await call('POST', '/api/mobile/connect/finish', { user: alice, body: { f: await connect(alice) } });
  assert.equal(ok.status, 200);
  assert.deepEqual(saved, [{ userId: 1, prov: 'github', tok: { access_token: 'token-for-c-1' } }]);
});

test("the site's callbacks are left alone", async () => {
  const { call } = setup();
  const r = await call('GET', '/api/connect/github/callback?code=x&state=not-ours');
  assert.equal(r.handled, false);
});
