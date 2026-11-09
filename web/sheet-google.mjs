// ── Spreadsheets kept in sync with Google Sheets ──
//
// A spreadsheet always lives in the user's library (media_assets, one row per
// version, grouped by baseFamily). When the user asks for it in Google Sheets,
// a native Sheets file is created from the current version and LINKED to the
// family here. From then on the library copy and the Sheets file are the same
// spreadsheet: before any read or edit the Sheets content is pulled when its
// version changed (someone may have typed there), and after any change the
// library version is pushed back, merging first if Sheets changed meanwhile.
//
// The table comes from migrations/2026-11-09-sheet-google-links.sql, never from
// boot. Without it nothing is linked and nothing syncs.
//
// No db connection/import here: the server injects the pool and tests pass a fake.

const TABLE = 'mtr_harness.sheet_google_links';
const UNDEFINED_TABLE = '42P01';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export const SHEETS_MIME = 'application/vnd.google-apps.spreadsheet';
const DRIVE = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';

export function createSheetLinks(pool) {
  let warnedMissing = false;
  async function safely(op, fallback, fn) {
    try {
      return await fn();
    } catch (e) {
      if (e?.code !== UNDEFINED_TABLE) console.error(`[sheet-google] ${op}:`, e?.code || e?.message || e);
      else if (!warnedMissing) {
        warnedMissing = true;
        console.warn('[sheet-google] table missing (migrations/2026-11-09-sheet-google-links.sql), no spreadsheet syncs');
      }
      return fallback;
    }
  }
  return {
    // false while the table is missing: then no spreadsheet can be linked.
    available() {
      return safely('available', false, async () => { await pool.query(`SELECT 1 FROM ${TABLE} LIMIT 0`); return true; });
    },
    // The link of one spreadsheet family, or null. assetIds are the family's
    // versions: a spreadsheet renamed in the library changes family, and its link,
    // found by the last synced version, moves to the new family. The row's `family`
    // is the key the sync writes back to.
    get(userId, family, assetIds = []) {
      return safely('get', null, async () => {
        const ids = assetIds.map(String).filter((id) => UUID_RE.test(id));
        const { rows } = await pool.query(
          `SELECT family, google_email, file_id, link, synced_version, base_asset_id FROM ${TABLE}
           WHERE user_id=$1 AND (family=$2 OR base_asset_id = ANY($3::uuid[]))
           ORDER BY (family=$2) DESC, updated_at DESC LIMIT 1`, [userId, family, ids]);
        const row = rows[0] || null;
        if (!row || row.family === family) return row;
        try {
          await pool.query(`UPDATE ${TABLE} SET family=$3, updated_at=now() WHERE user_id=$1 AND family=$2`, [userId, row.family, family]);
          return { ...row, family };
        } catch (e) {
          console.error('[sheet-google] move link:', e?.code || e?.message || e);
          return row;
        }
      });
    },
    // Links a family to a Sheets file (a new link replaces the old one). true when stored.
    link(userId, { family, googleEmail = null, fileId, link = null, version, baseAssetId }) {
      return safely('link', false, async () => {
        await pool.query(
          `INSERT INTO ${TABLE}(user_id,family,google_email,file_id,link,synced_version,base_asset_id)
           VALUES($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT(user_id,family) DO UPDATE SET google_email=EXCLUDED.google_email,
             file_id=EXCLUDED.file_id, link=EXCLUDED.link, synced_version=EXCLUDED.synced_version,
             base_asset_id=EXCLUDED.base_asset_id, updated_at=now()`,
          [userId, family, googleEmail, fileId, link, version, baseAssetId]);
        return true;
      });
    },
    // After a pull or a push: the Sheets version and the library version that now match.
    synced(userId, family, { version, baseAssetId }) {
      return safely('synced', false, async () => {
        const r = await pool.query(
          `UPDATE ${TABLE} SET synced_version=$3, base_asset_id=$4, updated_at=now()
           WHERE user_id=$1 AND family=$2`, [userId, family, version, baseAssetId]);
        return r.rowCount > 0;
      });
    },
  };
}

// ── Google Drive calls. `token` is a function returning the access token. ──

async function google(token, url, init = {}, fetchImpl = fetch) {
  const r = await fetchImpl(url, { ...init, headers: { Authorization: `Bearer ${await token()}`, ...(init.headers || {}) } });
  if (!r.ok) {
    const err = new Error(`Google ${r.status}: ${(await r.text()).slice(0, 300)}`);
    err.status = r.status;
    throw err;
  }
  return r;
}

// version grows with every change on the server, so comparing it with the one
// of the last sync tells whether someone changed the file.
export async function sheetVersion(token, fileId, { fetchImpl } = {}) {
  const r = await google(token, `${DRIVE}/${encodeURIComponent(fileId)}?fields=version,trashed&supportsAllDrives=true`, {}, fetchImpl);
  const j = await r.json();
  return { version: Number(j.version) || 0, trashed: !!j.trashed };
}

export async function exportSheet(token, fileId, { fetchImpl } = {}) {
  const r = await google(token, `${DRIVE}/${encodeURIComponent(fileId)}/export?mimeType=${encodeURIComponent(XLSX_MIME)}`, {}, fetchImpl);
  return Buffer.from(await r.arrayBuffer());
}

// Uploads an .xlsx converted into a native Google Sheets file.
export async function createSheet(token, { name, buffer, folderId = null }, { fetchImpl } = {}) {
  const boundary = 'brambitsheet' + Date.now().toString(36);
  const meta = JSON.stringify({ name, mimeType: SHEETS_MIME, ...(folderId ? { parents: [folderId] } : {}) });
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: ${XLSX_MIME}\r\n\r\n`, 'utf8'),
    buffer,
    Buffer.from(`\r\n--${boundary}--`, 'utf8'),
  ]);
  const r = await google(token, `${UPLOAD}?uploadType=multipart&fields=id,name,webViewLink,version`, {
    method: 'POST', headers: { 'content-type': `multipart/related; boundary=${boundary}` }, body,
  }, fetchImpl);
  return r.json();
}

// Replaces the whole content of the Sheets file with an .xlsx (same file, same link).
export async function replaceSheet(token, fileId, buffer, { fetchImpl } = {}) {
  const r = await google(token, `${UPLOAD}/${encodeURIComponent(fileId)}?uploadType=media&fields=id,version`, {
    method: 'PATCH', headers: { 'content-type': XLSX_MIME }, body: buffer,
  }, fetchImpl);
  return r.json();
}

// Anyone with the link can read ('reader') or edit ('writer').
export async function shareByLink(token, fileId, role, { fetchImpl } = {}) {
  if (!['reader', 'writer'].includes(role)) throw new Error(`invalid role ${role}`);
  await google(token, `${DRIVE}/${encodeURIComponent(fileId)}/permissions?supportsAllDrives=true`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'anyone', role, allowFileDiscovery: false }),
  }, fetchImpl);
}
