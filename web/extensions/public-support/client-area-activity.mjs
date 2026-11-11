// Access log of public support: who opened a conversation, exported, blocked or
// deleted a contact, changed an assistant's settings or texts, who set the
// client areas up (client-areas.mjs), and when an area's member signed in. It
// keeps the action, the person, the assistant, the area and the time, never what
// the conversation or the text says.
//
// Only the owner of the assistants reads it. A line keeps the area the assistant
// was in when it happened, so moving an assistant later does not hand its past
// to another area.
export const ACTIVITY_PATH = '/api/public-support/activity';
export const ACTIVITY_PAGE = 50;
export const ACTIVITY_ACTIONS = [
  'conversation_opened', 'contact_exported', 'contact_blocked', 'contact_unblocked', 'contact_deleted',
  'settings_changed', 'web_key_created', 'text_changed', 'text_restored',
  'area_created', 'assistant_added', 'assistant_removed', 'member_invited', 'member_removed', 'events_exported',
  'profiles_exported', 'theme_changed', 'panel_signed_in', 'password_link', 'test_contacts_changed',
];

// After clientAreaSchema: a line points to an area.
export const activitySchema = (S) => `
 CREATE TABLE IF NOT EXISTS ${S}.public_support_activity (
   id bigserial PRIMARY KEY,
   owner_user_id uuid NOT NULL REFERENCES ${S}.users(id) ON DELETE CASCADE,
   actor_user_id uuid REFERENCES ${S}.users(id) ON DELETE SET NULL,
   agent_id uuid REFERENCES ${S}.agents(id) ON DELETE SET NULL,
   area_id uuid REFERENCES ${S}.client_areas(id) ON DELETE SET NULL,
   action text NOT NULL,
   detail jsonb,
   created_at timestamptz NOT NULL DEFAULT now());
 CREATE INDEX IF NOT EXISTS public_support_activity_owner_idx ON ${S}.public_support_activity(owner_user_id, id DESC);
 CREATE INDEX IF NOT EXISTS public_support_activity_area_idx ON ${S}.public_support_activity(area_id, id DESC);
`;

export function createActivityStore(pool, { S = 'mtr_harness', log = console } = {}) {
  return {
    // detail: only what names the change (a text's kind, an invited e-mail and role).
    // A failed write never undoes the action it records; it goes to the server log.
    async record({ ownerId, actorId, agentId = null, areaId = null, action, detail = null }) {
      if (!ACTIVITY_ACTIONS.includes(action)) throw Error('activity: unknown action ' + action);
      try {
        await pool.query(`INSERT INTO ${S}.public_support_activity (owner_user_id, actor_user_id, agent_id, area_id, action, detail)
          VALUES ($1, $2, $3, $4, $5, $6)`, [ownerId, actorId, agentId, areaId, action, detail && JSON.stringify(detail)]);
      } catch (e) { log.error?.('[activity] record failed:', e?.message ?? e); }
    },

    // One line per sign-in: none if this person already has one for this owner and
    // area since the session began (since = the session's start; null = ever).
    async recordSignIn({ ownerId, actorId, areaId, since = null }) {
      try {
        await pool.query(`INSERT INTO ${S}.public_support_activity (owner_user_id, actor_user_id, area_id, action)
          SELECT $1::uuid, $2::uuid, $3::uuid, 'panel_signed_in' WHERE NOT EXISTS (SELECT 1 FROM ${S}.public_support_activity
            WHERE owner_user_id = $1 AND actor_user_id = $2 AND area_id IS NOT DISTINCT FROM $3::uuid
              AND action = 'panel_signed_in' AND created_at >= COALESCE($4::timestamptz, '-infinity'))`, [ownerId, actorId, areaId, since]);
      } catch (e) { log.error?.('[activity] record failed:', e?.message ?? e); }
    },

    // The newest lines first, ACTIVITY_PAGE at a time (before = the last id seen).
    async list({ ownerId, before = null }) {
      const { rows } = await pool.query(
        `SELECT l.id, l.action, l.detail, l.created_at, u.email AS actor, a.name AS agent, ar.name AS area
           FROM ${S}.public_support_activity l
           LEFT JOIN ${S}.users u ON u.id = l.actor_user_id
           LEFT JOIN ${S}.agents a ON a.id = l.agent_id
           LEFT JOIN ${S}.client_areas ar ON ar.id = l.area_id
          WHERE l.owner_user_id = $1 AND ($2::bigint IS NULL OR l.id < $2)
          ORDER BY l.id DESC LIMIT $3`, [ownerId, before, ACTIVITY_PAGE]);
      return rows.map((r) => ({ id: Number(r.id), action: r.action, detail: r.detail, at: r.created_at, actor: r.actor, agent: r.agent, area: r.area }));
    },
  };
}
