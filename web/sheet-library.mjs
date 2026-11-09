// ── Spreadsheets in the user's library, one per family ──
//
// Every edit saves a new asset with the canonical name and renames the previous
// one to `base_yyyymmddhhmmss.ext` (sheet-edit.mjs, versionedCaption). There is
// no version-group column, so a spreadsheet's versions are the assets whose
// captions share a baseFamily, and the CURRENT one is the newest of them.
//
// An id names one immutable asset. The model takes ids from listar_midia and
// from its own history, so it often holds the id of a version that has since
// been archived (2026-11-08: a routine read an archived copy with 1 row instead
// of the current one with 117). Reading a spreadsheet means its current version.
//
// No db connection/import here: the server injects the pool and tests pass a fake.

import { isSheetAsset, baseFamily, SHEET_MIMES } from './sheet-edit.mjs';

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
  const fam = baseFamily(asset.caption);
  let best = asset;
  for (const a of Array.isArray(assets) ? assets : []) {
    if (isSheetAsset(a) && baseFamily(a.caption) === fam && ts(a) > ts(best)) best = a;
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
  catch (e) { console.error('[ler_arquivo] versões da planilha:', e?.message ?? e); return { asset, nota: '' }; }
  const atual = currentVersion(asset, all);
  if (String(atual.id) === String(asset.id)) return { asset, nota: '' };
  const quando = new Date(atual.created_at).toLocaleString('pt-BR', { timeZone, dateStyle: 'short', timeStyle: 'short' });
  return {
    asset: atual,
    nota: `O id ${asset.id} é de uma versão antiga ("${asset.caption}"). Abri a versão atual da mesma planilha: id=${atual.id}, "${atual.caption}", de ${quando}. Use este id daqui pra frente.\n`,
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
  if (!bytes?.buffer) return { note: `ERRO: não consegui recuperar os bytes de "${asset.caption}".` };
  const lr = await load(userId, bytes.buffer, asset.caption || `planilha-${asset.id}`, { mime: asset.mime || '' });
  return lr.ok ? { sheet: lr, sync } : { note: sync + lr.note };
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

// analisar_planilha with nothing loaded (after a restart, and in every routine
// run, the in-memory registry is empty): opens the user's only spreadsheet, or
// lists them for the model to ask which. {} when the library has none.
const CHOICES_MAX = 8;
export async function autoLoadSheet(userId, { listSheets, fetchBytes, load, prepare }) {
  let all;
  try { all = await listSheets(userId); }
  catch (e) { console.error('[analisar_planilha] planilhas:', e?.message ?? e); return {}; }
  const atuais = [...new Map(all.filter(isSheetAsset).map((a) => [baseFamily(a.caption), currentVersion(a, all)])).values()];
  if (atuais.length === 1) return openForAnalysis(userId, atuais[0], { fetchBytes, load, prepare });
  if (!atuais.length) return {};
  const nomes = atuais.slice(0, CHOICES_MAX).map((a) => `"${a.caption}"`).join('; ');
  return { note: `Nenhuma planilha está carregada agora, e a biblioteca do usuário tem ${atuais.length}: ${nomes}. Se o pedido já diz qual é, chame analisar_planilha de novo com nome; se não diz, pergunte ao usuário qual, citando os nomes.` };
}
