// ── Email suppression ──
// Addresses that can no longer receive mail. Two sources feed it:
//  • 'bounce': the receiving server answered that the mailbox does not exist
//    (email-bounce.mjs reads the bounce notice that lands in the assistant's inbox);
//  • 'apple': Apple said a "Hide My Email" relay stopped forwarding, or the
//    person removed the app from their Apple ID (apple-notifications.mjs).
// sendEmail (mailer.mjs) checks it before every send. Writing again to a dead
// address only earns another bounce, and a steady trickle of them hurts the
// sending domain's reputation for every other user.
//
// The table comes from migrations/2026-10-13-email-suppressions.sql, never from
// boot. Without it every check answers "deliverable" and every write is a no-op
// with a log line: a missing table must not stop a password reset.

const TABLE = 'mtr_harness.email_suppressions';
const UNDEFINED_TABLE = '42P01';

// "Name <A@B.com>" and " a@b.com " both become "a@b.com"; no address -> null.
export function normalizeAddress(value) {
  const s = String(value || '');
  const addr = (s.match(/<([^<>]+)>/)?.[1] ?? s).trim().toLowerCase();
  return /^[^\s@<>]+@[^\s@<>]+$/.test(addr) ? addr : null;
}

export function createEmailSuppressionStore(pool) {
  let warnedMissing = false;
  // Any database failure, the table not existing yet included, degrades to
  // "not suppressed": the list only spares bounces, it must never block mail.
  async function safely(op, fallback, fn) {
    try {
      return await fn();
    } catch (e) {
      if (e?.code !== UNDEFINED_TABLE) console.error(`[email-suppression] ${op}:`, e?.code || e?.message || e);
      else if (!warnedMissing) {
        warnedMissing = true;
        console.warn('[email-suppression] table missing (migrations/2026-10-13-email-suppressions.sql), nothing is suppressed');
      }
      return fallback;
    }
  }
  return {
    // { source, reason } when the address must not receive mail, else null.
    lookup(address) {
      const email = normalizeAddress(address);
      if (!email) return Promise.resolve(null);
      return safely('lookup', null, async () => {
        const { rows } = await pool.query(`SELECT source, reason FROM ${TABLE} WHERE email=$1`, [email]);
        return rows[0] ? { source: rows[0].source, reason: rows[0].reason } : null;
      });
    },
    // true when stored. A later notice for the same address replaces the entry.
    suppress(address, { source, reason, detail = null }) {
      const email = normalizeAddress(address);
      if (!email) return Promise.resolve(false);
      return safely('suppress', false, async () => {
        await pool.query(
          `INSERT INTO ${TABLE}(email,source,reason,detail) VALUES($1,$2,$3,$4)
           ON CONFLICT(email) DO UPDATE SET source=EXCLUDED.source, reason=EXCLUDED.reason,
             detail=EXCLUDED.detail, updated_at=now()`,
          [email, source, reason, detail],
        );
        return true;
      });
    },
    // true when an entry was removed (Apple turned forwarding back on).
    lift(address) {
      const email = normalizeAddress(address);
      if (!email) return Promise.resolve(false);
      return safely('lift', false, async () => {
        const { rows } = await pool.query(`DELETE FROM ${TABLE} WHERE email=$1 RETURNING email`, [email]);
        return rows.length > 0;
      });
    },
  };
}

// The store over the server's pool. db.mjs is imported lazily so mailer.mjs
// keeps no database import of its own.
let shared = null;
export async function emailSuppressions() {
  if (!shared) {
    const { pool } = await import('./db.mjs');
    shared = createEmailSuppressionStore(pool);
  }
  return shared;
}
