import { randomUUID } from 'node:crypto';
import { normalizeRecurrence, recurrenceOccurrences, localDateTimeInstant } from './calendar-recurrence.mjs';
import { REMINDER_DELIVERY_SCHEMA, createReminderDeliveryLedger, reminderDeliverySummary } from './reminder-delivery-ledger.mjs';

// Each row is one scheduled occurrence, not a claim of exactly-once delivery.
// Importing this module never opens a connection. The application supplies its
// pool; tests supply an isolated PostgreSQL-compatible database.
export const REMINDER_EXECUTION_SCHEMA = `
  ALTER TABLE mtr_harness.reminders ADD COLUMN IF NOT EXISTS calendar_recurrence jsonb;
  ALTER TABLE mtr_harness.reminders ADD COLUMN IF NOT EXISTS resume_run_at timestamptz;
  ALTER TABLE mtr_harness.reminders ADD COLUMN IF NOT EXISTS action_id uuid;
  ALTER TABLE mtr_harness.reminders ADD COLUMN IF NOT EXISTS initial_run_at timestamptz;
  -- Legacy rows retain only their current cursor. This backfill deliberately
  -- does not claim to reconstruct their earlier scheduled occurrences.
  UPDATE mtr_harness.reminders SET initial_run_at=run_at WHERE initial_run_at IS NULL;
  ALTER TABLE mtr_harness.reminders ALTER COLUMN initial_run_at SET NOT NULL;
  ALTER TABLE mtr_harness.reminders ADD COLUMN IF NOT EXISTS origin_thread_id uuid
    REFERENCES mtr_harness.threads(id) ON DELETE SET NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS reminders_action_idx
    ON mtr_harness.reminders(user_id, action_id) WHERE action_id IS NOT NULL;
  -- Identity belongs to the original request, never the mutable run_at cursor.
  -- Different starting dates remain distinct actions even if they later overlap.
  CREATE UNIQUE INDEX IF NOT EXISTS reminders_dedup_request_v2_idx
    ON mtr_harness.reminders(user_id,agent_id,message,initial_run_at,channel,
      COALESCE(repeat_every_min,0),COALESCE(repeat_until,'infinity'::timestamptz),COALESCE(calendar_recurrence,'null'::jsonb))
    WHERE status='pending';
  DROP INDEX IF EXISTS mtr_harness.reminders_dedup_request_idx;
  DROP INDEX IF EXISTS mtr_harness.reminders_dedup_pending_idx;
  CREATE TABLE IF NOT EXISTS mtr_harness.reminder_occurrences (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    reminder_id uuid NOT NULL REFERENCES mtr_harness.reminders(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES mtr_harness.users(id) ON DELETE CASCADE,
    scheduled_at timestamptz NOT NULL,
    channel text NOT NULL,
    status text NOT NULL DEFAULT 'scheduled'
      CHECK (status IN ('scheduled','claimed','delivering','accepted','failed','uncertain','canceled')),
    claim_token uuid,
    lease_until timestamptz,
    attempt_count integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    claimed_at timestamptz,
    delivery_started_at timestamptz,
    finished_at timestamptz,
    receipt_id text,
    error_code text,
    UNIQUE(reminder_id, scheduled_at)
  );
  CREATE INDEX IF NOT EXISTS reminder_occurrences_owner_idx
    ON mtr_harness.reminder_occurrences(user_id, scheduled_at DESC);
  CREATE INDEX IF NOT EXISTS reminder_occurrences_recovery_idx
    ON mtr_harness.reminder_occurrences(lease_until)
    WHERE status IN ('claimed','delivering');
`;

const TERMINAL = new Set(['accepted', 'failed', 'uncertain']);
const iso = value => new Date(value).toISOString();
const sameTime = (a, b) => new Date(a).getTime() === new Date(b).getTime();
const canonical = value => JSON.stringify(value, (_k,v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))) : v);
const code = value => /^[A-Z0-9_:-]{1,80}$/.test(String(value || '')) ? String(value) : null;

// Preserve the original interval anchor; skip missed slots instead of bursting.
// This is elapsed-minute recurrence, as in the existing reminder contract.
export function nextReminderRun(reminder, at) {
  const afterMs=Math.max(new Date(at).getTime(),new Date(reminder.run_at).getTime(),reminder.resume_run_at ? new Date(reminder.resume_run_at).getTime()-1 : -Infinity);
  if (!Number.isFinite(afterMs)) return null;
  const effectiveAfter = new Date(afterMs).toISOString();
  if (reminder.calendar_recurrence) {
    const {regra,inicio,fuso}=reminder.calendar_recurrence;
    return recurrenceOccurrences(regra,inicio,fuso,{after: effectiveAfter,limit:1})[0]?.instant || null;
  }
  const minutes = Number(reminder.repeat_every_min);
  if (!Number.isSafeInteger(minutes) || minutes < 1) return null;
  const start = new Date(reminder.initial_run_at || reminder.run_at).getTime();
  const now = new Date(effectiveAfter).getTime();
  const step = minutes * 60_000;
  if (!Number.isFinite(start) || !Number.isFinite(now) || !Number.isSafeInteger(step)) return null;
  const next = start + (Math.floor(Math.max(0, now - start) / step) + 1) * step;
  if (!Number.isFinite(next) || next > 8.64e15) return null;
  if (reminder.repeat_until && next > new Date(reminder.repeat_until).getTime()) return null;
  return new Date(next).toISOString();
}

export function createReminderExecutionStore(pool, { leaseMs = 180_000 } = {}) {
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1) throw new Error('Invalid reminder lease');

  async function transaction(run) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await run(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async function ensureOccurrence(client, reminder) {
    const { rows } = await client.query(`
      INSERT INTO mtr_harness.reminder_occurrences(reminder_id,user_id,scheduled_at,channel)
      VALUES ($1,$2,$3,$4) ON CONFLICT (reminder_id,scheduled_at) DO NOTHING
      RETURNING id`, [reminder.id, reminder.user_id, reminder.run_at, reminder.channel]);
    if (rows[0]) return rows[0].id;
    const existing = await client.query(`SELECT id FROM mtr_harness.reminder_occurrences
      WHERE reminder_id=$1 AND user_id=$2 AND scheduled_at=$3`, [reminder.id, reminder.user_id, reminder.run_at]);
    return existing.rows[0]?.id || null;
  }

  async function ownedReminder(client, reminderId, userId) {
    const { rows } = await client.query(`SELECT r.*,now() AS database_now
      FROM mtr_harness.reminders r WHERE r.id=$1 AND r.user_id=$2 FOR UPDATE`, [reminderId, userId]);
    return rows[0] || null;
  }

  async function eligible(client, reminder) {
    const { rows } = await client.query(`SELECT a.id FROM mtr_harness.agents a
      JOIN mtr_harness.users u ON u.id=a.user_id
      WHERE a.id=$1 AND a.user_id=$2 AND a.archived_at IS NULL AND u.deleted_at IS NULL`,
    [reminder.agent_id, reminder.user_id]);
    return rows.length === 1;
  }

  async function ownedOccurrence(client, claim) {
    if (!claim?.id || !claim?.token || !claim?.reminderId || !claim?.userId || !claim?.scheduledAt) return null;
    const { rows } = await client.query(`SELECT * FROM mtr_harness.reminder_occurrences
      WHERE id=$1 AND reminder_id=$2 AND user_id=$3 AND scheduled_at=$4 AND claim_token=$5 FOR UPDATE`,
    [claim.id, claim.reminderId, claim.userId, claim.scheduledAt, claim.token]);
    return rows[0] || null;
  }

  async function settle(client, claim, value, { recovering = false } = {}) {
    if (!TERMINAL.has(value?.status)) throw new Error('Invalid reminder outcome');
    // Lock parent first everywhere (claim, begin, finish, cancel) to avoid a
    // cancel/finish deadlock and ensure cancellation cannot resurrect a series.
    const reminder = await ownedReminder(client, claim.reminderId, claim.userId);
    if (!reminder) return null;
    const occurrence = await ownedOccurrence(client, claim);
    if (!occurrence || !['claimed', 'delivering'].includes(occurrence.status)) return null;
    const expired = new Date(occurrence.lease_until).getTime() <= new Date(reminder.database_now).getTime();
    if (recovering ? !expired : expired) return null;
    const delivery = await reminderDeliverySummary(client, occurrence);
    if (delivery) value = { status: delivery.status,
      receipt: delivery.receiptId ? { id: delivery.receiptId, channel: occurrence.channel } : null,
      errorCode: delivery.status === 'accepted' ? null : delivery.state === 'partial' ? 'DELIVERY_PARTIAL' : value.errorCode };
    if (value.status === 'accepted' && occurrence.status !== 'delivering') return null;
    const receiptId = typeof value.receipt?.id === 'string' ? value.receipt.id.trim() : '';
    if (value.status === 'accepted' && (!receiptId || receiptId.length > 1000 || value.receipt?.channel !== occurrence.channel)) {
      throw new Error('Accepted reminder requires a matching provider receipt');
    }
    await client.query(`UPDATE mtr_harness.reminder_occurrences
      SET status=$2,finished_at=now(),lease_until=NULL,receipt_id=$3,error_code=$4,
        delivery_state=COALESCE($5,delivery_state)
      WHERE id=$1`, [occurrence.id, value.status, value.status === 'accepted' ? receiptId : null,
      code(value.errorCode) || (value.status === 'uncertain' ? 'DELIVERY_UNCONFIRMED' : value.status === 'failed' ? 'DELIVERY_REJECTED' : null), delivery?.state || null]);

    // The accepted state means the provider accepted the request. The legacy
    // parent status is 'sent' for compatibility; delivery/read are not inferred.
    let nextRun = null;
    let reminderStatus = reminder.status;
    if (reminder.status === 'pending' && sameTime(reminder.run_at, occurrence.scheduled_at)) {
      nextRun = await eligible(client, reminder) ? nextReminderRun(reminder, reminder.database_now) : null;
      reminderStatus = nextRun ? 'pending' : value.status === 'accepted' ? 'sent' : value.status;
      await client.query(`UPDATE mtr_harness.reminders
        SET run_at=COALESCE($3::timestamptz,run_at),status=$4,resume_run_at=NULL,
            sent_at=CASE WHEN $3::timestamptz IS NULL AND $5='accepted' THEN now() ELSE NULL END
        WHERE id=$1 AND user_id=$2`, [reminder.id, reminder.user_id, nextRun, reminderStatus, value.status]);
      if (nextRun) await ensureOccurrence(client, { ...reminder, run_at: nextRun });
    }
    return { status: value.status, nextRun, reminderStatus };
  }

  const deliveryLedger = createReminderDeliveryLedger({ transaction, ownedReminder, ownedOccurrence });
  return {
    ensureSchema: () => pool.query(REMINDER_EXECUTION_SCHEMA + REMINDER_DELIVERY_SCHEMA),
    deliveryTracking: claim => deliveryLedger.tracking(claim),
    recordDeliveryStatus: status => deliveryLedger.recordStatus(status),
    async metrics() {
      const { rows } = await pool.query(`SELECT channel,status,delivery_state,count(*)::integer AS count,
        max(EXTRACT(EPOCH FROM now()-delivery_started_at)) FILTER (WHERE status='uncertain') AS oldest_uncertain_seconds
        FROM mtr_harness.reminder_occurrences WHERE scheduled_at>=now()-interval '30 days'
        GROUP BY channel,status,delivery_state`);
      return { windowDays: 30, outcomes: rows };
    },

    async create({ userId, agentId, message, runAt, channel = 'telegram', repeatEveryMin = null,
      repeatUntil = null, actionId = null, originThreadId = null, calendarRecurrence = null }) {
      if (!userId || !agentId || !String(message || '').trim()) throw new Error('Invalid reminder');
      if (!['telegram', 'email', 'whatsapp'].includes(channel)) throw new Error('Invalid reminder channel');
      const when = iso(runAt);
      const until = repeatUntil ? iso(repeatUntil) : null;
      let cadence = null;
      if (calendarRecurrence !== null) {
        if (repeatEveryMin !== null || repeatUntil !== null) throw Error('Não combine recorrência de calendário com intervalo em minutos.');
        const {regra,inicio,fuso}=calendarRecurrence;
        const r=normalizeRecurrence(regra,inicio,fuso);
        if (!r || localDateTimeInstant(inicio,fuso)!==when) throw Error('Primeiro disparo diferente da recorrência.');
        cadence={regra:{frequencia:r.frequencia,intervalo:r.intervalo,...(r.quantidade!==undefined?{quantidade:r.quantidade}:{}),...(r.ate?{ate:r.ate}:{})},inicio:inicio.length===16 ? inicio+':00' : inicio,fuso:r.timezone};
      }
      if (repeatEveryMin !== null && (!Number.isSafeInteger(repeatEveryMin) || repeatEveryMin < 1)) throw new Error('Invalid reminder recurrence');
      if (repeatEveryMin !== null && repeatEveryMin < 1440 && !until) throw new Error('Subdaily reminder requires an end');
      if (until && new Date(until) < new Date(when)) throw new Error('Reminder recurrence ends before it starts');
      return transaction(async client => {
        if (!await eligible(client, { agent_id: agentId, user_id: userId })) return null;
        if (originThreadId) {
          const thread = await client.query(`SELECT id FROM mtr_harness.threads WHERE id=$1 AND user_id=$2`, [originThreadId, userId]);
          if (!thread.rows.length) return null;
        }
        const { rows } = await client.query(`INSERT INTO mtr_harness.reminders
          (user_id,agent_id,message,run_at,initial_run_at,channel,repeat_every_min,repeat_until,action_id,origin_thread_id,calendar_recurrence)
          VALUES ($1,$2,$3,$4,$4,$5,$6,$7,$8,$9,$10::jsonb) ON CONFLICT DO NOTHING RETURNING *`,
        [userId, agentId, message, when, channel, repeatEveryMin, until, actionId, originThreadId, cadence ? JSON.stringify(cadence) : null]);
        let reminder = rows[0];
        const duplicate = !reminder;
        if (!reminder) {
          const existing = await client.query(`SELECT * FROM mtr_harness.reminders
            WHERE user_id=$1 AND (($8::uuid IS NOT NULL AND action_id=$8)
              OR (agent_id=$2 AND message=$3 AND initial_run_at=$4 AND channel=$5 AND status='pending'
                AND repeat_every_min IS NOT DISTINCT FROM $6::integer
                AND repeat_until IS NOT DISTINCT FROM $7::timestamptz
                AND calendar_recurrence IS NOT DISTINCT FROM $9::jsonb))
            ORDER BY CASE WHEN action_id=$8 THEN 0 ELSE 1 END,created_at LIMIT 1 FOR UPDATE`,
          [userId, agentId, message, when, channel, repeatEveryMin, until, actionId,cadence ? JSON.stringify(cadence) : null]);
          reminder = existing.rows[0];
          if (!reminder) return null;
          // One request identity cannot be reused for a different action.
          if (!sameTime(reminder.initial_run_at, when) || reminder.agent_id !== agentId || reminder.message !== message || reminder.channel !== channel
              || (reminder.repeat_every_min ?? null) !== repeatEveryMin
              || (reminder.repeat_until ? iso(reminder.repeat_until) : null) !== until
              || canonical(reminder.calendar_recurrence) !== canonical(cadence)) {
            throw Object.assign(new Error('O lembrete existente tem outro horário, canal ou recorrência. Revise antes de confirmar.'), { code: 'REMINDER_CONFLICT' });
          }
        }
        const occurrenceId = reminder.status === 'pending' ? await ensureOccurrence(client, reminder) : null;
        return { id: reminder.id, run_at: reminder.run_at, initial_run_at: reminder.initial_run_at, channel: reminder.channel,
          repeat_every_min: reminder.repeat_every_min, repeat_until: reminder.repeat_until,
          calendar_recurrence: reminder.calendar_recurrence,
          action_id: reminder.action_id, occurrence_id: occurrenceId, status: reminder.status, duplicate };
      });
    },

    async claim(rem) {
      if (!rem?.id || !rem?.user_id || !rem?.run_at) return null;
      return transaction(async client => {
        const reminder = await ownedReminder(client, rem.id, rem.user_id);
        if (!reminder || reminder.status !== 'pending' || !sameTime(reminder.run_at, rem.run_at)
            || new Date(reminder.run_at) > new Date(reminder.database_now) || !await eligible(client, reminder)) return null;
        const occurrenceId = await ensureOccurrence(client, reminder);
        const token = randomUUID();
        const { rows } = await client.query(`UPDATE mtr_harness.reminder_occurrences
          SET status='claimed',claim_token=$4,claimed_at=now(),lease_until=now()+$5*interval '1 millisecond',
              attempt_count=attempt_count+1,error_code=NULL
          WHERE id=$1 AND reminder_id=$2 AND user_id=$3 AND status='scheduled' RETURNING id`,
        [occurrenceId, reminder.id, reminder.user_id, token, leaseMs]);
        return rows.length ? { id: occurrenceId, token, reminderId: reminder.id, userId: reminder.user_id, scheduledAt: iso(reminder.run_at) } : null;
      });
    },

    async begin(claim) {
      return transaction(async client => {
        const reminder = await ownedReminder(client, claim.reminderId, claim.userId);
        if (!reminder || reminder.status !== 'pending' || !sameTime(reminder.run_at, claim.scheduledAt)
            || !await eligible(client, reminder)) return false;
        const { rows } = await client.query(`UPDATE mtr_harness.reminder_occurrences
          SET status='delivering',delivery_started_at=now(),lease_until=now()+$6*interval '1 millisecond'
          WHERE id=$1 AND reminder_id=$2 AND user_id=$3 AND scheduled_at=$4 AND claim_token=$5
            AND status='claimed' AND lease_until>now() RETURNING id`,
        [claim.id, claim.reminderId, claim.userId, claim.scheduledAt, claim.token, leaseMs]);
        return rows.length === 1;
      });
    },

    finish: (claim, value) => transaction(client => settle(client, claim, value)),

    async recoverExpired() {
      const { rows } = await pool.query(`SELECT id,reminder_id,user_id,scheduled_at,claim_token,status
        FROM mtr_harness.reminder_occurrences
        WHERE status IN ('claimed','delivering') AND lease_until<=now() ORDER BY lease_until LIMIT 100`);
      let recovered = 0;
      for (const row of rows) {
        const claim = { id: row.id, reminderId: row.reminder_id, userId: row.user_id, scheduledAt: row.scheduled_at, token: row.claim_token };
        recovered += await transaction(async client => {
          if (row.status === 'delivering') {
            return await settle(client, claim, { status: 'uncertain', errorCode: 'WORKER_INTERRUPTED' }, { recovering: true }) ? 1 : 0;
          }
          const reminder = await ownedReminder(client, claim.reminderId, claim.userId);
          const occurrence = await ownedOccurrence(client, claim);
          if (!reminder || !occurrence || occurrence.status !== 'claimed'
              || new Date(occurrence.lease_until) > new Date(reminder.database_now)) return 0;
          // begin() was never reached: no request could have left this worker.
          // Invalidate the old token before allowing a fresh claim of this slot.
          const canceled = reminder.status !== 'pending' || !sameTime(reminder.run_at, occurrence.scheduled_at)
            || !await eligible(client, reminder);
          await client.query(`UPDATE mtr_harness.reminder_occurrences
            SET status=$2,claim_token=NULL,lease_until=NULL,error_code='CLAIM_INTERRUPTED',
                finished_at=CASE WHEN $2='canceled' THEN now() ELSE NULL END
            WHERE id=$1`, [occurrence.id, canceled ? 'canceled' : 'scheduled']);
          return 1;
        });
      }
      return recovered;
    },

    async reschedule(id, userId, {expectedRunAt, runAt}) {
      const when=iso(runAt), expected=iso(expectedRunAt);
      return transaction(async client => {
        const r=await ownedReminder(client,id,userId);
        if (!r || r.status !== 'pending' || !sameTime(r.run_at,expected)) return {ok:false,code:'REMINDER_CHANGED'};
        if (new Date(when)<=new Date(r.database_now)) return {ok:false,code:'PAST_TIME'};
        const active=await client.query(`SELECT status FROM mtr_harness.reminder_occurrences WHERE reminder_id=$1 AND user_id=$2 AND scheduled_at=$3 FOR UPDATE`,[id,userId,r.run_at]);
        if (active.rows.some(o=>['delivering','accepted','uncertain','failed'].includes(o.status))) return {ok:false,code:'DELIVERY_STARTED'};
        if (sameTime(when,expected)) return {ok:true,reminder:r,unchanged:true};
        // Avoids reusing an already processed/cancelled slot and its delivery identity.
        const used=await client.query('SELECT id FROM mtr_harness.reminder_occurrences WHERE reminder_id=$1 AND scheduled_at=$2',[id,when]);
        if (used.rows.length) return {ok:false,code:'SLOT_ALREADY_USED'};
        const resume=r.resume_run_at || nextReminderRun(r,r.run_at);
        await client.query(`UPDATE mtr_harness.reminder_occurrences SET status='canceled',finished_at=now(),lease_until=NULL WHERE reminder_id=$1 AND user_id=$2 AND status IN ('scheduled','claimed')`,[id,userId]);
        const {rows}=await client.query('UPDATE mtr_harness.reminders SET run_at=$3,resume_run_at=$4 WHERE id=$1 AND user_id=$2 RETURNING *',[id,userId,when,resume]);
        await ensureOccurrence(client,rows[0]);
        return {ok:true,reminder:rows[0]};
      });
    },

    async cancel(id, userId, {expectedRunAt, returnDetails = false} = {}) {
      return transaction(async client => {
        const reminder = await ownedReminder(client, id, userId);
        if (!reminder || reminder.status !== 'pending' || (expectedRunAt && !sameTime(reminder.run_at,expectedRunAt))) return false;
        const inFlight = returnDetails ? await client.query("SELECT id FROM mtr_harness.reminder_occurrences WHERE reminder_id=$1 AND user_id=$2 AND status='delivering'",[id,userId]) : null;
        await client.query(`UPDATE mtr_harness.reminders SET status='canceled' WHERE id=$1 AND user_id=$2`, [id, userId]);
        await client.query(`UPDATE mtr_harness.reminder_occurrences
          SET status='canceled',finished_at=now(),lease_until=NULL
          WHERE reminder_id=$1 AND user_id=$2 AND status IN ('scheduled','claimed')`, [id, userId]);
        // A request already in flight can still be accepted. Leave its evidence
        // intact; finish() will record it without scheduling another occurrence.
        return returnDetails ? {canceled:true,inFlight:!!inFlight.rows.length} : true;
      });
    },

    async listDue() {
      const { rows } = await pool.query(`SELECT r.*,u.email,u.name AS user_name,u.language AS user_language,a.name AS agent_name
        FROM mtr_harness.reminders r
        JOIN mtr_harness.users u ON u.id=r.user_id AND u.deleted_at IS NULL
        JOIN mtr_harness.agents a ON a.id=r.agent_id AND a.user_id=r.user_id AND a.archived_at IS NULL
        LEFT JOIN mtr_harness.reminder_occurrences o ON o.reminder_id=r.id AND o.scheduled_at=r.run_at
        WHERE r.status='pending' AND r.run_at<=now() AND (o.id IS NULL OR o.status='scheduled')
        ORDER BY r.run_at LIMIT 50`);
      return rows;
    },

    async listForUser(userId, { includeRecent = false } = {}) {
      const { rows } = await pool.query(`SELECT r.id,r.message,r.run_at,r.initial_run_at,r.channel,r.status,
          r.repeat_every_min,r.repeat_until,r.calendar_recurrence,r.action_id,r.origin_thread_id,a.name AS agent_name,
          CASE WHEN recent.id IS NULL THEN NULL ELSE jsonb_build_object(
            'id',recent.id,'status',recent.status,'scheduledAt',recent.scheduled_at,
            'claimedAt',recent.claimed_at,'deliveryStartedAt',recent.delivery_started_at,
            'finishedAt',recent.finished_at,'receiptId',recent.receipt_id,'errorCode',recent.error_code,
            'deliveryState',recent.delivery_state,'deliveryUpdatedAt',recent.delivery_updated_at
          ) END AS last_occurrence
        FROM mtr_harness.reminders r
        JOIN mtr_harness.agents a ON a.id=r.agent_id AND a.user_id=r.user_id
        JOIN mtr_harness.users u ON u.id=r.user_id AND u.deleted_at IS NULL
        LEFT JOIN LATERAL (
          SELECT o.id,o.status,o.scheduled_at,o.claimed_at,o.delivery_started_at,o.finished_at,o.receipt_id,o.error_code,o.delivery_state,o.delivery_updated_at
          FROM mtr_harness.reminder_occurrences o
          WHERE o.reminder_id=r.id AND o.user_id=r.user_id AND o.status<>'scheduled'
            AND o.scheduled_at<=now()
          ORDER BY o.scheduled_at DESC LIMIT 1
        ) recent ON true
        WHERE r.user_id=$1 AND ((r.status='pending' AND a.archived_at IS NULL)
          OR ($2::boolean AND (r.created_at>=now()-interval '30 days' OR recent.finished_at>=now()-interval '30 days')))
        ORDER BY CASE WHEN r.status='pending' THEN 0 ELSE 1 END,r.run_at LIMIT 200`, [userId, includeRecent === true]);
      return rows;
    },

    async listOccurrences(userId, reminderId, { limit = 50 } = {}) {
      const bounded = Number.isInteger(limit) ? Math.max(1, Math.min(200, limit)) : 50;
      const { rows } = await pool.query(`SELECT o.id,o.reminder_id,o.scheduled_at,o.channel,o.status,o.attempt_count,
          o.created_at,o.claimed_at,o.delivery_started_at,o.finished_at,o.receipt_id,o.error_code,o.delivery_state,o.delivery_updated_at,
          r.action_id,r.origin_thread_id
        FROM mtr_harness.reminder_occurrences o
        JOIN mtr_harness.reminders r ON r.id=o.reminder_id AND r.user_id=o.user_id
        WHERE o.user_id=$1 AND o.reminder_id=$2 ORDER BY o.scheduled_at DESC LIMIT $3`, [userId, reminderId, bounded]);
      return rows;
    },
  };
}
