// "conectar CÓDIGO" in a channel already bound to another account does not take it over:
// anyone in the Slack with an account could generate a code for their own assistant
// and grab #financeiro. The same account switches the assistant. Real SQL (disposable
// local Postgres) under the real handler; only the Slack API and the codes are fakes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { postgresSkipReason } from '../test-support/local-postgres.mjs';

const bin = process.env.TEST_POSTGRES_BIN;
const cmd = (name, args) => execFileSync(path.join(bin, name), args, { encoding: 'utf8', timeout: 20000, env: { PATH: process.env.PATH, LANG: 'C', LC_ALL: 'C', HOME: os.tmpdir() } });

test('a channel bound to one account is not re-bound by a code from another', { timeout: 60000, skip: postgresSkipReason() }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'slack-conectar-'));
  const socket = path.join(root, 'socket'); await fs.mkdir(socket);
  cmd('initdb', ['-D', path.join(root, 'data'), '-U', 'synthetic', '--auth=trust', '--no-locale', '--encoding=UTF8']);
  cmd('pg_ctl', ['-D', path.join(root, 'data'), '-l', path.join(root, 'pg.log'), '-o', `-c listen_addresses='' -c unix_socket_directories='${socket}'`, '-w', 'start']);
  Object.assign(process.env, { PGHOST: socket, PGPORT: '5432', PGUSER: 'synthetic', PGDATABASE: 'postgres', PGPASSWORD: '' });
  const db = await import('../web/db.mjs');
  const { createSlackHandler } = await import('../web/slack.mjs');
  t.after(async () => { await db.pool.end(); cmd('pg_ctl', ['-D', path.join(root, 'data'), '-m', 'immediate', 'stop']); await fs.rm(root, { recursive: true, force: true }); });

  const marcos = randomUUID(), outro = randomUUID(), fin = randomUUID(), prod = randomUUID(), intruso = randomUUID();
  await db.pool.query(`CREATE SCHEMA mtr_harness;
    CREATE TABLE mtr_harness.users(id uuid PRIMARY KEY);
    CREATE TABLE mtr_harness.agents(id uuid PRIMARY KEY, user_id uuid);
    CREATE TABLE mtr_harness.slack_channel_links (slack_team_id text NOT NULL, slack_channel_id text NOT NULL,
      user_id uuid REFERENCES mtr_harness.users(id) ON DELETE CASCADE, agent_id uuid REFERENCES mtr_harness.agents(id) ON DELETE CASCADE,
      created_by text, created_at timestamptz DEFAULT now(), PRIMARY KEY (slack_team_id, slack_channel_id));`);
  await db.pool.query('INSERT INTO mtr_harness.users VALUES ($1), ($2)', [marcos, outro]);
  await db.pool.query('INSERT INTO mtr_harness.agents VALUES ($1,$4), ($2,$4), ($3,$5)', [fin, prod, intruso, marcos, outro]);

  const codigos = { FIN1: { user_id: marcos, agent_id: fin }, INTR: { user_id: outro, agent_id: intruso }, PROD: { user_id: marcos, agent_id: prod } };
  const postados = [];
  const fetchOriginal = globalThis.fetch;
  t.after(() => { globalThis.fetch = fetchOriginal; });
  globalThis.fetch = async (url, init) => {
    assert.match(String(url), /^https:\/\/slack\.com\/api\/chat\.postMessage$/, 'no real network');
    postados.push(JSON.parse(init.body).text);
    return { status: 200, json: async () => ({ ok: true }) };
  };
  const handler = createSlackHandler({
    runConversation: async () => 'x',
    loadAgent: async (agentId, userId) => ({ id: agentId, user_id: userId, name: agentId }),
    db: { getSlackChannelLink: db.getSlackChannelLink, upsertSlackChannelLink: db.upsertSlackChannelLink,
      consumeSlackPairingCode: async (c) => { const p = codigos[c]; delete codigos[c]; return p || null; } },
    pessoa: async () => ({ nome: null, email: null }),
  });
  let n = 0;
  const conectar = (codigo, user) => handler.process({ type: 'event_callback', event_id: 'E' + (++n), team_id: 'T1',
    authorizations: [{ user_id: 'UBOT' }], event: { type: 'app_mention', ts: String(n), channel: 'CFIN', user, text: `<@UBOT> conectar ${codigo}` } });
  const vinculo = async () => (await db.getSlackChannelLink('T1', 'CFIN'))?.agent_id;

  await conectar('FIN1', 'UMARCOS');
  assert.equal(await vinculo(), fin);
  await conectar('INTR', 'UOUTRO');
  assert.equal(await vinculo(), fin, 'another account took over the channel');
  assert.match(postados.at(-1), /outra conta/);
  await conectar('PROD', 'UMARCOS');
  assert.equal(await vinculo(), prod, 'the same account could not switch the assistant');
});
