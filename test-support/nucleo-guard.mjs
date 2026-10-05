#!/usr/bin/env node
// Trava do núcleo (passo 11d da separação núcleo x nuvem). O nuvem.txt da raiz lista
// os arquivos da nuvem Brambs; todo o resto é o núcleo, que vai ser aberto. Duas provas:
//
//  1. Nenhum arquivo do núcleo importa arquivo da nuvem, nem o sobe como processo, nem
//     cita o caminho dele (lê, copia, testa; mesmo grafo do affected.mjs). Ligação com a
//     nuvem só pelas portas e pelo web/plugins/ativos.mjs, que o núcleo procura e, sem
//     ele, segue só com os padrões.
//  2. O núcleo sobe sozinho: copia o repositório SEM nenhum arquivo da nuvem pra uma
//     pasta temporária e faz o que o `npm run local` faz (Postgres descartável, tabelas
//     do boot, migrações, servidor), com a rede bloqueada como no server-boot.test.mjs.
//     Confere as páginas, o cadastro e o login de uma conta.
//
// Uso: node test-support/nucleo-guard.mjs          (as duas provas)
//      node test-support/nucleo-guard.mjs --sem-boot (só a 1)
// Sem o nuvem.txt (no repositório do núcleo) a nuvem é vazia: a 1 passa e a 2 sobe o repo como está.
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { migrationOrder, postgresBin } from '../dev/local.mjs';
import { buildGraph } from './affected.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const MANIFESTO = 'nuvem.txt';

// Linhas do nuvem.txt viram um teste por arquivo: pasta (termina em /), padrão com * ou caminho exato.
export function lerNuvem(texto) {
  const entradas = texto.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  const teste = (e) => {
    if (e.endsWith('/')) return (f) => f.startsWith(e);
    if (e.includes('*')) {
      const re = new RegExp(`^${e.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')}$`);
      return (f) => re.test(f);
    }
    return (f) => f === e;
  };
  const testes = entradas.map((e) => [e, teste(e)]);
  return { entradas: testes, ehNuvem: (f) => testes.some(([, t]) => t(f)) };
}

// Única citação de arquivo da nuvem permitida no núcleo: onde ele procura os plugins.
const PONTES = new Set(['web/plugins.mjs>web/plugins/ativos.mjs']);

// Prova 1. Devolve os problemas em texto (vazio = ok).
export function conferirImports(files, read, nuvem) {
  const problemas = [];
  for (const [e, t] of nuvem.entradas) if (!files.some(t)) problemas.push(`${MANIFESTO}: "${e}" não corresponde a nenhum arquivo (tire a linha)`);
  for (const [f, d] of buildGraph(files, read)) {
    if (nuvem.ehNuvem(f)) continue;
    const ruins = [...d.imports].filter(nuvem.ehNuvem);
    if (ruins.length) problemas.push(`${f} (núcleo) importa da nuvem: ${ruins.join(', ')}`);
    const citados = [...d.refs].filter((r) => nuvem.ehNuvem(r) && !PONTES.has(`${f}>${r}`));
    if (citados.length) problemas.push(`${f} (núcleo) cita arquivo da nuvem: ${citados.join(', ')}`);
  }
  return problemas;
}

const espera = (ms) => new Promise((r) => setTimeout(r, ms));
function pedir(port, rota, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const q = http.request({ hostname: '127.0.0.1', port, path: rota, method, headers }, (r) => {
      let b = ''; r.on('data', (x) => b += x); r.on('end', () => resolve({ status: r.statusCode, headers: r.headers, body: b }));
    });
    q.on('error', (e) => reject(Error(`${method} ${rota}: ${e.message}`))); q.setTimeout(5000, () => q.destroy(Error(`sem resposta em ${rota}`)));
    q.end(body);
  });
}

// Prova 2. Joga erro com o log do servidor se algo falhar.
export async function bootSemNuvem(files, nuvem) {
  const bin = process.env.TEST_POSTGRES_BIN || postgresBin();
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'brambs-boot-test-nucleo-'));
  const copia = path.join(tmp, 'repo'), socket = path.join(tmp, 'socket'), dados = path.join(tmp, 'pg');
  const pgcmd = (n, a) => execFileSync(path.join(bin, n), a, { stdio: 'ignore', timeout: 30000, env: { PATH: process.env.PATH, LANG: 'C', LC_ALL: 'C', HOME: tmp } });
  let servidor, pgLigado = false, log = '';
  const parar = async () => {
    const p = servidor; servidor = null;
    if (!p || p.exitCode !== null) return p?.exitCode;
    p.kill('SIGTERM'); await Promise.race([new Promise((r) => p.once('exit', r)), espera(5000)]);
    if (p.exitCode === null) { p.kill('SIGKILL'); await new Promise((r) => p.once('exit', r)); }
    return p.exitCode;
  };
  try {
    const nucleo = files.filter((f) => !nuvem.ehNuvem(f) && existsSync(path.join(root, f)));
    for (const f of nucleo) cpSync(path.join(root, f), path.join(copia, f));
    for (const f of files.filter(nuvem.ehNuvem)) if (existsSync(path.join(copia, f))) throw Error(`${f} é da nuvem e foi copiado`);
    symlinkSync(path.join(root, 'node_modules'), path.join(copia, 'node_modules'), 'dir');
    console.log(`núcleo copiado: ${nucleo.length} arquivos (${files.length - nucleo.length} da nuvem de fora)`);

    mkdirSync(socket);
    pgcmd('initdb', ['-D', dados, '-U', 'nucleo', '--auth=trust', '--no-locale', '--encoding=UTF8']);
    pgcmd('pg_ctl', ['-D', dados, '-l', path.join(tmp, 'pg.log'), '-o', `-c listen_addresses='' -c unix_socket_directories='${socket}'`, '-w', 'start']);
    pgLigado = true;
    const db = new pg.Client({ host: socket, user: 'nucleo', database: 'postgres' });
    await db.connect();
    await db.query('CREATE SCHEMA mtr_harness');

    const observador = path.join(tmp, 'porta.mjs');
    writeFileSync(observador, "import net from 'node:net';const l=net.Server.prototype.listen;net.Server.prototype.listen=function(...a){this.once('listening',()=>console.log('BOOT_TEST_PORT='+this.address().port));return l.apply(this,a);};");
    const env = { PATH: process.env.PATH, HOME: tmp, TZ: 'UTC', PGHOST: socket, PGPORT: '5432', PGUSER: 'nucleo', PGDATABASE: 'postgres', PGPASSWORD: '',
      PORT: '0', HOST: '127.0.0.1', TEST_BOOT_SOCKET: socket, VAULT_KEY: Buffer.alloc(32, 7).toString('base64'),
      APP_TASK_STORE_DIR: path.join(tmp, 'tasks'), CODING_JOB_STORE_DIR: path.join(tmp, 'jobs'), CREDIT_CALL_STORE_DIR: path.join(tmp, 'calls') };
    const subir = async () => {
      log = '';
      servidor = spawn(process.execPath, ['--import', path.join(copia, 'test-support/boot-network-guard.mjs'), '--import', observador, 'web/server.mjs'],
        { cwd: copia, env, stdio: ['ignore', 'pipe', 'pipe'] });
      servidor.stdout.on('data', (b) => log += b); servidor.stderr.on('data', (b) => log += b);
      for (let i = 0; i < 300; i++) {
        const porta = log.match(/BOOT_TEST_PORT=(\d+)/)?.[1];
        if (porta) return Number(porta);
        if (servidor.exitCode !== null) break;
        await espera(100);
      }
      throw Error('o servidor do núcleo não subiu');
    };
    const conferir = (cond, msg) => { if (!cond) throw Error(msg); };

    // 1º boot: o servidor cria as tabelas do núcleo; depois entram as migrações, como no npm run local.
    await subir();
    conferir(await parar() === 0, 'o servidor não saiu limpo no SIGTERM');
    for (const n of migrationOrder(readdirSync(path.join(copia, 'migrations')).filter((n) => n.endsWith('.sql')))) {
      try { await db.query(readFileSync(path.join(copia, 'migrations', n), 'utf8')); }
      catch (e) { throw Error(`migração ${n} falhou no banco do núcleo: ${e.message}`); }
    }
    await db.end();

    // 2º boot, já migrado: páginas, cadastro e login.
    const porta = await subir();
    for (const [rota, st] of [['/', 200], ['/login', 200], ['/api/config', 200], ['/api/me', 401]]) {
      const r = await pedir(porta, rota);
      conferir(r.status === st, `${rota} deu ${r.status}, esperado ${st}`);
    }
    const origem = `http://127.0.0.1:${porta}`;
    const cadastro = await pedir(porta, '/api/signup', { method: 'POST', headers: { 'content-type': 'application/json', origin: origem },
      body: JSON.stringify({ name: 'Conta do núcleo', email: 'nucleo@example.invalid', password: randomBytes(12).toString('hex') }) });
    conferir(cadastro.status === 200, `cadastro deu ${cadastro.status}: ${cadastro.body.slice(0, 200)}`);
    const cookie = String(cadastro.headers['set-cookie'] || '').split(';')[0];
    conferir(cookie.includes('='), 'cadastro sem cookie de sessão');
    const eu = await pedir(porta, '/api/me', { headers: { cookie } });
    conferir(eu.status === 200 && JSON.parse(eu.body).name === 'Conta do núcleo', `/api/me logado deu ${eu.status}`);
    conferir(await parar() === 0, 'o servidor não saiu limpo no SIGTERM');
    conferir(!/ERR_MODULE_NOT_FOUND|Cannot find module|ReferenceError|SyntaxError|Falha ao inicializar o banco/.test(log), 'erro no log do servidor');
    console.log('núcleo sem a nuvem: 2 boots, migrações, páginas, cadastro e login ok');
  } catch (e) {
    await espera(500);
    e.message += `\n--- log do servidor ---\n${log.slice(-4000)}`;
    throw e;
  } finally {
    await parar();
    if (pgLigado) try { pgcmd('pg_ctl', ['-D', dados, '-m', 'immediate', 'stop']); } catch {}
    rmSync(tmp, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const files = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
  const manifesto = path.join(root, MANIFESTO);
  const nuvem = lerNuvem(existsSync(manifesto) ? readFileSync(manifesto, 'utf8') : '');
  const problemas = conferirImports(files, (f) => readFileSync(path.join(root, f), 'utf8'), nuvem);
  if (problemas.length) {
    console.error(`Núcleo dependendo da nuvem (${MANIFESTO}). Mova a ligação pra uma porta/plugin ou, se o arquivo é da nuvem, liste-o lá:\n  ${problemas.join('\n  ')}`);
    process.exit(1);
  }
  console.log(`imports: nenhum arquivo do núcleo importa nem cita a nuvem (${files.filter(nuvem.ehNuvem).length} arquivos da nuvem)`);
  if (!process.argv.includes('--sem-boot')) {
    try { await bootSemNuvem(files, nuvem); }
    catch (e) { console.error(e.message); process.exit(1); }
  }
}
