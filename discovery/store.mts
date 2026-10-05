import { randomUUID } from 'node:crypto';
import { createClosingStore, REPORT_SCHEMA } from './closing.mjs';
export class DiscoveryError extends Error {
    constructor(public status: number, message: string) { super(message); }
}
// SQL row boundary: projections are controlled here; domain inputs are validated before writes.
export interface DB {
    query(sql: string, args?: unknown[]): Promise<{
        rows: Record<string, any>[];
    }>;
    release?(): void;
}
export interface Pool extends DB {
    connect(): Promise<DB>;
}
export interface Journey {
    user_id: string;
    agent_id: string;
    status: string;
    version: number;
    channel: string;
    timezone: string;
    lunch: string;
    evening: string;
    frequency: string;
    duration: number;
    sensitive: boolean;
    started_at: Date | string | null;
    ends_at: Date | string | null;
    last_response_at: Date | string | null;
    unanswered: number;
    lease_token: string | null;
    lease_at: Date | string | null;
    pause_reason: string | null;
    failures: number;
    silence_stage: string;
    quiet_until: Date | string | null;
    [key: string]: unknown;
}
export const CHANNELS = ['telegram', 'whatsapp', 'app'];
// Falhas determinísticas seguidas antes de pausar (uma falha isolada nunca pausa).
export const FAILURE_LIMIT = 3;
/**
 * Escadinha do silêncio. Silêncio não é recusa: a jornada nunca pausa de
 * repente por falta de resposta, e nunca pausa calada. Depois de
 * SILENCE_DAYS sem nenhuma resposta, o assistente AVISA que vai dar uma
 * pausa curta de QUIET_DAYS e deixa claro que a pessoa pode chamar quando
 * quiser; terminada a pausa, ele CONVIDA a pessoa a contar como tem sido; se
 * ainda assim passarem REENGAGE_DAYS em silêncio, aí sim a jornada pausa.
 * Qualquer resposta em qualquer ponto zera a escadinha.
 */
export const SILENCE_DAYS = 3, QUIET_DAYS = 3, REENGAGE_DAYS = 2;
export const SILENCE_STAGES = ['none', 'notified', 'reengaged'];
const P = 'mtr_harness.discovery_participants', E = 'mtr_harness.discovery_events', N = 'mtr_harness.discovery_notes', C = 'mtr_harness.discovery_settings';
export const SCHEMA = `CREATE TABLE IF NOT EXISTS ${C}(id int PRIMARY KEY CHECK(id=1),enabled boolean NOT NULL DEFAULT false,version int NOT NULL DEFAULT 0);
INSERT INTO ${C}(id) VALUES(1) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS ${P}(
 user_id uuid PRIMARY KEY REFERENCES mtr_harness.users(id) ON DELETE CASCADE,
 agent_id uuid NOT NULL REFERENCES mtr_harness.agents(id) ON DELETE CASCADE,
 status text NOT NULL DEFAULT 'invited' CHECK(status IN ('invited','active','paused','ended','completed')),
 channel text NOT NULL DEFAULT 'telegram' CHECK(channel IN ('telegram','whatsapp','app')),
 timezone text NOT NULL DEFAULT 'America/Sao_Paulo',lunch text NOT NULL DEFAULT '12:30',evening text NOT NULL DEFAULT '20:30',
 frequency text NOT NULL DEFAULT 'twice' CHECK(frequency IN ('twice','evening')),duration int NOT NULL DEFAULT 7 CHECK(duration BETWEEN 3 AND 14),
 sensitive boolean NOT NULL DEFAULT true,consent_version text,consented_at timestamptz,started_at timestamptz,ends_at timestamptz,
 last_response_at timestamptz,unanswered int NOT NULL DEFAULT 0,lease_token uuid,lease_at timestamptz,pause_reason text,version int NOT NULL DEFAULT 0,
 created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS ${E}(id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES ${P}(user_id) ON DELETE CASCADE,
 kind text NOT NULL,slot text,outcome text,receipt text,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(user_id,slot));
CREATE TABLE IF NOT EXISTS ${N}(id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES ${P}(user_id) ON DELETE CASCADE,
 kind text NOT NULL CHECK(kind IN ('context','preference','commitment','concern','opportunity','hypothesis')),
 text text NOT NULL,quote text NOT NULL,thread_id uuid NOT NULL,source_id text NOT NULL,sensitive boolean NOT NULL DEFAULT false,
 basis text NOT NULL DEFAULT 'user_report' CHECK(basis IN ('user_report','hypothesis','user_corrected')),
 created_at timestamptz NOT NULL DEFAULT now(),expires_at timestamptz,
 UNIQUE(user_id,source_id,kind,text));
ALTER TABLE ${P} DROP CONSTRAINT IF EXISTS discovery_participants_channel_check;
ALTER TABLE ${P} ADD CONSTRAINT discovery_participants_channel_check CHECK(channel IN ('telegram','whatsapp','app'));
ALTER TABLE ${P} ADD COLUMN IF NOT EXISTS failures int NOT NULL DEFAULT 0;
ALTER TABLE ${P} ADD COLUMN IF NOT EXISTS silence_stage text NOT NULL DEFAULT 'none';
ALTER TABLE ${P} ADD COLUMN IF NOT EXISTS quiet_until timestamptz;
ALTER TABLE ${P} DROP CONSTRAINT IF EXISTS discovery_participants_silence_check;
ALTER TABLE ${P} ADD CONSTRAINT discovery_participants_silence_check CHECK(silence_stage IN ('none','notified','reengaged'));
UPDATE ${P} SET silence_stage='none',quiet_until=NULL WHERE silence_stage NOT IN ('none','notified','reengaged');
ALTER TABLE ${E} ADD COLUMN IF NOT EXISTS detail text;
ALTER TABLE ${P} ALTER COLUMN sensitive SET DEFAULT true;
UPDATE ${P} SET sensitive=true WHERE sensitive=false;
ALTER TABLE ${N} ALTER COLUMN expires_at DROP DEFAULT;
ALTER TABLE ${N} ALTER COLUMN expires_at DROP NOT NULL;
UPDATE ${N} SET expires_at=NULL WHERE expires_at IS NOT NULL;
DROP INDEX IF EXISTS mtr_harness.discovery_notes_expiry;
CREATE INDEX IF NOT EXISTS discovery_events_user ON ${E}(user_id,created_at);
${REPORT_SCHEMA}`;
const uuid = (x: unknown): string => {
    if (typeof x !== 'string' || !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(x))
        throw new DiscoveryError(400, 'Identificador inválido.');
    return x;
};
export const object = (x: unknown): Record<string, unknown> => {
    if (!x || typeof x !== 'object' || Array.isArray(x))
        throw new DiscoveryError(400, 'Pedido inválido.');
    return x as Record<string, unknown>;
};
function requireVersion(x: unknown): number {
    if (!Number.isInteger(x) || Number(x) < 0)
        throw new DiscoveryError(400, 'Versão inválida.');
    return Number(x);
}
export function preferences(input: unknown) {
    const b = object(input);
    const clock = (x: unknown) => {
        if (typeof x !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(x))
            throw new DiscoveryError(400, 'Horário inválido.');
        return x;
    };
    const lunch = clock(b.lunch), evening = clock(b.evening);
    const minutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
    if (minutes(lunch) < 660 || minutes(lunch) > 900 || minutes(evening) < 1080 || minutes(evening) > 1320 || minutes(evening) - minutes(lunch) < 240)
        throw new DiscoveryError(400, 'Escolha almoço entre 11h e 15h e noite entre 18h e 22h, com 4h de intervalo.');
    if (!CHANNELS.includes(String(b.channel)) || !['twice', 'evening'].includes(String(b.frequency)))
        throw new DiscoveryError(400, 'Canal ou frequência inválidos.');
    if (typeof b.timezone !== 'string')
        throw new DiscoveryError(400, 'Fuso obrigatório.');
    try {
        new Intl.DateTimeFormat('en', { timeZone: b.timezone });
    }
    catch {
        throw new DiscoveryError(400, 'Fuso inválido.');
    }
    if (!Number.isInteger(b.duration) || Number(b.duration) < 3 || Number(b.duration) > 14)
        throw new DiscoveryError(400, 'Duração inválida.');
    return { lunch, evening, timezone: b.timezone, channel: b.channel as string, frequency: b.frequency as string, duration: Number(b.duration), sensitive: true };
}
export function localClock(now: Date, tz: string) { const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }); const p = Object.fromEntries(f.formatToParts(now).map(x => [x.type, x.value])); return { day: `${p.year}-${p.month}-${p.day}`, minute: Number(p.hour) * 60 + Number(p.minute) }; }
const DAY = 86400000;
const stamp = (x: Date | string | null | undefined): number | null => { if (!x) return null; const t = new Date(x).getTime(); return Number.isFinite(t) ? t : null; };
/** Tipo de contato de um slot: `check` é a pergunta do dia, os outros são degraus da escadinha. */
export function slotKind(slot: string | null | undefined): 'check' | 'notice' | 'reengage' {
    const kind = String(slot || '').split(':')[1];
    return kind === 'notice' || kind === 'reengage' ? kind : 'check';
}
/**
 * Qual contato a escadinha do silêncio permite agora, ou `null` para silêncio
 * combinado (a pausa curta que o próprio assistente anunciou).
 *
 * Note que nada aqui pausa a jornada: o único desfecho automático de pausa
 * mora em `maintenance()`, no fim da escadinha.
 */
export function silenceStep(p: Journey, now: Date): 'check' | 'notice' | 'reengage' | null {
    const quiet = stamp(p.quiet_until);
    if (p.silence_stage === 'reengaged')
        return null; // convite já feito; se o prazo vencer, a manutenção pausa
    if (p.silence_stage === 'notified')
        return quiet !== null && now.getTime() >= quiet ? 'reengage' : null;
    const since = stamp(p.last_response_at) ?? stamp(p.started_at) ?? now.getTime();
    return now.getTime() - since >= SILENCE_DAYS * DAY ? 'notice' : 'check';
}
export function dueSlot(p: Journey, now: Date): string | null {
    if (p.status !== 'active' || !p.ends_at || new Date(p.ends_at) <= now)
        return null;
    const step = silenceStep(p, now);
    if (!step)
        return null;
    const t = localClock(now, p.timezone);
    for (const [name, time] of [['lunch', p.lunch], ['evening', p.evening]]) {
        if (name === 'lunch' && p.frequency === 'evening')
            continue;
        const m = Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
        if (t.minute >= m && t.minute < m + 10)
            return `${t.day}:${step === 'check' ? name : step}`;
    }
    return null;
}
/**
 * Os cinco estados de entrega que o dono enxerga.
 *
 * `aceita` é o teto honesto do Telegram e do app: o provedor aceitou a mensagem
 * e não devolve confirmação de entrega nem de leitura. Só o WhatsApp tem webhook
 * de status, então só nele `entregue` e `lida` são fato, lidos de
 * `wa_message_status` pelo wamid guardado no recibo do evento.
 */
export const DELIVERY_STATES = ['aceita', 'entregue', 'lida', 'falhou', 'desconhecida'];
export function deliveryState(row: {
    outcome?: string | null;
    channel?: string | null;
    wa_status?: string | null;
}): string | null {
    if (row.channel === 'whatsapp') {
        const wa = String(row.wa_status || '');
        if (wa === 'read')
            return 'lida';
        if (wa === 'delivered')
            return 'entregue';
        if (wa === 'failed')
            return 'falhou';
    }
    switch (row.outcome) {
        case 'accepted': return 'aceita';
        case 'failed': return 'falhou';
        case 'uncertain':
        case 'interrupted':
        case 'generating': return 'desconhecida';
        default: return null; // skipped e afins não são tentativa de entrega
    }
}
/** Motivo de falha legível, sem token, telefone, e-mail ou payload do provedor. */
export function sanitizeReason(input: unknown): string | null {
    const raw = input instanceof Error ? input.message : typeof input === 'string' ? input : input === null || input === undefined ? '' : String((input as any)?.message ?? input);
    const text = raw
        .replace(/\b\d{6,}:[A-Za-z0-9_-]{10,}\b/g, '[token]')
        .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[email]')
        .replace(/\b[A-Za-z0-9_-]{24,}\b/g, '[id]')
        .replace(/\+?\d[\d ()-]{7,}\d/g, '[numero]')
        .replace(/\s+/g, ' ')
        .trim();
    return text ? text.slice(0, 200) : null;
}
export function createDiscoveryStore(pool: Pool, enabled = () => process.env.DISCOVERY_ENABLED === '1') {
    const event = async (c: DB, user: string, kind: string, outcome: string | null = null, slot: string | null = null, detail: string | null = null) => { const id = randomUUID(); await c.query(`INSERT INTO ${E}(id,user_id,kind,outcome,slot,detail) VALUES($1,$2,$3,$4,$5,$6)`, [id, user, kind, outcome, slot, detail]); return id; };
    const tx = async <T,>(fn: (c: DB) => Promise<T>): Promise<T> => {
        const c = await pool.connect();
        try {
            await c.query('BEGIN');
            const v = await fn(c);
            await c.query('COMMIT');
            return v;
        }
        catch (e) {
            await c.query('ROLLBACK');
            throw e;
        }
        finally {
            c.release?.();
        }
    };
    const get = async (user: string, agent?: string): Promise<Journey | null> => { const r = await pool.query(`SELECT p.* FROM ${P} p JOIN mtr_harness.agents a ON a.id=p.agent_id AND a.user_id=p.user_id AND a.archived_at IS NULL JOIN mtr_harness.users u ON u.id=p.user_id AND u.deleted_at IS NULL WHERE p.user_id=$1 ${agent ? 'AND p.agent_id=$2' : ''}`, [uuid(user), ...(agent ? [uuid(agent)] : [])]); return (r.rows[0] as Journey) || null; };
    const notes = async (user: string) => (await pool.query(`SELECT * FROM ${N} WHERE user_id=$1 ORDER BY created_at DESC,id DESC LIMIT 40`, [uuid(user)])).rows;
    /**
     * Histórico de entrega por tentativa, com o estado real quando existe webhook
     * (WhatsApp) e o teto honesto quando não existe.
     */
    // A tabela de status do WhatsApp pertence ao harness, não à jornada. Onde ela
    // não existe (bancos de teste), o histórico cai para o estado do próprio
    // evento em vez de quebrar a consulta inteira.
    let waStatusTable: boolean | null = null;
    const hasWaStatus = async () => {
        if (waStatusTable === null)
            waStatusTable = !!(await pool.query(`SELECT to_regclass('mtr_harness.wa_message_status') AS t`)).rows[0]?.t;
        return waStatusTable;
    };
    const deliveries = async (user?: string, limit = 50) => {
        const n = Number.isInteger(limit) && limit > 0 && limit <= 200 ? limit : 50;
        const wa = await hasWaStatus();
        const cols = wa ? 'ws.status AS wa_status,ws.error_title,ws.error_message,ws.status_at' : 'NULL AS wa_status,NULL AS error_title,NULL AS error_message,NULL AS status_at';
        const join = wa ? ` LEFT JOIN mtr_harness.wa_message_status ws ON p.channel='whatsapp' AND ws.wamid=e.receipt` : '';
        const rows = (await pool.query(`SELECT e.id,e.user_id,e.slot,e.outcome,e.receipt,e.detail,e.created_at,p.channel,${cols} FROM ${E} e JOIN ${P} p ON p.user_id=e.user_id${join} WHERE e.kind='contact'${user ? ' AND e.user_id=$1' : ''} ORDER BY e.created_at DESC LIMIT ${n}`, user ? [uuid(user)] : [])).rows;
        return rows.map(r => ({ id: r.id, user_id: r.user_id, slot: r.slot, channel: r.channel, created_at: r.created_at, outcome: r.outcome, delivery: deliveryState(r), reason: sanitizeReason(r.detail || r.error_title || r.error_message), status_at: r.status_at || null }));
    };
    const available = async (c: DB = pool) => enabled() && !!(await c.query(`SELECT enabled FROM ${C} WHERE id=1`)).rows[0]?.enabled;
    const closing = createClosingStore(pool, tx, available);
    return {
        init: async () => { await pool.query(SCHEMA); }, get, notes, available, deliveries, closing,
        async complete(user: string, agent: string, input: unknown) {
            const data = object(input), version = requireVersion(data.version);
            const delivery = data.delivery as import('./closing.mjs').ReportDelivery | undefined;
            return tx(async c => {
                const p = (await c.query(`SELECT p.*,p.ends_at>now() AS before_end FROM ${P} p JOIN mtr_harness.agents a ON a.id=p.agent_id AND a.user_id=p.user_id AND a.archived_at IS NULL JOIN mtr_harness.users u ON u.id=p.user_id AND u.deleted_at IS NULL WHERE p.user_id=$1 AND p.agent_id=$2 FOR UPDATE OF p`, [uuid(user), uuid(agent)])).rows[0] as Journey | undefined;
                if (!p) throw new DiscoveryError(404, 'Jornada deste assistente não encontrada.');
                if (p.version !== version || !['active', 'paused'].includes(p.status))
                    throw new DiscoveryError(409, 'A jornada mudou. Consulte o estado e proponha novamente se ainda estiver em andamento.');
                if (!p.before_end) throw new DiscoveryError(409, 'O período da jornada já terminou. Consulte a devolutiva; não é necessário antecipar.');
                if (!await available(c)) throw new DiscoveryError(409, 'O preparo de devolutivas está indisponível enquanto o piloto estiver desligado.');
                if (delivery) await closing.validateDelivery(c, user, agent, delivery);
                const completed = (await c.query(`UPDATE ${P} SET status='completed',ends_at=now(),lease_token=NULL,lease_at=NULL,version=version+1 WHERE user_id=$1 RETURNING ends_at`, [user])).rows[0];
                if (!await closing.enqueueRequested(c, user, delivery))
                    throw new DiscoveryError(409, 'Já existe uma devolutiva para esta jornada. Consulte antes de tentar concluir novamente.');
                await event(c, user, 'completed_early', null, null, JSON.stringify({ previous_ends_at: p.ends_at, ends_at: completed.ends_at }));
                return { status: 'completed', ends_at: completed.ends_at, report_state: 'pending' };
            });
        },
        async overview() { return { runtimeEnabled: enabled(), settings: (await pool.query(`SELECT enabled,version FROM ${C} WHERE id=1`)).rows[0], participants: (await pool.query(`SELECT p.user_id,p.agent_id,u.name,a.name AS agent_name,p.status,p.channel,p.timezone,p.lunch,p.evening,p.frequency,p.duration,p.started_at,p.ends_at,p.last_response_at,p.pause_reason,p.version,p.unanswered,p.silence_stage,p.quiet_until,(SELECT count(*)::int FROM ${N} n WHERE n.user_id=p.user_id) AS notes FROM ${P} p JOIN mtr_harness.users u ON u.id=p.user_id JOIN mtr_harness.agents a ON a.id=p.agent_id ORDER BY p.created_at DESC`)).rows, metrics: (await pool.query(`SELECT kind,outcome,count(*)::int AS count FROM ${E} GROUP BY kind,outcome ORDER BY kind,outcome`)).rows, deliveries: await deliveries(undefined, 200), reports: await closing.overview() }; },
        async candidates() { return (await pool.query(`SELECT a.user_id,a.id AS agent_id,u.name,a.name AS agent_name FROM mtr_harness.agents a JOIN mtr_harness.users u ON u.id=a.user_id WHERE a.archived_at IS NULL AND u.deleted_at IS NULL AND a.user_id NOT IN(SELECT user_id FROM ${P}) ORDER BY u.name,a.created_at LIMIT 200`)).rows; },
        async configure(input: unknown) {
            const b = object(input);
            if (typeof b.enabled !== 'boolean')
                throw new DiscoveryError(400, 'Estado inválido.');
            const r = await pool.query(`UPDATE ${C} SET enabled=$1,version=version+1 WHERE id=1 AND version=$2 RETURNING version`, [b.enabled, requireVersion(b.version)]);
            if (!r.rows.length)
                throw new DiscoveryError(409, 'Configuração mudou. Atualize.');
            return { ok: true };
        },
        async invite(input: unknown) {
            const b = object(input), user = uuid(b.user_id), agent = uuid(b.agent_id);
            return tx(async (c) => {
                await c.query(`SELECT id FROM ${C} WHERE id=1 FOR UPDATE`);
                if (!(await c.query('SELECT id FROM mtr_harness.agents WHERE id=$1 AND user_id=$2 AND archived_at IS NULL', [agent, user])).rows.length)
                    throw new DiscoveryError(400, 'Assistente não pertence à conta.');
                const r = await c.query(`INSERT INTO ${P}(user_id,agent_id) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING user_id`, [user, agent]);
                if (!r.rows.length)
                    throw new DiscoveryError(409, 'Conta já selecionada.');
                await event(c, user, 'selected');
                return { ok: true };
            });
        },
        async request(userInput: string, agentInput: string) {
            const user = uuid(userInput), agent = uuid(agentInput);
            return tx(async (c) => {
                if (!await available(c))
                    throw new DiscoveryError(409, 'Jornada de descoberta indisponível.');
                if (!(await c.query('SELECT id FROM mtr_harness.agents WHERE id=$1 AND user_id=$2 AND archived_at IS NULL', [agent, user])).rows.length)
                    throw new DiscoveryError(400, 'Assistente não pertence à conta.');
                const existing = (await c.query(`SELECT * FROM ${P} WHERE user_id=$1 FOR UPDATE`, [user])).rows[0] as Journey | undefined;
                if (existing) {
                    if (existing.agent_id !== agent)
                        throw new DiscoveryError(409, 'Já existe uma jornada vinculada a outro assistente desta conta.');
                    return existing;
                }
                const p = (await c.query(`INSERT INTO ${P}(user_id,agent_id) VALUES($1,$2) RETURNING *`, [user, agent])).rows[0] as Journey;
                await event(c, user, 'requested');
                return p;
            });
        },
        async invitationContext(user: string) { const r = await pool.query(`INSERT INTO ${E}(id,user_id,kind,slot) VALUES($1,$2,'invitation_context','invitation_context') ON CONFLICT DO NOTHING RETURNING id`, [randomUUID(), uuid(user)]); return r.rows.length === 1; },
        async state(user: string) { const p = await get(user); return { participant: p, notes: p ? await notes(user) : [], available: await available() }; },
        async control(user: string, input: unknown) {
            uuid(user);
            const b = object(input);
            return tx(async (c) => {
                const p = (await c.query(`SELECT * FROM ${P} WHERE user_id=$1 FOR UPDATE`, [user])).rows[0] as Journey;
                if (!p)
                    throw new DiscoveryError(404, 'Você não está neste piloto.');
                if (!['pause', 'end', 'erase', 'less'].includes(String(b.action)) && p.version !== requireVersion(b.version))
                    throw new DiscoveryError(409, 'A jornada mudou. Atualize antes de decidir.');
                const action = String(b.action);
                if (!['accept', 'pause', 'resume', 'less', 'end', 'settings', 'erase'].includes(action))
                    throw new DiscoveryError(400, 'Ação inválida.');
                if (action === 'erase') {
                    await c.query(`DELETE FROM ${N} WHERE user_id=$1`, [user]);
                    await closing.cancel(c, user, true);
                    await c.query(`UPDATE ${P} SET status='ended',lease_token=NULL,lease_at=NULL,version=version+1 WHERE user_id=$1`, [user]);
                    await event(c, user, 'erased');
                    return { ok: true };
                }
                if (['accept', 'settings'].includes(action)) {
                    const v = preferences(b);
                    if (action === 'accept' && (p.status !== 'invited' || b.consent !== true || !['discovery-v1', 'discovery-v2-chat'].includes(String(b.consentVersion))))
                        throw new DiscoveryError(400, 'Adesão explícita necessária.');
                    if (action === 'settings' && !['active', 'paused'].includes(p.status))
                        throw new DiscoveryError(409, 'Jornada não está em andamento.');
                    if (action === 'accept' && !await available(c))
                        throw new DiscoveryError(409, 'Piloto ainda não liberado.');
                    await c.query(`UPDATE ${P} SET lunch=$2,evening=$3,timezone=$4,channel=$5,frequency=$6,duration=$7,sensitive=$8,version=version+1,lease_token=NULL,lease_at=NULL WHERE user_id=$1`, [user, v.lunch, v.evening, v.timezone, v.channel, v.frequency, v.duration, v.sensitive]);
                    if (action === 'accept')
                        await c.query(`UPDATE ${P} SET status='active',started_at=now(),ends_at=now()+duration*interval '1 day',consented_at=now(),consent_version=$2 WHERE user_id=$1`, [user, b.consentVersion]);
                }
                else {
                    if (['resume', 'less', 'pause'].includes(action) && !['active', 'paused'].includes(p.status) && !(action === 'pause' && p.status === 'completed'))
                        throw new DiscoveryError(409, 'Jornada não está em andamento.');
                    if (action === 'resume' && (!await available(c) || !p.ends_at || new Date(p.ends_at) <= new Date()))
                        throw new DiscoveryError(409, 'Jornada encerrada ou piloto indisponível.');
                    if (['end', 'pause'].includes(action)) await closing.cancel(c, user);
                    await c.query(`UPDATE ${P} SET status=$2,frequency=$3,unanswered=CASE WHEN $4 THEN 0 ELSE unanswered END,failures=CASE WHEN $4 THEN 0 ELSE failures END,silence_stage=CASE WHEN $4 THEN 'none' ELSE silence_stage END,quiet_until=CASE WHEN $4 THEN NULL ELSE quiet_until END,pause_reason=NULL,lease_token=NULL,lease_at=NULL,version=version+1 WHERE user_id=$1`, [user, action === 'end' ? 'ended' : action === 'pause' ? (p.status === 'completed' ? 'completed' : 'paused') : action === 'resume' ? 'active' : p.status, action === 'less' ? 'evening' : p.frequency, action === 'resume']);
                }
                await event(c, user, action);
                return { ok: true };
            });
        },
        async editNote(user: string, input: unknown) {
            const b = object(input), id = uuid(b.id);
            const conditional = b.expectedText !== undefined;
            if (conditional && typeof b.expectedText !== 'string')
                throw new DiscoveryError(400, 'Versão da nota inválida.');
            if (b.action !== 'delete' && (b.action !== 'correct' || typeof b.text !== 'string' || !b.text.trim() || b.text.length > 600))
                throw new DiscoveryError(400, 'Correção inválida.');
            const args: unknown[] = [uuid(user), id];
            if (b.action === 'correct')
                args.push(String(b.text).trim());
            if (conditional)
                args.push(b.expectedText);
            const where = `user_id=$1 AND id=$2${conditional ? ` AND text=$${args.length}` : ''}`;
            await tx(async c => {
                await c.query(`SELECT user_id FROM ${P} WHERE user_id=$1 FOR UPDATE`, [user]);
                const r = await c.query(b.action === 'delete' ? `DELETE FROM ${N} WHERE ${where} RETURNING id` : `UPDATE ${N} SET text=$3,basis='user_corrected',quote='' WHERE ${where} RETURNING id`, args);
                if (conditional && !r.rows.length)
                    throw new DiscoveryError(409, 'A nota mudou ou foi apagada. Consulte de novo antes de confirmar.');
                if (r.rows.length) await closing.invalidate(c, user);
            });
            return { ok: true };
        },
        async observe(user: string, agent: string, sourceId: string) {
            const p = await get(user, agent);
            if (!p || p.status !== 'active' || !await available())
                return p;
            await tx(async (c) => {
                const r = await c.query(`INSERT INTO ${E}(id,user_id,kind,slot) VALUES($1,$2,'response',$3) ON CONFLICT DO NOTHING RETURNING id`, [randomUUID(), user, `response:${sourceId}`]);
                if (r.rows.length)
                    await c.query(`UPDATE ${P} SET last_response_at=now(),unanswered=0,silence_stage='none',quiet_until=NULL WHERE user_id=$1 AND status='active'`, [user]);
            });
            return get(user, agent);
        },
        async remember(user: string, agent: string, source: {
            text: string;
            id: string;
            thread: string;
        }, input: unknown) {
            const b = object(input);
            return tx(async (c) => {
                const p = (await c.query(`SELECT * FROM ${P} WHERE user_id=$1 AND agent_id=$2 FOR UPDATE`, [uuid(user), uuid(agent)])).rows[0] as Journey;
                if (!p || p.status !== 'active' || !p.ends_at || new Date(p.ends_at) <= new Date() || !await available(c))
                    throw new DiscoveryError(409, 'Jornada inativa.');
                if (!['context', 'preference', 'commitment', 'concern', 'opportunity', 'hypothesis'].includes(String(b.kind)) || typeof b.text !== 'string' || !b.text.trim() || b.text.length > 600 || typeof b.quote !== 'string' || b.quote.trim().length < 4 || b.quote.length > 400 || !source.text.includes(b.quote) || typeof b.sensitive !== 'boolean')
                    throw new DiscoveryError(400, 'Nota exige trecho literal desta mensagem e classificação válida.');
                // Defense in depth, not a complete detector of all personal/sensitive data.
                const privateText = String(b.text) + ' ' + String(b.quote);
                if (/(?:senha|password|api[_ -]?key|access[_ -]?token|chave secreta)\s*[:=]|\b(?:sk-|ghp_|gho_|xox[baprs]-)[A-Za-z0-9_-]{10,}|\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/i.test(privateText))
                    return { saved: false, reason: 'Credencial ou identificador não deve ser guardado nas notas.' };
                const count = (await c.query(`SELECT count(*)::int AS n FROM ${N} WHERE user_id=$1 AND source_id=$2`, [user, source.id])).rows[0].n;
                if (count >= 3)
                    return { saved: false, reason: 'Máximo de três notas por mensagem.' };
                await c.query(`INSERT INTO ${N}(id,user_id,kind,text,quote,thread_id,source_id,sensitive,basis) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING`, [randomUUID(), user, b.kind, b.text.trim(), b.quote, uuid(source.thread), source.id, b.sensitive, b.kind === 'hypothesis' ? 'hypothesis' : 'user_report']);
                return { saved: true };
            });
        },
        async outcome(user: string, agent: string, source: {
            text: string;
            id: string;
        }, input: unknown) {
            const b = object(input), p = await get(user, agent);
            if (!p || p.status !== 'active' || !await available())
                throw new DiscoveryError(409, 'Jornada inativa.');
            if (!['accepted', 'declined', 'useful_reported'].includes(String(b.outcome)) || typeof b.quote !== 'string' || b.quote.length < 3 || !source.text.includes(b.quote))
                throw new DiscoveryError(400, 'Resultado exige evidência literal da resposta atual.');
            await pool.query(`INSERT INTO ${E}(id,user_id,kind,outcome,slot) VALUES($1,$2,'help',$3,$4) ON CONFLICT DO NOTHING`, [randomUUID(), user, b.outcome, `help:${source.id}:${b.outcome}`]);
            return { ok: true, meaning: 'Relato classificado pelo assistente, não prova de execução ou entrega.' };
        },
        async claim(user: string, slot: string, now = new Date()) {
            return tx(async (c) => {
                if (!await available(c))
                    return null;
                const p = (await c.query(`SELECT * FROM ${P} WHERE user_id=$1 FOR UPDATE`, [uuid(user)])).rows[0] as Journey;
                if (!p || dueSlot(p, now) !== slot || p.lease_token)
                    return null;
                if ((await c.query(`SELECT id FROM ${E} WHERE user_id=$1 AND slot=$2`, [user, slot])).rows.length)
                    return null;
                if (p.last_response_at && now.getTime() - new Date(p.last_response_at).getTime() < 2 * 3600000) {
                    await event(c, user, 'skipped', 'recent_conversation', slot);
                    return null;
                }
                const token = await event(c, user, 'contact', 'generating', slot);
                await c.query(`UPDATE ${P} SET lease_token=$2,lease_at=now() WHERE user_id=$1`, [user, token]);
                return { ...p, lease_token: token } as Journey;
            });
        },
        async canSend(p: Journey) { const current = await get(p.user_id, p.agent_id); return await available() && current?.status === 'active' && current.lease_token === p.lease_token && !!current.lease_at && Date.now() - new Date(current.lease_at).getTime() < 10 * 60000 && !!current.ends_at && new Date(current.ends_at) > new Date() && (!current.last_response_at || Date.now() - new Date(current.last_response_at).getTime() >= 2 * 3600000); },
        /**
         * Fecha a tentativa de contato.
         *
         * Resultado INCERTO (`uncertain`, `interrupted`) nunca pausa a jornada: a
         * mensagem pode ter chegado, e pausar por isso foi exatamente o que
         * silenciou uma jornada saudável. Só falha DETERMINÍSTICA conta, e ainda
         * assim a pausa só entra depois de FAILURE_LIMIT tentativas seguidas,
         * com o motivo já sanitizado guardado no evento.
         *
         * É aqui também que a escadinha do silêncio avança, e só quando o
         * provedor ACEITOU a mensagem: o aviso abre a pausa curta prometida e o
         * convite abre o último prazo. Entrega falha ou incerta não avança nada,
         * então a pessoa nunca entra num silêncio que ninguém comunicou a ela.
         */
        async finish(p: Journey, outcome: string, receipt: string | null = null, detail: unknown = null) {
            const reason = sanitizeReason(detail);
            return tx(async (c) => {
                await c.query(`UPDATE ${E} SET outcome=$2,receipt=$3,detail=$4 WHERE id=$1 AND outcome='generating'`, [p.lease_token, outcome, receipt, reason]);
                const kind = slotKind((await c.query(`SELECT slot FROM ${E} WHERE id=$1`, [p.lease_token])).rows[0]?.slot);
                if (outcome === 'accepted' && kind !== 'check')
                    await c.query(`UPDATE ${P} SET silence_stage=$2,quiet_until=now()+interval '1 day'*$3 WHERE user_id=$1 AND lease_token=$4`, [p.user_id, kind === 'notice' ? 'notified' : 'reengaged', kind === 'notice' ? QUIET_DAYS : REENGAGE_DAYS, p.lease_token]);
                await c.query(`UPDATE ${P} SET unanswered=unanswered+CASE WHEN $3='accepted' AND (last_response_at IS NULL OR last_response_at<=lease_at) THEN 1 ELSE 0 END,failures=CASE WHEN $3='failed' THEN failures+1 WHEN $3='accepted' THEN 0 ELSE failures END,status=CASE WHEN $3='failed' AND failures+1>=$4 THEN 'paused' ELSE status END,pause_reason=CASE WHEN $3='failed' AND failures+1>=$4 THEN 'delivery_failed' ELSE pause_reason END,lease_token=NULL,lease_at=NULL,version=version+1 WHERE user_id=$1 AND lease_token=$2`, [p.user_id, p.lease_token, outcome, FAILURE_LIMIT]);
            });
        },
        // Lease vencido devolve a jornada ao ciclo normal: o resultado é DESCONHECIDO,
        // não uma falha do dono, e por isso não pausa mais nada aqui.
        //
        // A única pausa automática por silêncio do sistema inteiro é a do último
        // degrau: a pessoa recebeu o aviso da pausa curta, recebeu o convite para
        // contar como tem sido, e ainda assim passaram REENGAGE_DAYS sem nenhuma
        // resposta. Fora daqui, só pausa quem pede para pausar.
        async maintenance() {
            await pool.query(`UPDATE ${E} SET outcome='interrupted' WHERE outcome='generating' AND created_at<now()-interval '10 minutes'`);
            await pool.query(`UPDATE ${P} SET lease_token=NULL,lease_at=NULL,version=version+1 WHERE lease_at<now()-interval '10 minutes'`);
            await tx(async (c) => {
                const rows = (await c.query(`UPDATE ${P} SET status='paused',pause_reason='no_response',lease_token=NULL,lease_at=NULL,version=version+1 WHERE status='active' AND silence_stage='reengaged' AND quiet_until IS NOT NULL AND quiet_until<=now() RETURNING user_id`)).rows;
                for (const r of rows)
                    await event(c, r.user_id, 'auto_paused', 'no_response');
            });
            await tx(async c => {
                await closing.enqueue(c);
                await c.query(`UPDATE ${P} SET status='completed',lease_token=NULL,lease_at=NULL,version=version+1 WHERE status IN ('active','paused') AND ends_at<=now()`);
            });
        },
        async due(now = new Date()) {
            if (!await available())
                return [];
            const rows = (await pool.query(`SELECT p.* FROM ${P} p JOIN mtr_harness.agents a ON a.id=p.agent_id AND a.user_id=p.user_id AND a.archived_at IS NULL JOIN mtr_harness.users u ON u.id=p.user_id AND u.deleted_at IS NULL WHERE p.status='active' AND p.ends_at>now()`)).rows as Journey[];
            return rows.map(p => ({ p, slot: dueSlot(p, now) })).filter(x => x.slot);
        }
    };
}
export type DiscoveryStore = ReturnType<typeof createDiscoveryStore>;
