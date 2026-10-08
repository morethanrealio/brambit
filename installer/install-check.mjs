#!/usr/bin/env node
// Checks a copy installed by install.ps1 / install.sh the way a person meets it
// (CI runs the real installer on Windows, macOS and Linux and then this): the
// `brambit` command and the shortcuts exist; `brambit open` starts it in the
// background with the setup page; after the setup the server answers; `status`,
// `stop` and `uninstall` work, and uninstalling takes the program and the
// shortcuts away but keeps the data. The "AI" is a fake server on 127.0.0.1.
//
// Usage: BRAMBIT_HOME=<program folder> BRAMBIT_DATA_DIR=<data folder> node installer/install-check.mjs
import { execFileSync, spawnSync } from 'node:child_process';
import { closeSync, existsSync, lstatSync, openSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const home = process.env.BRAMBIT_HOME, dataDir = process.env.BRAMBIT_DATA_DIR;
if (!home || !dataDir) { console.error('[install-check] set BRAMBIT_HOME and BRAMBIT_DATA_DIR'); process.exit(2); }
const KEY = 'install-check-key';
const win = process.platform === 'win32';
const log = (m) => console.log(`[install-check] ${m}`);
const fail = (m) => { throw new Error(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shim = path.join(home, 'bin', win ? 'brambit.cmd' : 'brambit');

// What the installer puts outside the program folder, per system.
function placed() {
  const h = os.homedir();
  if (win) {
    const folders = execFileSync('powershell.exe', ['-NoProfile', '-Command',
      "'Programs','Desktop','Startup' | ForEach-Object { [Environment]::GetFolderPath($_) }"], { encoding: 'utf8' }).trim().split(/\r?\n/);
    return folders.map((f) => path.join(f.trim(), 'Brambit.lnk'));
  }
  const local = [path.join(h, '.local', 'bin', 'brambit')];
  if (process.platform === 'darwin') {
    return [...local, path.join(h, 'Applications', 'Brambit.app', 'Contents', 'Info.plist'), path.join(h, 'Library', 'LaunchAgents', 'io.github.morethanrealio.brambit.plist')];
  }
  return [...local, path.join(h, '.local', 'share', 'applications', 'brambit.desktop'), path.join(h, '.config', 'autostart', 'brambit.desktop')];
}
const present = (f) => { try { lstatSync(f); return true; } catch { return false; } };
const userPath = () => execFileSync('powershell.exe', ['-NoProfile', '-Command', "[Environment]::GetEnvironmentVariable('Path', 'User')"], { encoding: 'utf8' });

// The installed `brambit` command, as a terminal runs it. Windows runs .cmd only through cmd.
// Output goes to a file, not a pipe: `open` leaves Brambit running, and on Windows it
// would inherit the pipe and keep this waiting until Brambit stops.
// One file per run: Brambit left running may still hold the previous one.
const outFiles = [];
function brambit(...args) {
  const outFile = path.join(os.tmpdir(), `brambit-install-check-${process.pid}-${outFiles.length}.log`);
  outFiles.push(outFile);
  const fd = openSync(outFile, 'w');
  const opts = { stdio: ['ignore', fd, fd], timeout: 300_000 };
  const r = win
    ? spawnSync('cmd.exe', ['/d', '/s', '/c', `"${shim}" ${args.join(' ')}`], { ...opts, windowsVerbatimArguments: true })
    : spawnSync(shim, args, opts);
  closeSync(fd);
  const out = readFileSync(outFile, 'utf8');
  process.stdout.write(out);
  return { code: r.status, out };
}

// Fake AI: only the model list, which is what the key test asks for.
const ai = http.createServer((req, res) => {
  const ok = req.url === '/v1/models' && req.headers.authorization === `Bearer ${KEY}`;
  res.writeHead(ok ? 200 : 401, { 'content-type': 'application/json' });
  res.end(JSON.stringify(ok ? { data: [{ id: 'test-model' }] } : { error: 'key' }));
});
await new Promise((r) => ai.listen(0, '127.0.0.1', r));

try {
  for (const f of [path.join(home, '.brambit-install'), shim, ...placed()]) if (!present(f)) fail(`missing after the install: ${f}`);
  if (win && !userPath().split(';').includes(path.join(home, 'bin'))) fail('the bin folder is not on the user PATH');
  log('command and shortcuts in place');

  // 1) open: starts in the background and stops at the setup page.
  const opened = brambit('open', '--no-browser');
  if (opened.code !== 0 || !/set up Brambit in your browser/.test(opened.out)) fail(`open: code ${opened.code}`);
  const running = JSON.parse(readFileSync(path.join(dataDir, 'running.json'), 'utf8'));
  const state = await (await fetch(`http://127.0.0.1:${running.port}/state`, { headers: { authorization: `Bearer ${running.token}` } })).json();
  const [, base, code] = state.url.match(/^(http:\/\/[^/]+)\/#code=(.+)$/) || fail(`setup url: ${state.url}`);
  const install = await fetch(`${base}/install`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ code, name: 'Install Check', email: 'owner@example.com', provider: 'other', url: `http://127.0.0.1:${ai.address().port}/v1`, model: 'test-model', key: KEY }),
  });
  if (install.status !== 200) fail(`setup: ${install.status} ${await install.text()}`);
  let up = false;
  for (let i = 0; i < 240 && !up; i++) {
    try { up = (await fetch(`${base}/api/config`)).ok; } catch {}
    if (!up) await sleep(500);
  }
  if (!up) fail('the server did not start after the setup');
  log('open started it in the background and the setup brought the server up');

  // 2) status, open again (only points at it) and stop.
  const st = brambit('status');
  if (st.code !== 0 || !st.out.includes(`running: ${base}`)) fail(`status: code ${st.code}`);
  const again = brambit('open', '--no-browser');
  if (again.code !== 0 || !again.out.includes(`running: ${base}`)) fail(`open while running: code ${again.code}`);
  const stopped = brambit('stop');
  if (!/\] stopped\s*$/m.test(stopped.out)) fail('stop did not stop it');
  log('status, open while running and stop work');

  // 3) uninstall: program and shortcuts gone, data kept. Windows deletes the folder
  // a moment after the command exits.
  const removed = brambit('uninstall');
  if (removed.code !== 0) fail(`uninstall: code ${removed.code}`);
  for (let i = 0; i < 60 && existsSync(home); i++) await sleep(500);
  if (existsSync(home)) fail(`the program folder is still there: ${home}`);
  const left = placed().filter(present);
  if (left.length) fail(`left behind: ${left.join(', ')}`);
  if (win && userPath().split(';').includes(path.join(home, 'bin'))) fail('the bin folder is still on the user PATH');
  if (!existsSync(path.join(dataDir, 'installation.json'))) fail('uninstalling deleted the data');
  log('uninstall took everything away and kept the data: all good');
} catch (e) {
  process.exitCode = 1;
  console.error(`[install-check] FAILED: ${e.message}`);
  try { console.error(readFileSync(path.join(dataDir, 'brambit.log'), 'utf8').slice(-6000)); } catch {}
  if (existsSync(shim)) brambit('stop');
} finally {
  ai.close();
  for (const f of outFiles) try { rmSync(f, { force: true }); } catch {}
}
process.exit();
