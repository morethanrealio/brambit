#!/usr/bin/env node
// Whole suite in ONE command: `npm test` (or `node test-support/run-suite.mjs`).
//
// Why it exists: a raw `node --test` at the root also picks up the `.test.mts` from the
// TypeScript areas (deepseek, discovery, engagement, onboarding, ...). Those sources
// import siblings `./x.mjs` that only exist AFTER `<area>:build` (tsc into
// `.<area>-build/`), so they fail with ERR_MODULE_NOT_FOUND with no bug at all.
// Here: (1) runs the build for every area that has `build.mts` (the same command as
// `npm run <area>:build`), (2) assembles the list with `node --test`'s default
// patterns, swapping each compiled area's `.test.mts` for the compiled
// `.mjs`, and (3) runs everything in a single `node --test`. Extra arguments are
// passed through (e.g.: `npm test -- --test-concurrency=2`).
//
// `--changed-since <sha>` runs only the tests that the change since <sha> reaches
// (test-support/affected.mjs). That's what the CI does on every PR.
//
// Out of the suite, on purpose: PRODUCTION probes with a real session (SID_A/SID_B),
// which aren't local tests. And SID_A/SID_B are removed from the suite's environment, so
// no file (e.g.: ops/tenancy-runner-test.mjs) goes off hitting production.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { affectedTests } from './affected.mjs';

// Root = folder it runs from (npm/CI run at the root): whoever installs Brambit as a
// package runs the same guard in their own repo, with node node_modules/brambit/....
const root = process.cwd();

const PRODUCTION_PROBES = {
  'ops/tenancy-test.mjs': 'HTTP probe with real SID_A/SID_B cookies (local server by default; remote only with ALLOW_REMOTE=1); run by hand: SID_A=… SID_B=… node ops/tenancy-test.mjs',
  'ops/tenancy-write-test.mjs': 'WRITE probe with real SID_A/SID_B cookies (local server by default; remote only with ALLOW_REMOTE=1); run by hand: SID_A=… SID_B=… node ops/tenancy-write-test.mjs',
};

const areaDirs = () => readdirSync(root).filter((d) => !d.startsWith('.') && d !== 'node_modules'
  && statSync(path.join(root, d)).isDirectory() && existsSync(path.join(root, d, 'build.mts'))).sort();

// 2) List of files, with node --test's default patterns.
const EXT = '(?:c|m)?(?:j|t)s';
const PATTERNS = [
  new RegExp(`\\.test\\.${EXT}$`), new RegExp(`-test\\.${EXT}$`), new RegExp(`_test\\.${EXT}$`),
  new RegExp(`(?:^|/)test-[^/]*\\.${EXT}$`), new RegExp(`(?:^|/)test\\.${EXT}$`), new RegExp(`(?:^|/)test/.*\\.${EXT}$`),
];
function walk(dir, out) {
  for (const name of readdirSync(path.join(root, dir))) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const rel = dir === '.' ? name : `${dir}/${name}`;
    const st = statSync(path.join(root, rel));
    if (st.isDirectory()) walk(rel, out);
    else if (PATTERNS.some((p) => p.test(rel)) && !rel.endsWith('.d.mts') && !rel.endsWith('.d.ts')) out.push(rel);
  }
  return out;
}
// Each test: { source (what's in git), run (what node --test executes) }.
export function listTests() {
  const areas = areaDirs(), out = [];
  for (const rel of walk('.', [])) {
    if (PRODUCTION_PROBES[rel]) continue;
    const [area, ...rest] = rel.split('/');
    const run = areas.includes(area) && /\.m?ts$/.test(rel)
      ? `.${area}-build/${rest.join('/').replace(/\.m?ts$/, '.mjs')}` : rel;
    out.push({ source: rel, run });
  }
  return out;
}

function main(args) {
process.chdir(root);
let selected = listTests();
const i = args.indexOf('--changed-since');
if (i >= 0) {
  const base = args[i + 1];
  if (!base) throw Error('[suite] --changed-since needs a sha');
  args = [...args.slice(0, i), ...args.slice(i + 2)];
  const r = affectedTests(base, selected.map((t) => t.source), root);
  for (const f of r.uncovered) process.stderr.write(`[suite] no test reaches ${f}\n`);
  if (r.all) process.stderr.write('[suite] global change (package.json/lock or runner): whole suite\n');
  const keep = new Set(r.tests);
  selected = selected.filter((t) => keep.has(t.source));
  process.stderr.write(`[suite] ${r.changed.length} files changed since ${base.slice(0, 9)}\n`);
  if (!selected.length) { process.stderr.write('[suite] no test affected\n'); return 0; }
}

// 1) Build of the TypeScript areas.
const git = (a) => { try { return execFileSync('git', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return null; } };
const before = git(['status', '--porcelain']);
for (const area of areaDirs()) {
  process.stderr.write(`[suite] build ${area}\n`);
  execFileSync(process.execPath, ['--experimental-strip-types', `${area}/build.mts`], { stdio: 'inherit' });
}
const after = git(['status', '--porcelain']);
if (before !== null && before !== after) {
  process.stderr.write('[suite] WARNING: the build changed versioned files (generated output was stale relative to the .mts):\n'
    + after.split('\n').filter((l) => l && !before.split('\n').includes(l)).join('\n') + '\n');
}

for (const t of selected) if (!existsSync(t.run)) throw Error(`[suite] ${t.source} did not generate ${t.run} in the area build`);
for (const [rel, why] of Object.entries(PRODUCTION_PROBES)) process.stderr.write(`[suite] outside the suite: ${rel}: ${why}\n`);
process.stderr.write(`[suite] ${selected.length} test files\n`);
const files = selected.map((t) => t.run);

// 3) A single node --test. Localhost never goes through the environment's proxy.
const env = { ...process.env };
delete env.SID_A; delete env.SID_B;
const local = '127.0.0.1,localhost,::1';
env.NO_PROXY = env.NO_PROXY ? `${env.NO_PROXY},${local}` : local;
env.no_proxy = env.NO_PROXY;
const r = spawnSync(process.execPath, ['--test', ...args, ...files], { stdio: 'inherit', env });
return r.status ?? 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
