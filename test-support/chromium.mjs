// Locates a local Chromium/Chrome for the Playwright browser tests.
// Order: explicit env (CHROMIUM_PATH, CHROMIUM, CHROME_PATH), then the usual
// Linux and macOS install paths. When nothing is found the test must SKIP with
// the reason (node:test `skip`), never fail the whole suite.
import fs from 'node:fs';
import test from 'node:test';

const CANDIDATES = [
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

const executable = (p) => { try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; } };

export function chromiumPath(env = process.env) {
  const explicit = env.CHROMIUM_PATH || env.CHROMIUM || env.CHROME_PATH;
  if (explicit) return executable(explicit) ? explicit : null;
  return CANDIDATES.find(executable) || null;
}

export function chromiumSkipReason(env = process.env) {
  const explicit = env.CHROMIUM_PATH || env.CHROMIUM || env.CHROME_PATH;
  if (chromiumPath(env)) return false;
  return explicit
    ? `Chromium not executable at ${explicit} (CHROMIUM_PATH/CHROMIUM/CHROME_PATH)`
    : `no Chromium/Chrome found (set CHROMIUM_PATH; looked in ${CANDIDATES.join(', ')})`;
}

// For browser tests written as plain top-level scripts (no test() calls):
// returns true when the script should run; otherwise registers one skipped
// node:test entry with the reason, so the runner reports SKIP instead of FAIL.
export function browserAvailableOrSkip(name) {
  const reason = chromiumSkipReason();
  if (reason) { test(name, { skip: reason }, () => {}); return false; }
  return true;
}
