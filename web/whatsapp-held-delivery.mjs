// Content held back from a scheduled WhatsApp delivery outside the 24h window.
//
// Outside the window WhatsApp only accepts an approved template, and a template
// parameter cannot carry line breaks: a list arrives squeezed into one line.
// Instead, the scheduled delivery (web/scheduled-delivery.mjs) sends a short
// notice through the template and keeps the formatted content here. The
// person's next message reopens the window; the WhatsApp handler then releases
// the content as a normal message, layout intact, and it enters the history.

export const WA_HELD_SCHEMA = `
CREATE TABLE IF NOT EXISTS mtr_harness.whatsapp_held_messages (
 id bigserial PRIMARY KEY,
 user_id uuid NOT NULL REFERENCES mtr_harness.users(id) ON DELETE CASCADE,
 agent_id uuid REFERENCES mtr_harness.agents(id) ON DELETE CASCADE,
 phone text NOT NULL, body text NOT NULL, notice_wamid text,
 created_at timestamptz NOT NULL DEFAULT now(), sending_at timestamptz, released_at timestamptz);
CREATE INDEX IF NOT EXISTS whatsapp_held_pending_idx ON mtr_harness.whatsapp_held_messages(phone) WHERE released_at IS NULL;
`;

// A reply after this long no longer releases the content: it is stale.
const HOLD_DAYS = 7;
// A claim older than this is taken as a process that died mid-send.
const STALE_CLAIM = '5 minutes';

// Detects "list-like" content (bullets, numbering or several line breaks), which
// a template parameter would flatten into one line.
export function isListishText(t) {
  const s = String(t || '');
  if (!/\n/.test(s)) return false;
  const bullety = /(^|\n)\s*(?:[•\-*]|\d+[.)])\s+/.test(s);
  const manyLines = (s.match(/\n/g) || []).length >= 2;
  return bullety || manyLines;
}

// Whether a closed-window delivery should be held instead of sent as a
// template: a list would be flattened, a long text would be cut.
export const needsHolding = (text, templateMax) => isListishText(text) || String(text || '').length > templateMax;

// A reply that only says "go ahead": once the content is released, it needs no
// turn of its own. A reaction counts only when it is on the notice itself.
const ACK = /^\s*(?:ok(?:ay|ey)?|okk+|sim|pode(?: mandar| enviar)?|manda(?: a[ií])?|envia|blz|beleza|claro|yes|yep|sure|s[ií]|dale|vale|(?:👍|👌|✅|🙏)[\u{1F3FB}-\u{1F3FF}]?)[\s!.]*$/iu;
export function isAckOnly(msg, released) {
  if (msg?.type === 'reaction') return released.some((r) => r.notice_wamid && r.notice_wamid === msg.reaction?.message_id);
  return msg?.type === 'text' && ACK.test(msg.text?.body || '');
}

// `persist(row, text)` writes released content into the conversation history.
export function createWhatsAppHeldDelivery(pool, { persist = null } = {}) {
  const T = 'mtr_harness.whatsapp_held_messages';
  return {
    init: () => pool.query(WA_HELD_SCHEMA),
    async hold({ userId, agentId, phone, body }) {
      await pool.query(`DELETE FROM ${T} WHERE created_at < now() - interval '30 days'`);
      return (await pool.query(`INSERT INTO ${T}(user_id,agent_id,phone,body) VALUES($1,$2,$3,$4) RETURNING id`,
        [userId, agentId || null, phone, body])).rows[0].id;
    },
    attachNotice: (id, wamid) => pool.query(`UPDATE ${T} SET notice_wamid=$2 WHERE id=$1`, [id, wamid]),
    cancel: (id) => pool.query(`DELETE FROM ${T} WHERE id=$1 AND released_at IS NULL AND sending_at IS NULL`, [id]),
    // Sends everything held for this number, oldest first, through `send`
    // (a session message: the inbound that triggers this reopened the window).
    // Never throws: a failure leaves the rest held for the next message.
    async release({ phone, userId, send }) {
      const released = [];
      try {
        const rows = (await pool.query(`UPDATE ${T} SET sending_at=now()
          WHERE phone=$1 AND user_id=$2 AND released_at IS NULL AND created_at > now() - make_interval(days => $3)
          AND (sending_at IS NULL OR sending_at < now() - interval '${STALE_CLAIM}')
          RETURNING id, user_id, agent_id, body, notice_wamid`, [phone, userId, HOLD_DAYS])).rows
          .sort((a, b) => Number(a.id) - Number(b.id));
        for (const [i, row] of rows.entries()) {
          try {
            await send(row.body);
          } catch (error) {
            // A partly sent item is never resent; the untouched ones wait.
            const keep = error?.partial ? [row.id] : [];
            const free = rows.slice(i).map((r) => r.id).filter((id) => !keep.includes(id));
            if (keep.length) await pool.query(`UPDATE ${T} SET released_at=now() WHERE id=ANY($1::bigint[])`, [keep]);
            if (free.length) await pool.query(`UPDATE ${T} SET sending_at=NULL WHERE id=ANY($1::bigint[])`, [free]);
            console.error('[whatsapp-held] release:', error?.code || error?.message || 'error');
            break;
          }
          await pool.query(`UPDATE ${T} SET released_at=now() WHERE id=$1`, [row.id]);
          released.push(row);
          try { await persist?.(row, row.body); } catch { /* history is best-effort */ }
        }
      } catch (error) {
        console.error('[whatsapp-held] release:', error?.code || error?.message || 'error');
      }
      return released;
    },
  };
}
