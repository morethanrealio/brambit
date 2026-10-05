import { randomUUID, createHash } from 'node:crypto';

export const CONFIRMATION_SCHEMA = `
  CREATE TABLE IF NOT EXISTS mtr_harness.confirmation_requests (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES mtr_harness.users(id) ON DELETE CASCADE,
    agent_id uuid NOT NULL REFERENCES mtr_harness.agents(id) ON DELETE CASCADE,
    thread_id uuid NOT NULL REFERENCES mtr_harness.threads(id) ON DELETE CASCADE,
    request_no integer NOT NULL,
    tool_name text NOT NULL,
    payload text NOT NULL,
    fingerprint text NOT NULL,
    state text NOT NULL DEFAULT 'pending' CHECK
      (state IN ('pending','executing','completed','canceled','superseded','expired','uncertain','invalidated')),
    selection_required boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    presented_at timestamptz,
    started_at timestamptz,
    finished_at timestamptz,
    execution_token uuid,
    lease_until timestamptz,
    result text,
    decision_key text,
    decision_group uuid,
    continuation_ack_at timestamptz,
    continuation_cancelled boolean NOT NULL DEFAULT false,
    migration_key text,
    UNIQUE(thread_id,request_no)
  );
  ALTER TABLE mtr_harness.confirmation_requests ADD COLUMN IF NOT EXISTS decision_group uuid;
  CREATE INDEX IF NOT EXISTS confirmation_scope_idx
    ON mtr_harness.confirmation_requests(user_id,agent_id,thread_id,created_at DESC);
  CREATE UNIQUE INDEX IF NOT EXISTS confirmation_pending_identity_idx
    ON mtr_harness.confirmation_requests(thread_id,fingerprint) WHERE state='pending';
  CREATE UNIQUE INDEX IF NOT EXISTS confirmation_decision_idx
    ON mtr_harness.confirmation_requests(thread_id,decision_key) WHERE decision_key IS NOT NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS confirmation_migration_idx
    ON mtr_harness.confirmation_requests(thread_id,migration_key) WHERE migration_key IS NOT NULL;
  CREATE TABLE IF NOT EXISTS mtr_harness.confirmation_messages (
    request_id uuid NOT NULL REFERENCES mtr_harness.confirmation_requests(id) ON DELETE CASCADE,
    channel text NOT NULL,
    message_id text NOT NULL,
    PRIMARY KEY(request_id,channel,message_id)
  );
  CREATE INDEX IF NOT EXISTS confirmation_message_idx ON mtr_harness.confirmation_messages(channel,message_id);
`;

export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
  return value;
}
export const confirmationFingerprint = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const scopeArgs = s => [s.userId, s.agentId, s.threadId];
export function validConfirmationReference(ref) {
  return !!ref && typeof ref.channel === 'string' && /^[a-z][a-z0-9_-]{0,31}$/.test(ref.channel)
    && typeof ref.messageId === 'string' && !!ref.messageId.trim() && ref.messageId.length <= 2048;
}

// No connection or key is loaded by importing this module. Payloads/results are
// encrypted by the application; functions and closures are never serialized.
// Connector credentials are resolved afresh; checkout session cookies remain
// inside the encrypted payload. Authority comes from the authenticated scope.
export function createConfirmationStore(pool, { seal, open, ttlMs = 24 * 3600_000, leaseMs = 180_000, maxPending = 20 } = {}) {
  if (typeof seal !== 'function' || typeof open !== 'function') throw Error('Confirmation encryption required');
  if (![ttlMs,leaseMs,maxPending].every(n => Number.isSafeInteger(n) && n > 0)) throw Error('Invalid confirmation limits');
  async function tx(run) {
    const c = await pool.connect();
    try { await c.query('BEGIN'); const result = await run(c); await c.query('COMMIT'); return result; }
    catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; }
    finally { c.release(); }
  }
  async function owner(c, s, lock = false) {
    const { rows } = await c.query(`SELECT t.id FROM mtr_harness.threads t
      JOIN mtr_harness.agents a ON a.id=t.agent_id AND a.user_id=t.user_id
      JOIN mtr_harness.users u ON u.id=t.user_id
      WHERE t.user_id=$1 AND t.agent_id=$2 AND t.id=$3 AND a.archived_at IS NULL AND u.deleted_at IS NULL
      ${lock ? 'FOR UPDATE OF t' : ''}`, scopeArgs(s));
    return rows.length === 1;
  }
  async function decode(row) {
    if (!row) return null;
    const payload = JSON.parse(await open(row.payload));
    return { ...payload, id: row.id, number: row.request_no, state: row.state,
      selectionRequired: row.selection_required, presented: !!row.presented_at,
      continuationAcknowledged: !!row.continuation_ack_at,
      continuationCancelled: row.continuation_cancelled,
      at: new Date(row.created_at).getTime(), expiresAt: new Date(row.expires_at).getTime(),
      ...(row.result ? { result: JSON.parse(await open(row.result)) } : {}),
      messageRefs: row.message_refs || [], fingerprint: row.fingerprint, decisionKey: row.decision_key,
      decisionGroup: row.decision_group || null };
  }
  async function expire(c, s) {
    await c.query(`UPDATE mtr_harness.confirmation_requests SET state='expired',finished_at=now()
      WHERE user_id=$1 AND agent_id=$2 AND thread_id=$3 AND state='pending' AND expires_at<=now()`, scopeArgs(s));
    // An interrupted side effect is never automatically executed again.
    await c.query(`UPDATE mtr_harness.confirmation_requests SET state='uncertain',finished_at=now()
      WHERE user_id=$1 AND agent_id=$2 AND thread_id=$3 AND state='executing' AND lease_until<=now()`, scopeArgs(s));
  }
  const store = {
    ensureSchema: () => pool.query(CONFIRMATION_SCHEMA),
    async list(s) {
      return tx(async c => {
        if (!await owner(c, s, true)) throw Error('Confirmation conversation unavailable');
        await expire(c, s);
        const { rows } = await c.query(`SELECT r.*,COALESCE((SELECT jsonb_agg(jsonb_build_object('channel',m.channel,'messageId',m.message_id))
          FROM mtr_harness.confirmation_messages m WHERE m.request_id=r.id),'[]'::jsonb) AS message_refs
          FROM mtr_harness.confirmation_requests r WHERE r.user_id=$1 AND r.agent_id=$2 AND r.thread_id=$3
            AND (r.state IN ('pending','executing') OR r.finished_at>now()-interval '7 days')
          ORDER BY CASE WHEN r.state IN ('pending','executing') THEN 0 ELSE 1 END,r.request_no DESC LIMIT 100`, scopeArgs(s));
        return (await Promise.all(rows.map(decode))).sort((a, b) => a.number - b.number);
      });
    },
    async propose(s, payload, { migrationKey = null, expiresAt = null } = {}) {
      // Identity includes the exact prepared target, not prose alone.
      const fingerprint = confirmationFingerprint({ name: payload.name, args: payload.args, binding: payload.binding,
        context: payload.context, label: payload.label, confirmationText: payload.confirmationText });
      const encrypted = await seal(JSON.stringify(payload));
      if (encrypted.length > 1_500_000) throw Error('Confirmation payload too large');
      return tx(async c => {
        if (!await owner(c, s, true)) throw Error('Confirmation conversation unavailable');
        await expire(c, s);
        if (migrationKey) {
          const prior = await c.query(`SELECT * FROM mtr_harness.confirmation_requests WHERE thread_id=$1 AND migration_key=$2`, [s.threadId,migrationKey]);
          if (prior.rows.length) return decode(prior.rows[0]);
        }
        const existing = await c.query(`SELECT * FROM mtr_harness.confirmation_requests
          WHERE user_id=$1 AND agent_id=$2 AND thread_id=$3 AND state='pending' ORDER BY request_no`, scopeArgs(s));
        const duplicate = existing.rows.find(r => r.fingerprint === fingerprint);
        if (duplicate) return decode(duplicate);
        if (existing.rows.length >= maxPending) throw Error('Limite de pedidos pendentes atingido; confirme ou cancele um deles.');
        const { rows: numbers } = await c.query(`SELECT COALESCE(MAX(request_no),0)+1 AS n FROM mtr_harness.confirmation_requests WHERE thread_id=$1`, [s.threadId]);
        if (existing.rows.length) await c.query(`UPDATE mtr_harness.confirmation_requests SET selection_required=true
          WHERE thread_id=$1 AND state='pending'`, [s.threadId]);
        const { rows } = await c.query(`INSERT INTO mtr_harness.confirmation_requests
          (id,user_id,agent_id,thread_id,request_no,tool_name,payload,fingerprint,selection_required,expires_at,migration_key)
          VALUES ($4,$1,$2,$3,$5,$6,$7,$8,$9,LEAST(now()+$10*interval '1 millisecond',COALESCE($12::timestamptz,'infinity'::timestamptz)),$11) RETURNING *`,
        [...scopeArgs(s), randomUUID(), numbers[0].n, payload.name, encrypted, fingerprint, existing.rows.length > 0, ttlMs,migrationKey,expiresAt]);
        return decode(rows[0]);
      });
    },
    async present(s, ids) {
      if (!ids.length) return;
      await pool.query(`UPDATE mtr_harness.confirmation_requests SET presented_at=now()
        WHERE user_id=$1 AND agent_id=$2 AND thread_id=$3 AND id=ANY($4::uuid[]) AND state='pending'`, [...scopeArgs(s), ids]);
    },
    async bind(s, ids, reference) {
      if (!validConfirmationReference(reference) || !ids.length) return false;
      return tx(async c => {
        if (!await owner(c, s, true)) return false;
        const { rows } = await c.query(`INSERT INTO mtr_harness.confirmation_messages(request_id,channel,message_id)
          SELECT id,$5,$6 FROM mtr_harness.confirmation_requests
          WHERE user_id=$1 AND agent_id=$2 AND thread_id=$3 AND id=ANY($4::uuid[]) AND state='pending'
          ON CONFLICT DO NOTHING RETURNING request_id`, [...scopeArgs(s), ids, reference.channel, reference.messageId]);
        await c.query(`UPDATE mtr_harness.confirmation_requests SET presented_at=now()
          WHERE user_id=$1 AND agent_id=$2 AND thread_id=$3 AND id=ANY($4::uuid[]) AND state='pending'`, [...scopeArgs(s), ids]);
        return rows.length > 0;
      });
    },
    async close(s, id, state = 'canceled', decisionKey = null) {
      if (!['canceled', 'superseded', 'invalidated'].includes(state)) throw Error('Invalid confirmation transition');
      return tx(async c => {
        if (!await owner(c, s, true)) return false;
        if (decisionKey) {
          const prior = await c.query(`SELECT id FROM mtr_harness.confirmation_requests WHERE thread_id=$1 AND decision_key=$2`, [s.threadId,decisionKey]);
          if (prior.rows.length) return false;
        }
        const { rows } = await c.query(`UPDATE mtr_harness.confirmation_requests SET state=$5,finished_at=now(),decision_key=$6
          WHERE user_id=$1 AND agent_id=$2 AND thread_id=$3 AND id=$4 AND state='pending' RETURNING id`,
        [...scopeArgs(s), id, state, decisionKey]);
        return !!rows.length;
      });
    },
    async claim(s, id, fingerprint, decisionKey = null) {
      return tx(async c => {
        if (!await owner(c, s, true)) return null;
        await expire(c, s);
        if (decisionKey) {
          const prior = await c.query(`SELECT id FROM mtr_harness.confirmation_requests WHERE thread_id=$1 AND decision_key=$2`, [s.threadId, decisionKey]);
          if (prior.rows.length) return null;
        }
        const token = randomUUID();
        const { rows } = await c.query(`UPDATE mtr_harness.confirmation_requests
          SET state='executing',execution_token=$6,started_at=now(),lease_until=now()+$7*interval '1 millisecond',decision_key=$8
          WHERE user_id=$1 AND agent_id=$2 AND thread_id=$3 AND id=$4 AND fingerprint=$5
            AND state='pending' AND expires_at>now() AND presented_at IS NOT NULL RETURNING id`,
        [...scopeArgs(s), id, fingerprint, token, leaseMs, decisionKey]);
        return rows.length ? { id, token } : null;
      });
    },
    // One human message authorizes this exact, already presented set. Claim all
    // members before any effect; one unique decision key prevents replay from
    // being applied to a later proposal. Each member keeps its own receipt.
    async claimMany(s, requests, decisionKey = null) {
      if (!Array.isArray(requests) || requests.length < 2 || requests.length > maxPending
          || new Set(requests.map(r => r.id)).size !== requests.length) return null;
      return tx(async c => {
        if (!await owner(c, s, true)) return null;
        await expire(c, s);
        if (decisionKey) {
          const prior = await c.query(`SELECT id FROM mtr_harness.confirmation_requests WHERE thread_id=$1 AND decision_key=$2`, [s.threadId, decisionKey]);
          if (prior.rows.length) return null;
        }
        const {rows} = await c.query(`SELECT id,fingerprint FROM mtr_harness.confirmation_requests
          WHERE user_id=$1 AND agent_id=$2 AND thread_id=$3 AND id=ANY($4::uuid[])
            AND state='pending' AND expires_at>now() AND presented_at IS NOT NULL`, [...scopeArgs(s), requests.map(r => r.id)]);
        if (rows.length !== requests.length || requests.some(r => !rows.some(found => found.id === r.id && found.fingerprint === r.fingerprint))) return null;
        const group = randomUUID(), claims = [];
        for (const [index, request] of requests.entries()) {
          const token = randomUUID();
          await c.query(`UPDATE mtr_harness.confirmation_requests SET state='executing',execution_token=$5,
            started_at=now(),lease_until=now()+$6*interval '1 millisecond',decision_key=$7,decision_group=$8
            WHERE user_id=$1 AND agent_id=$2 AND thread_id=$3 AND id=$4`,
          [...scopeArgs(s), request.id, token, leaseMs, index === 0 ? decisionKey : null, group]);
          claims.push({id:request.id, token});
        }
        return claims;
      });
    },
    async closeMany(s, ids, decisionKey = null) {
      if (!Array.isArray(ids) || ids.length < 2 || ids.length > maxPending || new Set(ids).size !== ids.length) return false;
      return tx(async c => {
        if (!await owner(c, s, true)) return false;
        if (decisionKey) {
          const prior = await c.query(`SELECT id FROM mtr_harness.confirmation_requests WHERE thread_id=$1 AND decision_key=$2`, [s.threadId,decisionKey]);
          if (prior.rows.length) return false;
        }
        const {rows} = await c.query(`SELECT id FROM mtr_harness.confirmation_requests WHERE user_id=$1 AND agent_id=$2 AND thread_id=$3 AND id=ANY($4::uuid[]) AND state='pending'`, [...scopeArgs(s),ids]);
        if (rows.length !== ids.length) return false;
        const group = randomUUID();
        for (const [index,id] of ids.entries()) await c.query(`UPDATE mtr_harness.confirmation_requests SET state='canceled',finished_at=now(),decision_key=$5,decision_group=$6 WHERE user_id=$1 AND agent_id=$2 AND thread_id=$3 AND id=$4`, [...scopeArgs(s),id,index===0 ? decisionKey : null,group]);
        return true;
      });
    },
    async heartbeat(s, claim) {
      const { rows } = await pool.query(`UPDATE mtr_harness.confirmation_requests SET lease_until=now()+$6*interval '1 millisecond'
        WHERE user_id=$1 AND agent_id=$2 AND thread_id=$3 AND id=$4 AND execution_token=$5 AND state='executing' AND lease_until>now() RETURNING id`,
      [...scopeArgs(s), claim.id, claim.token, leaseMs]);
      return !!rows.length;
    },
    async finish(s, claim, result, state = 'completed') {
      if (!['completed', 'uncertain'].includes(state)) throw Error('Invalid confirmation result');
      const encrypted = await seal(JSON.stringify(result));
      const { rows } = await pool.query(`UPDATE mtr_harness.confirmation_requests SET state=$6,result=$7,finished_at=now(),lease_until=NULL
        WHERE user_id=$1 AND agent_id=$2 AND thread_id=$3 AND id=$4 AND execution_token=$5 AND state='executing' RETURNING id`,
      [...scopeArgs(s), claim.id, claim.token, state, encrypted]);
      return !!rows.length;
    },
    async recoverableCoding() {
      const { rows } = await pool.query(`SELECT r.* FROM mtr_harness.confirmation_requests r
        JOIN mtr_harness.threads t ON t.id=r.thread_id AND t.user_id=r.user_id AND t.agent_id=r.agent_id
        JOIN mtr_harness.agents a ON a.id=r.agent_id AND a.user_id=r.user_id AND a.archived_at IS NULL
        JOIN mtr_harness.users u ON u.id=r.user_id AND u.deleted_at IS NULL
        WHERE r.tool_name='gerenciar_tarefa_de_app' AND r.continuation_ack_at IS NULL
          AND (r.state='completed' OR r.state='uncertain' OR (r.state='executing' AND r.lease_until<=now()))
          AND r.created_at>now()-interval '7 days' ORDER BY r.created_at`);
      return Promise.all(rows.map(async r => ({scope:{userId:r.user_id,agentId:r.agent_id,threadId:r.thread_id},
        claim:{id:r.id,token:r.execution_token},proposal:await decode(r)})));
    },
    async recordCodingReceipt(s, claim, result) {
      const { rows } = await pool.query(`UPDATE mtr_harness.confirmation_requests SET state='completed',result=$6,finished_at=now(),lease_until=NULL
        WHERE user_id=$1 AND agent_id=$2 AND thread_id=$3 AND id=$4 AND execution_token=$5
          AND tool_name='gerenciar_tarefa_de_app' AND (state='uncertain' OR (state='executing' AND lease_until<=now())) RETURNING id`,
      [...scopeArgs(s),claim.id,claim.token,await seal(JSON.stringify(result))]);
      return !!rows.length;
    },
    async acknowledgeContinuation(s,id,canceled=false) {
      await pool.query(`UPDATE mtr_harness.confirmation_requests SET continuation_ack_at=now(),continuation_cancelled=continuation_cancelled OR $5
        WHERE user_id=$1 AND agent_id=$2 AND thread_id=$3 AND id=$4 AND tool_name='gerenciar_tarefa_de_app' AND state='completed'`, [...scopeArgs(s),id,canceled]);
    },
    async cancelContinuations(s) {
      return tx(async c => {
        if (!await owner(c,s,true)) return;
        await c.query(`UPDATE mtr_harness.confirmation_requests SET continuation_ack_at=now(),continuation_cancelled=true
          WHERE user_id=$1 AND agent_id=$2 AND thread_id=$3 AND tool_name='gerenciar_tarefa_de_app'
            AND state IN ('executing','completed','uncertain') AND continuation_cancelled=false`,scopeArgs(s));
      });
    },
    async isContinuationAllowed(s,id) {
      const { rows } = await pool.query(`SELECT r.id FROM mtr_harness.confirmation_requests r
        JOIN mtr_harness.threads t ON t.id=r.thread_id AND t.user_id=r.user_id AND t.agent_id=r.agent_id
        JOIN mtr_harness.agents a ON a.id=r.agent_id AND a.user_id=r.user_id AND a.archived_at IS NULL
        JOIN mtr_harness.users u ON u.id=r.user_id AND u.deleted_at IS NULL
        WHERE r.user_id=$1 AND r.agent_id=$2 AND r.thread_id=$3 AND r.id=$4
          AND r.tool_name='gerenciar_tarefa_de_app' AND r.state='completed' AND NOT r.continuation_cancelled`, [...scopeArgs(s),id]);
      return rows.length===1;
    },
  };
  return store;
}
