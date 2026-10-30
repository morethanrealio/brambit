// Volume of an assistant's public support, for its owner and the members of its
// client area (client-areas.mjs): conversations, new contacts, messages received
// and answered, by channel and by day. No cost: the owner pays for it, and a
// client sees only how much it is used.
//
// It counts what is still stored, so a period longer than the assistant's
// retention (retencao_dias) only covers the retained part; the reply says how
// many days that is. Days follow the installation's timezone.
import { defaultTimezone } from '../../locale.mjs';
import { CANAIS_PUBLICOS } from './public-support.mjs';

export const METRICS_PATH = '/api/public-support/metrics';
export const METRIC_DAYS = [7, 30, 90];

const zero = () => ({ conversations: 0, newContacts: 0, received: 0, replies: 0 });

export function createMetricsStore(pool, { S = 'mtr_harness', timezone = defaultTimezone() } = {}) {
  return {
    // ownerId checks the assistant's owner in the SQL itself (agents.user_id),
    // like every query of the owner's view. days must be one of METRIC_DAYS.
    async volume(ownerId, agentId, days) {
      if (!METRIC_DAYS.includes(days)) throw Error('metrics: days must be one of ' + METRIC_DAYS.join(', '));
      const firstDay = `date_trunc('day', now() AT TIME ZONE $4) - ($3::int - 1) * interval '1 day'`;
      const since = `(${firstDay}) AT TIME ZONE $4`;
      const mine = `JOIN ${S}.agents a ON a.id = c.agent_id WHERE c.agent_id = $1 AND a.user_id = $2`;
      const params = [agentId, ownerId, days, timezone];
      const [byDay, byChannel, newContacts, retention] = await Promise.all([
        // A contact is in a single channel, so the per-channel counts add up.
        pool.query(`SELECT to_char(m.criado_em AT TIME ZONE $4, 'YYYY-MM-DD') AS day, c.canal AS channel,
                           count(DISTINCT m.contact_id) FILTER (WHERE m.role = 'user')::int AS conversations,
                           count(*) FILTER (WHERE m.role = 'user' AND m.event IS NULL)::int AS received,
                           count(*) FILTER (WHERE m.role = 'assistant')::int AS replies
                      FROM ${S}.public_messages m JOIN ${S}.public_contacts c ON c.id = m.contact_id ${mine} AND m.criado_em >= ${since}
                     GROUP BY 1, 2`, params),
        pool.query(`SELECT c.canal AS channel, count(DISTINCT m.contact_id)::int AS conversations
                      FROM ${S}.public_messages m JOIN ${S}.public_contacts c ON c.id = m.contact_id ${mine} AND m.criado_em >= ${since} AND m.role = 'user'
                     GROUP BY 1`, params),
        pool.query(`SELECT c.canal AS channel, count(*)::int AS n FROM ${S}.public_contacts c ${mine} AND c.criado_em >= ${since} GROUP BY 1`, params),
        pool.query(`SELECT p.retencao_dias AS days, to_char(${firstDay}, 'YYYY-MM-DD') AS first_day
                      FROM ${S}.agents a LEFT JOIN ${S}.public_agents p ON p.agent_id = a.id WHERE a.id = $1 AND a.user_id = $2`, params),
      ]);
      const total = zero();
      const channels = Object.fromEntries(CANAIS_PUBLICOS.map((c) => [c, zero()]));
      const channel = (name) => (channels[name] ||= zero());
      for (const r of byChannel.rows) { channel(r.channel).conversations = r.conversations; total.conversations += r.conversations; }
      for (const r of newContacts.rows) { channel(r.channel).newContacts = r.n; total.newContacts += r.n; }
      const perDay = new Map();
      for (const r of byDay.rows) {
        const d = perDay.get(r.day) || { conversations: 0, received: 0, replies: 0 };
        d.conversations += r.conversations; d.received += r.received; d.replies += r.replies;
        perDay.set(r.day, d);
        channel(r.channel).received += r.received; channel(r.channel).replies += r.replies;
        total.received += r.received; total.replies += r.replies;
      }
      const first = retention.rows[0]?.first_day;
      const daily = [];
      // Every day of the period, quiet ones included; dates in UTC are only used to count calendar days.
      for (let i = 0, d = first && new Date(first + 'T00:00:00Z'); d && i < days; i++, d.setUTCDate(d.getUTCDate() + 1)) {
        const day = d.toISOString().slice(0, 10);
        daily.push({ day, ...(perDay.get(day) || { conversations: 0, received: 0, replies: 0 }) });
      }
      return { days, retentionDays: retention.rows[0]?.days ?? 90, total, channels, daily };
    },
  };
}
