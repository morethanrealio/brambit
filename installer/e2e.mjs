#!/usr/bin/env node
// End-to-end check of the installer, the way a person uses it (CI runs it on
// Windows, macOS and Linux): first run with the setup page, the owner's account,
// sign-up closed to everyone else, the key never in plain text on disk; starting
// again, the owner signs in; a second copy only points at the one already
// running; the owner sees "This computer" in Settings and changes the AI there
// while the assistant keeps running (keeping the saved key);
// `brambit stop` turns it off. The "AI" is a fake server on 127.0.0.1: nothing
// leaves the machine.
//
// Usage: node installer/e2e.mjs
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePort, postgresBin, stopPostgres } from '../dev/local.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = mkdtempSync(path.join(os.tmpdir(), 'brambit-e2e-'));
const KEY = 'test-key-that-must-not-reach-the-disk';
const OWNER = { name: 'Brambit Owner', email: 'owner@example.com', password: 'a-long-enough-password-1' };
const log = (m) => console.log(`[e2e] ${m}`);
const fail = (m) => { throw new Error(m); };

// Fake AI: only the model list, which is what the key test asks for.
const ai = http.createServer((req, res) => {
  const ok = req.url === '/v1/models' && req.headers.authorization === `Bearer ${KEY}`;
  res.writeHead(ok ? 200 : 401, { 'content-type': 'application/json' });
  res.end(JSON.stringify(ok ? { data: [{ id: 'test-model' }, { id: 'other-model' }] } : { error: 'key' }));
});
await new Promise((r) => ai.listen(0, '127.0.0.1', r));
const aiUrl = `http://127.0.0.1:${ai.address().port}/v1`;
const port = await freePort();

// Starts the installer and waits for the log line that matters.
function launch(waitFor, command = []) {
  const child = spawn(process.execPath, [path.join(root, 'installer', 'brambit.mjs'), ...command, '--no-browser'], {
    env: { ...process.env, BRAMBIT_DATA_DIR: dataDir, BRAMBIT_PORT: String(port) }, stdio: ['ignore', 'pipe', 'inherit'],
  });
  const all = { out: '' };
  const found = new Promise((resolve, reject) => {
    let out = '';
    child.stdout.on('data', (b) => {
      process.stdout.write(b);
      out += b;
      all.out += b;
      const m = out.match(waitFor);
      if (m) resolve(m);
    });
    child.on('exit', (code) => reject(new Error(`the installer exited (code ${code})`)));
    setTimeout(() => reject(new Error(`${waitFor} did not show up in 5 min`)), 300_000).unref();
  });
  return { child, found, all };
}

// On Windows kill does not take down the child server: taskkill takes the tree.
function kill(child) {
  if (child.exitCode !== null) return Promise.resolve();
  const exited = new Promise((r) => child.once('exit', r));
  if (process.platform === 'win32') { try { execFileSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore' }); } catch {} }
  else child.kill('SIGTERM');
  return exited;
}

const base = `http://127.0.0.1:${port}`;
const post = (url, body, origin = base, cookie = '') => fetch(`${base}${url}`, { method: 'POST', headers: { 'content-type': 'application/json', origin, cookie }, body: JSON.stringify(body) });
const cookieOf = (res) => res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
// Runs a launcher command to the end: {code, out}.
function run(command) {
  const { child, found } = launch(/$^/, command);
  found.catch(() => {});
  let out = '';
  child.stdout.on('data', (b) => { out += b; });
  return new Promise((r) => child.on('exit', (code) => r({ code, out })));
}
async function waitForServer() {
  for (let i = 0; i < 240; i++) {
    try { if ((await fetch(`${base}/api/config`)).ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  fail('the server did not start after the setup');
}

let current;
try {
  // 1) First run: the setup page.
  current = launch(/set up Brambit in your browser: (http:\S+)#code=(\S+)/);
  const [, url, code] = await current.found;
  const page = await fetch(url);
  const csp = page.headers.get('content-security-policy') || '';
  if (page.status !== 200 || !/script-src 'nonce-[^']+'/.test(csp)) fail(`setup page: ${page.status} ${csp}`);
  if ((await page.text()).includes('__CSP_NONCE__')) fail('the page went out without the nonce replaced');
  const request = { code, name: OWNER.name, email: OWNER.email, provider: 'other', url: aiUrl, model: 'test-model', key: KEY };
  if ((await post('/install', { ...request, code: 'wrong' })).status !== 403) fail('a wrong code got through');
  if ((await post('/install', request, 'http://evil.example')).status !== 403) fail('another origin got through');
  const listed = await (await post('/models', { code, provider: 'other', url: aiUrl, key: KEY })).json();
  if (!listed.models?.includes('test-model')) fail(`the model list did not come: ${JSON.stringify(listed)}`);
  // A provider without audio, and audio left to its default: voice messages off.
  if ((await (await post('/install', { ...request, audio: 'openai' })).json()).error !== 'audio_missing_key') fail('another audio provider got through without its key');
  const rejected = await post('/install', { ...request, key: 'other' });
  if ((await rejected.json()).error !== 'key_rejected') fail('a wrong key was not rejected');
  const install = await post('/install', request);
  if (install.status !== 200) fail(`setup: ${install.status} ${await install.text()}`);
  log('setup accepted');

  // 2) The real server starts on the same address; the owner creates the account.
  await waitForServer();
  const signup = await post('/api/signup', { name: OWNER.name, email: OWNER.email, password: OWNER.password });
  if (signup.status !== 200) fail(`owner sign-up: ${signup.status} ${await signup.text()}`);
  const cookies = signup.headers.getSetCookie();
  if (!cookies.length || cookies.some((c) => /;\s*Secure/i.test(c))) fail(`the same-computer cookie should come without Secure: ${cookies}`);
  const other = await post('/api/signup', { name: 'Someone Else', email: 'someone@example.com', password: OWNER.password });
  if (other.status !== 403) fail(`someone else's sign-up should be refused, got ${other.status}`);
  // The settings go in brambit.env, the file the server reads and the System
  // settings screen edits; installation.json keeps only the port.
  const configFile = path.join(dataDir, 'brambit.env');
  const settings = readFileSync(configFile, 'utf8');
  if (settings.includes(KEY) || !/^OTHER_API_KEY=vault:v1:/m.test(settings)) fail('the AI key is not encrypted in brambit.env');
  if (!/^BRAMBIT_AUDIO_PROVIDER=none$/m.test(settings) || !settings.includes(`ADMIN_EMAIL=${OWNER.email}`)) fail(`brambit.env: ${settings.replace(/vault:\S+/g, 'vault:…')}`);
  if (process.platform !== 'win32' && (statSync(configFile).mode & 0o077)) fail('brambit.env is readable by other users');
  const saved = JSON.parse(readFileSync(path.join(dataDir, 'installation.json'), 'utf8'));
  if (Object.keys(saved).sort().join() !== 'createdAt,port,version') fail(`installation.json: ${JSON.stringify(saved)}`);
  log('owner account created, sign-up closed to others, key encrypted');

  // 3) Start again: no setup, straight to the server; the owner signs in.
  await kill(current.child);
  stopPostgres(postgresBin(), path.join(dataDir, 'db'));
  current = launch(/ready: http/);
  await current.found;
  const login = await post('/api/login', { email: OWNER.email, password: OWNER.password });
  if (login.status !== 200) fail(`owner login after restarting: ${login.status} ${await login.text()}`);
  const session = cookieOf(login);
  log('started again and the owner signed in');

  // 4) Starting again while it runs only points at the copy already running.
  const second = await run([]);
  if (second.code !== 0 || !/already running/.test(second.out)) fail(`second copy: code ${second.code}, ${second.out}`);
  const st = await run(['status']);
  if (st.code !== 0 || !st.out.includes(`running: ${base}`)) fail(`status: code ${st.code}, ${st.out}`);
  log('a second copy does not start another; status says running');

  // 5) "This computer" in Settings: only the owner sees it.
  if ((await fetch(`${base}/api/installation`)).status !== 404) fail('/api/installation without a session should be 404');
  const info = await fetch(`${base}/api/installation`, { headers: { cookie: session } });
  const j = await info.json().catch(() => ({}));
  if (info.status !== 200 || j.ai?.model !== 'test-model' || j.audio !== 'none' || j.dataDir !== dataDir) fail(`owner's /api/installation: ${info.status} ${JSON.stringify(j)}`);
  if ((await post('/api/installation/ai', { provider: 'other', url: aiUrl, model: 'other-model', key: KEY }, base)).ok) fail('changing the AI without a session got through');
  if ((await fetch(`${base}/installation/ai`, { redirect: 'manual' })).status !== 302) fail('the change-the-AI page should send the signed out to sign in');

  // 6) Change the AI from inside the app: the server stays up and follows the new choice.
  const changePage = await fetch(`${base}/installation/ai`, { headers: { cookie: session } });
  if (changePage.status !== 200 || !(await changePage.text()).includes('data-mode="change"')) fail(`change-the-AI page: ${changePage.status}`);
  const currentAi = await (await fetch(`${base}/api/installation/ai`, { headers: { cookie: session } })).json();
  if (currentAi.model !== 'test-model' || JSON.stringify(currentAi).includes(KEY) || !currentAi.savedKeys?.includes('other')) fail(`/api/installation/ai: ${JSON.stringify(currentAi)}`);
  // An empty key for the same provider and address keeps the saved one.
  const models = await (await post('/api/installation/models', { provider: 'other', url: aiUrl, key: '' }, base, session)).json();
  if (!models.models?.includes('other-model')) fail(`models with the saved key: ${JSON.stringify(models)}`);
  if ((await (await post('/api/installation/ai', { provider: 'other', url: aiUrl, model: 'other-model', key: 'wrong' }, base, session)).json()).error !== 'key_rejected') fail('a wrong key was saved');
  const changed = await post('/api/installation/ai', { provider: 'other', url: aiUrl, model: 'other-model', key: '' }, base, session);
  if (changed.status !== 200) fail(`change the AI: ${changed.status} ${await changed.text()}`);
  const after = await (await fetch(`${base}/api/installation`, { headers: { cookie: session } })).json();
  if (after.ai?.model !== 'other-model') fail(`the new model did not take: ${JSON.stringify(after)}`);
  if (!readFileSync(configFile, 'utf8').match(/^OTHER_API_KEY=vault:v1:/m)) fail('the saved key was lost');
  if ((current.all.out.match(/ready: http/g) || []).length !== 1) fail('the server restarted to change the AI');
  log('changed the AI with the server running and the owner signed in');

  // 7) brambit stop turns everything off.
  const stopped = await run(['stop']);
  if (!/\] stopped$/m.test(stopped.out)) fail(`stop: ${stopped.out}`);
  if (current.child.exitCode === null) await Promise.race([new Promise((r) => current.child.once('exit', r)), new Promise((_, rej) => setTimeout(() => rej(new Error('Brambit did not stop')), 10_000))]);
  if (existsSync(path.join(dataDir, 'running.json'))) fail('running.json was left behind');
  log('brambit stop turned it off: all good');
} catch (e) {
  process.exitCode = 1;
  console.error(`[e2e] FAILED: ${e.message}`);
  try { console.error(readFileSync(path.join(dataDir, 'db', 'postgres.log'), 'utf8').slice(-4000)); } catch {}
} finally {
  if (current) await kill(current.child);
  stopPostgres(postgresBin(), path.join(dataDir, 'db'));
  ai.close();
  if (process.exitCode) log(`data kept for inspection: ${dataDir}`);
  else rmSync(dataDir, { recursive: true, force: true, maxRetries: 5 });
}
process.exit();
