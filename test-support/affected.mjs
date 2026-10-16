#!/usr/bin/env node
// Which tests a change affects (the PR's "area test").
//
// Nobody maintains a list of areas by hand: a test's area is everything it
// reaches. We build a dependency graph of the repository by reading, in each
// versioned code file, (a) the relative imports and (b) any string
// literal that points to a file/folder in the repo (that's how tests that
// read web/server.mjs's text as text show up in the graph). A test is affected if some
// changed file is within its closure. If the test itself changed, it runs.
//
// Import is transitive (the test runs whatever the module imports). Reference by
// string is terminal: whoever only READS server.mjs's text doesn't depend on what
// server.mjs imports. Exception: a file that spawns a process (spawn/execFile/fork)
// runs whatever it references, so there the string counts as an import.
//
// As server.mjs gets split into modules, tests start importing only
// the area's module and the selection narrows on its own.
//
// Usage: npm test -- --changed-since <sha-base>   (runs only the affected tests)
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

// A change in these files changes how EVERY test runs: run the whole suite.
export const RUN_ALL = ['package.json', 'package-lock.json', 'test-support/run-suite.mjs', 'test-support/affected.mjs'];

const CODE = /\.(?:c|m)?(?:j|t)s$|\.html$/;
const LITERAL = /(['"`])((?:\.{1,2}\/)?[\w@.-]+(?:\/[\w@.-]+)*\/?)\1/g;
const SPAWNS = /\b(?:spawn|fork|execFile)\w*\s*\(/;
const IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)(['"`])([^'"`]+)\1/g;

// The package.json "imports" alias (#nucleo/web/x.mjs, #regras-provedor) becomes the
// path at the root; with no matching alias, null.
function apelido(ref, imports) {
  for (const [k, v] of Object.entries(imports)) {
    const alvo = k.endsWith('*') ? (ref.startsWith(k.slice(0, -1)) ? v.replace('*', ref.slice(k.length - 1)) : null) : (ref === k ? v : null);
    // Alias for the brambit package (#nucleo/* in the cloud): the package's files go
    // into the map with the path inside it (fragile-guard.mjs).
    const local = typeof alvo === 'string' ? alvo.replace(/^brambit\//, './') : null;
    if (local?.startsWith('./')) return local;
  }
  return null;
}

// Possible targets of a reference: relative to the file and relative to the root
// (tests run with cwd at the root, so readFileSync('web/x.mjs') is from the root).
function targets(from, ref, tracked, dirs, apelidos = {}) {
  if (ref.startsWith('#')) { const a = apelido(ref, apelidos); if (!a) return []; from = 'x'; ref = a; }
  const clean = ref.replace(/[?#].*$/, '');
  const out = [];
  for (const base of [path.posix.dirname(from), '.']) {
    let p = path.posix.normalize(path.posix.join(base, clean)).replace(/\/$/, '');
    if (p.startsWith('..')) continue;
    if (tracked.has(p)) out.push(p);
    else if (p.endsWith('.mjs') && tracked.has(p.replace(/\.mjs$/, '.mts'))) out.push(p.replace(/\.mjs$/, '.mts'));
    else if (p.includes('/') && dirs.has(p)) out.push(...dirs.get(p));
  }
  return out;
}

export function buildGraph(files, read) {
  const tracked = new Set(files), dirs = new Map();
  for (const f of files) {
    for (let d = path.posix.dirname(f); d !== '.'; d = path.posix.dirname(d)) {
      if (!dirs.has(d)) dirs.set(d, []);
      dirs.get(d).push(f);
    }
  }
  const deps = new Map();
  let apelidos = {};
  try { apelidos = JSON.parse(read('package.json')).imports || {}; } catch { /* no package.json */ }
  for (const f of files) {
    if (!CODE.test(f)) continue;
    let src;
    try { src = read(f); } catch { continue; }
    const runs = SPAWNS.test(src);
    const imports = new Set(), refs = new Set();
    for (const [re, kind] of [[IMPORT, imports], [LITERAL, runs ? imports : refs]]) {
      for (const m of src.matchAll(re)) {
        if (!m[2].includes('/') && !m[2].includes('.') && !m[2].startsWith('#')) continue;
        for (const t of targets(f, m[2], tracked, dirs, apelidos)) if (t !== f) kind.add(t);
      }
    }
    for (const t of imports) refs.delete(t);
    deps.set(f, { imports, refs });
  }
  return deps;
}

export function closure(start, deps) {
  const seen = new Set([start]), stack = [start];
  while (stack.length) for (const d of deps.get(stack.pop())?.imports || []) if (!seen.has(d)) { seen.add(d); stack.push(d); }
  for (const f of [...seen]) for (const r of deps.get(f)?.refs || []) seen.add(r);
  return seen;
}

// tests: source paths of the tests. Returns { all, tests, uncovered }.
export function selectAffected({ changed, tests, deps }) {
  if (changed.some((f) => RUN_ALL.includes(f))) return { all: true, tests: [...tests], uncovered: [] };
  const want = new Set(changed), picked = [], covered = new Set();
  for (const t of tests) {
    const reach = closure(t, deps);
    const hit = [...want].filter((f) => reach.has(f));
    if (hit.length) { picked.push(t); hit.forEach((f) => covered.add(f)); }
  }
  const uncovered = changed.filter((f) => CODE.test(f) && !covered.has(f) && existsSync(f));
  return { all: false, tests: picked, uncovered };
}

const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 << 20 });

export function changedSince(baseSha, cwd = process.cwd()) {
  const committed = git(['diff', '--name-only', `${baseSha}...HEAD`], cwd);
  const local = git(['diff', '--name-only', 'HEAD'], cwd);
  return [...new Set((committed + local).split('\n').filter(Boolean))];
}

export function affectedTests(baseSha, tests, cwd = process.cwd()) {
  const files = git(['ls-files'], cwd).split('\n').filter((f) => f && existsSync(path.join(cwd, f)) && statSync(path.join(cwd, f)).isFile());
  const deps = buildGraph(files, (f) => readFileSync(path.join(cwd, f), 'utf8'));
  const changed = changedSince(baseSha, cwd);
  return { changed, ...selectAffected({ changed, tests, deps }) };
}

