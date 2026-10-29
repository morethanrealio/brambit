// Client areas: an owner groups public assistants into areas and lets people of
// another account into an area with a role. The owner keeps seeing and changing
// everything; a member sees only the assistants of their own areas.
//
//   admin  — edits the assistant's instructions, texts and link sites; sees, exports,
//            blocks and deletes contacts.
//   viewer — reads only.
//
// Everything else (turning it on, caps, limits, retention, avatar, the website
// channel and its key) stays with the owner. The turn, the spend and WhatsApp
// still run on the owner's account (agents.user_id); an area only decides who
// reaches the owner's screen. One check (agentAccess, contactAccess) answers that for every route
// (public-support-owner.mjs); the owner filter in each query stays as a second lock.
import { readBody } from '../../http-body.mjs';

export const CLIENT_ROLES = ['admin', 'viewer'];
export const AREA_NAME_MAX = 120;
export const CLIENT_AREAS_PATH = '/api/public-support/areas';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuid = (v) => (UUID.test(String(v || '')) ? String(v) : null);

// An assistant sits in one area at most, and only in an area of its own owner:
// the access query checks that too, so a row that breaks it grants nothing.
export const clientAreaSchema = (S) => `
 CREATE TABLE IF NOT EXISTS ${S}.client_areas (
   id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
   owner_user_id uuid NOT NULL REFERENCES ${S}.users(id) ON DELETE CASCADE,
   name text NOT NULL,
   created_at timestamptz NOT NULL DEFAULT now());
 CREATE TABLE IF NOT EXISTS ${S}.client_area_members (
   area_id uuid NOT NULL REFERENCES ${S}.client_areas(id) ON DELETE CASCADE,
   user_id uuid NOT NULL REFERENCES ${S}.users(id) ON DELETE CASCADE,
   role text NOT NULL CHECK (role IN ('admin','viewer')),
   created_at timestamptz NOT NULL DEFAULT now(),
   PRIMARY KEY (area_id, user_id));
 CREATE INDEX IF NOT EXISTS client_area_members_user_idx ON ${S}.client_area_members(user_id);
 CREATE TABLE IF NOT EXISTS ${S}.client_area_agents (
   agent_id uuid PRIMARY KEY REFERENCES ${S}.agents(id) ON DELETE CASCADE,
   area_id uuid NOT NULL REFERENCES ${S}.client_areas(id) ON DELETE CASCADE);
`;

export function createClientAreaStore(pool, { S = 'mtr_harness' } = {}) {
  // An assistant's owner and the area it is in, joined to the person asking.
  const ACCESS = `SELECT a.id AS agent_id, a.user_id AS owner_id, ar.id AS area_id, ar.name AS area_name,
        CASE WHEN a.user_id = $1 THEN 'owner' ELSE m.role END AS role
     FROM ${S}.agents a
     LEFT JOIN ${S}.client_area_agents x ON x.agent_id = a.id
     LEFT JOIN ${S}.client_areas ar ON ar.id = x.area_id AND ar.owner_user_id = a.user_id
     LEFT JOIN ${S}.client_area_members m ON m.area_id = ar.id AND m.user_id = $1`;
  const asAccess = (r) => (r && r.role ? { ownerId: r.owner_id, role: r.role, agentId: r.agent_id, areaId: r.area_id, areaName: r.area_name } : null);

  return {
    init: () => pool.query(clientAreaSchema(S)),

    // → { ownerId, role: owner|admin|viewer, agentId, areaId, areaName } or null.
    async agentAccess(userId, agentId) {
      const { rows } = await pool.query(`${ACCESS} WHERE a.id = $2`, [userId, agentId]);
      return asAccess(rows[0]);
    },

    async contactAccess(userId, contactId) {
      const { rows } = await pool.query(`${ACCESS} JOIN ${S}.public_contacts c ON c.agent_id = a.id WHERE c.id = $2`, [userId, contactId]);
      return asAccess(rows[0]);
    },

    // The assistants a person reaches as a member, not as the owner.
    async memberAgents(userId) {
      const { rows } = await pool.query(`${ACCESS} WHERE m.user_id = $1 AND a.user_id <> $1 AND a.archived_at IS NULL`, [userId]);
      return rows.map(asAccess);
    },

    // The area of each of an owner's assistants: agentId → { areaId, areaName }.
    async areaOfAgents(ownerId) {
      const { rows } = await pool.query(
        `SELECT x.agent_id, ar.id, ar.name FROM ${S}.client_area_agents x
           JOIN ${S}.client_areas ar ON ar.id = x.area_id AND ar.owner_user_id = $1`, [ownerId]);
      return new Map(rows.map((r) => [r.agent_id, { areaId: r.id, areaName: r.name }]));
    },

    async list(ownerId) {
      const { rows } = await pool.query(
        `SELECT ar.id, ar.name, ar.created_at,
                coalesce((SELECT json_agg(json_build_object('agentId', x.agent_id, 'name', a.name) ORDER BY a.name)
                            FROM ${S}.client_area_agents x JOIN ${S}.agents a ON a.id = x.agent_id AND a.user_id = ar.owner_user_id
                           WHERE x.area_id = ar.id), '[]') AS agents,
                coalesce((SELECT json_agg(json_build_object('userId', u.id, 'email', u.email, 'role', m.role) ORDER BY u.email)
                            FROM ${S}.client_area_members m JOIN ${S}.users u ON u.id = m.user_id
                           WHERE m.area_id = ar.id), '[]') AS members
           FROM ${S}.client_areas ar WHERE ar.owner_user_id = $1 ORDER BY ar.name`, [ownerId]);
      return rows.map((r) => ({ id: r.id, name: r.name, createdAt: r.created_at, agents: r.agents, members: r.members }));
    },

    async create(ownerId, name) {
      const { rows } = await pool.query(
        `INSERT INTO ${S}.client_areas (owner_user_id, name) VALUES ($1, $2) RETURNING id, name`, [ownerId, name]);
      return rows[0];
    },

    // areaId null = the assistant leaves its area. Only the owner's assistant, only into the owner's area.
    async setAgentArea(ownerId, agentId, areaId) {
      if (areaId == null) {
        const { rowCount } = await pool.query(
          `DELETE FROM ${S}.client_area_agents x USING ${S}.agents a WHERE x.agent_id = $1 AND a.id = x.agent_id AND a.user_id = $2`, [agentId, ownerId]);
        return rowCount > 0 || !!(await pool.query(`SELECT 1 FROM ${S}.agents WHERE id = $1 AND user_id = $2`, [agentId, ownerId])).rows[0];
      }
      const { rowCount } = await pool.query(
        `INSERT INTO ${S}.client_area_agents (agent_id, area_id)
         SELECT a.id, ar.id FROM ${S}.agents a JOIN ${S}.client_areas ar ON ar.owner_user_id = a.user_id
          WHERE a.id = $1 AND ar.id = $2 AND a.user_id = $3
         ON CONFLICT (agent_id) DO UPDATE SET area_id = EXCLUDED.area_id`, [agentId, areaId, ownerId]);
      return rowCount > 0;
    },

    // An account that already exists joins the area (role) or leaves it (role null).
    // → 'ok' | 'no_area' | 'no_account'.
    async setMember(ownerId, areaId, email, role) {
      if (!(await pool.query(`SELECT 1 FROM ${S}.client_areas WHERE id = $1 AND owner_user_id = $2`, [areaId, ownerId])).rows[0]) return 'no_area';
      const user = (await pool.query(`SELECT id FROM ${S}.users WHERE lower(email) = lower($1)`, [email])).rows[0];
      if (!user) return 'no_account';
      if (role == null) {
        await pool.query(`DELETE FROM ${S}.client_area_members WHERE area_id = $1 AND user_id = $2`, [areaId, user.id]);
      } else {
        await pool.query(
          `INSERT INTO ${S}.client_area_members (area_id, user_id, role) VALUES ($1, $2, $3)
           ON CONFLICT (area_id, user_id) DO UPDATE SET role = EXCLUDED.role`, [areaId, user.id, role]);
      }
      return 'ok';
    },
  };
}

// The owner's routes to set areas up. A member or anyone else gets a 404 for an
// area that is not theirs; the screen comes later, these are its API.
export function registerClientAreaRoutes({ rotas, areas, send, fail, tooManyRequests }) {
  const route = (method, path, handle) => rotas.registrar(method, path, async (req, res, url, ctx) => {
    res.setHeader('Cache-Control', 'no-store');
    const user = await ctx.currentUser?.();
    if (!user) return send(res, 401, { error: 'unauthorized' });
    if (tooManyRequests(req, res, 'client-areas', 60, 60_000)) return;
    try { return await handle({ req, res, user }); }
    catch (e) { return fail(res, 500, 'client_areas_failed', e); }
  });
  const notFound = (res) => send(res, 404, { error: 'not_found' });

  route('GET', CLIENT_AREAS_PATH, async ({ res, user }) => send(res, 200, { areas: await areas.list(user.id) }));

  route('POST', CLIENT_AREAS_PATH, async ({ req, res, user }) => {
    const name = String((await readBody(req)).name ?? '').trim();
    if (!name || name.length > AREA_NAME_MAX) return send(res, 400, { error: 'bad_name', max: AREA_NAME_MAX });
    return send(res, 200, await areas.create(user.id, name));
  });

  // { agentId, areaId | null }
  route('POST', CLIENT_AREAS_PATH + '/agent', async ({ req, res, user }) => {
    const b = await readBody(req);
    const agentId = uuid(b.agentId);
    const areaId = b.areaId === null ? null : uuid(b.areaId);
    if (!agentId || (b.areaId !== null && !areaId)) return notFound(res);
    return (await areas.setAgentArea(user.id, agentId, areaId)) ? send(res, 200, { ok: true }) : notFound(res);
  });

  // { areaId, email, role: admin|viewer|null }
  route('POST', CLIENT_AREAS_PATH + '/member', async ({ req, res, user }) => {
    const b = await readBody(req);
    const areaId = uuid(b.areaId);
    const email = typeof b.email === 'string' ? b.email.trim() : '';
    if (!areaId) return notFound(res);
    if (!email || (b.role !== null && !CLIENT_ROLES.includes(b.role))) return send(res, 400, { error: 'bad_request' });
    const r = await areas.setMember(user.id, areaId, email, b.role);
    if (r === 'no_area') return notFound(res);
    if (r === 'no_account') return send(res, 400, { error: 'no_account' });
    return send(res, 200, { ok: true });
  });
}
