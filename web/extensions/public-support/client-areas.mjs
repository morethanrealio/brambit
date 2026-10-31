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
//
// Inviting an e-mail with no account creates a panel account: it is held to this
// screen (account-scope.mjs), so it never chats, creates assistants or spends,
// and it is not a product sign-up (no conta_criada event, so no plan or welcome
// from a plugin). The owner gets a one-time link to set the password and passes
// it on; with e-mail set up, the server can send it too.
import { readBody } from '../../http-body.mjs';
import { hashPassword, newToken, validEmail } from '../../auth.mjs';
import { marca } from '../../brand.mjs';
import { productI18n } from '../../i18n.mjs';
import { mailEnabled as coreMailEnabled, sendEmail as coreSendEmail } from '../../mailer.mjs';
import { remetenteConvite } from '../../company-invite-email.mjs';
import { PUBLIC_SUPPORT_PAGE } from '../../page-paths.mjs';
import { AGENT_TEXTS_PATH, PROFILES_PATH, PROFILES_CSV_PATH } from './public-support-owner.mjs';
import { METRICS_PATH } from './public-support-metrics.mjs';
import { ACTIVITY_PATH } from './client-area-activity.mjs';
import { EVENTS_PATH } from './public-support-events.mjs';

export const CLIENT_ROLES = ['admin', 'viewer'];
export const AREA_NAME_MAX = 120;
export const CLIENT_AREAS_PATH = '/api/public-support/areas';
// How long the link to set a panel account's password lasts.
export const INVITE_LINK_MINUTES = 72 * 60;

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
 CREATE TABLE IF NOT EXISTS ${S}.client_area_panel_accounts (
   user_id uuid PRIMARY KEY REFERENCES ${S}.users(id) ON DELETE CASCADE,
   invited_by uuid REFERENCES ${S}.users(id) ON DELETE SET NULL,
   created_at timestamptz NOT NULL DEFAULT now());
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
  // Panel accounts, kept in memory: the core asks on every request of a signed-in
  // account (account-scope.mjs). Only this store writes the table.
  const panel = new Set();
  let loaded = false;
  let loading = null;
  const loadPanel = () => (loading ||= pool.query(`SELECT user_id FROM ${S}.client_area_panel_accounts`, []).then(({ rows }) => {
    for (const r of rows) panel.add(r.user_id);
    loaded = true;
  }, (e) => { loading = null; throw e; }));

  return {
    init: () => pool.query(clientAreaSchema(S)),

    // What the core's account scope reads. Until the list loads, every signed-in
    // account is checked, so nobody slips through at boot.
    panelActive: () => !loaded || panel.size > 0,
    async isPanelAccount(userId) { await loadPanel(); return panel.has(userId); },

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

    // An account joins the area (role) or leaves it (role null). An e-mail with no
    // account joins as a new panel account. → { status: 'ok' | 'no_area' |
    // 'no_account' | 'account_closed', userId, created }.
    async setMember(ownerId, areaId, email, role) {
      await loadPanel();
      const area = (await pool.query(`SELECT name FROM ${S}.client_areas WHERE id = $1 AND owner_user_id = $2`, [areaId, ownerId])).rows[0];
      if (!area) return { status: 'no_area' };
      let user = (await pool.query(`SELECT id, deleted_at FROM ${S}.users WHERE lower(email) = lower($1)`, [email])).rows[0];
      if (user?.deleted_at) return { status: 'account_closed' };
      if (role == null) {
        if (!user) return { status: 'no_account' };
        await pool.query(`DELETE FROM ${S}.client_area_members WHERE area_id = $1 AND user_id = $2`, [areaId, user.id]);
        return { status: 'ok', userId: user.id, created: false };
      }
      const created = !user;
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        if (created) {
          const em = email.toLowerCase();
          user = (await client.query(`INSERT INTO ${S}.users (name, email, password_hash) VALUES ($1, $2, $3) RETURNING id`,
            [em.split('@')[0], em, hashPassword(newToken())])).rows[0];
          await client.query(`INSERT INTO ${S}.client_area_panel_accounts (user_id, invited_by) VALUES ($1, $2)`, [user.id, ownerId]);
        }
        await client.query(
          `INSERT INTO ${S}.client_area_members (area_id, user_id, role) VALUES ($1, $2, $3)
           ON CONFLICT (area_id, user_id) DO UPDATE SET role = EXCLUDED.role`, [areaId, user.id, role]);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      } finally { client.release(); }
      if (created) panel.add(user.id);
      return { status: 'ok', userId: user.id, created, areaName: area.name };
    },

    // A one-time token to set the password (core's /reset page), only for a panel
    // account that never set one; null otherwise, so the owner can't take over
    // an account its person already uses.
    async inviteToken(userId, minutes = INVITE_LINK_MINUTES) {
      await loadPanel();
      if (!panel.has(userId)) return null;
      const used = (await pool.query(`SELECT 1 FROM ${S}.password_resets WHERE user_id = $1 AND used_at IS NOT NULL LIMIT 1`, [userId])).rows[0];
      if (used) return null;
      const token = newToken();
      await pool.query(`INSERT INTO ${S}.password_resets (token, user_id, expires_at) VALUES ($1, $2, now() + ($3 || ' minutes')::interval)`,
        [token, userId, String(minutes)]);
      return token;
    },
  };
}

// What the core's account scope (account-scope.mjs) holds a panel account to:
// the owner's screen and its routes, as a member. Not the areas' own routes,
// which only an owner uses.
export const panelScope = (areas) => ({
  name: 'public-support', active: areas.panelActive, holds: areas.isPanelAccount, home: PUBLIC_SUPPORT_PAGE,
  api: (method, path) => path.startsWith('/api/publico/') || path === AGENT_TEXTS_PATH || path.startsWith(AGENT_TEXTS_PATH + '/') || path === METRICS_PATH || path === EVENTS_PATH || path === ACTIVITY_PATH
    || path === PROFILES_PATH || path === PROFILES_CSV_PATH,
});

// The invite e-mail, in the inviter's language (the invitee has none yet).
export function inviteEmail({ link, areaName, inviter, language }) {
  const t = (k, vars = {}) => productI18n().t(`emails.client_area_invite.${k}`, language, { brand: marca().nome, area: areaName, ...vars });
  return { subject: t('subject'), text: t('body', { link, inviter: inviter || marca().nome }) };
}

// The owner's routes to set areas up, used by the areas card of the owner's
// screen. A member or anyone else gets a 404 for an area that is not theirs.
// publicBase() → the installation's address, for the password link. mail = the
// core's mailer ({ enabled(), send() }); the invite e-mail goes out only when
// the owner asks for it (sendEmail: true) and e-mail is set up. activity
// (client-area-activity.mjs) = the access log, where each change is recorded.
export function registerClientAreaRoutes({ rotas, areas, send, fail, tooManyRequests, publicBase = () => '',
  mail = { enabled: coreMailEnabled, send: coreSendEmail }, log = console, activity = null }) {
  const route = (method, path, handle) => rotas.registrar(method, path, async (req, res, url, ctx) => {
    res.setHeader('Cache-Control', 'no-store');
    const user = await ctx.currentUser?.();
    if (!user) return send(res, 401, { error: 'unauthorized' });
    if (tooManyRequests(req, res, 'client-areas', 60, 60_000)) return;
    try { return await handle({ req, res, user }); }
    catch (e) { return fail(res, 500, 'client_areas_failed', e); }
  });
  const notFound = (res) => send(res, 404, { error: 'not_found' });
  const record = (user, action, areaId, { agentId = null, detail = null } = {}) =>
    activity?.record({ ownerId: user.id, actorId: user.id, agentId, areaId, action, detail });

  // mail: whether the screen offers to e-mail the invite link.
  route('GET', CLIENT_AREAS_PATH, async ({ res, user }) => send(res, 200, { areas: await areas.list(user.id), mail: !!mail.enabled() }));

  route('POST', CLIENT_AREAS_PATH, async ({ req, res, user }) => {
    const name = String((await readBody(req)).name ?? '').trim();
    if (!name || name.length > AREA_NAME_MAX) return send(res, 400, { error: 'bad_name', max: AREA_NAME_MAX });
    const area = await areas.create(user.id, name);
    await record(user, 'area_created', area.id);
    return send(res, 200, area);
  });

  // { agentId, areaId | null }
  route('POST', CLIENT_AREAS_PATH + '/agent', async ({ req, res, user }) => {
    const b = await readBody(req);
    const agentId = uuid(b.agentId);
    const areaId = b.areaId === null ? null : uuid(b.areaId);
    if (!agentId || (b.areaId !== null && !areaId)) return notFound(res);
    const was = areaId ? null : (await areas.agentAccess(user.id, agentId))?.areaId;
    if (!(await areas.setAgentArea(user.id, agentId, areaId))) return notFound(res);
    if (areaId || was) await record(user, areaId ? 'assistant_added' : 'assistant_removed', areaId || was, { agentId });
    return send(res, 200, { ok: true });
  });

  // { areaId, email, role: admin|viewer|null, sendEmail? }. An e-mail with no
  // account becomes a panel account; while it has no password, every invite
  // returns a fresh link to set one (link) and, if asked, e-mails it (emailed).
  route('POST', CLIENT_AREAS_PATH + '/member', async ({ req, res, user }) => {
    const b = await readBody(req);
    const areaId = uuid(b.areaId);
    const email = typeof b.email === 'string' ? b.email.trim() : '';
    if (!areaId) return notFound(res);
    if (!validEmail(email) || (b.role !== null && !CLIENT_ROLES.includes(b.role))) return send(res, 400, { error: 'bad_request' });
    const r = await areas.setMember(user.id, areaId, email, b.role);
    if (r.status === 'no_area') return notFound(res);
    if (r.status !== 'ok') return send(res, 400, { error: r.status });
    await record(user, b.role === null ? 'member_removed' : 'member_invited', areaId,
      { detail: b.role === null ? { email: email.toLowerCase() } : { email: email.toLowerCase(), role: b.role } });
    const token = b.role !== null && (await areas.inviteToken(r.userId));
    if (!token) return send(res, 200, { ok: true, created: r.created });
    const link = `${String(publicBase() || '').replace(/\/+$/, '')}/reset?token=${token}`;
    let emailed = false;
    if (b.sendEmail === true && mail.enabled()) {
      try {
        const { subject, text } = inviteEmail({ link, areaName: r.areaName, inviter: user.name, language: res.idiomaResposta });
        emailed = !!(await mail.send({ to: email.toLowerCase(), subject, text, ...remetenteConvite() }))?.ok;
      } catch (e) { log.error?.('[client-areas] invite e-mail failed:', e?.message ?? e); }
    }
    return send(res, 200, { ok: true, created: r.created, link, linkHours: INVITE_LINK_MINUTES / 60, emailed });
  });
}
