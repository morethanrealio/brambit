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
