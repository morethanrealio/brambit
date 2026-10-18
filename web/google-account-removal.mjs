// Removing a connected Google account (audit 12).
// google_tokens is the old table, from before multi-account (1 account per user, the
// login e-mail). Nothing writes to it any more, but the boot copies it into
// google_accounts with ON CONFLICT DO NOTHING. So removing that account without
// deleting the old row brought it back, token included, on the next restart.
//
// Removing also revokes the grant at Google, so the app leaves the person's
// Google account ("Third-party apps with account access") and a token left in an
// old backup stops working. Google revokes the whole grant of that Google account
// for this app, so it is kept while another user of this install still has the
// same Google account connected: revoking would cut them off too. A failed
// revocation never blocks the removal the person asked for.
import { googleRevoke } from './auth.mjs';
import { decMaybe } from './vault.mjs';

const S = 'mtr_harness';

export function createGoogleAccountRemoval(pool, { revoke = googleRevoke } = {}) {
  async function revokeAtGoogle(userId, email) {
    const { rows } = await pool.query(
      `SELECT g.access_token, g.refresh_token,
              EXISTS (SELECT 1 FROM ${S}.google_accounts o
                       WHERE o.google_email = g.google_email AND o.user_id <> g.user_id
                         AND (o.refresh_token IS NOT NULL OR o.access_token IS NOT NULL)) AS shared
         FROM ${S}.google_accounts g WHERE g.user_id=$1 AND g.google_email=$2`, [userId, email]);
    const row = rows[0];
    if (!row || row.shared) return;
    try {
      // The refresh token outlives the access token, and revoking either one drops the grant.
      const token = decMaybe(row.refresh_token) || decMaybe(row.access_token);
      if (token) await revoke(token);
    } catch (e) {
      console.warn(`[google] revoking user ${userId}'s grant failed:`, e?.message ?? e);
    }
  }

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
    await revokeAtGoogle(userId, email);
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
    // if the primary one was deleted and another account is left, promote the most recent one
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
