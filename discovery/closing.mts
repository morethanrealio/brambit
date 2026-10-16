import { randomUUID } from 'node:crypto';
import type { DB, Pool, Journey } from './store.mjs';
import { HISTORY_DAYS, reportContext, reportPrompt, parseReport, renderReport, renderReportMarkdown, reportFailure, emptyReport, type ReportContext } from './report.mjs';
import { reportAccount } from './report-account.mjs';

const P = 'mtr_harness.discovery_participants', R = 'mtr_harness.discovery_reports';
export const REPORT_SCHEMA = `CREATE TABLE IF NOT EXISTS ${R}(
 id uuid PRIMARY KEY,user_id uuid NOT NULL UNIQUE REFERENCES ${P}(user_id) ON DELETE CASCADE,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','generating','ready','sending','accepted','failed','uncertain','canceled')),
 auto_send boolean NOT NULL,reason text,attempts int NOT NULL DEFAULT 0,
 lease_token uuid,lease_at timestamptz,body text,report jsonb,coverage jsonb,
 receipt text,thread_id uuid,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),sent_at timestamptz);
CREATE INDEX IF NOT EXISTS discovery_reports_queue ON ${R}(state,updated_at);
ALTER TABLE ${R} ADD COLUMN IF NOT EXISTS delivery_thread_id uuid;
ALTER TABLE ${R} ADD COLUMN IF NOT EXISTS delivery_channel text;
ALTER TABLE ${R} ADD COLUMN IF NOT EXISTS recovery_count int NOT NULL DEFAULT 0;
ALTER TABLE ${R} ADD COLUMN IF NOT EXISTS failure_notice text;
ALTER TABLE ${R} ADD COLUMN IF NOT EXISTS body_markdown text;`;
export interface ReportDelivery { threadId: string; channel: 'telegram' | 'whatsapp' | 'app'; }
export interface Closing extends Journey { report_id: string; report_state: string; report_token: string | null; body: string | null; body_markdown?: string | null; auto_send: boolean; email?: string | null; user_name?: string | null; agent_name?: string | null; delivery_thread_id?: string | null; delivery_channel?: string | null; report_reason?: string | null; generation_attempt?: number; recovery_count?: number; }

/** Delivery only in the agreed slots. A missed slot can run the following day. */
export function closingWindow(p: Journey, now = new Date()): boolean {
    if (!p.ends_at || new Date(p.ends_at) > now || p.quiet_until && new Date(p.quiet_until) > now) return false;
    const f = new Intl.DateTimeFormat('en', { timeZone: p.timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    const t = Object.fromEntries(f.formatToParts(now).map(v => [v.type, v.value]));
    const minute = Number(t.hour) * 60 + Number(t.minute);
    return (p.frequency === 'evening' ? [p.evening] : [p.lunch, p.evening]).some(time => {
        const at = Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
        return minute >= at && minute < at + 10;
    });
}
export function createClosingStore(pool: Pool, tx: <T>(fn: (db: DB) => Promise<T>) => Promise<T>, available: (db?: DB) => Promise<boolean>) {
    const projection = 'p.*,r.id AS report_id,r.state AS report_state,r.lease_token AS report_token,r.body,r.body_markdown,r.auto_send,u.email,u.name AS user_name,a.name AS agent_name,r.delivery_thread_id,r.delivery_channel,r.reason AS report_reason,r.attempts AS generation_attempt,r.recovery_count';
    const join = `FROM ${R} r JOIN ${P} p ON p.user_id=r.user_id JOIN mtr_harness.users u ON u.id=p.user_id AND u.deleted_at IS NULL JOIN mtr_harness.agents a ON a.id=p.agent_id AND a.user_id=p.user_id AND a.archived_at IS NULL`;
    const owned = async (user: string, agent: string) => (await pool.query(`SELECT r.id,r.recovery_count,r.state,r.auto_send,r.reason,r.body,r.report,r.coverage,r.thread_id,r.sent_at,r.updated_at,r.delivery_thread_id,r.delivery_channel,r.failure_notice ${join} WHERE p.user_id=$1 AND p.agent_id=$2`, [user, agent])).rows[0] || null;
    async function validateDelivery(db: DB, user: string, agent: string, delivery: ReportDelivery) {
        if (!delivery || !['telegram', 'whatsapp', 'app'].includes(delivery.channel) || typeof delivery.threadId !== 'string') throw Error('Conversa de entrega inválida.');
        const thread = (await db.query(`SELECT id FROM mtr_harness.threads WHERE id=$1 AND user_id=$2 AND agent_id=$3 AND deleted_at IS NULL AND COALESCE(webhook_skill,'')=''`, [delivery.threadId, user, agent])).rows[0];
        if (!thread) throw Error('A conversa de entrega não está disponível para este dono e assistente.');
    }
    return {
        owned, validateDelivery,
        async overview() { return (await pool.query(`SELECT user_id,state,auto_send,reason,coverage,created_at,updated_at,sent_at,delivery_channel,failure_notice FROM ${R} ORDER BY created_at DESC LIMIT 200`)).rows; },
        // Delivery is authorized only by a confirmation bound to the requesting
        // conversation. Old calls without a target remain consult-only.
        async enqueueRequested(db: DB, user: string, delivery?: ReportDelivery) {
            return (await db.query(`INSERT INTO ${R}(id,user_id,auto_send,reason,delivery_thread_id,delivery_channel) VALUES($1,$2,$3,'user_requested_completion',$4,$5) ON CONFLICT(user_id) DO NOTHING RETURNING id`, [randomUUID(), user, !!delivery, delivery?.threadId || null, delivery?.channel || null])).rows[0]?.id || null;
        },
        async retry(user: string, agent: string, expected: { id: string; recoveryCount: number }, delivery: ReportDelivery) {
            return tx(async db => {
                if (!await available(db)) throw Error('O preparo de devolutivas está indisponível.');
                const p = (await db.query(`SELECT p.status,r.id,r.recovery_count,r.state,r.body,r.failure_notice ${join} WHERE p.user_id=$1 AND p.agent_id=$2 FOR UPDATE OF p,r`, [user, agent])).rows[0];
                if (!p || p.status !== 'completed' || p.state !== 'failed' || p.body || p.failure_notice === 'sending' || p.id !== expected.id || Number(p.recovery_count) !== expected.recoveryCount) throw Error('O estado da devolutiva mudou. Consulte antes de tentar novamente.');
                await validateDelivery(db, user, agent, delivery);
                await db.query(`UPDATE ${R} SET state='pending',attempts=0,recovery_count=recovery_count+1,reason='user_requested_retry',auto_send=true,delivery_thread_id=$2,delivery_channel=$3,failure_notice=NULL,lease_token=NULL,lease_at=NULL,updated_at=now() WHERE user_id=$1`, [user, delivery.threadId, delivery.channel]);
            });
        },
        // Called in the same transaction as the participant's completion. The
        // prior status is captured before maintenance discards active/paused.
        async enqueue(db: DB) {
            const rows = (await db.query(`SELECT user_id,status,silence_stage FROM ${P} WHERE status IN ('active','paused') AND ends_at<=now() FOR UPDATE`)).rows;
            for (const p of rows) {
                const reason = p.status === 'paused' ? 'journey_paused' : p.silence_stage === 'reengaged' ? 'awaiting_response' : null;
                await db.query(`INSERT INTO ${R}(id,user_id,auto_send,reason) VALUES($1,$2,$3,$4) ON CONFLICT(user_id) DO NOTHING`, [randomUUID(), p.user_id, !reason, reason]);
            }
            // Older completed journeys have no trustworthy prior status. Their
            // report may be consulted, but migration cannot grant a new send.
            const old = (await db.query(`SELECT p.user_id FROM ${P} p WHERE p.status='completed' AND p.ends_at>=now()-interval '7 days' AND NOT EXISTS(SELECT 1 FROM ${R} r WHERE r.user_id=p.user_id)`)).rows;
            for (const p of old) await db.query(`INSERT INTO ${R}(id,user_id,auto_send,reason) VALUES($1,$2,false,'completed_before_reports') ON CONFLICT(user_id) DO NOTHING`, [randomUUID(), p.user_id]);
        },
        async cancel(db: DB, user: string, erase = false) {
            if (erase) await db.query(`DELETE FROM ${R} WHERE user_id=$1`, [user]);
            else {
                await db.query(`UPDATE ${R} SET auto_send=false WHERE user_id=$1`, [user]);
                await db.query(`UPDATE ${R} SET failure_notice=NULL WHERE user_id=$1 AND failure_notice='pending'`, [user]);
                // A send already admitted may have reached the provider. Keep
                // its lease so finish can still record the real receipt.
                await db.query(`UPDATE ${R} SET state='canceled',lease_token=NULL,lease_at=NULL,body=NULL,body_markdown=NULL,report=NULL,coverage=NULL,reason='journey_stopped',updated_at=now() WHERE user_id=$1 AND state IN ('pending','generating','ready','failed') AND failure_notice IS DISTINCT FROM 'sending'`, [user]);
            }
        },
        async invalidate(db: DB, user: string) {
            await db.query(`UPDATE ${R} SET state='pending',attempts=0,lease_token=NULL,lease_at=NULL,body=NULL,body_markdown=NULL,report=NULL,coverage=NULL,updated_at=now() WHERE user_id=$1 AND state IN ('pending','generating','ready','failed')`, [user]);
        },
        async recover() {
            await pool.query(`UPDATE ${R} SET failure_notice=CASE WHEN state='generating' AND attempts>=3 AND delivery_thread_id IS NOT NULL AND auto_send THEN 'pending' ELSE failure_notice END,state=CASE WHEN state='sending' THEN 'uncertain' WHEN attempts>=3 THEN 'failed' ELSE 'pending' END,reason=CASE WHEN state='sending' THEN 'delivery_interrupted' ELSE 'generation_interrupted' END,lease_token=NULL,lease_at=NULL,updated_at=now() WHERE state IN ('generating','sending') AND lease_at<now()-interval '10 minutes'`);
            await pool.query(`UPDATE ${R} SET failure_notice='uncertain',lease_token=NULL,lease_at=NULL,updated_at=now() WHERE failure_notice='sending' AND lease_at<now()-interval '10 minutes'`);
        },
        async candidates() {
            if (!await available()) return [];
            return (await pool.query(`SELECT ${projection} ${join} WHERE p.status='completed' AND (r.state='pending' OR r.state='ready' AND r.auto_send=true OR r.state='failed' AND r.failure_notice='pending' AND r.auto_send=true) ORDER BY CASE WHEN r.state='pending' THEN 0 ELSE 1 END,p.ends_at LIMIT 30`)).rows as Closing[];
        },
        async claim(p: Closing) {
            return tx(async db => {
                if (!await available(db)) return null;
                const participant = (await db.query(`SELECT p.status ${join} WHERE r.id=$1 AND p.user_id=$2 FOR UPDATE OF p`, [p.report_id, p.user_id])).rows[0];
                if (participant?.status !== 'completed') return null;
                const token = randomUUID();
                const r = await db.query(`UPDATE ${R} SET state='generating',lease_token=$2,lease_at=now(),attempts=attempts+1,updated_at=now() WHERE id=$1 AND state='pending' AND attempts<3 RETURNING attempts`, [p.report_id, token]);
                return r.rows.length ? { ...p, report_token: token, generation_attempt: Number(r.rows[0].attempts) } : null;
            });
        },
        async context(p: Closing): Promise<ReportContext> {
            const through = new Date(p.ends_at!);
            const started = p.started_at ? new Date(p.started_at) : new Date(through.getTime() - p.duration * 86400000);
            const from = new Date(started.getTime() - HISTORY_DAYS * 86400000);
            // Only human messages in owned, non-deleted, non-webhook threads of
            // this assistant. No other assistants, tool output or assistant claims.
            const filter = `FROM mtr_harness.messages m JOIN mtr_harness.threads t ON t.id=m.thread_id AND t.user_id=$1 AND t.agent_id=$2 WHERE m.agent_id=$2 AND m.role='user' AND t.deleted_at IS NULL AND COALESCE(t.webhook_skill,'')='' AND m.ts>=$3 AND m.ts<=$4`;
            const args = [p.user_id, p.agent_id, from, through, p.timezone];
            const stats = (await pool.query(`SELECT count(*)::int AS count,count(DISTINCT (m.ts AT TIME ZONE $5)::date)::int AS days,count(DISTINCT m.thread_id)::int AS conversations,count(*) FILTER(WHERE m.ts<$6)::int AS before_journey,count(*) FILTER(WHERE m.ts>=$6)::int AS during_journey ${filter}`, [...args, started])).rows[0];
            // Sample only when needed; ordinary days retain up to 48 messages.
            // The final budget is distributed across days, never newest-only.
            const messages = (await pool.query(`WITH ranked AS (SELECT m.id,m.ts,left(m.content,2400) AS content,(m.ts AT TIME ZONE $5)::date AS day,ntile(48) OVER(PARTITION BY (m.ts AT TIME ZONE $5)::date ORDER BY m.ts,m.id) AS bucket ${filter}) SELECT DISTINCT ON(day,bucket) id,ts,content,day FROM ranked ORDER BY day,bucket,ts,id`, args)).rows;
            const notes = (await pool.query(`SELECT id,kind,basis,text,quote,created_at FROM mtr_harness.discovery_notes WHERE user_id=$1 AND created_at<=$2 ORDER BY created_at,id LIMIT 3000`, [p.user_id, through])).rows;
            const count = (await pool.query(`SELECT count(*)::int AS count FROM mtr_harness.discovery_notes WHERE user_id=$1 AND created_at<=$2`, [p.user_id, through])).rows[0];
            const routines = (await pool.query(`SELECT title,left(prompt,600) AS prompt FROM mtr_harness.routines WHERE user_id=$1 AND agent_id=$2 AND enabled=true ORDER BY created_at DESC LIMIT 101`, [p.user_id, p.agent_id])).rows;
            const account = await reportAccount(pool, p.user_id, p.agent_id);
            account.partial ||= routines.length > 100;
            return reportContext({ from, through, journeyStartedAt: started, messages, notes, totalMessages: stats.count, totalNotes: count.count, activeDays: stats.days, routines: routines.slice(0, 100), account,
                usage: { conversations: stats.conversations, messagesBeforeJourney: stats.before_journey, messagesDuringJourney: stats.during_journey } });
        },
        async save(p: Closing, context: ReportContext, raw: string) {
            const report = parseReport(raw, context), body = renderReport(report, context), markdown = renderReportMarkdown(report, context);
            return (await pool.query(`UPDATE ${R} SET state='ready',body=$3,body_markdown=$6,report=$4::jsonb,coverage=$5::jsonb,reason=CASE WHEN auto_send THEN NULL ELSE reason END,lease_token=NULL,lease_at=NULL,updated_at=now() WHERE id=$1 AND lease_token=$2 AND state='generating' RETURNING id`, [p.report_id, p.report_token, body, JSON.stringify(report), JSON.stringify({ ...context.coverage, from: context.from, through: context.through, journeyStartedAt: context.journeyStartedAt }), markdown])).rows.length > 0;
        },
        async generationFailed(p: Closing, error?: unknown) {
            // Never store model output / source excerpts in operational errors.
            await pool.query(`UPDATE ${R} SET state=CASE WHEN attempts>=3 THEN 'failed' ELSE 'pending' END,failure_notice=CASE WHEN attempts>=3 AND delivery_thread_id IS NOT NULL AND auto_send THEN 'pending' ELSE NULL END,reason=$3,lease_token=NULL,lease_at=NULL,updated_at=now() WHERE id=$1 AND lease_token=$2 AND state='generating'`, [p.report_id, p.report_token, reportFailure(error)]);
        },
        async begin(p: Closing, now = new Date()) {
            return tx(async db => {
                if (!await available(db)) return null;
                const current = (await db.query(`SELECT ${projection} ${join} WHERE r.id=$1 AND p.user_id=$2 FOR UPDATE OF p,r`, [p.report_id, p.user_id])).rows[0] as Closing;
                if (!current || current.status !== 'completed') return null;
                if (current.delivery_thread_id) {
                    try { await validateDelivery(db, current.user_id, current.agent_id, { threadId: current.delivery_thread_id, channel: current.delivery_channel as ReportDelivery['channel'] }); }
                    catch { return null; }
                } else if (!closingWindow(current, now)) return null;
                const token = randomUUID();
                const r = (await db.query(`UPDATE ${R} SET state='sending',lease_token=$2,lease_at=now(),updated_at=now() WHERE id=$1 AND state='ready' AND auto_send=true RETURNING body,body_markdown`, [p.report_id, token])).rows[0];
                return r ? { ...p, ...current, body: r.body as string, body_markdown: (r.body_markdown as string | null) || null, report_token: token } : null;
            });
        },
        async beginFailure(p: Closing) {
            return tx(async db => {
                if (!await available(db)) return null;
                const current = (await db.query(`SELECT ${projection} ${join} WHERE r.id=$1 AND p.user_id=$2 FOR UPDATE OF p,r`, [p.report_id, p.user_id])).rows[0] as Closing;
                if (!current || current.status !== 'completed' || !current.delivery_thread_id) return null;
                try { await validateDelivery(db, current.user_id, current.agent_id, { threadId: current.delivery_thread_id, channel: current.delivery_channel as ReportDelivery['channel'] }); } catch { return null; }
                const token = randomUUID();
                const r = await db.query(`UPDATE ${R} SET failure_notice='sending',lease_token=$2,lease_at=now() WHERE id=$1 AND state='failed' AND failure_notice='pending' AND auto_send=true RETURNING id`, [p.report_id, token]);
                return r.rows.length ? { ...current, report_token: token } : null;
            });
        },
        async finishFailure(p: Closing, receipt: { ok: boolean; id?: string | null; definitive?: boolean }) {
            await pool.query(`UPDATE ${R} SET failure_notice=$3,lease_token=NULL,lease_at=NULL,updated_at=now() WHERE id=$1 AND lease_token=$2 AND failure_notice='sending'`, [p.report_id, p.report_token, receipt.ok && receipt.id ? 'accepted' : receipt.definitive ? 'failed' : 'uncertain']);
        },
        async finish(p: Closing, receipt: { ok: boolean; id?: string | null; definitive?: boolean; threadId?: string; reason?: string }) {
            const state = receipt.ok && receipt.id ? 'accepted' : receipt.definitive ? 'failed' : 'uncertain';
            await pool.query(`UPDATE ${R} SET state=$3,receipt=$4,thread_id=$5,reason=$6,lease_token=NULL,lease_at=NULL,sent_at=CASE WHEN $3='accepted' THEN now() ELSE NULL END,updated_at=now() WHERE id=$1 AND lease_token=$2 AND state='sending'`, [p.report_id, p.report_token, state, receipt.id || null, receipt.threadId || null, receipt.reason || (state === 'accepted' ? null : 'delivery_failed')]);
        },
    };
}
export type ClosingStore = ReturnType<typeof createClosingStore>;
export function createClosingRunner(store: ClosingStore, io: {
    brief?(): string | null | undefined;
    generate(p: Closing, prompt: string): Promise<string>;
    send(p: Closing, body: string): Promise<{ ok: boolean; id?: string | null; definitive?: boolean; threadId?: string; reason?: string }>;
}) {
    let closed = false, flight: Promise<void> | null = null;
    async function work() {
        await store.recover();
        let generations = 0;
        for (const p of await store.candidates()) {
            if (closed) break;
            if (p.report_state === 'pending') {
                if (generations >= 3) continue;
                const claim = await store.claim(p);
                if (!claim) continue;
                generations++;
                try {
                    const context = await store.context(claim);
                    const raw = context.evidence.some(e => !e.kind.includes('hypothesis') && e.text.trim().length >= 20) ? await io.generate(claim, reportPrompt(context, claim.report_reason, io.brief?.() || undefined)) : JSON.stringify(emptyReport());
                    await store.save(claim, context, raw);
                } catch (error) { await store.generationFailed(claim, error); }
                // Delivery is separately claimed on the next tick, even if the
                // process restarts after the draft was persisted.
            } else if (p.report_state === 'failed') {
                const claim = await store.beginFailure(p);
                if (!claim) continue;
                try { await store.finishFailure(claim, await io.send(claim, 'Não consegui preparar sua devolutiva desta vez. Sua jornada continua concluída e suas anotações estão preservadas. Posso tentar novamente quando você quiser; basta me pedir para refazer a devolutiva.')); }
                catch { await store.finishFailure(claim, { ok: false }); }
            } else {
                const claim = await store.begin(p);
                if (!claim) continue;
                try { await store.finish(claim, await io.send(claim, claim.body!)); }
                catch { await store.finish(claim, { ok: false, reason: 'delivery_interrupted' }); }
            }
        }
    }
    return {
        tick: () => { if (!flight && !closed) flight = work().finally(() => { flight = null; }); return flight || Promise.resolve(); },
        stop: async () => { closed = true; await flight; },
    };
}
