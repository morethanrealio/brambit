// Background services that follow the config file (web/live-services.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startConfigFile, stopConfigFile, writeConfig } from '../web/config-file.mjs';
import { registerLiveService } from '../web/live-services.mjs';

const quiet = { log() {}, warn() {}, error() {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('settles flapping, stops, restarts on a new target and never overlaps', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brambit-live-'));
  const file = path.join(dir, '.env');
  fs.writeFileSync(file, 'SVC_ADDR=a\n');
  const env = { BRAMBIT_CONFIG_FILE: file };
  t.after(stopConfigFile);
  startConfigFile({ env, watchMs: 0, log: quiet });

  const calls = [];
  let busy = false;
  const step = async (what) => {
    assert.equal(busy, false, 'start and stop overlapped');
    busy = true; calls.push(what); await sleep(30); busy = false;
  };
  const svc = registerLiveService({
    name: 'svc', keys: ['SVC_ADDR'], settleMs: 60, log: quiet,
    wanted: () => !!env.SVC_ADDR, target: () => env.SVC_ADDR,
    start: ({ live }) => step(live ? 'start-live' : 'start-boot'),
    stop: () => step('stop'),
  });
  await svc.boot();
  assert.deepEqual(calls, ['start-boot']);

  // A value removed and written back right away (an editor saving in two steps): nothing happens.
  writeConfig({ SVC_ADDR: null });
  writeConfig({ SVC_ADDR: 'a' });
  await sleep(120);
  assert.deepEqual(calls, ['start-boot']);

  // Removed for good: stops once settled.
  writeConfig({ SVC_ADDR: null });
  await sleep(150);
  assert.deepEqual(calls, ['start-boot', 'stop']);
  assert.equal(svc.running, false);

  // Back, then pointed elsewhere while starting: the stop waits for the start.
  writeConfig({ SVC_ADDR: 'a' });
  await sleep(70);
  writeConfig({ SVC_ADDR: 'b' });
  await sleep(250);
  assert.deepEqual(calls, ['start-boot', 'stop', 'start-live', 'stop', 'start-live']);
  assert.equal(svc.running, true);
});
