// ── Library spreadsheet <-> Google Sheets, before every read, analysis or edit ──
//
// A spreadsheet linked to a Google Sheets file (sheet-google.mjs, created by
// enviar_para_drive with planilha_google) may have been changed in Sheets since
// the last sync. Before the assistant reads, analyzes or edits it, `pull` checks
// the Sheets version and, when it moved, brings the content back as a new
// library version (the same way an edit does: canonical name for the new one,
// archive stamp for the old one), so the library copy is always the latest.
//
// A version bump with the same cell values (Google bumps it for formatting,
// comments, a resize) creates nothing: only the synced version moves.
//
// Any Google failure keeps the library copy and tells the model it may be
// missing what changed in Sheets: the read still happens.
//
// No db connection/import here: the server injects everything and tests pass fakes.

import { isSheetAsset, baseFamily, versionedCaption, withKeyLock } from './sheet-edit.mjs';
import { currentVersion, sheetForReading, openForAnalysis } from './sheet-library.mjs';
import { xlsxToText } from './xlsxread.mjs';
import { XLSX_MIME, sheetVersion as driveVersion, exportSheet as driveExport } from './sheet-google.mjs';

const SHEET_EXT_RE = /\.(xlsx|xlsm)$/i;
const READ_ALL = { maxChars: 20_000_000, maxRowsPerSheet: 1_048_576 };

// Cell values only, sheet by sheet. Trailing empty cells and rows are dropped:
// Google and Excel disagree on a sheet's extent, not on its data.
export function cellText(buf) {
  const { text } = xlsxToText(buf, READ_ALL);
  return text.split('\n# ').map((sheet) => sheet.split('\n').map((l) => l.replace(/,+$/, '')).join('\n').replace(/\n+$/, '')).join('\n# ');
}

export function sameCells(a, b) {
  try { return cellText(a) === cellText(b); } catch { return false; }
}

// deps: userId, links (createSheetLinks), tokenFor(googleEmail) -> token function,
// listSheets(userId), fetchBytes(s3Key) -> { buffer }, saveAsset({ buffer, ext, mime, caption })
// -> { assetId, key, url }, renameAsset(userId, id, caption); drive overrides the
// Google calls in tests ({ sheetVersion, exportSheet }).
export function createSheetSync(deps) {
  const { userId, links } = deps;
  const drive = { sheetVersion: driveVersion, exportSheet: driveExport, ...(deps.drive || {}) };
  const notSynced = (caption, why) => `NOT synced with Google Sheets ("${caption}"): ${why}. This is the library copy, which may miss what was changed in Google Sheets since the last sync; tell the user.\n`;

  async function doPull(asset) {
    if (!isSheetAsset(asset)) return { asset, note: '' };
    const family = baseFamily(asset.caption);
    const link = await links.get(userId, family);
    if (!link) return { asset, note: '' };
    // Inside the lock: an edit that finished while this call waited made a newer version.
    try { asset = currentVersion(asset, await deps.listSheets(userId)); } catch {}
    const token = deps.tokenFor(link.google_email);
    let remote;
    try { remote = await drive.sheetVersion(token, link.file_id); }
    catch (e) { return { asset, note: notSynced(asset.caption, e?.status === 404 ? 'the Google Sheets file no longer exists' : `Google error (${e?.message ?? e})`) }; }
    if (remote.trashed) return { asset, note: notSynced(asset.caption, 'the Google Sheets file is in the Drive trash') };
    if (remote.version <= Number(link.synced_version)) return { asset, note: '' };
    if (String(asset.id) !== String(link.base_asset_id)) {
      return { asset, note: notSynced(asset.caption, 'it changed both here and in Google Sheets since the last sync, and they were not merged') };
    }

    let theirs, ours;
    try { theirs = await drive.exportSheet(token, link.file_id); }
    catch (e) { return { asset, note: notSynced(asset.caption, `could not export it from Google (${e?.message ?? e})`) }; }
    try { cellText(theirs); } catch (e) { return { asset, note: notSynced(asset.caption, `the export from Google did not open (${e?.message ?? e})`) }; }
    try { ours = (await deps.fetchBytes(asset.s3_key))?.buffer; } catch { ours = null; }
    if (ours && sameCells(ours, theirs)) {
      await links.synced(userId, family, { version: remote.version, baseAssetId: asset.id });
      return { asset, note: '' };
    }

    // Saves the new version first, then archives the old one (same order as an edit).
    const caption = asset.caption;
    const ext = (String(caption).match(SHEET_EXT_RE)?.[0] || '.xlsx').slice(1).toLowerCase();
    let saved;
    try { saved = await deps.saveAsset({ buffer: theirs, ext, mime: XLSX_MIME, caption }); }
    catch (e) { return { asset, note: notSynced(caption, `could not save what came from Google in the library (${e?.message ?? e})`) }; }
    try { await deps.renameAsset(userId, asset.id, versionedCaption(caption, asset.created_at, { id: asset.id })); } catch {}
    const pulled = { ...asset, id: saved.assetId, s3_key: saved.key, mime: XLSX_MIME, created_at: new Date().toISOString() };
    await links.synced(userId, family, { version: remote.version, baseAssetId: pulled.id });
    return { asset: pulled, pulled: true, note: `"${caption}" had changed in Google Sheets: those changes are now the current version in the library (id=${pulled.id}). Use this id from now on.\n` };
  }

  // locked: the caller already holds the user's spreadsheet lock (editar_planilha).
  const pull = (asset, { locked = false } = {}) => (locked ? doPull(asset) : withKeyLock(`sheet:${userId}`, () => doPull(asset)));

  return {
    pull,
    // ler_arquivo: an archived id opens the current version, then Google's changes come in.
    async forReading(asset, opts) {
      const r = await sheetForReading(userId, asset, opts);
      const p = await pull(r.asset);
      return { asset: p.asset, nota: r.nota + p.note };
    },
    // analisar_planilha with spreadsheets already loaded in the sandbox: a linked one
    // whose Sheets changed is reloaded from the new library version.
    async refreshLoaded(entries, { fetchBytes, load }) {
      const sheets = [];
      let sync = '';
      for (const e of entries) {
        const family = baseFamily(e.filename);
        let asset = null;
        if (await links.get(userId, family)) {
          try { asset = (await deps.listSheets(userId)).find((a) => isSheetAsset(a) && baseFamily(a.caption) === family) || null; } catch {}
        }
        if (!asset) { sheets.push(e); continue; }
        const p = await pull(asset);
        sync += p.note;
        const o = p.pulled ? await openForAnalysis(userId, p.asset, { fetchBytes, load }) : {};
        if (o.note) sync += `The new version did not open in the analysis environment (${o.note}); this analysis used the copy loaded before.\n`;
        sheets.push(o.sheet || e);
      }
      return { sheets, sync };
    },
  };
}
