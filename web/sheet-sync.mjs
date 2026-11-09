// ── Library spreadsheet <-> Google Sheets, before and after every read, analysis or edit ──
//
// A spreadsheet linked to a Google Sheets file (sheet-google.mjs, created by
// enviar_para_drive with planilha_google) is one spreadsheet in two places: the
// library (always the source the assistant works on) and Sheets (where people
// type). `sync` brings both to the same content, compared by version: what changed
// in Sheets comes back as a new library version (canonical name for the new one,
// archive stamp for the old one, like an edit), what changed here is uploaded to
// the same Sheets file, and when both changed they are merged first
// (sheet-merge.mjs; a cell changed on both sides keeps the Sheets value).
//
// A Sheets version bump with the same cell values (formatting, comments, a
// resize) creates no library version: only the synced version moves.
//
// Any failure keeps the library copy and tells the model that the two may differ:
// the read or edit still happens, and the next sync tries again.
//
// No db connection/import here: the server injects everything and tests pass fakes.

import { isSheetAsset, familyKey, versionedCaption, withKeyLock } from './sheet-edit.mjs';
import { currentVersion, sheetForReading, openForAnalysis } from './sheet-library.mjs';
import { xlsxToText } from './xlsxread.mjs';
import { XLSX_MIME, sheetVersion as driveVersion, exportSheet as driveExport, replaceSheet as driveReplace } from './sheet-google.mjs';
import { describeMerge } from './sheet-merge.mjs';

const SHEET_EXT_RE = /\.(xlsx|xlsm)$/i;
const READ_ALL = { maxChars: 20_000_000, maxRowsPerSheet: 1_048_576 };

// Cell values only, sheet by sheet. Trailing empty cells and rows are dropped:
// Google and Excel disagree on a sheet's extent, not on its data.
export function cellText(buf) {
  const { text } = xlsxToText(buf, READ_ALL);
  return text.split('\n# ').map((sheet) => sheet.split('\n').map((l) => l.replace(/,+$/, '')).join('\n').replace(/\n+$/, '')).join('\n# ');
}

// Ids of the versions of `asset`'s spreadsheet, to find its Google Sheets link
// after a rename (sheet-google.mjs, get).
export function versionIds(asset, sheets) {
  const fam = familyKey(asset);
  return [...new Set([asset, ...sheets].filter((a) => isSheetAsset(a) && familyKey(a) === fam).map((a) => a.id))];
}

export function sameCells(a, b) {
  try { return cellText(a) === cellText(b); } catch { return false; }
}

// deps: userId, links (createSheetLinks), tokenFor(googleEmail) -> token function,
// listSheets(userId), getAsset(userId, id), fetchBytes(s3Key) -> { buffer },
// saveAsset({ buffer, ext, mime, caption }) -> { assetId, key, url },
// renameAsset(userId, id, caption), merge({ base, ours, theirs }) -> mergeSheets
// result (sheet-merge.mjs; absent without a sandbox); drive overrides the Google
// calls in tests ({ sheetVersion, exportSheet, replaceSheet }).
export function createSheetSync(deps) {
  const { userId, links } = deps;
  const drive = { sheetVersion: driveVersion, exportSheet: driveExport, replaceSheet: driveReplace, ...(deps.drive || {}) };
  const notSynced = (caption, why) => `NOT synced with Google Sheets ("${caption}"): ${why}. The library copy and the Google Sheets file may differ until the next sync; tell the user.\n`;
  const bytesOf = async (asset) => { try { return (await deps.fetchBytes(asset.s3_key))?.buffer || null; } catch { return null; } };

  // Saves a new library version with the canonical name, then archives `asset` (same order as an edit).
  async function saveVersion(asset, buffer) {
    const caption = asset.caption;
    const ext = (String(caption).match(SHEET_EXT_RE)?.[0] || '.xlsx').slice(1).toLowerCase();
    const saved = await deps.saveAsset({ buffer, ext, mime: XLSX_MIME, caption });
    try { await deps.renameAsset(userId, asset.id, versionedCaption(caption, asset.created_at, { id: asset.id })); } catch {}
    return { ...asset, id: saved.assetId, s3_key: saved.key, mime: XLSX_MIME, created_at: new Date().toISOString() };
  }

  async function push(token, link, asset, buffer) {
    const r = await drive.replaceSheet(token, link.file_id, buffer);
    const version = Number(r?.version) || (await drive.sheetVersion(token, link.file_id)).version;
    await links.synced(userId, link.family, { version, baseAssetId: asset.id });
  }

  // Brings the library spreadsheet and its Google Sheets file to the same content:
  // only Sheets changed -> pull; only the library changed -> push; both -> merge, then push.
  async function doSync(asset) {
    if (!isSheetAsset(asset)) return { asset, note: '' };
    // Inside the lock: an edit that finished while this call waited made a newer version.
    let all = [];
    try { all = await deps.listSheets(userId); } catch {}
    const link = await links.get(userId, familyKey(asset), versionIds(asset, all));
    if (!link) return { asset, note: '' };
    asset = currentVersion(asset, all);
    const family = link.family;
    const caption = asset.caption;
    const token = deps.tokenFor(link.google_email);
    let remote;
    try { remote = await drive.sheetVersion(token, link.file_id); }
    catch (e) { return { asset, note: notSynced(caption, e?.status === 404 ? 'the Google Sheets file no longer exists' : `Google error (${e?.message ?? e})`) }; }
    if (remote.trashed) return { asset, note: notSynced(caption, 'the Google Sheets file is in the Drive trash') };
    const googleMoved = remote.version > Number(link.synced_version);
    const localMoved = String(asset.id) !== String(link.base_asset_id);
    if (!googleMoved && !localMoved) return { asset, note: '' };

    const ours = await bytesOf(asset);
    if (!ours) return { asset, note: notSynced(caption, 'could not read the library copy') };
    let theirs = null;
    if (googleMoved) {
      try { theirs = await drive.exportSheet(token, link.file_id); cellText(theirs); }
      catch (e) { return { asset, note: notSynced(caption, `could not bring it from Google (${e?.message ?? e})`) }; }
    }

    try {
      if (googleMoved && !localMoved) {
        if (sameCells(ours, theirs)) {
          await links.synced(userId, family, { version: remote.version, baseAssetId: asset.id });
          return { asset, note: '' };
        }
        const pulled = await saveVersion(asset, theirs);
        await links.synced(userId, family, { version: remote.version, baseAssetId: pulled.id });
        return { asset: pulled, newVersion: true, note: `"${caption}" had changed in Google Sheets: those changes are now the current version in the library (id=${pulled.id}). Use this id from now on.\n` };
      }
      let base = null, merged = null;
      if (googleMoved) {
        const baseAsset = link.base_asset_id ? await deps.getAsset(userId, link.base_asset_id) : null;
        base = baseAsset ? await bytesOf(baseAsset) : null;
        if (!base) return { asset, note: notSynced(caption, 'it changed both here and in Google Sheets, and the last synced version is gone, so they could not be merged') };
      }
      if (googleMoved && !sameCells(base, theirs)) {
        if (!deps.merge) return { asset, note: notSynced(caption, 'it changed both here and in Google Sheets, and merging needs the analysis environment, which is off') };
        merged = await deps.merge({ base, ours, theirs });
        if (!merged?.ok) return { asset, note: notSynced(caption, `it changed both here and in Google Sheets, and the merge failed (${merged?.error || 'unknown'})`) };
      }
      let current = asset, buffer = ours;
      if (merged && !sameCells(merged.buffer, ours)) { current = await saveVersion(asset, merged.buffer); buffer = merged.buffer; }
      await push(token, link, current, buffer);
      const head = merged ? `"${caption}" was ${describeMerge(merged)}. ` : `"${caption}": `;
      const id = current === asset ? '' : ` The merged version is the current one in the library (id=${current.id}); use this id from now on.`;
      return { asset: current, newVersion: current !== asset, note: `${head}sent to Google Sheets, the file there now has this version at the same link.${id}\n` };
    } catch (e) {
      return { asset, note: notSynced(caption, `${e?.message ?? e}`) };
    }
  }

  // locked: the caller already holds the user's spreadsheet lock (editar_planilha).
  const sync = (asset, { locked = false } = {}) => (locked ? doSync(asset) : withKeyLock(`sheet:${userId}`, () => doSync(asset)));

  return {
    sync,
    // ler_arquivo: an archived id opens the current version, then Google's changes come in.
    async forReading(asset, opts) {
      const r = await sheetForReading(userId, asset, opts);
      const p = await sync(r.asset);
      return { asset: p.asset, nota: r.nota + p.note };
    },
    // analisar_planilha with spreadsheets already loaded in the sandbox: a linked one
    // whose Sheets changed is reloaded from the new library version. A loaded copy is
    // known by the library file it came from (assetId), not by its sandbox name, which
    // has spaces and accents replaced; a copy from outside the library has none.
    async refreshLoaded(entries, { fetchBytes, load }) {
      const sheets = [];
      let notes = '', all = null;
      for (const e of entries) {
        let asset = null;
        if (e.assetId) {
          if (!all) { try { all = await deps.listSheets(userId); } catch { all = []; } }
          let own = all.find((a) => String(a.id) === String(e.assetId));
          if (!own) { try { own = await deps.getAsset(userId, e.assetId); } catch {} }
          if (isSheetAsset(own) && await links.get(userId, familyKey(own), versionIds(own, all))) asset = currentVersion(own, all);
        }
        if (!asset) { sheets.push(e); continue; }
        const p = await sync(asset);
        notes += p.note;
        const o = p.newVersion ? await openForAnalysis(userId, p.asset, { fetchBytes, load }) : {};
        if (o.note) notes += `The new version did not open in the analysis environment (${o.note}); this analysis used the copy loaded before.\n`;
        sheets.push(o.sheet || e);
      }
      return { sheets, sync: notes };
    },
  };
}
