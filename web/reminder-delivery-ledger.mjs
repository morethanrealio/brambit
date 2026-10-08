import { createHash, randomUUID } from 'node:crypto';

// No message bodies or phone numbers: callbacks carry an opaque per-part ID.
// A manifest is committed before HTTP, so a callback can recover a lost reply.
export const REMINDER_DELIVERY_SCHEMA = `
  ALTER TABLE mtr_harness.reminder_occurrences ADD COLUMN IF NOT EXISTS delivery_state text;
  ALTER TABLE mtr_harness.reminder_occurrences ADD COLUMN IF NOT EXISTS delivery_updated_at timestamptz;
  ALTER TABLE mtr_harness.reminder_occurrences ADD COLUMN IF NOT EXISTS delivery_attempt_id uuid;
  CREATE TABLE IF NOT EXISTS mtr_harness.reminder_delivery_parts (
    id uuid PRIMARY KEY, occurrence_id uuid NOT NULL
      REFERENCES mtr_harness.reminder_occurrences(id) ON DELETE CASCADE,
    attempt_id uuid NOT NULL, part integer NOT NULL, total integer NOT NULL,
    recipient_hash text NOT NULL, provider_id text,
    state text NOT NULL DEFAULT 'planned'
      CHECK(state IN ('planned','dispatching','accepted','sent','delivered','read','failed','uncertain')),
    error_code text, updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(attempt_id,part)
  );
  CREATE UNIQUE INDEX IF NOT EXISTS reminder_delivery_provider_idx
    ON mtr_harness.reminder_delivery_parts(provider_id) WHERE provider_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS reminder_delivery_occurrence_idx
    ON mtr_harness.reminder_delivery_parts(occurrence_id,attempt_id);
`;
const hash = phone => createHash('sha256').update(String(phone).replace(/\D/g, '')).digest('hex');
const validId = id => typeof id === 'string' && id.trim().length > 0 && id.length <= 1000;
const accepted = new Set(['accepted', 'sent', 'delivered', 'read']);
const ranks = { accepted: 1, sent: 2, delivered: 3, read: 4 };

export async function reminderDeliverySummary(client, occurrence) {
  if (!occurrence.delivery_attempt_id) return null;
  const { rows } = await client.query(`SELECT * FROM mtr_harness.reminder_delivery_parts
    WHERE occurrence_id=$1 AND attempt_id=$2 ORDER BY part`, [occurrence.id, occurrence.delivery_attempt_id]);
  if (!rows.length) return null;
  const complete = rows.length === rows[0].total;
  const all = predicate => complete && rows.every(predicate);
  const state = all(r => r.state === 'read') ? 'read'
    : all(r => ['delivered', 'read'].includes(r.state)) ? 'delivered'
    : all(r => accepted.has(r.state) && validId(r.provider_id)) ? 'accepted'
    : all(r => ['failed', 'planned'].includes(r.state)) && rows.some(r => r.state === 'failed') ? 'failed'
    : rows.some(r => accepted.has(r.state)) ? 'partial' : 'uncertain';
  return { state, status: ['read', 'delivered', 'accepted'].includes(state) ? 'accepted'
    : state === 'failed' ? 'failed' : 'uncertain', receiptId: rows.find(r => validId(r.provider_id))?.provider_id || null };
}

export function createReminderDeliveryLedger({ transaction, ownedReminder, ownedOccurrence }) {
  async function refresh(client, occurrence) {
    const summary = await reminderDeliverySummary(client, occurrence);
    if (!summary) return;
    const terminal = ['accepted', 'uncertain', 'failed'].includes(occurrence.status);
    await client.query(`UPDATE mtr_harness.reminder_occurrences SET delivery_state=$2,delivery_updated_at=now(),
      status=CASE WHEN $3 THEN $4 ELSE status END,
      receipt_id=COALESCE($5,receipt_id),
      error_code=CASE WHEN $3 AND $4='accepted' THEN NULL ELSE error_code END WHERE id=$1`,
    [occurrence.id, summary.state, terminal, summary.status, summary.receiptId]);
    if (terminal) {
      // Never change a canceled parent or a recurrence cursor already advanced.
      await client.query(`UPDATE mtr_harness.reminders SET status=$3,
        sent_at=CASE WHEN $3='sent' THEN COALESCE(sent_at,now()) ELSE NULL END
        WHERE id=$1 AND run_at=$2 AND status IN ('sent','uncertain','failed')`,
      [occurrence.reminder_id, occurrence.scheduled_at, summary.status === 'accepted' ? 'sent' : summary.status]);
    }
  }
  async function lockPart(client, id, providerId) {
    const found = await client.query(`SELECT p.*,o.reminder_id,o.user_id FROM mtr_harness.reminder_delivery_parts p
      JOIN mtr_harness.reminder_occurrences o ON o.id=p.occurrence_id
      WHERE ${id ? 'p.id=$1' : 'p.provider_id=$1'}`, [id || providerId]);
    const part = found.rows[0];
    if (!part) return null;
    if (!await ownedReminder(client, part.reminder_id, part.user_id)) return null;
    const result = await client.query('SELECT * FROM mtr_harness.reminder_occurrences WHERE id=$1 FOR UPDATE', [part.occurrence_id]);
    const current = await client.query('SELECT * FROM mtr_harness.reminder_delivery_parts WHERE id=$1 FOR UPDATE', [part.id]);
    return { occurrence: result.rows[0], part: current.rows[0] };
  }
  async function record({ id, providerId, state, recipient, errorCode, callback = false }) {
    return transaction(async client => {
      const locked = await lockPart(client, id, providerId);
      if (!locked) return false;
      const { occurrence, part } = locked;
      if (callback && (occurrence.channel !== 'whatsapp' || hash(recipient) !== part.recipient_hash
          || !validId(providerId))) return false;
      if (part.provider_id && providerId && part.provider_id !== providerId) return false;
      // Delayed receipt/failed/sent events cannot undo delivery or reading.
      let next = state;
      if ((ranks[part.state] || 0) > (ranks[state] || 0) && (state !== 'failed' || ranks[part.state] >= 3)) next = part.state;
      if (part.state === 'failed' && ['accepted', 'sent', 'uncertain'].includes(state)) next = 'failed';
      await client.query(`UPDATE mtr_harness.reminder_delivery_parts
        SET state=$2,provider_id=COALESCE(provider_id,$3),error_code=COALESCE($4,error_code),updated_at=now() WHERE id=$1`,
      [part.id, next, validId(providerId) ? providerId : null, errorCode == null ? null : String(errorCode).slice(0,80)]);
      await refresh(client, occurrence);
      return true;
    });
  }
  return {
    tracking(claim) {
      let parts;
      return {
        async start({ total, recipient }) {
          // Manifest sanity cap. Used to be 8, the old WhatsApp bubble cap;
          // since 2026-09-29 a long response goes in full (100k chars).
          if (!Number.isSafeInteger(total) || total < 1 || total > 100 || !/^\+?\d{7,18}$/.test(String(recipient))) throw Error('Invalid delivery manifest');
          parts = await transaction(async client => {
            const parent = await ownedReminder(client, claim.reminderId, claim.userId);
            const occurrence = await ownedOccurrence(client, claim);
            if (!parent || parent.status !== 'pending' || !occurrence || occurrence.channel !== 'whatsapp' || occurrence.status !== 'delivering'
                || new Date(occurrence.lease_until) <= new Date(parent.database_now)) throw Error('Delivery lease expired');
            if (occurrence.delivery_attempt_id) {
              const prior = await reminderDeliverySummary(client, occurrence);
              if (prior?.state !== 'failed') throw Error('Previous delivery cannot be repeated');
            }
            const attemptId = randomUUID(), ids = Array.from({ length: total }, () => randomUUID());
            for (let part = 0; part < total; part++) await client.query(`INSERT INTO mtr_harness.reminder_delivery_parts
              (id,occurrence_id,attempt_id,part,total,recipient_hash) VALUES ($1,$2,$3,$4,$5,$6)`,
            [ids[part], occurrence.id, attemptId, part, total, hash(recipient)]);
            await client.query(`UPDATE mtr_harness.reminder_occurrences SET delivery_attempt_id=$2,
              delivery_state='uncertain',delivery_updated_at=now() WHERE id=$1`, [occurrence.id, attemptId]);
            return ids;
          });
        },
        async beforePart(part) {
          const id = parts?.[part];
          if (!id) throw Error('Missing delivery manifest');
          await transaction(async client => {
            const parent = await ownedReminder(client, claim.reminderId, claim.userId);
            const occurrence = await ownedOccurrence(client, claim);
            if (!parent || parent.status !== 'pending' || !occurrence || occurrence.status !== 'delivering'
                || new Date(occurrence.lease_until) <= new Date(parent.database_now)) throw Error('Delivery lease expired');
            const result = await client.query(`UPDATE mtr_harness.reminder_delivery_parts SET state='dispatching'
              WHERE id=$1 AND attempt_id=$2 AND state='planned' RETURNING id`, [id, occurrence.delivery_attempt_id]);
            if (!result.rows.length) throw Error('Delivery part already dispatched');
          });
          return `reminder:${id}`;
        },
        accepted: (part, providerId) => record({ id: parts?.[part], providerId, state: 'accepted' }),
        failed: (part, error) => record({ id: parts?.[part], state: error?.definitive === true ? 'failed' : 'uncertain', errorCode: error?.code }),
      };
    },
    async recordStatus(status) {
      if (!['sent','delivered','read','failed'].includes(status?.status) || !validId(status?.id)) return false;
      const ref = status.biz_opaque_callback_data;
      const id = typeof ref === 'string' && /^reminder:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(ref) ? ref.slice(9) : null;
      return record({ id, providerId: status.id, state: status.status, recipient: status.recipient_id,
        errorCode: status.errors?.[0]?.code, callback: true });
    },
  };
}

// Called before acknowledging the signed webhook. Only our business number is
// eligible; failed SQL causes an HTTP retry, never a fresh message send.
export async function recordReminderDeliveryStatuses(payload, recordStatus, phoneId) {
  if (!phoneId) return;
  for (const entry of payload?.entry || []) for (const change of entry.changes || []) {
    const value = change.value;
    if (String(value?.metadata?.phone_number_id || '') !== String(phoneId)) continue;
    for (const status of Array.isArray(value?.statuses) ? value.statuses : []) await recordStatus(status);
  }
}
