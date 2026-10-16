// E-mail channel storage: Message-ID dedup (email_seen) and the persistent queue
// of raw e-mails (email_queue). Tables are created in db.mjs; this module adds
// what retention needs. No db import here: db.mjs injects the pool.
//
// Retention (audit 11). The raw e-mail is personal data (body, attachments,
// headers), so it can't live forever:
//  • answered (done): kept while the account exists, as the conversation is.
//    user_id has ON DELETE CASCADE: the account's final purge deletes it.
//  • skipped/failed (non-user, forged From, discarded): deleted after 7 days,
//    the time to look at a problem. Same for an answered e-mail with no owner
//    (from before user_id existed, and not traceable through email_seen).
const S = 'mtr_harness';
export const EMAIL_DISCARD_DAYS = 7;

export function createEmailQueue(pool) {
  async function purgeDiscarded(days = EMAIL_DISCARD_DAYS) {
    const { rowCount } = await pool.query(
      `DELETE FROM ${S}.email_queue
        WHERE (status IN ('skipped', 'failed') OR (status = 'done' AND user_id IS NULL))
          AND updated_at < now() - ($1 || ' days')::interval`,
      [String(days)],
    );
    return rowCount;
  }
  let timer = null;
  return {
    purgeDiscarded,
    async init() {
      await pool.query(`
        ALTER TABLE ${S}.email_queue ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES ${S}.users(id) ON DELETE CASCADE;
        CREATE INDEX IF NOT EXISTS email_queue_user_idx ON ${S}.email_queue(user_id) WHERE user_id IS NOT NULL;
      `);
      // Answered before user_id existed: the owner comes from email_seen, by Message-ID.
      await pool.query(`
        UPDATE ${S}.email_queue q SET user_id = s.user_id
          FROM ${S}.email_seen s
         WHERE q.status = 'done' AND q.user_id IS NULL AND s.user_id IS NOT NULL
           AND s.message_id = substring(encode(q.source, 'escape') from '(?i)\\nmessage-id:\\s*(<[^>\\s]+>)')`);
      const tick = () => purgeDiscarded()
        .then((n) => { if (n) console.log(`[email] ${n} discarded e-mails older than ${EMAIL_DISCARD_DAYS} days deleted`); })
        .catch((e) => console.error('[email] retention:', e?.message ?? e));
      await tick();
      timer ||= setInterval(tick, 24 * 3600_000).unref();
    },

    // ── Dedup by Message-ID ──
    async emailSeen(messageId) {
      if (!messageId) return false;
      const { rows } = await pool.query(
        `SELECT 1 FROM ${S}.email_seen WHERE message_id = $1`, [messageId],
      );
      return rows.length > 0;
    },
    async markEmailSeen(messageId, userId = null) {
      if (!messageId) return;
      await pool.query(
        `INSERT INTO ${S}.email_seen (message_id, user_id) VALUES ($1, $2)
         ON CONFLICT (message_id) DO NOTHING`,
        [messageId, userId],
      );
    },

    // ── Persistent queue (see the CREATE TABLE comment in db.mjs) ──
    async enqueueEmail(source) {
      await pool.query(`INSERT INTO ${S}.email_queue (source) VALUES ($1)`, [source]);
    },

    // Claims up to `limit` pending emails to process. The claim ALREADY increments
    // attempts: if the process crashes midway, the crash counts as an attempt.
    async claimPendingEmails(limit = 10, maxAttempts = 3) {
      // Re-arms orphaned claims (process crashed with the row in 'working')...
      await pool.query(
        `UPDATE ${S}.email_queue SET status = 'pending', updated_at = now()
          WHERE status = 'working' AND updated_at < now() - interval '15 minutes'`,
      );
      // ...and buries whatever ran out of attempts (stays auditable in 'failed').
      await pool.query(
        `UPDATE ${S}.email_queue SET status = 'failed', updated_at = now()
          WHERE status = 'pending' AND attempts >= $1`,
        [maxAttempts],
      );
      const { rows } = await pool.query(
        `UPDATE ${S}.email_queue SET status = 'working', attempts = attempts + 1, updated_at = now()
          WHERE id IN (SELECT id FROM ${S}.email_queue
                        WHERE status = 'pending' AND attempts < $2
                        ORDER BY created_at LIMIT $1
                        FOR UPDATE SKIP LOCKED)
          RETURNING id, source, attempts`,
        [limit, maxAttempts],
      );
      return rows;
    },

    // Closes the row: 'done' | 'skipped' | 'failed' | 'pending' (= try again).
    // userId: the account the From resolved to, so the e-mail goes with it.
    async settleEmail(id, status, error = null, userId = null) {
      await pool.query(
        `UPDATE ${S}.email_queue SET status = $2, last_error = $3, user_id = COALESCE($4, user_id), updated_at = now()
          WHERE id = $1`,
        [id, status, error, userId],
      );
    },

    // Returns the attempt (case 'defer': rate-limit isn't a failure, doesn't spend an attempt).
    async unclaimEmail(id) {
      await pool.query(
        `UPDATE ${S}.email_queue SET status = 'pending', attempts = greatest(attempts - 1, 0),
           updated_at = now() WHERE id = $1`,
        [id],
      );
    },
  };
}
