// Test of web/sheet-merge.mjs with the real merge script: openpyxl runs locally in
// place of the sandbox (SHEET_PY, default /tmp/pdvenv/bin/python; skipped without it).
// Run with: node --test tests/sheet-merge.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import nodePath from 'node:path';
import { spawnSync } from 'node:child_process';
import { mergeSheets, describeMerge } from '../web/sheet-merge.mjs';

const PY = process.env.SHEET_PY || '/tmp/pdvenv/bin/python';
const hasOpenpyxl = fs.existsSync(PY) && spawnSync(PY, ['-c', 'import openpyxl'], { stdio: 'ignore' }).status === 0;
const skip = !hasOpenpyxl && 'no local openpyxl';

const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'sheet-merge-'));
const local = (p) => nodePath.join(root, p.replace(/^\/workspace\//, ''));
const sandbox = {
  async writeBytes(_u, path, buf) { fs.mkdirSync(nodePath.dirname(local(path)), { recursive: true }); fs.writeFileSync(local(path), buf); return { ok: true }; },
  async readBytes(_u, path) { return fs.existsSync(local(path)) ? { ok: true, buffer: fs.readFileSync(local(path)) } : { ok: false, error: 'missing' }; },
  async shell(_u, cmd) {
    if (cmd.startsWith('rm -rf ')) return { exitCode: 0, stdout: '' };
    const m = /^python3 - '([^']+)' <<'MERGE_PY'\n([\s\S]*)\nMERGE_PY$/.exec(cmd);
    assert.ok(m, 'merge command in the expected format');
    const r = spawnSync(PY, ['-', local(m[1])], { input: m[2], encoding: 'utf8', timeout: 60_000 });
    return { exitCode: r.status, stdout: r.stdout, stderr: r.stderr };
  },
};

// sheets: { name: [[...row], ...] } -> .xlsx bytes, and back.
function book(sheets) {
  const r = spawnSync(PY, ['-c', `
import sys, json, io
from openpyxl import Workbook
wb = Workbook(); wb.remove(wb.active)
for name, rows in json.loads(sys.stdin.read()).items():
    ws = wb.create_sheet(name)
    for row in rows: ws.append(row)
b = io.BytesIO(); wb.save(b); sys.stdout.buffer.write(b.getvalue())`], { input: JSON.stringify(sheets), maxBuffer: 1 << 24 });
  assert.equal(r.status, 0, String(r.stderr));
  return r.stdout;
}
function read(buf) {
  const r = spawnSync(PY, ['-c', `
import sys, json, io
from openpyxl import load_workbook
wb = load_workbook(io.BytesIO(sys.stdin.buffer.read()))
print(json.dumps({ws.title: [list(r) for r in ws.iter_rows(values_only=True)] for ws in wb}))`], { input: buf, encoding: 'buffer' });
  assert.equal(r.status, 0, String(r.stderr));
  return JSON.parse(String(r.stdout));
}

const head = ['Item', 'Valor', 'Pago'];
const base = { Gastos: [head, ['Luz', 120, 'não'], ['Água', 80, 'não'], ['Gás', 50, 'não'], ['Net', 100, 'não']] };

test('changes from both sides come together; the same cell keeps the Google value', { skip }, async () => {
  const ours = { Gastos: [head, ['Luz', 120, 'sim'], ['Água', 85, 'não'], ['Gás', 50, 'não'], ['Net', 100, 'não'], ['Aluguel', 2000, 'não']] };
  const theirs = { Gastos: [head, ['Luz', 120, 'não'], ['Água', 90, 'não'], ['Gás', 55, 'não'], ['Net', 100, 'não'], ['Celular', 60, 'sim']], Notas: [['ok']] };
  const m = await mergeSheets('u1', { base: book(base), ours: book(ours), theirs: book(theirs) }, sandbox);
  assert.equal(m.ok, true, m.error);
  assert.deepEqual(read(m.buffer), {
    Gastos: [head, ['Luz', 120, 'sim'], ['Água', 90, 'não'], ['Gás', 55, 'não'], ['Net', 100, 'não'], ['Celular', 60, 'sim'], ['Aluguel', 2000, 'não']],
    Notas: [['ok']],
  });
  assert.deepEqual(m.conflicts, [{ ref: 'Gastos!B3', here: '85', google: '90' }]);
  assert.equal(m.sheets, 1);
  assert.match(describeMerge(m), /Gastos!B3 \(here "85", Google "90"\)/);
});

test('a row deleted in Google goes away here, unless it was edited here', { skip }, async () => {
  const ours = { Gastos: [head, ['Luz', 120, 'não'], ['Água', 80, 'sim'], ['Gás', 50, 'não'], ['Net', 100, 'não']] };
  const theirs = { Gastos: [head, ['Luz', 120, 'não'], ['Net', 100, 'não']] };
  const m = await mergeSheets('u1', { base: book(base), ours: book(ours), theirs: book(theirs) }, sandbox);
  assert.equal(m.ok, true, m.error);
  assert.deepEqual(read(m.buffer).Gastos, [head, ['Luz', 120, 'não'], ['Água', 80, 'sim'], ['Net', 100, 'não']]);
  assert.match(m.kept.join(), /row 3 was edited here but deleted in Google Sheets/);
});

test('a row inserted in the middle in Google lands in the same place here', { skip }, async () => {
  const theirs = { Gastos: [head, ['Luz', 120, 'não'], ['IPTU', 300, 'não'], ['Água', 80, 'não'], ['Gás', 50, 'não'], ['Net', 100, 'não']] };
  const ours = { Gastos: [head, ['Luz', 120, 'não'], ['Água', 80, 'não'], ['Gás', 50, 'sim'], ['Net', 100, 'não']] };
  const m = await mergeSheets('u1', { base: book(base), ours: book(ours), theirs: book(theirs) }, sandbox);
  assert.deepEqual(read(m.buffer).Gastos, [head, ['Luz', 120, 'não'], ['IPTU', 300, 'não'], ['Água', 80, 'não'], ['Gás', 50, 'sim'], ['Net', 100, 'não']]);
  assert.equal(m.middle, 1);
});

test('a sheet deleted in Google stays here, and the script failing is an error, not a merge', { skip }, async () => {
  const two = { ...base, Extra: [['x']] };
  const m = await mergeSheets('u1', { base: book(two), ours: book(two), theirs: book(base) }, sandbox);
  assert.deepEqual(Object.keys(read(m.buffer)), ['Gastos', 'Extra']);
  assert.match(m.kept.join(), /sheet "Extra" was deleted in Google Sheets; kept it here/);
  const bad = await mergeSheets('u1', { base: Buffer.from('x'), ours: book(base), theirs: book(base) }, sandbox);
  assert.equal(bad.ok, false);
});
