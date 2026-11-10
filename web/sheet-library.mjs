// ── Spreadsheets in the user's library, one per family ──
//
// Every edit saves a new asset with the canonical name and renames the previous
// one to `base_yyyymmddhhmmss.ext` (sheet-edit.mjs, versionedCaption). There is
// no version-group column, so a spreadsheet's versions are the assets that share a
// familyKey (the caption's baseFamily; a file from outside stays on its own until
// it is edited here), and the CURRENT one is the newest of them.
//
// An id names one immutable asset. The model takes ids from listar_midia and
// from its own history, so it often holds the id of a version that has since
// been archived (2026-11-08: a routine read an archived copy with 1 row instead
// of the current one with 117). Reading a spreadsheet means its current version.
//
// No db connection/import here: the server injects the pool and tests pass a fake.

import { isSheetAsset, baseFamily, familyKey, SHEET_MIMES } from './sheet-edit.mjs';

// How many spreadsheet assets of one user are scanned to find a family's
// current version. The edit path looks at the newest 40 assets of any kind;
// here only spreadsheets are fetched, so an old family still resolves.
export const SHEET_SCAN_MAX = 500;

const SHEET_CAPTION_SQL = '\\.(xlsx|xlsm)$';

export function createSheetLibrary(pool) {
  return {
    async listSheets(userId, { limit = SHEET_SCAN_MAX } = {}) {
      const { rows } = await pool.query(
        `SELECT id, agent_id, s3_key, kind, mime, source, caption, created_at
         FROM mtr_harness.media_assets
         WHERE user_id = $1 AND (caption ~* $2 OR lower(mime) = ANY($3))
         ORDER BY created_at DESC LIMIT $4`,
        [userId, SHEET_CAPTION_SQL, [...SHEET_MIMES], Math.min(Math.max(1, limit), SHEET_SCAN_MAX)],
      );
      return rows;
    },
  };
}

const ts = (a) => {
  const d = a?.created_at instanceof Date ? a.created_at : new Date(a?.created_at);
  return Number.isNaN(d.getTime()) ? -Infinity : d.getTime();
};

// Newest version of the family `asset` belongs to; `asset` itself when it is not
// a spreadsheet or nothing newer shares its family. `assets` may be in any order.
export function currentVersion(asset, assets) {
  if (!isSheetAsset(asset)) return asset;
  const fam = familyKey(asset);
  let best = asset;
  for (const a of Array.isArray(assets) ? assets : []) {
    if (isSheetAsset(a) && familyKey(a) === fam && ts(a) > ts(best)) best = a;
  }
  return best;
}

// For ler_arquivo. Returns the asset to open and, when it differs from the one
// asked for, a note for the model saying the id was an archived version.
// If the library can't be listed, opens the asset asked for (as before).
export async function sheetForReading(userId, asset, { listSheets, timeZone } = {}) {
  if (!isSheetAsset(asset) || typeof listSheets !== 'function') return { asset, nota: '' };
  let all;
  try { all = await listSheets(userId); }
  catch (e) { console.error('[ler_arquivo] spreadsheet versions:', e?.message ?? e); return { asset, nota: '' }; }
  const atual = currentVersion(asset, all);
  if (String(atual.id) === String(asset.id)) return { asset, nota: '' };
  const quando = new Date(atual.created_at).toLocaleString('pt-BR', { timeZone, dateStyle: 'short', timeStyle: 'short' });
  return {
    asset: atual,
    nota: `Id ${asset.id} is an older version ("${asset.caption}"). Opened the current version of the same spreadsheet instead: id=${atual.id}, "${atual.caption}", from ${quando}. Use this id from now on. Only if the user asked about what that older version contained, analyze it with analisar_planilha and versao_id=${asset.id}.\n`,
  };
}

// For analisar_planilha with a name: opens that library spreadsheet in the
// analysis environment. { sheet } with the loaded entry, or { note } for the model.
// prepare(asset) -> { asset, note } runs first (Google Sheets sync, sheet-sync.mjs);
// its note comes back as `sync`, to go before the analysis.
export async function openForAnalysis(userId, asset, { fetchBytes, load, prepare }) {
  let sync = '';
  if (prepare) ({ asset, note: sync } = await prepare(asset));
  let bytes = null;
  try { bytes = await fetchBytes(asset.s3_key); } catch (e) { console.error('[analisar_planilha] bytes:', e?.message ?? e); }
  if (!bytes?.buffer) return { note: `ERROR: could not fetch the bytes of "${asset.caption}".` };
  const lr = await load(userId, bytes.buffer, asset.caption || `planilha-${asset.id}`, { mime: asset.mime || '', assetId: asset.id });
  return lr.ok ? { sheet: lr, sync } : { note: sync + lr.note };
}

// analisar_planilha with arquivo_id: the spreadsheet that id belongs to, at its
// current version, as ler_arquivo opens it (the model often holds the id of a
// version since archived). Without this the id was ignored and the analysis ran on
// whatever was loaded (2026-11: 11 of 42 calls passed one). A CSV has no versions.
const OTHER_TABLE_RE = /\.(xls|csv|tsv)$/i;
export async function openIdForAnalysis(userId, id, { getAsset, listSheets, fetchBytes, load, prepare }) {
  const asset = await getAsset(userId, String(id).trim());
  if (!asset) return { note: `ERROR: file ${id} is not in the user's library. Use listar_midia to find the id.` };
  if (!isSheetAsset(asset)) {
    if (OTHER_TABLE_RE.test(asset.caption || '')) return openForAnalysis(userId, asset, { fetchBytes, load });
    return { note: `ERROR: file ${id} ("${asset.caption}") is not a spreadsheet.` };
  }
  let atual = asset;
  try { atual = currentVersion(asset, await listSheets(userId)); } catch (e) { console.error('[analisar_planilha] versions:', e?.message ?? e); }
  return openForAnalysis(userId, atual, { fetchBytes, load, prepare });
}

// analisar_planilha with versao_id: one exact version, for when the user asks what
// an older version contained (listar_midia versoes_de lists them). An older version
// is opened as it was: no Google Sheets sync, which would turn it into the current
// one, and not kept in the loaded list, so a later analysis without a name never
// takes it for the spreadsheet. The current version's id opens like a name does.
export async function openVersionForAnalysis(userId, id, { getAsset, listSheets, fetchBytes, load, prepare, timeZone }) {
  const asset = await getAsset(userId, String(id).trim());
  if (!asset) return { note: `ERROR: version ${id} is not in the user's library. Use listar_midia with versoes_de to see the versions.` };
  if (!isSheetAsset(asset)) return { note: `ERROR: file ${id} ("${asset.caption}") is not an .xlsx spreadsheet.` };
  let atual = asset;
  try { atual = currentVersion(asset, await listSheets(userId)); } catch (e) { console.error('[analisar_planilha] versions:', e?.message ?? e); }
  if (String(atual.id) === String(asset.id)) return openForAnalysis(userId, asset, { fetchBytes, load, prepare });
  const once = (u, b, name, opts) => load(u, b, name, { ...opts, register: false });
  const o = await openForAnalysis(userId, asset, { fetchBytes, load: once });
  if (!o.sheet) return o;
  const quando = new Date(asset.created_at).toLocaleString('pt-BR', { timeZone, dateStyle: 'short', timeStyle: 'short' });
  return { ...o, sync: `This analysis is of an OLDER version ("${asset.caption}", from ${quando}), not the current one (id=${atual.id}, "${atual.caption}"). Say so in the reply.\n` };
}

// Spreadsheets loaded in the analysis environment, one per family. Reading an
// archived copy and then editing leaves two versions of the same spreadsheet in
// /workspace, and the analyst picked one on its own and mixed their data
// (2026-11-09). Keeps the current version: the canonical name, without the
// archive stamp, which is the one the edit path writes; else the newest loaded.
export function currentLoaded(entries) {
  const byFam = new Map();
  for (const e of Array.isArray(entries) ? entries : []) {
    const fam = baseFamily(e.filename);
    const prev = byFam.get(fam);
    const canonical = (x) => String(x.filename || '').toLowerCase() === fam;
    if (!prev || (canonical(e) && !canonical(prev)) || (canonical(e) === canonical(prev) && (e.ts || 0) >= (prev.ts || 0))) byFam.set(fam, e);
  }
  return [...byFam.values()];
}

// The copies a conversation may take for "the spreadsheet": the ones loaded in it
// (`threadId`, sheet.mjs). A routine or another chat loads its own, and the
// registry is per user (2026-11: an edit without a name took one from another chat).
export function loadedHere(entries, thread = null) {
  return currentLoaded((Array.isArray(entries) ? entries : []).filter((e) => (e.threadId ?? null) === (thread ?? null)));
}

// analisar_planilha without a library file: with `nome`, the copies from outside the
// library loaded under that name in any conversation (as editar_planilha finds them);
// with no name, or none by that name, only the ones loaded in this conversation.
export function analysisCopies(entries, { thread = null, nome = null } = {}) {
  const want = plainName(nome);
  const hits = want ? (Array.isArray(entries) ? entries : []).filter((e) => !e.assetId && [e.name, e.filename].some((n) => plainName(n).includes(want))) : [];
  return hits.length ? currentLoaded(hits) : loadedHere(entries, thread);
}

// analisar_planilha with nothing loaded (after a restart, and in every routine
// run, the in-memory registry is empty): opens the user's only spreadsheet, or
// lists them for the model to ask which. {} when the library has none.
const CHOICES_MAX = 8;
// A spreadsheet sent from outside may not open at all (2026-11: an uploaded
// "fatura.xlsx" with no zip inside). One the system generated always does. Checked
// by the first bytes (an .xlsx is a zip, "PK"), once per asset, which never changes.
const readableCache = new Map();
export async function opensAsSheet(asset, fetchBytes) {
  if (!isSheetAsset(asset) || asset.source == null || asset.source === 'generated' || !fetchBytes) return true;
  if (readableCache.has(asset.id)) return readableCache.get(asset.id);
  let buf = null;
  try { buf = (await fetchBytes(asset.s3_key))?.buffer || null; } catch {}
  if (!buf) return true;
  const ok = buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b;
  if (readableCache.size >= 1000) readableCache.clear();
  readableCache.set(asset.id, ok);
  return ok;
}

// Leaves out of a choice the spreadsheets that cannot open, unless that leaves
// none: a single file is still opened, and the failure note names it.
export async function withoutUnreadable(list, fetchBytes) {
  if (list.length < 2) return list;
  const keep = [];
  for (const a of list) if (await opensAsSheet(a, fetchBytes)) keep.push(a);
  return keep.length ? keep : list;
}

export async function autoLoadSheet(userId, { listSheets, fetchBytes, load, prepare }) {
  let all;
  try { all = await listSheets(userId); }
  catch (e) { console.error('[analisar_planilha] spreadsheets:', e?.message ?? e); return {}; }
  const atuais = await withoutUnreadable([...new Map(all.filter(isSheetAsset).map((a) => [familyKey(a), currentVersion(a, all)])).values()], fetchBytes);
  if (atuais.length === 1) return openForAnalysis(userId, atuais[0], { fetchBytes, load, prepare });
  if (!atuais.length) return {};
  const nomes = atuais.slice(0, CHOICES_MAX).map((a) => `"${a.caption}"`).join('; ');
  return { note: `No spreadsheet is loaded in this conversation, and the user's library has ${atuais.length}: ${nomes}. If the request already says which one, call analisar_planilha again with nome; if not, ask the user which one, citing the names.` };
}

// editar_planilha without arquivo_id. It used to take the newest spreadsheet in
// the library, which was not always the one being talked about: the analysis
// reads the loaded copy, and a spreadsheet opened by link, Drive, OneDrive or
// e-mail has no library file at all (2026-11: an edit went to another file, and
// one by the name of a sheet opened by link found nothing). With a name, the
// library is searched first, then the spreadsheets loaded from outside it.
// Without one, it edits the one spreadsheet loaded in this conversation (`thread`);
// a copy another conversation or a routine loaded does not count. A loaded copy
// from outside the library is saved there first (the original stays as it was).
// Several loaded, or none loaded and several in the library: the model asks.
// { asset } (only the id is used) | { asset, note } | { reply }
const EDITABLE_RE = /\.(xlsx|xlsm)$/i;
const MACRO_MIME = [...SHEET_MIMES].find((m) => /macro/i.test(m));
const XLSX_MIME = [...SHEET_MIMES].find((m) => m !== MACRO_MIME);
const plainName = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/\.(xlsx|xlsm|xls|csv|tsv)$/, '').replace(/[^a-z0-9]+/g, ' ').trim();
export async function editTarget(userId, { nome = null, byName = null, loaded, thread = null, listSheets, fetchBytes, readBytes, saveAsset }) {
  const entries = currentLoaded(loaded);
  const here = loadedHere(loaded, thread);
  const nameOf = (e) => e.name || e.filename;
  const fromLoaded = async (e) => {
    if (e.assetId) return { asset: { id: e.assetId } };
    const name = nameOf(e);
    if (!EDITABLE_RE.test(e.filename)) return { reply: `Nothing was edited: the spreadsheet loaded now, "${name}", is not an .xlsx, and editar_planilha only changes .xlsx files. If the user meant a library spreadsheet, call editar_planilha again with its nome; if not, tell the user.` };
    const r = await readBytes(userId, e.path);
    const buffer = r?.ok ? r.buffer : null;
    if (!buffer || buffer[0] !== 0x50 || buffer[1] !== 0x4b) return { reply: `ERRO: could not read the spreadsheet "${name}" loaded now (${r?.error || 'not an .xlsx file'}). Nothing was edited. Open it again from where it came from and try once more.` };
    const macro = /\.xlsm$/i.test(e.filename);
    let saved = null;
    try { saved = await saveAsset({ buffer, ext: macro ? 'xlsm' : 'xlsx', mime: macro ? MACRO_MIME : XLSX_MIME, caption: name }); } catch {}
    if (!saved?.assetId) return { reply: `ERRO: could not save "${name}" in the library to edit it. Nothing was edited.` };
    return { asset: { id: saved.assetId }, note: `"${name}" came from outside the library (a link, Drive, OneDrive or e-mail), so it was saved in the library to be edited, and the edited version is there. The original file where it came from was NOT changed: tell the user.` };
  };
  if (nome) {
    const r = await byName(nome);
    const want = plainName(nome);
    if (!r?.notFound || !want) return r;
    const hits = entries.filter((e) => !e.assetId && [nameOf(e), e.filename].some((n) => plainName(n).includes(want)));
    return hits.length === 1 ? fromLoaded(hits[0]) : r;
  }
  if (here.length > 1) {
    const nomes = here.slice(0, CHOICES_MAX).map((e) => `"${nameOf(e)}"`).join('; ');
    return { reply: `Nothing was edited: ${here.length} spreadsheets are loaded in this conversation: ${nomes}. If the request already says which one, call editar_planilha again with nome; if not, ask the user which one, citing the names.` };
  }
  if (here.length === 1) return fromLoaded(here[0]);
  let all;
  try { all = await listSheets(userId); }
  catch (e) { return { reply: `ERRO: could not list the user's spreadsheets (${e?.message ?? e}). Nothing was edited.` }; }
  const atuais = await withoutUnreadable([...new Map(all.filter(isSheetAsset).map((a) => [familyKey(a), currentVersion(a, all)])).values()], fetchBytes);
  if (atuais.length === 1) return { asset: atuais[0] };
  if (!atuais.length) return { reply: 'ERRO: the user has no .xlsx spreadsheet in the library and none is loaded in this conversation. Generate it first (gerar_documento with format xlsx), or open it from where it is, and then edit.' };
  const nomes = atuais.slice(0, CHOICES_MAX).map((a) => `"${a.caption}"`).join('; ');
  return { reply: `Nothing was edited: no spreadsheet is loaded in this conversation, and the user's library has ${atuais.length}: ${nomes}. If the request already says which one, call editar_planilha again with nome; if not, ask the user which one, citing the names.` };
}
