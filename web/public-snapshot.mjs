// Public copy of an app's code (audit 13).
// source_snapshot is the owner's code: the draft re-seeds from it, so it stays raw.
// What the library lists and what others copy is public_snapshot, which is only
// ever written from the anonymizer's output. If the anonymizer could not check the
// code, nothing new goes public: the app stays out of the library (or keeps its last
// checked copy). public_snapshot_of = the snapshot_at the public copy came from;
// when it differs from snapshot_at, the public copy is behind and catchUp retries it.
const S = 'mtr_harness';

export function createPublicSnapshots(pool, { anonymize, log = (m) => console.warn(m) }) {
  async function init() {
    await pool.query(`ALTER TABLE ${S}.apps ADD COLUMN IF NOT EXISTS public_snapshot text`);
    await pool.query(`ALTER TABLE ${S}.apps ADD COLUMN IF NOT EXISTS public_snapshot_of timestamptz`);
  }

  async function readSource(userId, system) {
    const { rows } = await pool.query(
      `SELECT source_snapshot, snapshot_at::text AS at, visibility
         FROM ${S}.apps WHERE user_id = $1 AND system = $2`, [userId, system]);
    return rows[0] || null;
  }

  // Only writes if the owner's code is still the version that was checked
  // (snapshot_at compared as text: a JS Date would drop the microseconds).
  async function writeChecked(userId, system, at, blob) {
    const { rowCount } = await pool.query(
      `UPDATE ${S}.apps SET public_snapshot = $4, public_snapshot_of = snapshot_at
        WHERE user_id = $1 AND system = $2 AND snapshot_at::text = $3 AND visibility = 'public'`,
      [userId, system, at, blob]);
    return rowCount > 0;
  }

  // Brings the public copy up to the owner's current code. No-op for private apps.
  async function refresh(userId, system) {
    const row = await readSource(userId, system);
    if (!row || row.visibility !== 'public' || !row.source_snapshot) return false;
    const res = await anonymize(row.source_snapshot);
    if (!res.ok) { log(`[public-snapshot] ${system}: not checked (${res.error}), library keeps the last checked copy`); return false; }
    return writeChecked(userId, system, row.at, res.blob);
  }

  // Every write of the owner's code goes through here, so publish, rollback and any
  // future path also refresh the public copy (in the background: never blocks the save).
  async function setAppSnapshot(userId, system, snapshot) {
    const { rowCount } = await pool.query(
      `UPDATE ${S}.apps SET source_snapshot = $3, snapshot_at = now()
        WHERE user_id = $1 AND system = $2`,
      [userId, system, snapshot || null]);
    if (rowCount) refresh(userId, system).catch((e) => log(`[public-snapshot] ${system}: ${e?.message || e}`));
    return rowCount;
  }

  // Library on/off. Going public only happens with a checked copy; if the check fails,
  // nothing changes. Without code yet, it is marked public and the next publish fills it.
  // Returns { ok, reason?, replicavel?, anonimizado? }.
  async function setLibraryVisibility(userId, system, publico, description) {
    if (!publico) {
      const { rowCount } = await pool.query(
        `UPDATE ${S}.apps SET visibility = 'private', public_snapshot = NULL, public_snapshot_of = NULL,
                description = COALESCE($3, description), updated_at = now()
          WHERE user_id = $1 AND system = $2`, [userId, system, description ?? null]);
      return rowCount ? { ok: true } : { ok: false, reason: 'not_found' };
    }
    const row = await readSource(userId, system);
    if (!row) return { ok: false, reason: 'not_found' };
    let res = { ok: true, blob: null, changed: false };
    if (row.source_snapshot) {
      res = await anonymize(row.source_snapshot);
      if (!res.ok) { log(`[public-snapshot] ${system}: not checked (${res.error}), stays out of the library`); return { ok: false, reason: 'anonymize_failed' }; }
    }
    const { rows: [now] } = await pool.query(
      `UPDATE ${S}.apps SET visibility = 'public', public_snapshot = $4,
              public_snapshot_of = CASE WHEN $4::text IS NULL THEN NULL ELSE $3::timestamptz END,
              description = COALESCE($5, description), updated_at = now()
        WHERE user_id = $1 AND system = $2
        RETURNING snapshot_at::text AS at`,
      [userId, system, row.at, res.blob, description ?? null]);
    if (!now) return { ok: false, reason: 'not_found' };
    // The owner republished during the check: the copy just written is behind.
    if (res.blob && now.at !== row.at) refresh(userId, system).catch((e) => log(`[public-snapshot] ${system}: ${e?.message || e}`));
    return { ok: true, replicavel: !!res.blob, anonimizado: !!res.changed };
  }

  // Boot: public apps whose public copy is missing or behind. One at a time, in the
  // background (the caller does not await it).
  async function catchUp() {
    const { rows } = await pool.query(
      `SELECT user_id, system FROM ${S}.apps
        WHERE visibility = 'public' AND source_snapshot IS NOT NULL
          AND public_snapshot_of IS DISTINCT FROM snapshot_at`);
    let done = 0;
    for (const r of rows) if (await refresh(r.user_id, r.system).catch(() => false)) done++;
    if (rows.length) log(`[public-snapshot] catch-up: ${done}/${rows.length} public copies updated`);
    return { pending: rows.length, done };
  }

  // Searches the library (metadata only). q matches system/description/label.
  async function listPublicApps({ q, limit = 30 } = {}) {
    const vals = [];
    const where = [`a.visibility = 'public'`, `a.public_snapshot IS NOT NULL`];
    if (q && String(q).trim()) {
      vals.push(`%${String(q).trim().toLowerCase()}%`);
      where.push(`(lower(a.system) LIKE $${vals.length} OR lower(coalesce(a.description,'')) LIKE $${vals.length} OR lower(a.label) LIKE $${vals.length})`);
    }
    vals.push(Math.min(Number(limit) || 30, 100));
    const { rows } = await pool.query(
      `SELECT a.label, a.system, a.runtime, a.description, a.url, a.updated_at,
              u.name AS owner_name
         FROM ${S}.apps a
         LEFT JOIN ${S}.users u ON u.id = a.user_id
        WHERE ${where.join(' AND ')}
        ORDER BY a.updated_at DESC
        LIMIT $${vals.length}`,
      vals);
    return rows;
  }

  // A library app WITH its public (checked) code, to replicate. null if not in the library.
  async function getPublicApp(label, system) {
    const { rows } = await pool.query(
      `SELECT label, system, runtime, description, public_snapshot AS source_snapshot
         FROM ${S}.apps
        WHERE label = $1 AND system = $2 AND visibility = 'public'
              AND public_snapshot IS NOT NULL`,
      [label, system]);
    return rows[0] || null;
  }

  return { init, refresh, setAppSnapshot, setLibraryVisibility, catchUp, listPublicApps, getPublicApp };
}
