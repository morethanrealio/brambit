#!/usr/bin/env node
// Brambit on your own computer, for people who are not technical: starts the
// database, the server and opens the browser. The first run opens the setup page
// (who the owner is, which AI to use and its key) and the owner's account is
// created there. After that sign-up is closed: everyone else needs the owner's
// invite.
//
// Data lives outside the program folder (updating deletes nothing), in
// BRAMBIT_DATA_DIR or, without it, in the user's .brambit folder. Everything
// listens on 127.0.0.1 only: nothing is open to the network. To let other people
// at home have their own accounts, `brambit share <https address>` saves the
// address Tailscale Serve gives this computer (installer/shared.mjs) and the
// server uses it in its links; Brambit itself still listens on 127.0.0.1 only.
//
// The settings live in brambit.env in that folder (keys encrypted with the
// vault key next to it) and the AI in models.yaml: the server reads both and
// follows them while it runs (BRAMBIT_CONFIG_FILE, BRAMBIT_MODELS_FILE), and the
// owner edits them in the app (Settings › This computer, plugin installer/plugin).
// installation.json only keeps the port and the date of the setup. What the
// launcher itself decides (address, database, folders) is pinned
// (BRAMBIT_CONFIG_PINNED): the file cannot override it.
//
// Only one copy runs per data folder. While it runs, running.json in that folder
// says how to reach it (a control port on 127.0.0.1 and a token only someone who
// can read the folder has): that is how running `brambit` again just opens the
// browser, `brambit stop` turns it off and `brambit status` asks. The server asks
// for "shutdown" (button in Settings, plugin installer/plugin) over the message
// channel (IPC) this process opens when starting it.
//
// `start` runs in this window; `open` (what the shortcuts and starting with the
// computer run) starts it in the background if needed, with the log in
// brambit.log in the data folder, and opens the browser once it answers.
//
// Usage: node installer/brambit.mjs [start | open | stop | status | share <address> | share off | uninstall] [--no-browser]
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
import { parseModels } from '../core-proto/models.mjs';
import { configValues, ENCRYPTED_PREFIX, writeConfig } from '../web/config-file.mjs';
import { checkAi, writeAi } from './ai-setup.mjs';
import { aiOf, audioOf, endpoint, listModels, modelsYaml, PROVIDERS } from './providers.mjs';
import { SHARED_KEY, sharedUrlOf, tailscaleOff, tailscaleOn } from './shared.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.resolve(process.env.BRAMBIT_DATA_DIR || path.join(os.homedir(), '.brambit'));
const installFile = path.join(dataDir, 'installation.json');
const configFile = path.join(dataDir, 'brambit.env');
const modelsFile = path.join(dataDir, 'models.yaml');
const runningFile = path.join(dataDir, 'running.json');
const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const log = (m) => console.log(`[brambit] ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The keys are stored encrypted in brambit.env by the server's own vault.
process.env.BRAMBS_LOCAL = '1';
process.env.VAULT_KEY_FILE = path.join(dataDir, 'vault.key');
const vault = await import('../web/vault.mjs');

const readInstallation = () => (existsSync(installFile) ? JSON.parse(readFileSync(installFile, 'utf8')) : null);
const CONFIG_HEADER = [
  "# Brambit's settings on this computer. The server follows this file while it runs;",
  '# the owner edits it in the app: Settings › This computer › System settings.',
  '# Keys are saved encrypted (vault:...) with vault.key from this folder.',
  '',
].join('\n');

// A setup saved by an older launcher kept everything in installation.json: the
// owner, the AI and its keys (encrypted with this same vault). It moves to
// brambit.env and models.yaml once, in an order that survives a stop halfway:
// installation.json only loses those fields at the end.
function migrate() {
  const old = readInstallation();
  if (!old?.ai) return old;
  if (!existsSync(configFile)) {
    const audio = audioOf(old);
    const updates = { ADMIN_EMAIL: old.owner.email, BRAMBIT_SIGNUP: 'closed', BRAMBIT_AUDIO_PROVIDER: audio };
    if (old.key) updates[PROVIDERS[old.ai.provider].keyVar] = ENCRYPTED_PREFIX + old.key;
    if (old.audioKey && audio !== 'none') updates[PROVIDERS[audio].keyVar] = ENCRYPTED_PREFIX + old.audioKey;
    writeFileSync(configFile, CONFIG_HEADER, { mode: 0o600 });
    writeConfig(updates, { file: configFile });
  }
  writeFileSync(modelsFile, modelsYaml({ ...old.ai, key: Boolean(old.key) }));
  const slim = { version: 2, port: old.port, createdAt: old.createdAt };
  writeFileSync(installFile, JSON.stringify(slim, null, 2) + '\n', { mode: 0o600 });
  log('settings moved to brambit.env');
  return slim;
}

// The address the others at home open (BRAMBIT_SHARED_URL): brambit.env, or the
// environment when the file does not have it. null: this computer only. An
// invalid one is ignored with a note in the log, so Brambit still starts.
function sharedOf() {
  let value;
  try { value = configValues(readFileSync(configFile, 'utf8'))[SHARED_KEY]; } catch {}
  const shared = sharedUrlOf(value ?? process.env.BRAMBIT_SHARED_URL);
  if (shared.error) log(`${SHARED_KEY} ignored (${shared.error}): Brambit stays on this computer only`);
  return shared.url || null;
}

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

// First-run page: who the owner is and which AI to use (the rest is set later,
// in the app). It only opens with the one-time code carried in the address
// (after the #, so it never shows in a log or in a server's history); it checks
// the Host (another site pointing a domain at 127.0.0.1 gets nothing) and that
// the request came from the page itself (fromSetupPage). Resolves once the AI key was tested and the choice saved; onListen runs
// when the port already answers (before that the browser would land on an error
// page). Changing the AI later is a page of the app itself (installer/plugin).
// Whether a POST came from the setup page itself. The browser sets
// Sec-Fetch-Site (no page can), and it only says "same-origin" for this page;
// some browser extensions rewrite the Origin header, which left the person with
// "Something went wrong" and no way out. Without Sec-Fetch-Site (an old
// browser), the Origin has to match.
function fromSetupPage(req) {
  const site = req.headers['sec-fetch-site'];
  return site ? site === 'same-origin' : req.headers.origin === `http://${req.headers.host}`;
}
// What a refused request carried, for the launcher window: the person only sees
// the page's message, and these headers are not secret.
const shown = (v) => JSON.stringify(String(v || 'none').slice(0, 100));

function serveSetup(port, code, onListen) {
  const page = readFileSync(path.join(root, 'installer', 'setup.html'), 'utf8').replace('__MODE__', 'first');
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
      const json = (status, body) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); };
      if (!hosts.has(String(req.headers.host || ''))) {
        log(`setup page: refused a request for host ${shown(req.headers.host)}`);
        return json(403, { error: 'host' });
      }
      const pathname = String(req.url || '').split('?')[0];
      if (req.method === 'GET' && pathname === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(page.split('__CSP_NONCE__').join(nonce));
      }
      if (req.method !== 'POST' || !['/install', '/models'].includes(pathname)) return json(404, { error: 'not_found' });
      if (!fromSetupPage(req)) {
        log(`setup page: refused a request from another page (Origin ${shown(req.headers.origin)}, Sec-Fetch-Site ${shown(req.headers['sec-fetch-site'])})`);
        return json(403, { error: 'origin' });
      }
      let raw = '';
      for await (const chunk of req) { raw += chunk; if (raw.length > 16384) return json(413, { error: 'too_large' }); }
      let p;
      try { p = JSON.parse(raw); } catch { return json(400, { error: 'body' }); }
      if (attempts >= 10) return json(403, { error: 'code_exhausted' });
      if (!sameText(p.code, code)) { attempts++; return json(403, { error: 'code' }); }
      // The models the key can use, for the page to offer (this also tests the key).
      if (pathname === '/models') {
        const e = endpoint(p);
        if (e.error) return json(400, { error: e.error });
        const r = await listModels(e);
        return r.ok ? json(200, { models: r.models.map((m) => m.id), recommended: r.recommended }) : json(400, { error: r.error, status: r.status });
      }
      const name = String(p.name || '').trim().slice(0, 120);
      const email = String(p.email || '').trim().toLowerCase();
      if (!name || !validEmail(email)) return json(400, { error: 'owner' });
      const r = await checkAi(p);
      if (r.error) return json(400, { error: r.error, status: r.status });
      if (!existsSync(configFile)) writeFileSync(configFile, CONFIG_HEADER, { mode: 0o600 });
      writeAi(r, { configFile, modelsFile, extra: { ADMIN_EMAIL: email, BRAMBIT_SIGNUP: 'closed', BRAMBIT_PROFILE: 'personal' } });
      // Last: without it the next start opens this page again.
      const setup = { version: 2, port, createdAt: new Date().toISOString() };
      writeFileSync(installFile, JSON.stringify(setup, null, 2) + '\n', { mode: 0o600 });
      res.on('finish', () => { server.close(() => resolve(setup)); server.closeIdleConnections(); });
      json(200, { ok: true });
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
  const live = await instance(), setup = readInstallation();
  log(!live ? 'not running'
    : live.phase === 'running' ? `running: ${new URL(live.url).origin}`
      : live.phase === 'setup' ? 'running, with the setup page open' : 'starting');
  log(`data: ${dataDir}`);
  if (!setup) return void (process.exitCode = live ? 0 : 3, log('not set up yet: open Brambit to set it up'));
  // A setup an older launcher saved is only moved on the next start.
  let ai = setup.ai, audio = ai && audioOf(setup);
  if (!ai) {
    try { ai = aiOf(parseModels(readFileSync(modelsFile, 'utf8'), modelsFile)); } catch {}
    try { audio = configValues(readFileSync(configFile, 'utf8')).BRAMBIT_AUDIO_PROVIDER || 'none'; } catch { audio = 'none'; }
  }
  log(ai ? `AI: ${ai.provider} · ${ai.model} · audio: ${audio}` : `AI: not readable from ${modelsFile}`);
  const shared = sharedOf();
  if (shared) log(`shared with other devices at: ${shared}`);
  process.exitCode = live ? 0 : 3;
}

// `brambit share <address>` saves the https address the others at home open
// (what Tailscale Serve answers for this computer); `brambit share off` goes back
// to this computer only. It applies on the next start.
async function share(value) {
  const setup = readInstallation();
  if (!setup || !existsSync(configFile)) {
    log('set Brambit up first: open it once and finish the setup page');
    process.exitCode = 1;
    return;
  }
  const off = /^(off|none|no)$/i.test(String(value || ''));
  const shared = off ? {} : sharedUrlOf(value);
  if (!off && !shared.url) {
    log(shared.error ? `that address does not work: ${shared.error}` : 'usage: brambit share https://<this computer>.<tailnet>.ts.net | off');
    process.exitCode = 2;
    return;
  }
  writeConfig({ [SHARED_KEY]: shared.url || null }, { file: configFile });
  if (off) {
    log('Brambit is for this computer only again');
    log(`to stop Tailscale from answering for it, run: ${tailscaleOff}`);
  } else {
    log(`shared address saved: ${shared.url}`);
    log(`if you have not yet, make Tailscale answer it on this computer: ${tailscaleOn(setup.port)}`);
    log('the others create their account there with your invite code (ask your assistant for it)');
  }
  if (await instance()) log('restart Brambit for this to apply: run "brambit stop" and open it again');
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
  let setup = migrate();
  const port = setup?.port || Number(process.env.BRAMBIT_PORT) || await availablePort(8080);
  const base = `http://127.0.0.1:${port}`;
  // Shared at home: links (emails, invites, images) use the address the others
  // open; this computer still reaches it at base.
  const shared = sharedOf();
  const publicUrl = shared || base;
  const since = new Date().toISOString();
  let phase = 'starting', url = base, server = null, shuttingDown = false;

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

  // What the launcher decides is pinned: brambit.env cannot override it. The
  // rest (owner, keys, channels) the server reads from brambit.env itself.
  const own = {
    ...dbEnvOf(conn),
    HOST: '127.0.0.1', PORT: String(port), PUBLIC_BASE_URL: publicUrl,
    ...(shared && { APP_BASE_URL: `${shared}/` }),
    APP_TASK_STORE_DIR: path.join(dataDir, 'app-tasks'),
    CODING_JOB_STORE_DIR: path.join(dataDir, 'coding-jobs'),
    CREDIT_CALL_STORE_DIR: path.join(dataDir, 'credit-calls'),
    BRAMBIT_LOCALES_DIR: path.join(dataDir, 'locales'),
    BRAMBIT_MODELS_FILE: modelsFile,
    BRAMBIT_PLUGINS: path.join(root, 'installer', 'plugin', 'enabled.mjs'),
    BRAMBIT_INSTALLATION: JSON.stringify({ version, url: base, ...(shared && { shared }), dataDir, since }),
    BRAMBS_LOCAL: '1', VAULT_KEY_FILE: process.env.VAULT_KEY_FILE,
  };
  const env = {
    ...process.env, ...own,
    BRAMBIT_CONFIG_FILE: configFile,
    BRAMBIT_CONFIG_PINNED: Object.keys(own).join(','),
  };

  function startServer() {
    const s = spawn(process.execPath, ['server.mjs'], {
      cwd: path.join(root, 'web'), stdio: ['inherit', 'inherit', 'inherit', 'ipc'], windowsHide: true, env,
    });
    s.on('message', (m) => {
      if (s === server && m?.action === 'shutdown') shutdown();
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

  const db = prepareDatabase(conn, env);
  db.catch(() => {}); // the error shows at the await below
  const firstRun = !setup;
  if (firstRun) {
    const code = randomBytes(18).toString('base64url');
    phase = 'setup';
    url = `${base}/#code=${code}`;
    const done = serveSetup(port, code, () => {
      log(`set up Brambit in your browser: ${url}`);
      if (!noBrowser) openBrowser(url);
    });
    setup = await done;
    phase = 'starting';
    url = base;
    log('setup saved');
  }
  await db;
  await startServer();
  log(`ready: ${base}  (to turn it off, close this window, press Ctrl+C or run "brambit stop")`);
  if (shared) log(`shared with other devices at: ${shared}`);
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
  if (command === 'share') return share(args.filter((a) => !a.startsWith('--'))[1]);
  if (command === 'uninstall') return uninstall();
  console.error('usage: brambit [start | open | stop | status | share <address> | share off | uninstall] [--no-browser]');
  process.exitCode = 2;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch((e) => { console.error(`[brambit] ${e.message}`); process.exit(1); });
