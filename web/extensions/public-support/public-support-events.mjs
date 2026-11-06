// What happened in an assistant's public conversations besides the messages:
// a plugin's own steps (showed products, put one in the bag, the skin scan came
// back) and the clicks on the links the assistant sent. Each event names the
// contact and the time, so the owner can follow a person through the steps and
// count how many reached each one (funnel).
//
// Events live as long as the conversation: they go with the contact (delete
// command, owner's delete, retention) and with its messages when the
// conversation alone is erased (store.apagarConversa).
//
// Measured links: a link button the person gets points to this server
// (CLICK_PATH?l=<id>) instead of the site (the web chat gets it in clickUrl, next
// to the real url). The id is random and the address it
// leads to is kept here, so the route never sends anyone to an address it did
// not store. A click records the event and redirects. The conversation keeps
// the real address: the owner reading it doesn't open the measured one.
import { randomBytes } from 'node:crypto';
import { defaultTimezone } from '../../locale.mjs';

export const CLICK_PATH = '/go';
export const EVENTS_PATH = '/api/public-support/events.csv';
export const LINK_CLICK = 'link_click';
export const EVENT_KIND = /^[a-z][a-z0-9_.-]{0,63}$/;
export const EVENT_REF_MAX = 200;
export const LINK_URL_MAX = 2000;
export const FUNNEL_STEPS_MAX = 5;
const KINDS_PER_STEP_MAX = 5;
export const TOP_REFS_MAX = 50;    // refs a top() call returns, or a step lists, at most
export const EVENTS_EXPORT_MAX = 50000;
const CLICK_REPEAT_MS = 5000;      // a second tap on the same link this soon is the same click
const CLICKS_PER_LINK_HOUR = 20;   // past this, a link's clicks stop counting for the hour
const LINK_ID = /^[A-Za-z0-9_-]{16}$/;
// Link previews and crawlers fetch the address without anyone clicking. WhatsApp's
// own preview starts with "WhatsApp/"; its in-app browser does not.
const PREVIEW = /^WhatsApp\/|facebookexternalhit|Facebot|Slackbot|TelegramBot|Twitterbot|Discordbot|LinkedInBot|SkypeUriPreview|Googlebot|bingbot|HeadlessChrome/i;

// Inside esquemaPublico, after public_contacts.
export const eventsSchema = (S) => `
 CREATE TABLE IF NOT EXISTS ${S}.public_support_events (
   id bigserial PRIMARY KEY,
   agent_id uuid NOT NULL REFERENCES ${S}.public_agents(agent_id) ON DELETE CASCADE,
   contact_id uuid NOT NULL REFERENCES ${S}.public_contacts(id) ON DELETE CASCADE,
   kind text NOT NULL, ref text NOT NULL DEFAULT '', link_id text,
   at timestamptz NOT NULL DEFAULT now());
 CREATE INDEX IF NOT EXISTS public_support_events_agent_idx ON ${S}.public_support_events(agent_id, at);
 CREATE INDEX IF NOT EXISTS public_support_events_contact_idx ON ${S}.public_support_events(contact_id);
 CREATE TABLE IF NOT EXISTS ${S}.public_support_links (
   id text PRIMARY KEY,
   agent_id uuid NOT NULL REFERENCES ${S}.public_agents(agent_id) ON DELETE CASCADE,
   contact_id uuid NOT NULL REFERENCES ${S}.public_contacts(id) ON DELETE CASCADE,
   url text NOT NULL, ref text NOT NULL DEFAULT '',
   created_at timestamptz NOT NULL DEFAULT now());
 CREATE UNIQUE INDEX IF NOT EXISTS public_support_links_same_idx ON ${S}.public_support_links(contact_id, md5(url), ref);
`;

const cleanRef = (v) => String(v ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, EVENT_REF_MAX);
export const isPreview = (userAgent) => PREVIEW.test(String(userAgent ?? ''));

// A step of a funnel or a count: {kind, ref?} matches that ref, {kind, refPrefix?}
// any ref that starts with it. kind may be a list, any of them: a tap on a product
// card and a click on its link are both a click. → [sql, params] for a WHERE,
// numbered from `n`.
function match(step, n) {
  const kinds = [step?.kind].flat().map((k) => String(k ?? ''));
  if (!kinds.length || kinds.length > KINDS_PER_STEP_MAX || !kinds.every((k) => EVENT_KIND.test(k))) throw Error('events: bad kind');
  const [kind, value] = kinds.length === 1 ? [`kind = $${n}`, kinds[0]] : [`kind = ANY($${n}::text[])`, kinds];
  if (Array.isArray(step.ref)) {
    if (!step.ref.length || step.ref.length > TOP_REFS_MAX) throw Error('events: 1 to ' + TOP_REFS_MAX + ' refs');
    return [`${kind} AND ref = ANY($${n + 1}::text[])`, [value, step.ref.map(cleanRef)]];
  }
  if (step.ref !== undefined) return [`${kind} AND ref = $${n + 1}`, [value, cleanRef(step.ref)]];
  if (step.refPrefix !== undefined) return [`${kind} AND left(ref, length($${n + 1})) = $${n + 1}`, [value, cleanRef(step.refPrefix)]];
  return [kind, [value]];
}

export function createEventsStore(pool, { S = 'mtr_harness', timezone = defaultTimezone(), log = console } = {}) {
  // from/to = first and last day (YYYY-MM-DD) in the installation's timezone.
  const period = (n) => `at >= ($${n}::date::timestamp AT TIME ZONE $${n + 2}) AND at < (($${n + 1}::date + 1)::timestamp AT TIME ZONE $${n + 2})`;
  // range = {from, to} and/or {contactId}: the period, one contact, or both. → [sql, params], numbered from `n`.
  const scope = ({ from, to, contactId } = {}, n) => {
    const parts = [], params = [];
    if (contactId) { parts.push(`contact_id = $${n}`); params.push(contactId); }
    if (from && to) { parts.push(period(n + params.length)); params.push(from, to, timezone); }
    return [parts.join(' AND ') || 'true', params];
  };

  return {
    // A plugin's event. Never throws: a failed write only goes to the log, the
    // conversation goes on.
    async record({ agentId, contactId, kind, ref = '' }) {
      if (!EVENT_KIND.test(String(kind ?? ''))) { log.error?.('[events] bad kind ignored'); return false; }
      try {
        await pool.query(`INSERT INTO ${S}.public_support_events (agent_id, contact_id, kind, ref) VALUES ($1, $2, $3, $4)`,
          [agentId, contactId, kind, cleanRef(ref)]);
        return true;
      } catch (e) { log.error?.('[events] record failed:', e?.message ?? e); return false; }
    },

    // The id of the measured link for this contact, address and ref (the same one
    // each time, so a conversation re-read keeps its links). null = keep the address.
    async linkId({ agentId, contactId, url, ref = '' }) {
      if (typeof url !== 'string' || url.length > LINK_URL_MAX) return null;
      const id = randomBytes(12).toString('base64url');
      const { rows } = await pool.query(
        `INSERT INTO ${S}.public_support_links (id, agent_id, contact_id, url, ref) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (contact_id, md5(url), ref) DO UPDATE SET created_at = now() RETURNING id`, [id, agentId, contactId, url, cleanRef(ref)]);
      return rows[0]?.id ?? null;
    },

    // A click: → the address to send the person to, or null (unknown or expired id).
    // record=false (a link preview) only looks the address up.
    async click(id, { record = true } = {}) {
      if (!LINK_ID.test(String(id ?? ''))) return null;
      const { rows: [l] } = await pool.query(`SELECT id, agent_id, contact_id, url, ref FROM ${S}.public_support_links WHERE id = $1`, [id]);
      if (!l) return null;
      if (record) {
        await pool.query(
          `INSERT INTO ${S}.public_support_events (agent_id, contact_id, kind, ref, link_id)
           SELECT $1, $2, '${LINK_CLICK}', $3, $4
            WHERE NOT EXISTS (SELECT 1 FROM ${S}.public_support_events WHERE link_id = $4 AND at > now() - interval '${CLICK_REPEAT_MS} milliseconds')
              AND (SELECT count(*) FROM ${S}.public_support_events WHERE link_id = $4 AND at > now() - interval '1 hour') < ${CLICKS_PER_LINK_HOUR}`,
          [l.agent_id, l.contact_id, l.ref, l.id]).catch((e) => log.error?.('[events] click failed:', e?.message ?? e));
      }
      return l.url;
    },

    // How many times and how many people, in the period.
    async count(agentId, range, step) {
      const [inScope, scoped] = scope(range, 2);
      const [where, params] = match(step, 2 + scoped.length);
      const { rows: [r] } = await pool.query(
        `SELECT count(*)::int AS times, count(DISTINCT contact_id)::int AS people FROM ${S}.public_support_events
          WHERE agent_id = $1 AND ${inScope} AND ${where}`, [agentId, ...scoped, ...params]);
      return { times: r?.times ?? 0, people: r?.people ?? 0 };
    },

    // The step's refs, most frequent first: {rows: [{ref, times, people}] (at most
    // `limit`), refs: how many different refs in all}. Events with no ref don't count.
    async top(agentId, range, step, limit = 10) {
      const n = Math.min(Math.max(Math.trunc(Number(limit)) || 10, 1), TOP_REFS_MAX);
      const [inScope, scoped] = scope(range, 2);
      const [where, params] = match(step, 2 + scoped.length);
      const { rows } = await pool.query(
        `SELECT ref, count(*)::int AS times, count(DISTINCT contact_id)::int AS people, count(*) OVER ()::int AS refs
           FROM ${S}.public_support_events
          WHERE agent_id = $1 AND ${inScope} AND ${where} AND ref <> ''
          GROUP BY ref ORDER BY times DESC, ref LIMIT ${n}`, [agentId, ...scoped, ...params]);
      return { rows: rows.map(({ ref, times, people }) => ({ ref, times, people })), refs: rows[0]?.refs ?? 0 };
    },

    // People who did each step in order, in the period: [step 1, step 2 after
    // step 1, step 3 after step 2, ...].
    async funnel(agentId, range, steps) {
      if (!Array.isArray(steps) || !steps.length || steps.length > FUNNEL_STEPS_MAX) throw Error('events: 1 to ' + FUNNEL_STEPS_MAX + ' steps');
      const [inScope, scoped] = scope(range, 2);
      const params = [agentId, ...scoped];
      const ctes = steps.map((s, i) => {
        const [where, p] = match(s, params.length + 1);
        params.push(...p);
        const base = `FROM ${S}.public_support_events e WHERE e.agent_id = $1 AND ${inScope.replace(/\b(at|contact_id)\b/g, 'e.$1')} AND ${where.replace(/\b(kind|ref)\b/g, 'e.$1')}`;
        return i === 0
          ? `s0 AS (SELECT e.contact_id, min(e.at) AS t ${base} GROUP BY e.contact_id)`
          : `s${i} AS (SELECT e.contact_id, min(e.at) AS t ${base.replace('WHERE', `JOIN s${i - 1} p ON p.contact_id = e.contact_id AND e.at >= p.t WHERE`)} GROUP BY e.contact_id)`;
      });
      const { rows: [r] } = await pool.query(`WITH ${ctes.join(', ')} SELECT ${steps.map((_, i) => `(SELECT count(*)::int FROM s${i}) AS n${i}`).join(', ')}`, params);
      return steps.map((_, i) => r?.[`n${i}`] ?? 0);
    },

    // The owner's assistant's events from `from` to `to` (first and last day,
    // YYYY-MM-DD), oldest first: local time, contact, channel, kind, ref. Null when
    // the assistant is not ownerId's (agents.user_id).
    async list(ownerId, agentId, { from, to }) {
      const own = await pool.query(`SELECT 1 FROM ${S}.agents WHERE id = $1 AND user_id = $2`, [agentId, ownerId]);
      if (!own.rows.length) return null;
      const { rows } = await pool.query(
        `SELECT to_char(e.at AT TIME ZONE $4, 'YYYY-MM-DD HH24:MI:SS') AS at, e.contact_id, c.canal AS channel, e.kind, e.ref
           FROM ${S}.public_support_events e JOIN ${S}.public_contacts c ON c.id = e.contact_id
          WHERE e.agent_id = $1 AND ${period(2).replace(/\bat\b/g, 'e.at')}
          ORDER BY e.at, e.id LIMIT ${EVENTS_EXPORT_MAX}`, [agentId, from, to, timezone]);
      return rows;
    },

    // What metricCards gets: the queries above tied to one assistant and its
    // period, or to one of its contacts.
    forCards(agentId, range) {
      return {
        count: (step) => this.count(agentId, range, step),
        funnel: (steps) => this.funnel(agentId, range, steps),
        top: (step, limit) => this.top(agentId, range, step, limit),
      };
    },
  };
}

// A turn's link buttons pointing to CLICK_PATH, for the copy that goes to the
// person (the conversation keeps the real addresses). Only with an https base,
// since a channel takes only https buttons; a link that fails to store keeps its address.
// keepUrl (web chat): the button keeps its real url and gets the measured one in
// clickUrl, because the page decides how to show a link (color, opening inside the
// chat) by its address; it opens clickUrl. Other channels get the measured url.
export async function measureLinks(events, base, { agentId, contactId }, saidas, { keepUrl = false } = {}) {
  const root = String(base ?? '').replace(/\/+$/, '');
  if (!events || !contactId || !/^https:\/\/[^\s?#]+$/.test(root) || !Array.isArray(saidas) || !saidas.some((s) => s?.tipo === 'botao')) return saidas;
  const out = [];
  for (const s of saidas) {
    if (s?.tipo !== 'botao') { out.push(s); continue; }
    const id = await events.linkId({ agentId, contactId, url: s.url, ref: s.ref ?? '' }).catch(() => null);
    const measured = id && `${root}${CLICK_PATH}?l=${id}`;
    out.push(!measured ? s : keepUrl ? { ...s, clickUrl: measured } : { ...s, url: measured });
  }
  return out;
}

// Hosts whose links leave the click route by script instead of a redirect
// (BRAMBIT_CLICK_IN_BROWSER, comma-separated). A store whose phone app claims every
// address of its site (iOS universal links, Android app links) takes a redirected
// tap into the app, even for a page the app does not have; a navigation the page
// starts by itself keeps the person in the browser. Links to other hosts (an app
// the person should open, like WhatsApp) keep the redirect.
export const clickInBrowserHosts = (value = process.env.BRAMBIT_CLICK_IN_BROWSER) =>
  String(value ?? '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);

const hostOf = (to) => { try { return new URL(to).hostname.toLowerCase(); } catch { return ''; } };
const htmlAttr = (v) => String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// The page that sends the person on by script, with a link if scripts are off.
// Its own CSP: only this script runs, nothing loads, it cannot be framed.
function sendByScript(res, to) {
  const nonce = randomBytes(16).toString('base64');
  // JSON.stringify keeps the address a string; escaping < keeps it from closing the script.
  const target = JSON.stringify(to).replace(/</g, '\\u003c');
  const body = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<meta name="robots" content="noindex"><title>…</title></head><body>`
    + `<script nonce="${nonce}">location.replace(${target});</script>`
    + `<p style="font-family:sans-serif;text-align:center;margin-top:40vh"><a href="${htmlAttr(to)}">→</a></p></body></html>`;
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
  });
  res.end(body);
}

// The click route: records the click (not a link preview's fetch nor a HEAD) and
// sends the person on. An unknown id is a 404, never a guess of where to go.
// inBrowser: hosts left by script (clickInBrowserHosts); a preview and a HEAD get the redirect.
export function registerClickRoute({ rotas, events, send, log = console, inBrowser = clickInBrowserHosts() }) {
  const handle = async (req, res, url) => {
    let to = null;
    const preview = isPreview(req.headers['user-agent']);
    try { to = await events.click(url.searchParams.get('l'), { record: req.method === 'GET' && !preview }); }
    catch (e) { log.error?.('[events] click lookup failed:', e?.message ?? e); }
    res.setHeader('Cache-Control', 'no-store');
    if (!to) return send(res, 404, { error: 'not_found' });
    if (req.method === 'GET' && !preview && inBrowser.includes(hostOf(to))) return sendByScript(res, to);
    res.writeHead(302, { Location: to, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
    res.end();
  };
  rotas.registrar('GET', CLICK_PATH, handle);
  rotas.registrar('HEAD', CLICK_PATH, handle);
}

// A cell of the spreadsheet: quoted, and a value a spreadsheet would run as a formula starts with '.
export const csvCell = (v) => {
  const s = String(v ?? '');
  return `"${(/^[=+\-@\t\r]/.test(s) ? `'${s}` : s).replace(/"/g, '""')}"`;
};
export const eventsCsv = (rows) => [['at', 'contact_id', 'channel', 'event', 'ref'], ...rows.map((r) => [r.at, r.contact_id, r.channel, r.kind, r.ref])]
  .map((line) => line.map(csvCell).join(',')).join('\r\n') + '\r\n';
