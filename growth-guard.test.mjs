import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { compareGrowth, countLines, run } from './test-support/growth-guard.mjs';

test('countLines conta a última linha sem \\n final', () => {
  assert.equal(countLines(''), 0);
  assert.equal(countLines('a\nb\n'), 2);
  assert.equal(countLines('a\nb'), 2);
});

test('compareGrowth: só cresce quando os dois lados existem e o depois é maior', () => {
  const r = compareGrowth({ a: 10, b: 10, c: null }, { a: 11, b: 9, c: 50 }, ['a', 'b', 'c']);
  assert.deepEqual(r.map((x) => [x.file, x.grew, x.delta]), [['a', true, 1], ['b', false, -1], ['c', false, null]]);
});

function repo() {
  const dir = mkdtempSync(path.join(tmpdir(), 'growth-guard-'));
  const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  mkdirSync(path.join(dir, 'web'));
  writeFileSync(path.join(dir, 'web/server.mjs'), 'a\nb\nc\n');
  writeFileSync(path.join(dir, 'web/db.mjs'), 'x\n');
  git('add', '.'); git('commit', '-qm', 'base');
  return { dir, base: git('rev-parse', 'HEAD'), done: () => rmSync(dir, { recursive: true, force: true }) };
}

test('run: reprova quando server.mjs cresce e aprova com o rótulo', () => {
  const r = repo();
  try {
    writeFileSync(path.join(r.dir, 'web/server.mjs'), 'a\nb\nc\nd\n');
    const out = [];
    assert.equal(run({ baseSha: r.base, cwd: r.dir, log: (l) => out.push(l) }), 1);
    assert.match(out.join('\n'), /web\/server\.mjs: 3 -> 4 \(\+1\)  CRESCEU/);
    assert.equal(run({ baseSha: r.base, cwd: r.dir, allow: true, log: () => {} }), 0);
  } finally { r.done(); }
});

test('run: aprova quando encolhe ou fica igual', () => {
  const r = repo();
  try {
    writeFileSync(path.join(r.dir, 'web/server.mjs'), 'a\n');
    assert.equal(run({ baseSha: r.base, cwd: r.dir, log: () => {} }), 0);
  } finally { r.done(); }
});
