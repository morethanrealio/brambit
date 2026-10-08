#!/usr/bin/env node
// Brambit on your own computer, for people who are not technical: starts the
// database, the server and opens the browser. The first run opens the setup page
// (who the owner is, which AI to use and its key) and the owner's account is
// created there. After that sign-up is closed: everyone else needs the owner's
// invite.
//
// Data lives outside the program folder (updating deletes nothing), in
// BRAMBIT_DATA_DIR or, without it, in the user's .brambit folder. Everything
// listens on 127.0.0.1 only: nothing is open to the network.
//
// Only one copy runs per data folder. While it runs, running.json in that folder
// says how to reach it (a control port on 127.0.0.1 and a token only someone who
// can read the folder has): that is how running `brambit` again just opens the
// browser, `brambit stop` turns it off and `brambit status` asks. The server asks
// for "shutdown" and "change the AI" (buttons in Settings, plugin installer/plugin)
// over the message channel (IPC) this process opens when starting it.
//
// `start` runs in this window; `open` (what the shortcuts and starting with the
// computer run) starts it in the background if needed, with the log in
// brambit.log in the data folder, and opens the browser once it answers.
//
// Usage: node installer/brambit.mjs [start | open | stop | status | uninstall] [--no-browser]
// status exits with 0 when running and 3 when not (like systemctl).
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dbEnvOf, freePort, postgresBin, prepareDatabase, startPostgres, waitReady } from '../dev/local.mjs';
import { choice, modelsYaml, PROVIDERS, testKey } from './providers.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.resolve(process.env.BRAMBIT_DATA_DIR || path.join(os.homedir(), '.brambit'));
const configFile = path.join(dataDir, 'installation.json');
const runningFile = path.join(dataDir, 'running.json');
const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const log = (m) => console.log(`[brambit] ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The AI key is stored encrypted in installation.json by the server's own vault.
process.env.BRAMBS_LOCAL = '1';
process.env.VAULT_KEY_FILE = path.join(dataDir, 'vault.key');
const vault = await import('../web/vault.mjs');

const readConfig = () => (existsSync(configFile) ? JSON.parse(readFileSync(configFile, 'utf8')) : null);

// 8080 if free; otherwise any. It is saved: the address does not change.
const availablePort = (preferred) => new Promise((resolve) => {
  const s = net.createServer().once('error', () => freePort().then(resolve));
  s.listen(preferred, '127.0.0.1', () => s.close(() => resolve(preferred)));
});

export function openBrowser(url) {
  const [cmd, args, extra] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url], { windowsVerbatimArguments: true }]
    : process.platform === 'darwin' ? ['open', [url], {}] : ['xdg-open', [url], {}];
  try { spawn(cmd, args, { stdio: 'ignore', detached: true, ...extra }).on('error', () => {}).unref(); } catch {}
}

const sameText = (a, b) => timingSafeEqual(createHash('sha256').update(String(a)).digest(), createHash('sha256').update(String(b)).digest());
const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e || ''));
const processAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

// Setup page. It only opens with the one-time code carried in the address (after
// the #, so it never shows in a log or in a server's history); it checks the Host
// (another site pointing a domain at 127.0.0.1 gets nothing) and the Origin.
// Resolves with the configuration once the AI key was tested and saved; onListen
// runs when the port already answers (before that the browser would land on an
// error page). With `current` it is the AI change (button in Settings): the owner
// and the port stay, and "Cancel" goes back with the previous configuration.
function serveSetup(port, code, onListen, current = null) {
  const page = readFileSync(path.join(root, 'installer', 'setup.html'), 'utf8').replace('__MODE__', current ? 'change' : 'first');
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  let attempts = 0;
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      const nonce = randomBytes(16).toString('base64');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`);
      // The app looks for this while it waits for the server to hand over to this page.
      res.setHeader('x-brambit-setup', '1');
      const json = (status, body) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); };
      if (!hosts.has(String(req.headers.host || ''))) return json(403, { error: 'host' });
      const pathname = String(req.url || '').split('?')[0];
      if (req.method === 'GET' && pathname === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(page.split('__CSP_NONCE__').join(nonce));
      }
      // The current AI, so the page comes with it selected. Nothing secret: the key is not sent.
      if (req.method === 'GET' && pathname === '/current' && current) return json(200, current.ai);
      if (req.method !== 'POST' || !['/install', '/cancel'].includes(pathname) || (pathname === '/cancel' && !current)) return json(404, { error: 'not_found' });
      if (req.headers.origin !== `http://${req.headers.host}`) return json(403, { error: 'origin' });
      let raw = '';
      for await (const chunk of req) { raw += chunk; if (raw.length > 16384) return json(413, { error: 'too_large' }); }
      let p;
      try { p = JSON.parse(raw); } catch { return json(400, { error: 'body' }); }
      if (attempts >= 10) return json(403, { error: 'code_exhausted' });
      if (!sameText(p.code, code)) { attempts++; return json(403, { error: 'code' }); }
      const finish = (cfg) => { res.on('finish', () => { server.close(() => resolve(cfg)); server.closeIdleConnections(); }); json(200, { ok: true }); };
      if (pathname === '/cancel') return finish(current);
      const name = current ? current.owner.name : String(p.name || '').trim().slice(0, 120);
      const email = current ? current.owner.email : String(p.email || '').trim().toLowerCase();
      if (!name || !validEmail(email)) return json(400, { error: 'owner' });
      const c = choice(p);
      if (c.error) return json(400, { error: c.error });
      const test = await testKey(c);
      if (!test.ok) return json(400, { error: test.error, status: test.status });
      const cfg = {
        version: 1, port, owner: { name, email },
        ai: { provider: c.provider, url: c.url, model: c.model },
        key: c.key ? vault.encryptSecret(c.key) : null,
        createdAt: current?.createdAt || new Date().toISOString(),
        ...(current ? { changedAt: new Date().toISOString() } : {}),
      };
      writeFileSync(configFile, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
      finish(cfg);
    });
    server.once('error', reject);
    server.listen(port, '127.0.0.1', onListen);
  });
}

// The running copy for this data folder, if any: {phase, url, since, running}.
async function instance() {
  let running;
  try { running = JSON.parse(readFileSync(runningFile, 'utf8')); } catch { return null; }
  try {
    const r = await fetch(`http://127.0.0.1:${running.port}/state`, { headers: { authorization: `Bearer ${running.token}` }, signal: AbortSignal.timeout(3000) });
    if (r.ok) return { ...(await r.json()), running };
  } catch {}
  // Left over by a copy that died without cleaning up (window closed, computer turned off).
  if (!processAlive(running.pid)) { try { unlinkSync(runningFile); } catch {} }
  return null;
}

async function status() {
  const live = await instance(), cfg = readConfig();
  log(!live ? 'not running'
    : live.phase === 'running' ? `running: ${new URL(live.url).origin}`
      : live.phase === 'setup' ? 'running, with the setup page open' : 'starting');
  log(`data: ${dataDir}`);
  log(cfg ? `AI: ${cfg.ai.provider} · ${cfg.ai.model}` : 'not set up yet: open Brambit to set it up');
  process.exitCode = live ? 0 : 3;
}

async function stop() {
  const live = await instance();
  if (!live) return log('Brambit is not running');
  const { port, token, pid } = live.running;
  await fetch(`http://127.0.0.1:${port}/stop`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000) }).catch(() => {});
  for (let i = 0; i < 120; i++) {
    if (!processAlive(pid)) return log('stopped');
    await sleep(500);
  }
  log('asked Brambit to stop, but it is still running');
  process.exitCode = 1;
}

// Starts in the background (no window) when it is not running, waits for the
// setup page or the server and opens the browser there.
async function open(noBrowser) {
  let live = await instance();
  const logFile = path.join(dataDir, 'brambit.log');
  if (!live) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    try { if (statSync(logFile).size > 5_000_000) unlinkSync(logFile); } catch {}
    const out = openSync(logFile, 'a');
    spawn(process.execPath, [fileURLToPath(import.meta.url), 'start', '--no-browser'], { detached: true, windowsHide: true, stdio: ['ignore', out, out] }).unref();
    log('starting...');
  }
  for (let i = 0; i < 360 && live?.phase !== 'running' && live?.phase !== 'setup'; i++) {
    await sleep(500);
    live = await instance();
  }
  if (live?.phase !== 'running' && live?.phase !== 'setup') {
    log(`Brambit did not start: see ${logFile}`);
    process.exitCode = 1;
    return;
  }
  log(live.phase === 'setup' ? 'set up Brambit in your browser' : `running: ${new URL(live.url).origin}`);
  if (!noBrowser) openBrowser(live.url);
}

// Takes the shortcuts, the `brambit` command and the program away. The data folder stays.
async function uninstall() {
  const desktop = await import('./desktop.mjs');
  if (!desktop.installed()) {
    log('this copy was not installed by install.ps1 or install.sh: nothing to uninstall');
    process.exitCode = 1;
    return;
  }
  if (await instance()) await stop();
  desktop.uninstall();
  // Windows does not delete the folder of a program still running: a separate
  // command waits for this one to exit first.
  if (process.platform === 'win32') {
    spawn('cmd.exe', ['/d', '/c', `ping -n 3 127.0.0.1 >nul & rmdir /s /q "${desktop.home}"`], { detached: true, windowsHide: true, stdio: 'ignore', windowsVerbatimArguments: true }).unref();
  } else rmSync(desktop.home, { recursive: true, force: true });
  log('Brambit was uninstalled');
  log(`your data is still in ${dataDir}; delete that folder to remove it too`);
}

async function start(noBrowser) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const live = await instance();
  if (live) {
    if (live.phase === 'starting') return log('Brambit is already starting; its address shows in its window');
    log('Brambit is already running');
    if (!noBrowser) openBrowser(live.url);
    return;
  }
  await vault.initVault();
  let cfg = readConfig();
  const port = cfg?.port || Number(process.env.BRAMBIT_PORT) || await availablePort(8080);
  const base = `http://127.0.0.1:${port}`;
  const since = new Date().toISOString();
  let phase = 'starting', url = base, server = null, shuttingDown = false, changing = false;

  // Control: 127.0.0.1 only, Host checked and the token from running.json.
  const token = randomBytes(24).toString('base64url');
  const control = http.createServer((req, res) => {
    const allowed = req.headers.host === `127.0.0.1:${control.address().port}` && sameText(req.headers.authorization || '', `Bearer ${token}`);
    if (!allowed) { res.writeHead(403); return res.end(); }
    res.setHeader('content-type', 'application/json');
    if (req.method === 'GET' && req.url === '/state') return res.end(JSON.stringify({ phase, url, since }));
    if (req.method === 'POST' && req.url === '/stop') { res.end('{"ok":true}'); return shutdown(); }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => control.listen(0, '127.0.0.1', r));
  writeFileSync(runningFile, JSON.stringify({ pid: process.pid, port: control.address().port, token }), { mode: 0o600 });
  process.on('exit', () => {
    try { if (JSON.parse(readFileSync(runningFile, 'utf8')).pid === process.pid) unlinkSync(runningFile); } catch {}
  });

  const { stop: stopDb, conn } = await startPostgres(postgresBin(), path.join(dataDir, 'db'));
  process.on('exit', stopDb);
  process.on('exit', () => { if (server?.exitCode === null) server.kill(); });
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => (shuttingDown ? process.exit(1) : shutdown()));

  const env = {
    ...process.env, ...dbEnvOf(conn),
    HOST: '127.0.0.1', PORT: String(port), PUBLIC_BASE_URL: base,
    APP_TASK_STORE_DIR: path.join(dataDir, 'app-tasks'),
    CODING_JOB_STORE_DIR: path.join(dataDir, 'coding-jobs'),
    CREDIT_CALL_STORE_DIR: path.join(dataDir, 'credit-calls'),
    BRAMBIT_LOCALES_DIR: path.join(dataDir, 'locales'),
  };

  function startServer() {
    const ai = cfg.ai, keyVar = PROVIDERS[ai.provider].keyVar;
    writeFileSync(path.join(dataDir, 'modelos.yaml'), modelsYaml({ ...ai, key: Boolean(cfg.key) }));
    const s = spawn(process.execPath, ['server.mjs'], {
      cwd: path.join(root, 'web'), stdio: ['inherit', 'inherit', 'inherit', 'ipc'], windowsHide: true,
      env: {
        ...env, ADMIN_EMAIL: cfg.owner.email, BRAMBIT_SIGNUP: 'closed',
        MODELOS_ARQUIVO: path.join(dataDir, 'modelos.yaml'),
        BRAMBIT_PLUGINS: path.join(root, 'installer', 'plugin', 'enabled.mjs'),
        BRAMBIT_INSTALLATION: JSON.stringify({ version, url: base, dataDir, ai: { provider: ai.provider, model: ai.model }, since }),
        ...(cfg.key ? { [keyVar]: vault.decryptSecret(cfg.key) } : {}),
      },
    });
    s.on('message', (m) => {
      if (s !== server) return;
      if (m?.action === 'shutdown') shutdown();
      else if (m?.action === 'change-ai' && typeof m.code === 'string' && m.code.length >= 20) changeAi(m.code);
    });
    // A server that dies on its own takes the launcher down (the window shows the error).
    s.on('exit', (code) => { if (s === server && !shuttingDown) process.exit(code ?? 1); });
    server = s;
    return waitReady(base, s).then(() => { phase = 'running'; url = base; });
  }

  // Unix: SIGTERM, and the server waits for turns in progress (60 s cap). Windows
  // has no signal: taskkill takes down the server and whatever it started.
  async function stopServer() {
    const s = server;
    server = null;
    if (!s || s.exitCode !== null || s.signalCode) return;
    const exited = new Promise((r) => s.once('exit', r));
    if (process.platform === 'win32') { try { execFileSync('taskkill', ['/T', '/F', '/PID', String(s.pid)], { stdio: 'ignore' }); } catch {} }
    else s.kill('SIGTERM');
    if (await Promise.race([exited.then(() => true), sleep(70000).then(() => false)])) return;
    s.kill('SIGKILL');
    await exited;
  }

  async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    log('stopping...');
    await stopServer();
    control.close();
    process.exit(0);
  }

  async function changeAi(code) {
    if (changing || shuttingDown) return;
    changing = true;
    log('changing the AI: the assistant is paused until you finish in the browser');
    await stopServer();
    phase = 'setup';
    url = `${base}/?ai#code=${code}`;
    try { cfg = await serveSetup(port, code, null, cfg); }
    catch (e) { log(`the setup page did not open (${e.message}); restarting with the previous AI`); }
    phase = 'starting';
    url = base;
    try { await startServer(); } catch (e) { log(e.message); return shutdown(); }
    changing = false;
    log(`ready again: ${base}`);
  }

  const db = prepareDatabase(conn, env);
  db.catch(() => {}); // the error shows at the await below
  const firstRun = !cfg;
  if (firstRun) {
    const code = randomBytes(18).toString('base64url');
    phase = 'setup';
    url = `${base}/#code=${code}`;
    const done = serveSetup(port, code, () => {
      log(`set up Brambit in your browser: ${url}`);
      if (!noBrowser) openBrowser(url);
    });
    cfg = await done;
    phase = 'starting';
    url = base;
    log('setup saved');
  }
  await db;
  await startServer();
  log(`ready: ${base}  (to turn it off, close this window, press Ctrl+C or run "brambit stop")`);
  // On the first run the setup page is already open and creates the owner's account.
  if (!firstRun && !noBrowser) openBrowser(base);
}

async function main() {
  const args = process.argv.slice(2);
  const command = args.find((a) => !a.startsWith('--')) || 'start';
  if (command === 'status') return status();
  if (command === 'stop') return stop();
  if (command === 'start') return start(args.includes('--no-browser'));
  if (command === 'open') return open(args.includes('--no-browser'));
  if (command === 'uninstall') return uninstall();
  console.error('usage: brambit [start | open | stop | status | uninstall] [--no-browser]');
  process.exitCode = 2;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch((e) => { console.error(`[brambit] ${e.message}`); process.exit(1); });
