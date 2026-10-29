// Access log of public support: who opened a conversation, exported, blocked or
// deleted a contact, changed an assistant's settings or texts, and who set the
// client areas up (client-areas.mjs). It keeps the action, the person, the
// assistant, the area and the time, never what the conversation or the text says.
//
// The owner sees every line of their assistants; an area's admin sees the lines
// of that area, the owner's own included; a viewer sees none. A line keeps the
// area the assistant was in when it happened, so moving an assistant later does
// not hand its past to another area.
export const ACTIVITY_PATH = '/api/public-support/activity';
export const ACTIVITY_PAGE = 50;
export const ACTIVITY_ACTIONS = [
  'conversation_opened', 'contact_exported', 'contact_blocked', 'contact_unblocked', 'contact_deleted',
  'settings_changed', 'web_key_created', 'text_changed', 'text_restored',
  'area_created', 'assistant_added', 'assistant_removed', 'member_invited', 'member_removed',
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

    // The newest lines first, ACTIVITY_PAGE at a time (before = the last id seen).
    // areaId narrows to one area, for a member; the owner's id is always checked.
    async list({ ownerId, areaId = null, before = null }) {
      const { rows } = await pool.query(
        `SELECT l.id, l.action, l.detail, l.created_at, u.email AS actor, a.name AS agent, ar.name AS area
           FROM ${S}.public_support_activity l
           LEFT JOIN ${S}.users u ON u.id = l.actor_user_id
           LEFT JOIN ${S}.agents a ON a.id = l.agent_id
           LEFT JOIN ${S}.client_areas ar ON ar.id = l.area_id
          WHERE l.owner_user_id = $1 AND ($2::uuid IS NULL OR l.area_id = $2) AND ($3::bigint IS NULL OR l.id < $3)
          ORDER BY l.id DESC LIMIT $4`, [ownerId, areaId, before, ACTIVITY_PAGE]);
      return rows.map((r) => ({ id: Number(r.id), action: r.action, detail: r.detail, at: r.created_at, actor: r.actor, agent: r.agent, area: r.area }));
    },
  };
}
