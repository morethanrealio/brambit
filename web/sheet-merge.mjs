// ── Three-way merge of one spreadsheet changed both here and in Google Sheets ──
//
// base = the library version that was last in sync with Google Sheets, ours = the
// current library version, theirs = the Sheets export. The result starts from
// ours (keeps its formatting, formulas and sheets) and takes every change made in
// Sheets since base: rows are matched with difflib, then cell by cell.
//
// Nothing is lost: a cell changed on both sides takes the Sheets value (decided
// 2026-11-09) and is listed as a conflict; a row deleted in Sheets but edited
// here stays and is listed; a sheet deleted on one side but changed on the other
// stays. Runs with openpyxl in the user's sandbox, like the spreadsheet editor.
//
// No sandbox import here: the server injects shell/writeBytes/readBytes and tests run Python locally.

export const MERGE_PY = String.raw`
import sys, json, difflib, datetime
from openpyxl import load_workbook
from openpyxl.utils import get_column_letter

d = sys.argv[1]

def norm(v):
    if v is None: return None
    if isinstance(v, bool): return v
    if isinstance(v, (int, float)): return round(float(v), 9)
    if isinstance(v, (datetime.datetime, datetime.date, datetime.time)): return v.isoformat()
    s = str(v)
    if s.startswith('='): return s.upper().replace(' ', '').replace('$', '')
    s = s.strip()
    return s or None

def grid(ws):
    raw = [list(r) for r in ws.iter_rows(min_row=1, max_row=ws.max_row, max_col=ws.max_column, values_only=True)]
    rows = []
    for r in raw:
        n = [norm(v) for v in r]
        while n and n[-1] is None: n.pop()
        rows.append(tuple(n))
    while rows and not rows[-1]: rows.pop()
    return rows, raw[:len(rows)]

def at(row, c):
    return row[c] if c < len(row) else None

def show(v):
    return '' if v is None else str(v)[:60]

def mapping(a, b):
    m = {}
    for tag, i1, i2, j1, j2 in difflib.SequenceMatcher(None, a, b, autojunk=False).get_opcodes():
        if tag == 'equal' or tag == 'replace':
            for k in range(min(i2 - i1, j2 - j1)): m[i1 + k] = j1 + k
    return m

base = load_workbook(d + '/base.xlsx')
ours = load_workbook(d + '/ours.xlsx')
theirs = load_workbook(d + '/theirs.xlsx')
out = {'ok': True, 'conflicts': [], 'kept': [], 'cells': 0, 'rows': 0, 'middle': 0, 'sheets': 0}

for name in theirs.sheetnames:
    tw = theirs[name]
    if name not in base.sheetnames:
        if name in ours.sheetnames: out['kept'].append('sheet "%s" was created on both sides; kept the one from here' % name); continue
        nw = ours.create_sheet(name)
        for r in tw.iter_rows(values_only=True): nw.append(list(r))
        out['sheets'] += 1
        continue
    B, _ = grid(base[name])
    T, Traw = grid(tw)
    if name not in ours.sheetnames:
        if T != B:
            nw = ours.create_sheet(name)
            for r in Traw: nw.append(r)
            out['kept'].append('sheet "%s" was deleted here but changed in Google Sheets; kept it' % name)
        continue
    ow = ours[name]
    O, _ = grid(ow)
    bo = mapping(B, O)
    sets, inserts = {}, []
    def anchor(i):
        for k in range(i, -1, -1):
            if k in bo: return bo[k]
        return -1
    for tag, i1, i2, j1, j2 in difflib.SequenceMatcher(None, B, T, autojunk=False).get_opcodes():
        if tag == 'equal': continue
        pairs = min(i2 - i1, j2 - j1) if tag == 'replace' else 0
        for k in range(pairs):
            i, j = i1 + k, j1 + k
            if i not in bo:
                inserts.append((anchor(i - 1), [Traw[j]]))
                out['kept'].append('%s row %d was deleted here but changed in Google Sheets; kept the Google Sheets row' % (name, j + 1))
                continue
            o = bo[i]
            for c in range(max(len(B[i]), len(T[j]))):
                bv, tv, ov = at(B[i], c), at(T[j], c), at(O[o], c)
                if bv == tv or ov == tv: continue
                if ov != bv:
                    out['conflicts'].append({'ref': '%s!%s%d' % (name, get_column_letter(c + 1), o + 1), 'here': show(ow.cell(o + 1, c + 1).value), 'google': show(Traw[j][c])})
                sets[(o, c)] = Traw[j][c] if c < len(Traw[j]) else None
        for i in range(i1 + pairs, i2):
            if i in bo and O[bo[i]] != B[i]:
                out['kept'].append('%s row %d was edited here but deleted in Google Sheets; kept it' % (name, bo[i] + 1))
            elif i in bo:
                inserts.append((bo[i], None))
        if j2 - j1 > pairs:
            inserts.append((anchor(i1 + pairs - 1), [Traw[j] for j in range(j1 + pairs, j2)]))
    for (o, c), v in sets.items():
        ow.cell(o + 1, c + 1).value = v
        out['cells'] += 1
    # Bottom-up so earlier positions stay valid; at one position the rows after it
    # go in first (in their order), then the row itself may be deleted.
    last, added, dropped = len(O) - 1, {}, set()
    for pos, rows in inserts:
        if rows is None: dropped.add(pos)
        else: added.setdefault(pos, []).extend(rows)
    for pos in sorted(set(added) | dropped, reverse=True):
        rows = added.get(pos, [])
        if rows:
            if pos < last: out['middle'] += 1
            ow.insert_rows(pos + 2, len(rows))
            for k, r in enumerate(rows):
                for c, v in enumerate(r):
                    ow.cell(pos + 2 + k, c + 1).value = v
            out['rows'] += len(rows)
        if pos in dropped:
            ow.delete_rows(pos + 1, 1)
            out['rows'] += 1

for name in base.sheetnames:
    if name not in theirs.sheetnames and name in ours.sheetnames:
        out['kept'].append('sheet "%s" was deleted in Google Sheets; kept it here' % name)

ours.save(d + '/merged.xlsx')
print(json.dumps(out, ensure_ascii=False, default=str))
`;

const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// -> { ok, buffer, conflicts, kept, cells, rows, middle, sheets } | { ok:false, error }
export async function mergeSheets(userId, { base, ours, theirs }, { shell, writeBytes, readBytes }) {
  const dir = `/workspace/.sheet-sync/${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  try {
    for (const [name, buf] of [['base', base], ['ours', ours], ['theirs', theirs]]) {
      const w = await writeBytes(userId, `${dir}/${name}.xlsx`, buf);
      if (!w?.ok) return { ok: false, error: `could not write the ${name} copy (${w?.error || 'sandbox'})` };
    }
    let res;
    try { res = await shell(userId, `python3 - ${q(dir)} <<'MERGE_PY'\n${MERGE_PY}\nMERGE_PY`, 120_000); }
    catch (e) { return { ok: false, error: `the sandbox did not answer (${e?.message ?? e})` }; }
    let out;
    try { out = JSON.parse(String(res?.stdout || '').trim().split('\n').at(-1)); }
    catch { return { ok: false, error: String(res?.stderr || 'no result').trim().split('\n').at(-1).slice(0, 200) }; }
    const r = await readBytes(userId, `${dir}/merged.xlsx`);
    if (!r?.ok) return { ok: false, error: `could not read the merged copy (${r?.error || 'sandbox'})` };
    return { ...out, buffer: r.buffer };
  } finally {
    try { await shell(userId, `rm -rf ${q(dir)}`, 10_000); } catch {}
  }
}

// One line per finding, for the model to tell the user.
export function describeMerge(m) {
  const parts = [`merged with what changed in Google Sheets meanwhile (${m.cells} cell(s), ${m.rows} row(s)${m.sheets ? `, ${m.sheets} new sheet(s)` : ''})`];
  if (m.conflicts?.length) parts.push(`${m.conflicts.length} cell(s) were changed on both sides and kept the Google Sheets value: ${m.conflicts.slice(0, 8).map((c) => `${c.ref} (here "${c.here}", Google "${c.google}")`).join('; ')}`);
  if (m.kept?.length) parts.push(m.kept.slice(0, 5).join('; '));
  if (m.middle) parts.push('rows were inserted in the middle of a sheet: formulas that point below them may need a look');
  return parts.join('. ');
}
