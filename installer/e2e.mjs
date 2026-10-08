#!/usr/bin/env node
// End-to-end check of the installer, the way a person uses it (CI runs it on
// Windows, macOS and Linux): first run with the setup page, the owner's account,
// sign-up closed to everyone else, the key never in plain text on disk; starting
// again, the owner signs in; a second copy only points at the one already
// running; the owner sees "This computer" in Settings and changes the AI there
// (keeping the saved key);
// `brambit stop` turns it off. The "AI" is a fake server on 127.0.0.1: nothing
// leaves the machine.
//
// Usage: node installer/e2e.mjs
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
  res.end(JSON.stringify(ok ? { data: [{ id: 'test-model' }] } : { error: 'key' }));
});
await new Promise((r) => ai.listen(0, '127.0.0.1', r));
const aiUrl = `http://127.0.0.1:${ai.address().port}/v1`;
const port = await freePort();

// Starts the installer and waits for the log line that matters.
function launch(waitFor, command = []) {
  const child = spawn(process.execPath, [path.join(root, 'installer', 'brambit.mjs'), ...command, '--no-browser'], {
    env: { ...process.env, BRAMBIT_DATA_DIR: dataDir, BRAMBIT_PORT: String(port) }, stdio: ['ignore', 'pipe', 'inherit'],
  });
  const found = new Promise((resolve, reject) => {
    let out = '';
    child.stdout.on('data', (b) => {
      process.stdout.write(b);
      out += b;
      const m = out.match(waitFor);
      if (m) resolve(m);
    });
    child.on('exit', (code) => reject(new Error(`the installer exited (code ${code})`)));
    setTimeout(() => reject(new Error(`${waitFor} did not show up in 5 min`)), 300_000).unref();
  });
  return { child, found };
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
  const saved = readFileSync(path.join(dataDir, 'installation.json'), 'utf8');
  if (saved.includes(KEY)) fail('the AI key is in plain text on disk');
  if (JSON.parse(saved).audio?.provider !== 'none') fail(`audio should default to off: ${saved}`);
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
  const noSession = await post('/api/installation/change-ai', {}, base);
  if (noSession.ok || 'code' in (await noSession.json().catch(() => ({})))) fail(`changing the AI without a session got through: ${noSession.status}`);

  // 6) Change the AI: the server gives way to the setup page and comes back with the new choice.
  const changeRequest = await post('/api/installation/change-ai', {}, base, session);
  const { code: changeCode } = await changeRequest.json().catch(() => ({}));
  if (changeRequest.status !== 200 || !changeCode) fail(`change the AI: ${changeRequest.status}`);
  let onSetup = false;
  for (let i = 0; i < 120 && !onSetup; i++) {
    try { onSetup = (await fetch(`${base}/?ai`)).headers.get('x-brambit-setup') === '1'; } catch {}
    if (!onSetup) await new Promise((r) => setTimeout(r, 500));
  }
  if (!onSetup) fail('the change-the-AI page did not open');
  const currentAi = await (await fetch(`${base}/current`)).json();
  if (currentAi.model !== 'test-model' || 'key' in currentAi || !currentAi.hasKey) fail(`/current: ${JSON.stringify(currentAi)}`);
  // An empty key for the same provider and address keeps the saved one.
  const changed = await post('/install', { code: changeCode, provider: 'other', url: aiUrl, model: 'test-model', key: '' });
  if (changed.status !== 200) fail(`change the AI: ${changed.status} ${await changed.text()}`);
  await waitForServer();
  const cfg = JSON.parse(readFileSync(path.join(dataDir, 'installation.json'), 'utf8'));
  if (cfg.owner.email !== OWNER.email || !cfg.changedAt) fail('changing the AI touched the owner or did not save');
  if ((await fetch(`${base}/api/installation`, { headers: { cookie: session } })).status !== 200) fail('the owner session did not survive the AI change');
  log('changed the AI and the owner is still signed in');

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
