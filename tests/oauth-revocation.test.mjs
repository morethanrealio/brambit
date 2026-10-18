// Issue #35: disconnecting a connector or deleting the account revokes the access at
// the provider, without cutting off another user of the install who holds the same
// access, and without a failure at the provider blocking the disconnect.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { createOAuthRevocation } from '../web/oauth-revocation.mjs';
import { providerRevoke } from '../web/providers.mjs';

const ana = '00000000-0000-4000-8000-000000000001';
const bia = '00000000-0000-4000-8000-000000000002';

test('revokes with the person\'s token, skips a token another user holds, and a failure does not throw', async (t) => {
  const db = new PGlite(); t.after(() => db.close());
  await db.exec(`CREATE SCHEMA mtr_harness;
    CREATE TABLE mtr_harness.oauth_tokens(user_id uuid, provider text NOT NULL, access_token text, refresh_token text,
      meta jsonb DEFAULT '{}'::jsonb, PRIMARY KEY (user_id, provider));
    INSERT INTO mtr_harness.oauth_tokens(user_id, provider, access_token, refresh_token) VALUES
      ('${ana}', 'github', 'gh-ana', NULL), ('${bia}', 'github', 'gh-bia', NULL),
      ('${ana}', 'slack', 'xoxp-shared', NULL), ('${bia}', 'slack', 'xoxp-shared', NULL),
      ('${ana}', 'canva', 'at-ana', 'rt-ana');`);
  const pool = { query: (sql, values) => db.query(sql, values) };
  const calls = [];
  const { revokeOAuthGrant, revokeOAuthGrants } = createOAuthRevocation(pool, {
    revoke: async (provider, row, others) => {
      calls.push([provider, row.access_token, others.map((o) => o.access_token)]);
      if (provider === 'canva') throw new Error('canva down');
    },
  });
  t.mock.method(console, 'warn', () => {});

  await revokeOAuthGrant(ana, 'github');
  assert.deepEqual(calls, [['github', 'gh-ana', ['gh-bia']]]);

  calls.length = 0;
  await revokeOAuthGrants(ana);
  assert.deepEqual(calls.map((c) => c[0]).sort(), ['canva', 'github']);
});

test('GitHub deletes the whole grant only when no other user connected the same GitHub account', async (t) => {
  for (const [k, v] of Object.entries({ GITHUB_CLIENT_ID: 'cid', GITHUB_CLIENT_SECRET: 'sec', GITHUB_REDIRECT_URI: 'http://localhost/api/connect/github/callback' })) {
    const old = process.env[k]; process.env[k] = v;
    t.after(() => { if (old === undefined) delete process.env[k]; else process.env[k] = old; });
  }
  const owners = { 'gh-ana': 1, 'gh-ana-2': 1, 'gh-bia': 2 };
  const deleted = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const kind = String(url).split('/').pop();
    const token = JSON.parse(init.body).access_token;
    if (init.method === 'DELETE') { deleted.push(kind); return new Response(null, { status: 204 }); }
    if (token === 'gh-broken') return new Response('{}', { status: 500 });
    if (!(token in owners)) return new Response('{}', { status: 404 });
    return Response.json({ user: { id: owners[token] } });
  });
  const run = (token, others) => providerRevoke('github', { access_token: token }, others.map((o) => ({ access_token: o })));

  await run('gh-ana', ['gh-bia']);
  await run('gh-ana', ['gh-ana-2']);
  await run('gh-ana', ['gh-broken']);
  await run('gh-gone', []);
  assert.deepEqual(deleted, ['grant', 'token', 'token']);
});
