// ── Sign-up confirmed by e-mail ──
// Before this, /api/signup created the account on the spot. Anyone could sign up
// with someone else's e-mail and keep the password: when the real owner later
// came in with "Continue with Google", they landed inside an account whose
// password the other person knew (account pre-hijacking).
//
// Now a sign-up with a password is only a REQUEST, kept in pending_signups. The
// account is created when someone opens the link sent to that e-mail and taps
// the button. Until then there is no account at all: nothing to log into, and a
// Google/Apple login with that e-mail creates the account of whoever owns the
// e-mail and throws the requests away.
//
// Several requests for the same e-mail can coexist (the owner and someone else,
// or the owner twice with different passwords); each link creates the account
// with the password typed in ITS request, and confirming one discards the rest.
// Only the sha256 of the link token is stored.
import { createHash } from 'node:crypto';

export const CONFIRM_LINK_HOURS = 24;
// How long a request lives. Past the link's 24 hours the person can still log in
// with e-mail and password to get a new link; after this, they sign up again.
export const PENDING_SIGNUP_DAYS = 7;

export const PENDING_SIGNUP_SCHEMA = `
  CREATE TABLE IF NOT EXISTS mtr_harness.pending_signups (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email            text NOT NULL,
    name             text NOT NULL,
    password_hash    text NOT NULL,
    referral_code    text,
    language         text,
    token_hash       text NOT NULL UNIQUE,
    token_expires_at timestamptz NOT NULL,
    created_at       timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS pending_signups_email_idx
    ON mtr_harness.pending_signups(email, created_at DESC);
`;

const tokenHash = (t) => createHash('sha256').update(String(t)).digest('hex');

export function createPendingSignupStore(pool) {
  const live = `created_at > now() - interval '${PENDING_SIGNUP_DAYS} days'`;
  return {
    ensureSchema: () => pool.query(PENDING_SIGNUP_SCHEMA),

    // Saves a request with a fresh link. Old requests (any e-mail) are swept here.
    async add({ email, name, passwordHash, referralCode = null, language = null }, token) {
      await pool.query(`DELETE FROM mtr_harness.pending_signups WHERE NOT (${live})`);
      const { rows } = await pool.query(
        `INSERT INTO mtr_harness.pending_signups
           (email, name, password_hash, referral_code, language, token_hash, token_expires_at)
         VALUES ($1,$2,$3,$4,$5,$6, now() + interval '${CONFIRM_LINK_HOURS} hours')
         RETURNING id, email, language`,
        [String(email).toLowerCase(), name, passwordHash, referralCode || null, language || null, tokenHash(token)],
      );
      return rows[0];
    },

    // The live requests for an e-mail, newest first, one per password (a request
    // sent again has one row per link). Capped: the caller checks the password
    // against each one (scrypt), and that can't make a login cost without limit.
    async forEmail(email, limit = 5) {
      const { rows } = await pool.query(
        `SELECT * FROM (
           SELECT DISTINCT ON (password_hash)
                  id, email, name, password_hash, language, created_at,
                  token_expires_at > now() AS link_valid
             FROM mtr_harness.pending_signups
            WHERE email = $1 AND ${live}
            ORDER BY password_hash, token_expires_at DESC
         ) r ORDER BY created_at DESC LIMIT $2`,
        [String(email).toLowerCase(), limit],
      );
      return rows;
    },

    // A new link for an existing request. The links already sent keep working:
    // whoever asks again and then opens the older e-mail still gets in. The copy
    // keeps the request's age, so asking again doesn't stretch its life.
    async reissue(id, token) {
      const { rows } = await pool.query(
        `INSERT INTO mtr_harness.pending_signups
           (email, name, password_hash, referral_code, language, token_hash, token_expires_at, created_at)
         SELECT email, name, password_hash, referral_code, language, $2,
                now() + interval '${CONFIRM_LINK_HOURS} hours', created_at
           FROM mtr_harness.pending_signups WHERE id = $1 AND ${live}
         RETURNING id, email, language`,
        [id, tokenHash(token)],
      );
      return rows[0] || null;
    },

    // Takes the request out of the table in one statement: two taps on the same
    // link (or two tabs) can't both get it.
    async consume(token) {
      if (!token) return null;
      const { rows } = await pool.query(
        `DELETE FROM mtr_harness.pending_signups
          WHERE token_hash = $1 AND token_expires_at > now() AND ${live}
          RETURNING email, name, password_hash, referral_code, language`,
        [tokenHash(token)],
      );
      return rows[0] || null;
    },

    async clear(email) {
      await pool.query('DELETE FROM mtr_harness.pending_signups WHERE email = $1', [String(email).toLowerCase()]);
    },

    // Does the code still have an invite left? Sign-up decides the way in
    // before the account exists (createReferredUserByCode is the one that
    // actually takes the seat, on confirmation).
    async codeHasRoom(code) {
      const { rows } = await pool.query(
        `SELECT 1 FROM mtr_harness.users r
          WHERE r.referral_code = $1
            AND (SELECT count(*) FROM mtr_harness.users c WHERE c.referred_by = r.id) < r.invites_total
          LIMIT 1`, [String(code)],
      );
      return rows.length > 0;
    },
  };
}

// The request whose password matches, or null. Used by login and by "send it
// again": both only answer about a request to whoever knows its password.
export function matchingRequest(requests, password, verifyPassword) {
  for (const r of requests) if (verifyPassword(password, r.password_hash)) return r;
  return null;
}

// Turns a confirmed request into the account. `createAccount(request)` is the
// server's account creation (sign-up event, language); it returns the user or
// null. If the e-mail already got a live account meanwhile (another link of the
// same e-mail, Google), the link counts as used. The e-mail's other requests are
// discarded in every case where the account exists.
export async function confirmRequest(store, token, { getUserByEmail, purgeUser, createAccount }) {
  const request = await store.consume(token);
  if (!request) return null;
  const existing = await getUserByEmail(request.email);
  if (existing && !existing.deleted_at) {
    await store.clear(request.email);
    return null;
  }
  // An account closed by its owner and still inside the 30-day window holds the
  // e-mail (UNIQUE). Same rule sign-up had: whoever comes back with that e-mail
  // gets a clean account. Done only now, on confirmation, so a stranger signing
  // up can't wipe the closed account's data before its time.
  if (existing) await purgeUser(existing);
  let user;
  try { user = await createAccount(request); }
  catch (e) {
    if (e?.code === '23505') { await store.clear(request.email); return null; } // a simultaneous confirmation won
    throw e;
  }
  await store.clear(request.email);
  return user ? { user, email: request.email } : null;
}
