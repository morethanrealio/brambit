#!/usr/bin/env node
// Sobe o Brambit na sua máquina: Postgres 14 descartável (mesma versão do prod),
// schema, migrações, uma conta de teste e o servidor. Nada sai daqui: o banco
// escuta só num socket local e os dados ficam em .local/ (apague pra recomeçar).
//
// Uso: npm run local        (lê o .env e o modelos.yaml da raiz; precisa de uma chave de modelo)
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import pg from 'pg';
import { carregarModelos, descreverModelos, tabelaModelos } from '../core-proto/modelos.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const local = path.join(root, '.local');
const pgdata = path.join(local, 'pgdata');
// Socket Unix tem limite de ~100 caracteres no caminho: fica no tmp, não no repo.
const sock = path.join(os.tmpdir(), `brambs-pg-${createHash('sha1').update(root).digest('hex').slice(0, 8)}`);
const DB_USER = 'brambs';
export const TEST_ACCOUNT = { name: 'Conta de Teste', email: 'teste@example.com', password: 'brambs-local-teste' };

export function postgresBin() {
  const pkg = `@embedded-postgres/${process.platform}-${process.arch}`;
  try { return path.resolve(path.dirname(fileURLToPath(import.meta.resolve(pkg))), '..', 'native', 'bin'); }
  catch { throw new Error(`Postgres embutido não instalado pra ${process.platform}-${process.arch}. Rode npm install.`); }
}

// Ordem cronológica: os nomes misturam 2026-09-12 e 20260910.
export const migrationOrder = (names) => [...names].sort((a, b) => a.replace(/-/g, '').localeCompare(b.replace(/-/g, '')));

function readDotEnv() {
  const file = path.join(root, '.env');
  return existsSync(file) ? parseEnv(readFileSync(file, 'utf8')) : {};
}

function startPostgres(bin) {
  mkdirSync(sock, { recursive: true });
  if (!existsSync(path.join(pgdata, 'PG_VERSION'))) {
    mkdirSync(local, { recursive: true });
    execFileSync(path.join(bin, 'initdb'), ['-D', pgdata, '-U', DB_USER, '--auth=trust', '--no-locale', '--encoding=UTF8'], { stdio: 'ignore' });
  }
  execFileSync(path.join(bin, 'pg_ctl'), ['-D', pgdata, '-w', '-l', path.join(local, 'postgres.log'),
    '-o', `-c listen_addresses='' -c unix_socket_directories='${sock}'`, 'start'], { stdio: 'ignore' });
  return () => { try { execFileSync(path.join(bin, 'pg_ctl'), ['-D', pgdata, '-m', 'fast', 'stop'], { stdio: 'ignore' }); } catch {} };
}

const dbEnv = { PGHOST: sock, PGPORT: '5432', PGUSER: DB_USER, PGPASSWORD: '', PGDATABASE: 'postgres' };

async function migrate() {
  const client = new pg.Client({ host: sock, user: DB_USER, database: 'postgres' });
  await client.connect();
  try {
    await client.query('CREATE TABLE IF NOT EXISTS public.local_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const done = new Set((await client.query('SELECT name FROM public.local_migrations')).rows.map((r) => r.name));
    const dir = path.join(root, 'migrations');
    for (const name of migrationOrder(readdirSync(dir).filter((n) => n.endsWith('.sql')))) {
      if (done.has(name)) continue;
      await client.query(readFileSync(path.join(dir, name), 'utf8'));
      await client.query('INSERT INTO public.local_migrations(name) VALUES ($1)', [name]);
      console.log(`[local] migração ${name}`);
    }
  } finally { await client.end(); }
}

// As migrações dependem das tabelas que o initDb cria no boot do servidor (as do
// núcleo e as dos plugins de web/plugins/ativos.mjs, se existir, como no boot).
function initDb(env) {
  execFileSync(process.execPath, ['--input-type=module', '-e',
    "const m=await import('./web/db.mjs');const p=await import('./web/plugins.mjs');const l=await p.carregarPlugins();await m.initDb(...l.map((x)=>x.esquema).filter(Boolean));process.exit(0)"], { cwd: root, env, stdio: ['ignore', 'ignore', 'inherit'] });
}

async function waitReady(base, child) {
  for (let i = 0; i < 120; i++) {
    if (child.exitCode !== null) throw new Error('o servidor parou durante o boot (veja o log acima)');
    try { if ((await fetch(`${base}/api/config`)).ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('o servidor não respondeu em 60s');
}

async function ensureTestAccount(base) {
  const res = await fetch(`${base}/api/signup`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify(TEST_ACCOUNT) });
  if (res.ok || res.status === 409) return;
  console.warn(`[local] não consegui criar a conta de teste (${res.status}): ${(await res.text()).slice(0, 200)}`);
}

async function main() {
  const fileEnv = readDotEnv();
  const env = {
    ...fileEnv, ...process.env, ...dbEnv,
    HOST: '127.0.0.1', PORT: process.env.PORT || fileEnv.PORT || '8080', BRAMBS_LOCAL: '1',
    APP_TASK_STORE_DIR: path.join(local, 'app-tasks'),
    CODING_JOB_STORE_DIR: path.join(local, 'coding-jobs'),
    CREDIT_CALL_STORE_DIR: path.join(local, 'credit-calls'),
  };
  const modelos = carregarModelos({ env });
  if (modelos) {
    console.log(`[local] modelos.yaml\n${tabelaModelos({ cfg: modelos, env })}`);
    if (descreverModelos({ cfg: modelos, env }).some((l) => l.principal.includes('SEM CHAVE'))) {
      console.warn('[local] tem função sem chave no .env (marcada acima): ela vai responder "serviço indisponível".');
    }
  } else if (!['TOGETHER_API_KEY', 'GEMINI_API_KEY', 'OPENAI_API_KEY'].some((k) => env[k])) {
    console.warn('[local] nenhuma chave de modelo no .env: o servidor sobe, mas o chat vai responder "serviço indisponível". Veja o Quick start no README.');
  }
  const stop = startPostgres(postgresBin());
  process.on('exit', stop);
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(0));
  const admin = new pg.Client({ host: sock, user: DB_USER, database: 'postgres' });
  await admin.connect(); await admin.query('CREATE SCHEMA IF NOT EXISTS mtr_harness'); await admin.end();
  initDb(env);
  await migrate();

  const base = `http://127.0.0.1:${env.PORT}`;
  const server = spawn(process.execPath, ['server.mjs'], { cwd: path.join(root, 'web'), env, stdio: 'inherit' });
  process.on('exit', () => server.kill());
  server.on('exit', (code) => process.exit(code ?? 0));
  await waitReady(base, server);
  await ensureTestAccount(base);
  console.log(`\n[local] pronto: ${base}\n[local] login: ${TEST_ACCOUNT.email} / ${TEST_ACCOUNT.password}\n[local] Ctrl+C para parar (o banco fica em .local/)\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch((e) => { console.error(`[local] ${e.message}`); process.exit(1); });
