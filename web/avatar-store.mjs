// An assistant's avatar: the face photo, the consent to use that face and the
// ready-made voice it speaks with, plus where the photo stands at the avatar
// service (vidu.mjs). The photo lives here, in the database, not in the media
// bucket: it is private to the owner, works without a bucket, and goes away
// with the assistant or the account (ON DELETE CASCADE).
//
// The avatar service registers a photo by content, so two rows with the same
// bytes share one provider photo; a provider photo is only deleted when no row
// holds it anymore (`held`).
export const CONSENTS = ['self', 'authorized', 'fictional'];

export async function avatarSchema({ pool, S }) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${S}.agent_avatars (
      agent_id     uuid PRIMARY KEY REFERENCES ${S}.agents(id) ON DELETE CASCADE,
      user_id      uuid NOT NULL REFERENCES ${S}.users(id) ON DELETE CASCADE,
      photo        bytea NOT NULL,
      photo_mime   text NOT NULL,
      photo_sha256 text NOT NULL,
      consent      text NOT NULL CHECK (consent IN ('self', 'authorized', 'fictional')),
      consent_at   timestamptz NOT NULL DEFAULT now(),
      voice        text,
      provider_photo_id         text,
      provider_photo_created_at timestamptz,
      provider_status text NOT NULL DEFAULT 'pending' CHECK (provider_status IN ('pending', 'registering', 'ready', 'failed')),
      provider_error  text,
      updated_at   timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS agent_avatars_user_idx ON ${S}.agent_avatars (user_id);
    CREATE INDEX IF NOT EXISTS agent_avatars_provider_photo_idx ON ${S}.agent_avatars (provider_photo_id);
  `);
}

const FIELDS = 'agent_id, user_id, photo_mime, photo_sha256, consent, consent_at, voice, provider_photo_id, provider_photo_created_at, provider_status, provider_error, updated_at';

export function createAvatarStore({ pool, S }) {
  const one = async (sql, args) => (await pool.query(sql, args)).rows[0] || null;
  return {
    // Everything but the photo bytes.
    get: (agentId, userId) => one(`SELECT ${FIELDS} FROM ${S}.agent_avatars WHERE agent_id = $1 AND user_id = $2`, [agentId, userId]),

    photo: (agentId, userId) => one(`SELECT photo, photo_mime, photo_sha256 FROM ${S}.agent_avatars WHERE agent_id = $1 AND user_id = $2`, [agentId, userId]),

    // photo = {buffer, mime, sha256} or null to keep the current one (a first
    // save without a photo returns null). A new photo goes back to 'pending'
    // and hands back the provider photo it replaced in `released`; consent is
    // dated again whenever the photo or the consent changes.
    async save({ agentId, userId, photo, consent, voice }) {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        const cur = (await c.query(`SELECT photo_sha256, consent, provider_photo_id FROM ${S}.agent_avatars WHERE agent_id = $1 AND user_id = $2 FOR UPDATE`, [agentId, userId])).rows[0];
        let row, released = null, register = false;
        if (!cur) {
          if (!photo) { await c.query('ROLLBACK'); return null; }
          row = (await c.query(
            `INSERT INTO ${S}.agent_avatars (agent_id, user_id, photo, photo_mime, photo_sha256, consent, voice)
             VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ${FIELDS}`,
            [agentId, userId, photo.buffer, photo.mime, photo.sha256, consent, voice],
          )).rows[0];
          register = true;
        } else if (photo && photo.sha256 !== cur.photo_sha256) {
          row = (await c.query(
            `UPDATE ${S}.agent_avatars SET photo = $3, photo_mime = $4, photo_sha256 = $5, consent = $6, consent_at = now(), voice = $7,
               provider_photo_id = NULL, provider_photo_created_at = NULL, provider_status = 'pending', provider_error = NULL, updated_at = now()
             WHERE agent_id = $1 AND user_id = $2 RETURNING ${FIELDS}`,
            [agentId, userId, photo.buffer, photo.mime, photo.sha256, consent, voice],
          )).rows[0];
          released = cur.provider_photo_id;
          register = true;
        } else {
          row = (await c.query(
            `UPDATE ${S}.agent_avatars SET consent = $3, consent_at = CASE WHEN consent = $3 THEN consent_at ELSE now() END, voice = $4, updated_at = now()
             WHERE agent_id = $1 AND user_id = $2 RETURNING ${FIELDS}`,
            [agentId, userId, consent, voice],
          )).rows[0];
        }
        await c.query('COMMIT');
        return { row, released, register };
      } catch (e) {
        await c.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        c.release();
      }
    },

    // → the provider photo the deleted row held (null when there was none or no row).
    async remove(agentId, userId) {
      const r = await one(`DELETE FROM ${S}.agent_avatars WHERE agent_id = $1 AND user_id = $2 RETURNING provider_photo_id`, [agentId, userId]);
      return r?.provider_photo_id ?? null;
    },

    // Whether some row still holds this provider photo (other than the given user's, when passed).
    async held(providerPhotoId, { exceptUserId = null } = {}) {
      const r = await one(`SELECT 1 FROM ${S}.agent_avatars WHERE provider_photo_id = $1 AND ($2::uuid IS NULL OR user_id <> $2) LIMIT 1`, [providerPhotoId, exceptUserId]);
      return !!r;
    },

    // The latest assistant reply in one of the user's chats, {id, content}: what a live avatar says (avatar-live.mjs).
    latestReply: (threadId, userId) => one(
      `SELECT m.id, m.content FROM ${S}.messages m JOIN ${S}.threads t ON t.id = m.thread_id
        WHERE m.thread_id = $1 AND t.user_id = $2 AND m.role = 'assistant' ORDER BY m.id DESC LIMIT 1`,
      [threadId, userId],
    ),

    // The photo to register for an agent, with its owner; null once it is gone.
    forRegistration: (agentId) => one(`SELECT agent_id, user_id, photo, photo_mime, photo_sha256 FROM ${S}.agent_avatars WHERE agent_id = $1`, [agentId]),

    markRegistering: (agentId, sha256) => pool.query(
      `UPDATE ${S}.agent_avatars SET provider_status = 'registering', provider_error = NULL, updated_at = now() WHERE agent_id = $1 AND photo_sha256 = $2`,
      [agentId, sha256],
    ),

    // A provider photo got ready for these bytes: every row with the same bytes
    // and every row that held a photo the registration discarded point to it.
    // → how many rows took it (0 = the photo changed meanwhile, nobody holds it).
    async markReady(sha256, { id, createdAt, discarded = [] }) {
      const r = await pool.query(
        `UPDATE ${S}.agent_avatars SET provider_photo_id = $2, provider_photo_created_at = $3, provider_status = 'ready', provider_error = NULL, updated_at = now()
         WHERE photo_sha256 = $1 OR provider_photo_id = ANY($4::text[])`,
        [sha256, id, createdAt, discarded],
      );
      return r.rowCount;
    },

    // retry = the service failed, not the photo: stays 'pending' for the sweep.
    markFailed: (agentId, sha256, code, { retry = false } = {}) => pool.query(
      `UPDATE ${S}.agent_avatars SET provider_status = $3, provider_error = $4, updated_at = now() WHERE agent_id = $1 AND photo_sha256 = $2`,
      [agentId, sha256, retry ? 'pending' : 'failed', code],
    ),

    // Rows to register again: waiting, or caught mid-registration by a restart.
    stuck: (staleMs) => pool.query(
      `SELECT agent_id FROM ${S}.agent_avatars
        WHERE provider_status = 'pending' OR (provider_status = 'registering' AND updated_at < now() - make_interval(secs => $1::double precision / 1000))`,
      [staleMs],
    ).then((r) => r.rows.map((x) => x.agent_id)),

    // One row per provider photo created before `before`, with the bytes to register it again.
    aging: (before) => pool.query(
      `SELECT DISTINCT ON (provider_photo_id) provider_photo_id, photo, photo_mime, photo_sha256 FROM ${S}.agent_avatars
        WHERE provider_status = 'ready' AND provider_photo_created_at < $1 ORDER BY provider_photo_id, updated_at DESC`,
      [before],
    ).then((r) => r.rows),

    // Avatars of deleted (archived) assistants: deleted with this, → the provider photos they held.
    async dropArchived() {
      const r = await pool.query(
        `DELETE FROM ${S}.agent_avatars v USING ${S}.agents a WHERE a.id = v.agent_id AND a.archived_at IS NOT NULL RETURNING v.provider_photo_id`,
      );
      return [...new Set(r.rows.map((x) => x.provider_photo_id).filter(Boolean))];
    },

    // The provider photos a user's avatars hold that no other user's avatar holds.
    ownPhotos: (userId) => pool.query(
      `SELECT DISTINCT provider_photo_id FROM ${S}.agent_avatars v WHERE user_id = $1 AND provider_photo_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM ${S}.agent_avatars o WHERE o.provider_photo_id = v.provider_photo_id AND o.user_id <> $1)`,
      [userId],
    ).then((r) => r.rows.map((x) => x.provider_photo_id)),
  };
}
