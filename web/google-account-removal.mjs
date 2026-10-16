// Removing a connected Google account (audit 12).
// google_tokens is the old table, from before multi-account (1 account per user, the
// login e-mail). Nothing writes to it any more, but the boot copies it into
// google_accounts with ON CONFLICT DO NOTHING. So removing that account without
// deleting the old row brought it back, token included, on the next restart.
const S = 'mtr_harness';

export function createGoogleAccountRemoval(pool) {
  // Idempotent boot backfill: brings each user's single account from google_tokens
  // (the connected account == the login e-mail), marked as primary.
  async function backfillLegacy() {
    await pool.query(`
      INSERT INTO ${S}.google_accounts (user_id, google_email, access_token, refresh_token, scope, expiry, is_primary, updated_at)
        SELECT gt.user_id, lower(u.email), gt.access_token, gt.refresh_token, gt.scope, gt.expiry, true, gt.updated_at
          FROM ${S}.google_tokens gt JOIN ${S}.users u ON u.id = gt.user_id
         WHERE u.email IS NOT NULL
        ON CONFLICT (user_id, google_email) DO NOTHING`);
  }

  async function removeGoogleAccount(userId, googleEmail) {
    const email = String(googleEmail || '').toLowerCase();
    // One statement: the account and its old copy go together, so a crash in between
    // can't leave the copy for the backfill to restore.
    const { rows } = await pool.query(
      `WITH gone AS (
         DELETE FROM ${S}.google_accounts WHERE user_id=$1 AND google_email=$2 RETURNING is_primary
       ), legacy AS (
         DELETE FROM ${S}.google_tokens gt USING ${S}.users u
          WHERE gt.user_id=$1 AND u.id=gt.user_id AND lower(u.email)=$2
       )
       SELECT is_primary FROM gone`, [userId, email]);
    // unlinks the agents that pointed to this account (they fall back to the primary one)
    await pool.query(`UPDATE ${S}.agents SET google_email = NULL WHERE user_id=$1 AND google_email=$2`, [userId, email]);
    // se apagou a principal e sobrou conta, promove a mais recente
    if (rows[0]?.is_primary) {
      const { rows: next } = await pool.query(
        `SELECT google_email FROM ${S}.google_accounts WHERE user_id=$1 ORDER BY updated_at DESC LIMIT 1`, [userId]);
      if (next[0]) await pool.query(
        `UPDATE ${S}.google_accounts SET is_primary = (google_email = $2), updated_at = CASE WHEN google_email=$2 THEN now() ELSE updated_at END WHERE user_id=$1`,
        [userId, next[0].google_email]);
    }
    return rows.length > 0;
  }

  return { backfillLegacy, removeGoogleAccount };
}
