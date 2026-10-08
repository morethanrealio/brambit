#!/usr/bin/env node
// Runs Brambit on your machine for development: a throwaway Postgres 14 (same
// version as production), schema, migrations, a test account and the server.
// Nothing leaves the machine: the database listens on 127.0.0.1 only, with a
// password, and the data lives in .local/ (delete it to start over).
// Runs on Linux, macOS and Windows.
//
// Usage: npm run local             (reads .env and modelos.yaml from the root; needs a model key)
//        npm run local -- --check  starts, checks sign-up and login, and exits (used by CI)
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import pg from 'pg';
import { carregarModelos, descreverModelos, tabelaModelos } from '../core-proto/modelos.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const local = path.join(root, '.local');
const DB_USER = 'brambs';
export const TEST_ACCOUNT = { name: 'Test Account', email: 'test@example.com', password: 'brambit-local-test' };

export function postgresBin() {
  // The Windows package is called windows-x64, not win32-x64.
  const pkg = `@embedded-postgres/${process.platform === 'win32' ? 'windows' : process.platform}-${process.arch}`;
  try { return path.resolve(path.dirname(fileURLToPath(import.meta.resolve(pkg))), '..', 'native', 'bin'); }
  catch { throw new Error(`Embedded Postgres is not installed for ${process.platform}-${process.arch}. Run npm install.`); }
}

// Chronological order: the names mix 2026-09-12 and 20260910.
export const migrationOrder = (names) => [...names].sort((a, b) => a.replace(/-/g, '').localeCompare(b.replace(/-/g, '')));

export function readDotEnv() {
  const file = path.join(root, '.env');
  return existsSync(file) ? parseEnv(readFileSync(file, 'utf8')) : {};
}

export const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer().once('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

// TCP on 127.0.0.1 only (Windows has no Unix socket), with a password: on Windows
// and on a shared computer, another user of the machine can reach 127.0.0.1.
// The password is generated on the first run and kept in <dir>/pg-password.
const exeOf = (bin) => (name) => path.join(bin, process.platform === 'win32' ? `${name}.exe` : name);
export const stopPostgres = (bin, dir = local) => { try { execFileSync(exeOf(bin)('pg_ctl'), ['-D', path.join(dir, 'pgdata'), '-m', 'fast', 'stop'], { stdio: 'ignore' }); } catch {} };
export async function startPostgres(bin, dir = local) {
  const exe = exeOf(bin), pgdata = path.join(dir, 'pgdata'), pwfile = path.join(dir, 'pg-password');
  mkdirSync(dir, { recursive: true });
  const fresh = !existsSync(path.join(pgdata, 'PG_VERSION'));
  // A .local/ from before this version was created without a password (socket only): it gets one now.
  const noPassword = !fresh && !existsSync(pwfile);
  if (!existsSync(pwfile)) writeFileSync(pwfile, randomBytes(24).toString('hex'), { mode: 0o600 });
  const password = readFileSync(pwfile, 'utf8').trim();
  if (fresh) execFileSync(exe('initdb'), ['-D', pgdata, '-U', DB_USER, '--auth=scram-sha-256', `--pwfile=${pwfile}`, '--no-locale', '--encoding=UTF8'], { stdio: 'ignore' });
  const port = await freePort();
  // In a file, not in pg_ctl -o: on Windows the quotes of '' arrive literally.
  const conf = path.join(pgdata, 'postgresql.conf');
  if (!readFileSync(conf, 'utf8').includes("include_if_exists = 'brambit.conf'")) appendFileSync(conf, "\ninclude_if_exists = 'brambit.conf'\n");
  writeFileSync(path.join(pgdata, 'brambit.conf'), `listen_addresses = '127.0.0.1'\nport = ${port}\nunix_socket_directories = ''\n`);
  execFileSync(exe('pg_ctl'), ['-D', pgdata, '-w', '-l', path.join(dir, 'postgres.log'), 'start'], { stdio: 'ignore' });
  const stop = () => stopPostgres(bin, dir);
  const conn = { host: '127.0.0.1', port, user: DB_USER, password, database: 'postgres' };
  if (noPassword) {
    const c = new pg.Client(conn); await c.connect();
    await c.query(`ALTER ROLE ${DB_USER} PASSWORD '${password}'`);
    writeFileSync(path.join(pgdata, 'pg_hba.conf'), 'host all all 127.0.0.1/32 scram-sha-256\nhost all all ::1/128 scram-sha-256\n');
    await c.query('SELECT pg_reload_conf()'); await c.end();
  }
  return { stop, conn };
}

export const dbEnvOf = (conn) => ({ PGHOST: conn.host, PGPORT: String(conn.port), PGUSER: conn.user, PGPASSWORD: conn.password, PGDATABASE: conn.database });

async function migrate(conn) {
  const client = new pg.Client(conn);
  await client.connect();
  try {
    await client.query('CREATE TABLE IF NOT EXISTS public.local_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const done = new Set((await client.query('SELECT name FROM public.local_migrations')).rows.map((r) => r.name));
    const dir = path.join(root, 'migrations');
    for (const name of migrationOrder(readdirSync(dir).filter((n) => n.endsWith('.sql')))) {
      if (done.has(name)) continue;
      await client.query(readFileSync(path.join(dir, name), 'utf8'));
      await client.query('INSERT INTO public.local_migrations(name) VALUES ($1)', [name]);
      console.log(`[local] migration ${name}`);
    }
  } finally { await client.end(); }
}

// The migrations depend on the tables initDb creates when the server boots (the
// core's and those of the plugins in web/plugins/ativos.mjs, if it exists, as at boot).
function initDb(env) {
  execFileSync(process.execPath, ['--input-type=module', '-e',
    "const m=await import('./web/db.mjs');const p=await import('./web/plugins.mjs');const l=await p.carregarPlugins();await m.initDb(...l.map((x)=>x.esquema).filter(Boolean));process.exit(0)"], { cwd: root, env, stdio: ['ignore', 'ignore', 'inherit'] });
}

// Schema, boot tables and migrations: everything the server expects to find ready.
export async function prepareDatabase(conn, env) {
  const admin = new pg.Client(conn);
  await admin.connect(); await admin.query('CREATE SCHEMA IF NOT EXISTS mtr_harness'); await admin.end();
  initDb(env);
  await migrate(conn);
}

export async function waitReady(base, child) {
  for (let i = 0; i < 120; i++) {
    if (child.exitCode !== null) throw new Error('the server stopped during boot (see the log above)');
    try { if ((await fetch(`${base}/api/config`)).ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('the server did not answer within 60s');
}

async function ensureTestAccount(base) {
  const res = await fetch(`${base}/api/signup`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify(TEST_ACCOUNT) });
  if (res.ok || res.status === 409) return;
  console.warn(`[local] could not create the test account (${res.status}): ${(await res.text()).slice(0, 200)}`);
}

async function checkLogin(base) {
  const res = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ email: TEST_ACCOUNT.email, password: TEST_ACCOUNT.password }) });
  if (!res.ok) throw new Error(`test account login failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
}

async function main() {
  const check = process.argv.includes('--check');
  const fileEnv = readDotEnv();
  const { stop, conn } = await startPostgres(postgresBin());
  process.on('exit', stop);
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(0));
  const env = {
    ...fileEnv, ...process.env, ...dbEnvOf(conn),
    HOST: '127.0.0.1', PORT: process.env.PORT || fileEnv.PORT || '8080', BRAMBS_LOCAL: '1',
    APP_TASK_STORE_DIR: path.join(local, 'app-tasks'),
    CODING_JOB_STORE_DIR: path.join(local, 'coding-jobs'),
    CREDIT_CALL_STORE_DIR: path.join(local, 'credit-calls'),
  };
  const models = carregarModelos({ env });
  if (models) {
    console.log(`[local] modelos.yaml\n${tabelaModelos({ cfg: models, env })}`);
    // 'SEM CHAVE' is the marker the core's model table prints for a missing key.
    if (descreverModelos({ cfg: models, env }).some((l) => l.principal.includes('SEM CHAVE'))) {
      console.warn('[local] a function has no key in .env (marked above): it will answer "service unavailable".');
    }
  } else if (!['TOGETHER_API_KEY', 'GEMINI_API_KEY', 'OPENAI_API_KEY'].some((k) => env[k])) {
    console.warn('[local] no model key in .env: the server starts, but the chat will answer "service unavailable". See the Quick start in the README.');
  }
  await prepareDatabase(conn, env);

  const base = `http://127.0.0.1:${env.PORT}`;
  const server = spawn(process.execPath, ['server.mjs'], { cwd: path.join(root, 'web'), env, stdio: 'inherit' });
  process.on('exit', () => server.kill());
  server.on('exit', (code) => process.exit(code ?? 0));
  await waitReady(base, server);
  await ensureTestAccount(base);
  if (check) { await checkLogin(base); console.log(`[local] ok: starts, signs up and signs in (${process.platform}-${process.arch})`); process.exit(0); }
  console.log(`\n[local] ready: ${base}\n[local] login: ${TEST_ACCOUNT.email} / ${TEST_ACCOUNT.password}\n[local] Ctrl+C to stop (the database stays in .local/)\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch((e) => { console.error(`[local] ${e.message}`); process.exit(1); });
