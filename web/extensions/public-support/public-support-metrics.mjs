// Volume of an assistant's public support, for its owner and the members of its
// client area (client-areas.mjs): people who wrote, the conversations they had
// (a contact's messages are split into conversations by conversation_idle_minutes,
// public-support.mjs), messages received and answered, by channel and by day; test contacts
// (public-support-test-contacts.mjs) left out. No cost: the owner pays for it, and a
// client sees only how much it is used.
//
// It counts what is still stored, so a period reaching further back than the
// assistant's retention (retencao_dias) only covers the retained part; the reply
// says so (partial). Days follow the installation's timezone.
import { defaultTimezone } from '../../locale.mjs';
import { CANAIS_PUBLICOS } from './public-support.mjs';

export const METRICS_PATH = '/api/public-support/metrics';
export const METRIC_DAYS = [7, 30, 90];
// A period picked by its first and last day spans at most this many days.
export const METRIC_RANGE_MAX = 366;

const DAY_MS = 86400000;
const isDay = (s) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s ?? '')) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};
// Today (YYYY-MM-DD) in the installation's timezone.
export const todayIn = (timezone = defaultTimezone()) => new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date());

// The period in the address: ?days= (one of METRIC_DAYS, ending today) or ?from=&to=
// (first and last day, YYYY-MM-DD; an end after today counts as today; up to
// METRIC_RANGE_MAX days). → {from, to, days}, or null when it is not a valid period.
export function metricRange(params, today) {
  if (params.has('from') || params.has('to')) {
    const from = params.get('from'), to = params.get('to') > today ? today : params.get('to');
    if (!isDay(from) || !isDay(to) || from > to) return null;
    const days = (Date.parse(to) - Date.parse(from)) / DAY_MS + 1;
    return days <= METRIC_RANGE_MAX ? { from, to, days } : null;
  }
  const days = Number(params.get('days'));
  if (!METRIC_DAYS.includes(days)) return null;
  return { from: new Date(Date.parse(today) - (days - 1) * DAY_MS).toISOString().slice(0, 10), to: today, days };
}

const zero = () => ({ people: 0, conversations: 0, received: 0, replies: 0 });

export function createMetricsStore(pool, { S = 'mtr_harness', timezone = defaultTimezone() } = {}) {
  return {
    // ownerId checks the assistant's owner in the SQL itself (agents.user_id),
    // like every query of the owner's view. range = metricRange()'s {from, to, days}.
    async volume(ownerId, agentId, { from, to, days } = {}) {
      if (!isDay(from) || !isDay(to) || !(days >= 1)) throw Error('metrics: the period needs from, to and days');
      const inPeriod = `m.criado_em >= ($3::date::timestamp AT TIME ZONE $4) AND m.criado_em < (($5::date + 1)::timestamp AT TIME ZONE $4)`;
      const mine = `JOIN ${S}.agents a ON a.id = c.agent_id WHERE c.agent_id = $1 AND a.user_id = $2 AND NOT c.is_test`;
      const params = [agentId, ownerId, from, timezone, to];
      const [byDay, byChannel, retention] = await Promise.all([
        // A contact is in a single channel, so the per-channel counts add up.
        pool.query(`SELECT to_char(m.criado_em AT TIME ZONE $4, 'YYYY-MM-DD') AS day, c.canal AS channel,
                           count(DISTINCT (m.contact_id, m.conversation)) FILTER (WHERE m.role = 'user')::int AS conversations,
                           count(*) FILTER (WHERE m.role = 'user' AND m.event IS NULL)::int AS received,
                           count(*) FILTER (WHERE m.role = 'assistant')::int AS replies
                      FROM ${S}.public_messages m JOIN ${S}.public_contacts c ON c.id = m.contact_id ${mine} AND ${inPeriod}
                     GROUP BY 1, 2`, params),
        pool.query(`SELECT c.canal AS channel, count(DISTINCT m.contact_id)::int AS people,
                           count(DISTINCT (m.contact_id, m.conversation))::int AS conversations
                      FROM ${S}.public_messages m JOIN ${S}.public_contacts c ON c.id = m.contact_id ${mine} AND ${inPeriod} AND m.role = 'user'
                     GROUP BY 1`, params),
        pool.query(`SELECT p.retencao_dias AS days
                      FROM ${S}.agents a LEFT JOIN ${S}.public_agents p ON p.agent_id = a.id WHERE a.id = $1 AND a.user_id = $2`, [agentId, ownerId]),
      ]);
      const total = zero();
      const channels = Object.fromEntries(CANAIS_PUBLICOS.map((c) => [c, zero()]));
      const channel = (name) => (channels[name] ||= zero());
      for (const r of byChannel.rows) {
        Object.assign(channel(r.channel), { people: r.people, conversations: r.conversations });
        total.people += r.people; total.conversations += r.conversations;
      }
      const perDay = new Map();
      for (const r of byDay.rows) {
        const d = perDay.get(r.day) || { conversations: 0, received: 0, replies: 0 };
        d.conversations += r.conversations; d.received += r.received; d.replies += r.replies;
        perDay.set(r.day, d);
        channel(r.channel).received += r.received; channel(r.channel).replies += r.replies;
        total.received += r.received; total.replies += r.replies;
      }
      const first = retention.rows.length ? from : null;
      const daily = [];
      // Every day of the period, quiet ones included; dates in UTC are only used to count calendar days.
      for (let i = 0, d = first && new Date(first + 'T00:00:00Z'); d && i < days; i++, d.setUTCDate(d.getUTCDate() + 1)) {
        const day = d.toISOString().slice(0, 10);
        daily.push({ day, ...(perDay.get(day) || { conversations: 0, received: 0, replies: 0 }) });
      }
      // partial: the period starts before the oldest day still kept.
      const retentionDays = retention.rows[0]?.days ?? 90;
      const partial = from < new Date(Date.parse(todayIn(timezone)) - (retentionDays - 1) * DAY_MS).toISOString().slice(0, 10);
      return { from, to, days, retentionDays, partial, total, channels, daily };
    },
  };
}
