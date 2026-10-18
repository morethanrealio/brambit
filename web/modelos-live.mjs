// ── models.yaml, followed live ──
// Loads models.yaml at boot (a typo stops the boot with the line of the
// problem, as before) and then follows it while the server runs: an edit by
// hand or by the launcher, or BRAMBIT_MODELS_FILE pointing at another file in the
// config file, applies on the next model call. A file that stops reading keeps
// the last good configuration and logs why; a deleted file goes back to the
// built-in routing.
import fs from 'node:fs';
import { modelsFilePath, loadModels, modelsTable } from '../core-proto/modelos.mjs';
import { registerPrices } from './pricing.mjs';
import { onConfigChange } from './config-file.mjs';

let watched = null;

function reload(log) {
  const before = loadModels();
  let cfg;
  try { cfg = loadModels({ reload: true }); }
  catch (e) { log.error(`[models] ${e.message}; keeping the previous configuration`); return; }
  // Whoever wrote the file may have reloaded it already (reloadModels).
  if (JSON.stringify(cfg) === JSON.stringify(before)) return;
  if (cfg) { registerPrices(cfg.prices); log.log(`[models] reloaded ${modelsFilePath()}\n${modelsTable()}`); }
  else if (before) log.log(`[models] ${modelsFilePath()} is gone: back to the built-in routing`);
}

function watch(log, intervalMs) {
  const file = modelsFilePath();
  if (watched === file) return;
  if (watched) fs.unwatchFile(watched);
  watched = file;
  // Polling, like the config file: works for a file that doesn't exist yet and on every OS.
  fs.watchFile(file, { interval: intervalMs }, (cur, prev) => {
    if (cur.mtimeMs !== prev.mtimeMs || cur.size !== prev.size) reload(log);
  }).unref();
}

export function startModelsWatch({ intervalMs = 2000, log = console } = {}) {
  const cfg = loadModels();
  if (cfg) { registerPrices(cfg.prices); log.log(`[models] models.yaml\n${modelsTable()}`); }
  if (intervalMs <= 0) return;
  watch(log, intervalMs);
  onConfigChange((keys) => {
    if (!keys.includes('BRAMBIT_MODELS_FILE')) return;
    watch(log, intervalMs);
    reload(log);
  });
}

// For whoever writes the file and needs it in use right away (the installation
// plugin's AI change), not on the next poll. A file that does not read keeps
// the previous configuration, as with the watcher.
export function reloadModels(log = console) {
  reload(log);
}

// Tests and shutdown.
export function stopModelsWatch() {
  if (watched) fs.unwatchFile(watched);
  watched = null;
}
