import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { createDiscoveryStore, SCHEMA, type Pool } from './store.mjs';
import { createClosingRunner, closingWindow, type Closing } from './closing.mjs';
import { reportContext, reportPrompt, parseReport, renderReport, reportFailure, redact, type ReportContext } from './report.mjs';
import { reportAccount } from './report-account.mjs';

const pg = new PGlite();
const query = (s: string, args?: any[]) => pg.query<Record<string, any>>(s, args);
const db = { query: async (s: string, args?: any[]) => s === SCHEMA ? (await pg.exec(s)).at(-1)! : query(s, args), release() {} };
let enabled = true;
const store = createDiscoveryStore({ ...db, connect: async () => db } as Pool, () => enabled);
const id = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const u = id(1), a = id(11), t = id(21);
const expiry = new Date(Date.now() - 3600000);
before(async () => {
    await pg.exec(`CREATE SCHEMA mtr_harness;
        CREATE TABLE mtr_harness.users(id uuid PRIMARY KEY,name text,email text,deleted_at timestamptz);
        CREATE TABLE mtr_harness.agents(id uuid PRIMARY KEY,user_id uuid,name text,archived_at timestamptz,created_at timestamptz DEFAULT now(),google_email text,category text DEFAULT 'pessoal');
        CREATE TABLE mtr_harness.threads(id uuid PRIMARY KEY,user_id uuid,agent_id uuid,deleted_at timestamptz,webhook_skill text);
        CREATE TABLE mtr_harness.messages(id bigserial PRIMARY KEY,agent_id uuid,thread_id uuid,role text,content text,ts timestamptz);
        CREATE TABLE mtr_harness.routines(id uuid PRIMARY KEY,user_id uuid,agent_id uuid,title text,prompt text,enabled boolean,created_at timestamptz DEFAULT now());
        CREATE TABLE mtr_harness.connections(user_id uuid,provider text,kind text,secret_enc text);
        CREATE TABLE mtr_harness.oauth_tokens(user_id uuid,provider text,access_token text);
        CREATE TABLE mtr_harness.google_accounts(user_id uuid,google_email text,access_token text,is_primary boolean);
        CREATE TABLE mtr_harness.apps(id uuid,user_id uuid,system text,description text,status text,created_at timestamptz DEFAULT now());
        CREATE TABLE mtr_harness.trackers(id uuid,owner_user_id uuid,title text,kind text,unit text,enabled boolean,created_at timestamptz DEFAULT now());`);
    for (let n = 1; n <= 2; n++) {
        await query('INSERT INTO mtr_harness.users VALUES($1,$2,NULL)', [id(n), `Synthetic ${n}`]);
        await query('INSERT INTO mtr_harness.agents(id,user_id,name) VALUES($1,$2,$3)', [id(n + 10), id(n), 'Synthetic assistant']);
        await query('INSERT INTO mtr_harness.threads VALUES($1,$2,$3,NULL,NULL)', [id(n + 20), id(n), id(n + 10)]);
    }
    await store.init();
});
after(() => pg.close());
async function reset(status = 'active') {
    enabled = true;
    await pg.exec(`TRUNCATE mtr_harness.discovery_participants CASCADE; TRUNCATE mtr_harness.messages,mtr_harness.routines,mtr_harness.connections,mtr_harness.oauth_tokens,mtr_harness.google_accounts,mtr_harness.apps,mtr_harness.trackers;
        UPDATE mtr_harness.users SET deleted_at=NULL; UPDATE mtr_harness.agents SET archived_at=NULL,category='pessoal',google_email=NULL;
        UPDATE mtr_harness.threads SET deleted_at=NULL,webhook_skill=NULL;
        UPDATE mtr_harness.discovery_settings SET enabled=true;`);
    await query(`INSERT INTO mtr_harness.discovery_participants(user_id,agent_id,status,started_at,ends_at) VALUES($1,$2,$3,$4,$5)`, [u, a, status, new Date(expiry.getTime() - 7 * 86400000), expiry]);
}
async function queued(): Promise<Closing> { await store.maintenance(); return (await store.closing.candidates())[0]; }
async function message(text: string, days = 1, opts: Record<string, any> = {}) {
    return (await query(`INSERT INTO mtr_harness.messages(agent_id,thread_id,role,content,ts) VALUES($1,$2,$3,$4,$5) RETURNING id`, [opts.agent || a, opts.thread || t, opts.role || 'user', text, new Date(expiry.getTime() - days * 86400000)])).rows[0];
}
const report = (c: ReportContext) => JSON.stringify({
    version: 2,
    understanding: c.evidence.length ? [{ text: 'Você busca ajuda para planejar as compras.', basis: 'observed', evidence: [{ id: c.evidence[0].id, quote: c.evidence[0].text.slice(0, 30) }] }] : [],
    frictions: [], experiments: [], app: null,
    suggestions: c.evidence.length ? [{ id: 'S1', kind: 'routine', title: 'Lista de compras para a semana', why: 'Reunir os itens antes da ida ao mercado.', deliverable: 'Uma lista por seção, usando os itens que você me contar.', cadence: 'Sexta-feira, horário a combinar', user_role: 'Conferir os ingredientes e aprovar o planejamento.', impact: 'Reduzir as idas extras ao mercado.', first_step: 'Confirmar o dia e informar o que já tem em casa.', evidence: [{ id: c.evidence[0].id, quote: c.evidence[0].text.slice(0, 30) }] }] : [],
    questions: ['Quer começar pela lista de compras?'],
    start: { suggestion_id: c.evidence.length ? 'S1' : null, action: 'Conte os ingredientes que já tem em casa.', why: 'Podemos organizar uma primeira lista sem conexão externa.' },
});
async function ready() {
    await message('Quero organizar as compras da semana com uma lista por seção.');
    const p = (await store.closing.claim(await queued()))!;
    const c = await store.closing.context(p);
    await store.closing.save(p, c, report(c));
    return (await store.closing.candidates())[0];
}
const atSlot = new Date('2099-09-21T15:31:00Z');

test('early completion generates on demand before the original end, including paused journeys, without sending', async () => {
    for (const status of ['active', 'paused']) {
        await reset(status);
        await query("UPDATE mtr_harness.discovery_participants SET ends_at=now()+interval '5 days',quiet_until=now()+interval '2 days'");
        const previous = (await store.get(u))!;
        await message('Quero organizar as compras da semana com uma lista por seção.');
        await store.complete(u, a, { version: previous.version });
        const completed = (await store.get(u))!;
        assert.equal(completed.status, 'completed'); assert.ok(new Date(completed.ends_at!) < new Date(previous.ends_at!));
        assert.deepEqual(completed.quiet_until, previous.quiet_until);
        const context = await store.closing.context((await store.closing.candidates())[0]);
        assert.equal(new Date(context.through).getTime(), new Date(completed.ends_at!).getTime());
        let calls = 0;
        const runner = createClosingRunner(store.closing, {
            generate: async p => { calls++; return report(await store.closing.context(p)); },
            send: async () => assert.fail('on-demand completion never authorizes a notification'),
        });
        await runner.tick(); await runner.tick(); await runner.stop();
        const result = await store.closing.owned(u, a);
        assert.equal(result.state, 'ready'); assert.match(result.body, /Lista de compras/); assert.equal(calls, 1);
        await store.maintenance();
        assert.equal((await store.closing.overview()).length, 1); assert.equal((await store.closing.candidates()).length, 0);
        assert.equal(result.auto_send, false);
        await assert.rejects(store.complete(u, a, { version: previous.version }));
        const events = (await query("SELECT detail FROM mtr_harness.discovery_events WHERE kind='completed_early'")).rows;
        assert.equal(events.length, 1);
        assert.equal(new Date(JSON.parse(String(events[0].detail)).previous_ends_at).getTime(), new Date(previous.ends_at!).getTime());
    }
});

test('early completion checks ownership, stale proposal, expiry and global gates inside the transaction', async () => {
    await reset();
    await query("UPDATE mtr_harness.discovery_participants SET ends_at=now()+interval '1 day'");
    await assert.rejects(store.complete(id(2), a, { version: 0 }));
    await assert.rejects(store.complete(u, id(12), { version: 0 }));
    await assert.rejects(store.complete(u, a, { version: 1 }));
    enabled = false; await assert.rejects(store.complete(u, a, { version: 0 })); enabled = true;
    await query('UPDATE mtr_harness.discovery_settings SET enabled=false');
    await assert.rejects(store.complete(u, a, { version: 0 }));
    await query('UPDATE mtr_harness.discovery_settings SET enabled=true');
    await query('UPDATE mtr_harness.agents SET archived_at=now() WHERE id=$1', [a]);
    await assert.rejects(store.complete(u, a, { version: 0 }));
    await query('UPDATE mtr_harness.agents SET archived_at=NULL WHERE id=$1', [a]);
    await query('UPDATE mtr_harness.users SET deleted_at=now() WHERE id=$1', [u]);
    await assert.rejects(store.complete(u, a, { version: 0 }));
    await query('UPDATE mtr_harness.users SET deleted_at=NULL WHERE id=$1', [u]);
    await query("UPDATE mtr_harness.discovery_participants SET ends_at=now()-interval '1 second'");
    await assert.rejects(store.complete(u, a, { version: 0 }));
    assert.equal((await store.closing.overview()).length, 0); assert.equal((await store.get(u))!.status, 'active');
    await store.maintenance();
    await assert.rejects(store.complete(u, a, { version: 0 }));
    assert.equal((await store.closing.overview()).length, 1);
});

test('reservation failure rolls back early completion; old in-flight check-in loses permission to send', async () => {
    await reset();
    await query("UPDATE mtr_harness.discovery_participants SET ends_at=now()+interval '1 day'");
    const before = (await store.get(u))!;
    await store.closing.enqueueRequested(db, u);
    await assert.rejects(store.complete(u, a, { version: before.version }), /Já existe/);
    assert.equal((await store.get(u))!.status, 'active');
    assert.equal((await store.get(u))!.version, before.version);
    assert.deepEqual((await store.get(u))!.ends_at, before.ends_at);
    await query('DELETE FROM mtr_harness.discovery_reports');
    await query('UPDATE mtr_harness.discovery_participants SET lease_token=$1,lease_at=now()', [id(100)]);
    const inFlight = (await store.get(u))!;
    await store.complete(u, a, { version: inFlight.version });
    assert.equal(await store.canSend(inFlight), false);
    assert.equal((await store.get(u))!.lease_token, null);
});

test('completion and report reservation are idempotent; paused and legacy completions never gain send consent', async () => {
    for (const [status, auto] of [['active', true], ['paused', false], ['completed', false]] as const) {
        await reset(status);
        if (status === 'completed') await query('UPDATE mtr_harness.discovery_participants SET ends_at=now()');
        await store.maintenance(); await store.maintenance();
        assert.equal((await store.get(u))!.status, 'completed');
        const rows = await store.closing.overview();
        assert.equal(rows.length, 1); assert.equal(rows[0].auto_send, auto);
    }
    await reset('ended'); await store.maintenance(); assert.equal((await store.closing.overview()).length, 0);
    await reset();
    await query("UPDATE mtr_harness.discovery_participants SET silence_stage='reengaged',quiet_until=now()+interval '1 day'");
    await store.maintenance(); assert.equal((await store.closing.overview())[0].auto_send, false);
});
test('whole journey plus preceding 20 days context is scoped, dated, human-only and excludes deleted/webhook threads', async () => {
    await reset();
    await query("UPDATE mtr_harness.threads SET webhook_skill='' WHERE id=$1", [t]);
    await message('Organizar a lista da semana com itens por seção.', 26);
    await message('Preciso organizar minhas compras durante a jornada.', 2);
    await message('OUTSIDE_WINDOW', 28); await message('AFTER_END', -1);
    await message('ASSISTANT_CLAIM', 1, { role: 'assistant' });
    await message('OTHER_OWNER', 1, { agent: id(12), thread: id(22) });
    await message('WRONG_THREAD_OWNER', 1, { thread: id(22) });
    await query('INSERT INTO mtr_harness.threads VALUES($1,$2,$3,now(),NULL)', [id(23), u, a]);
    await message('DELETED_THREAD', 1, { thread: id(23) });
    await query('INSERT INTO mtr_harness.threads VALUES($1,$2,$3,NULL,$4)', [id(24), u, a, 'external']);
    await message('WEBHOOK_INSTRUCTION', 1, { thread: id(24) });
    await query('INSERT INTO mtr_harness.routines VALUES($1,$2,$3,$4,$5,true,now())', [id(41), u, a, 'Lista já ativa', 'Preparar lista toda sexta']);
    const c = await store.closing.context(await queued());
    assert.equal(c.coverage.messages, 2); assert.equal(c.coverage.activeDays, 2);
    assert.equal(new Date(c.from).getTime(), expiry.getTime() - 27 * 86400000);
    assert.equal(c.evidence.length, 2); assert.match(c.evidence[0].text, /Organizar/);
    assert.equal(c.routines.length, 1); assert.doesNotMatch(JSON.stringify(c), /OTHER_OWNER|CLAIM|OUTSIDE_WINDOW|AFTER_END|WEBHOOK|DELETED|WRONG_THREAD/);
});
test('all 77 notes are considered, and sampling preserves old days instead of only recent conversations', async () => {
    await reset();
    for (let n = 0; n < 77; n++) await query(`INSERT INTO mtr_harness.discovery_notes(id,user_id,kind,text,quote,thread_id,source_id,created_at) VALUES($1,$2,'context',$3,'literal source',$4,$5,$6)`, [id(100 + n), u, `Nota sintética ${n} sobre compras da semana`, t, String(n), new Date(expiry.getTime() - 86400000)]);
    await message('Lembro de organizar as compras antigas.', 19);
    for (let n = 0; n < 50; n++) await message(`Pedido sintético recente ${n} para organizar compras.`, 1);
    const c = await store.closing.context(await queued());
    assert.equal(c.coverage.notes, 77); assert.equal(c.coverage.sampledNotes, 77);
    assert.equal(c.coverage.messages, 51); assert.ok(c.coverage.partial);
    assert.ok(c.evidence.some(e => e.text.includes('compras antigas')));
    assert.ok(c.coverage.sampledMessages <= 49);
});
test('account context selects owner metadata, never secrets, other owners, deleted apps or disabled trackers', async () => {
    await reset();
    await message('Quero organizar as compras com o assistente.', 26);
    await message('Agora quero manter a lista no meu app.', 1);
    await query("INSERT INTO mtr_harness.connections VALUES($1,'calendar','apikey','PRIVATE_SECRET'),($2,'OTHER_PROVIDER','token','OTHER_SECRET')", [u, id(2)]);
    await query("INSERT INTO mtr_harness.oauth_tokens VALUES($1,'microsoft','PRIVATE_TOKEN'),($1,'revoked',NULL)", [u]);
    await query("INSERT INTO mtr_harness.google_accounts VALUES($1,'synthetic@example.invalid','PRIVATE_GOOGLE_TOKEN',true)", [u]);
    await query("INSERT INTO mtr_harness.apps(id,user_id,system,description,status) VALUES($1,$2,'Lista existente','Compras por categoria','running'),($3,$4,'OTHER_APP','Outro dono','running'),($5,$2,'DELETED_APP','Apagado','deleted')", [id(301),u,id(302),id(2),id(303)]);
    await query("INSERT INTO mtr_harness.trackers(id,owner_user_id,title,kind,unit,enabled) VALUES($1,$2,'Compras registradas','count','itens',true),($3,$4,'OTHER_TRACKER','count','itens',true),($5,$2,'DISABLED_TRACKER','count','itens',false)", [id(401),u,id(402),id(2),id(403)]);
    const c = await store.closing.context(await queued());
    assert.deepEqual(c.usage, { conversations: 1, messagesBeforeJourney: 1, messagesDuringJourney: 1 });
    assert.deepEqual(c.account!.connections.map(x => x.provider), ['calendar','google','microsoft']);
    assert.equal(c.account!.apps.length, 1); assert.equal(c.account!.trackers.length, 1);
    assert.doesNotMatch(JSON.stringify(c), /PRIVATE_|OTHER_|DELETED_APP|DISABLED_TRACKER|example.invalid|revoked/);
    assert.deepEqual(c.evidence.map(e => e.period), ['before_journey','journey']);
});
test('account metadata respects the assistant Google binding and denies personal inventory to group assistants', async () => {
    await reset();
    await query("INSERT INTO mtr_harness.google_accounts VALUES($1,'primary@example.invalid','PRIVATE',true),($1,'other@example.invalid',NULL,false)", [u]);
    assert.ok((await reportAccount(db,u,a)).connections.some(c=>c.provider==='google'));
    await query("UPDATE mtr_harness.agents SET google_email='other@example.invalid' WHERE id=$1", [a]);
    assert.equal((await reportAccount(db,u,a)).connections.length, 0);
    await query("UPDATE mtr_harness.agents SET category='grupo' WHERE id=$1", [a]);
    await query("INSERT INTO mtr_harness.apps(id,user_id,system,status) VALUES($1,$2,'PRIVATE_APP','running')", [id(500),u]);
    const group = await reportAccount(db,u,a);
    assert.deepEqual(group.apps, []); assert.deepEqual(group.trackers, []); assert.deepEqual(group.connections, []);
    assert.equal(group.hosting, 'unknown');
});
test('claims and durable ready state survive restart; send starts once and accepted is distinct from read', async () => {
    await reset(); const p = await ready();
    assert.equal((await store.closing.owned(u, a)).state, 'ready');
    assert.equal(await store.closing.owned(u, id(12)), null);
    assert.equal(await store.closing.owned(id(2), a), null);
    const claim = (await store.closing.begin(p, atSlot))!;
    assert.ok(claim); assert.equal(await store.closing.begin(p, atSlot), null);
    await store.closing.finish(claim, { ok: true, id: 'synthetic-receipt', threadId: t });
    assert.equal((await store.closing.owned(u, a)).state, 'accepted');
    assert.equal((await store.closing.candidates()).length, 0);
    assert.doesNotMatch(JSON.stringify(await store.overview()), /lista por seção|Confirmar o dia|Quero organizar/);
});
test('generation recovery is fenced; interrupted delivery remains uncertain without automatic resend', async () => {
    await reset();
    const first = (await store.closing.claim(await queued()))!;
    assert.equal(await store.closing.claim(first), null);
    await query("UPDATE mtr_harness.discovery_reports SET lease_at=now()-interval '11 minutes'");
    await store.closing.recover();
    const second = (await store.closing.claim((await store.closing.candidates())[0]))!;
    const c = await store.closing.context(second);
    assert.equal(await store.closing.save(first, c, report(c)), false);
    assert.equal(await store.closing.save(second, c, report(c)), true);
    await store.closing.begin((await store.closing.candidates())[0], atSlot);
    await query("UPDATE mtr_harness.discovery_reports SET lease_at=now()-interval '11 minutes'");
    await store.closing.recover();
    assert.equal((await store.closing.owned(u, a)).state, 'uncertain');
    assert.equal((await store.closing.candidates()).length, 0);
});
test('a stop during admitted delivery preserves its receipt instead of inventing cancellation', async () => {
    await reset(); const p = await ready();
    const claim = (await store.closing.begin(p, atSlot))!;
    await store.control(u, { action: 'end' });
    await store.closing.finish(claim, { ok: true, id: 'already-in-transit', threadId: t });
    assert.equal((await store.closing.owned(u, a)).state, 'accepted');
    assert.equal((await store.closing.candidates()).length, 0);
});
test('shutdown waits for a draft and does not start a notification after closing', async () => {
    await reset(); await message('Quero organizar as compras da semana.'); await queued();
    let release!: () => void, started!: () => void;
    const wait = new Promise<void>(r => { release = r; });
    const began = new Promise<void>(r => { started = r; });
    const runner = createClosingRunner(store.closing, {
        generate: async (p) => { started(); await wait; return report(await store.closing.context(p)); },
        send: async () => assert.fail('shutdown must not admit a send'),
    });
    const tick = runner.tick(); await began;
    let stopped = false; const stop = runner.stop().then(() => { stopped = true; });
    await Promise.resolve(); assert.equal(stopped, false);
    release(); await tick; await stop;
    assert.equal((await store.closing.owned(u, a)).state, 'ready');
    await runner.tick(); assert.equal((await store.closing.owned(u, a)).state, 'ready');
});
test('stop, pause, deletion and global gates suppress reports already being prepared', async () => {
    for (const action of ['pause', 'end', 'erase']) {
        await reset(); const claim = (await store.closing.claim(await queued()))!;
        const c = await store.closing.context(claim);
        await store.control(u, { action });
        assert.equal(await store.closing.save(claim, c, report(c)), false);
        assert.equal(await store.closing.begin(claim, atSlot), null);
    }
    await reset(); const p = await ready();
    enabled = false; assert.equal(await store.closing.begin(p, atSlot), null);
    enabled = true; await query('UPDATE mtr_harness.discovery_settings SET enabled=false');
    assert.equal(await store.closing.begin(p, atSlot), null);
    await query('UPDATE mtr_harness.discovery_settings SET enabled=true');
    await query('UPDATE mtr_harness.agents SET archived_at=now() WHERE id=$1', [a]);
    assert.equal(await store.closing.begin(p, atSlot), null);
});
test('short quiet interval and configured slots are respected after expiry, without extending the journey', async () => {
    await reset(); const p = await ready();
    assert.ok(closingWindow(p, atSlot));
    assert.equal(closingWindow(p, new Date('2099-09-21T15:41:00Z')), false);
    assert.equal(closingWindow({ ...p, frequency: 'evening' }, atSlot), false);
    await query('UPDATE mtr_harness.discovery_participants SET quiet_until=$1', [new Date('2099-09-21T16:00:00Z')]);
    assert.equal(await store.closing.begin(p, atSlot), null);
    assert.ok(await store.closing.begin(p, new Date('2099-09-21T23:31:00Z')));
    assert.equal(new Date((await store.get(u))!.ends_at!).getTime(), expiry.getTime());
});
test('correcting a note invalidates a pending report and its old generation lease', async () => {
    await reset();
    await query(`INSERT INTO mtr_harness.discovery_notes(id,user_id,kind,text,quote,thread_id,source_id,created_at) VALUES($1,$2,'context','Compras na quarta','Compras na quarta',$3,'source',$4)`, [id(50), u, t, expiry]);
    const claim = (await store.closing.claim(await queued()))!;
    const c = await store.closing.context(claim);
    await store.editNote(u, { id: id(50), action: 'correct', text: 'Compras na quinta' });
    assert.equal(await store.closing.save(claim, c, report(c)), false);
    assert.equal((await store.closing.owned(u, a)).state, 'pending');
});
test('no evidence means no invented suggestions or model call; generation retries are bounded', async () => {
    await reset('paused'); await queued();
    const runner = createClosingRunner(store.closing, { generate: async () => assert.fail('no evidence'), send: async () => assert.fail('paused') });
    await runner.tick(); await runner.tick(); await runner.stop();
    assert.deepEqual((await store.closing.owned(u, a)).report.suggestions, []);
    await reset(); await message('Organizar as compras da semana com uma lista.'); await queued();
    let calls = 0;
    const broken = createClosingRunner(store.closing, { generate: async () => { calls++; throw Error('synthetic failure'); }, send: async () => assert.fail('no draft') });
    for (let n = 0; n < 5; n++) await broken.tick();
    await broken.stop(); assert.equal(calls, 3); assert.equal((await store.closing.owned(u, a)).state, 'failed');
});
test('report validation rejects fabricated evidence, sensitive credentials and unsupported actions', () => {
    for (const text of ['{"api_key":"synthetic-secret"}', 'Authorization: Bearer synthetic-secret', 'postgres://owner:synthetic-secret@db.invalid'])
        assert.ok(!redact(text).includes('synthetic-secret'));
    const c = reportContext({ from: new Date('2026-09-01'), through: new Date('2026-09-21'), messages: [{ id: 1, day: '2026-09-20', ts: '2026-09-20', content: 'Organizar as compras da semana com uma lista por seção.' }], notes: [], totalMessages: 1, totalNotes: 0, activeDays: 1, routines: [] });
    const valid = parseReport(report(c), c);
    assert.match(renderReport(valid, c), /Nenhuma rotina foi ativada/);
    assert.match(reportPrompt(c), /Do not recreate routines that are already active/);
    const bad = JSON.parse(report(c)); bad.suggestions[0].evidence[0].quote = 'Invented source quote';
    assert.throws(() => parseReport(JSON.stringify(bad), c));
    bad.suggestions[0].evidence[0].quote = c.evidence[0].text.slice(0, 30); bad.suggestions[0].kind = 'send_money';
    assert.throws(() => parseReport(JSON.stringify(bad), c));
    const secret = JSON.parse(report(c)); secret.questions = ['senha: synthetic-secret'];
    assert.throws(() => parseReport(JSON.stringify(secret), c));
    assert.throws(() => parseReport(report(c), { ...c, evidence: c.evidence.map(e => ({ ...e, kind: 'hypothesis' })) }));
});

test('literal long quotes are bounded locally, while wrong IDs and mismatched quotes remain rejected', () => {
    const text = 'Preciso organizar a lista de compras e reduzir as idas ao mercado. '.repeat(5);
    const c = reportContext({ from: expiry, through: expiry, messages: [], notes: [{ id: id(42), kind: 'concern', basis: 'explicit', text, created_at: expiry }], totalMessages: 0, totalNotes: 1, activeDays: 0, routines: [] });
    assert.equal(c.evidence[0].id, 'N1');
    assert.doesNotMatch(JSON.stringify(c), new RegExp(id(42)));
    const raw = JSON.parse(report(c));
    raw.suggestions[0].evidence[0].quote = text.slice(0, 246);
    assert.equal(parseReport(JSON.stringify(raw), c).suggestions[0].evidence[0].quote.length, 240);
    raw.suggestions[0].evidence[0].id = 'N999';
    assert.throws(() => parseReport(JSON.stringify(raw), c), /invalid_report_evidence/);
    raw.suggestions[0].evidence[0].id = 'N1'; raw.suggestions[0].evidence[0].quote = text + 'inventado';
    assert.throws(() => parseReport(JSON.stringify(raw), c), /invalid_report_evidence/);
    const spaces = ' '.repeat(241) + 'Organizar a semana sem correria.';
    const spaced = { ...c, evidence: [{ ...c.evidence[0], text: spaces }] };
    raw.suggestions[0].evidence[0].quote = spaces;
    raw.understanding[0].evidence[0].quote = 'Organizar a semana';
    assert.equal(parseReport(JSON.stringify(raw), spaced).suggestions[0].evidence[0].quote, 'Organizar a semana sem correria.');
    const emoji = 'x'.repeat(239) + '🙂 compra';
    const unicode = { ...c, evidence: [{ ...c.evidence[0], text: emoji }] };
    raw.understanding[0].evidence[0].quote = emoji;
    raw.suggestions[0].evidence[0].quote = emoji;
    assert.equal(parseReport(JSON.stringify(raw), unicode).suggestions[0].evidence[0].quote.length, 239);
});

test('cosmetic field overruns fit the total report; excessive fields have safe specific diagnostics', () => {
    const c = reportContext({ from: expiry, through: expiry, notes: [], messages: [{ id: 1, ts: expiry, day: '2026-09-20', content: 'Organizar as compras da semana com uma lista por seção.' }], totalNotes: 0, totalMessages: 1, activeDays: 1, routines: [] });
    const raw = JSON.parse(report(c)); raw.suggestions[0].why = 'Uma explicação útil sobre as compras da semana. '.repeat(8);
    assert.ok(raw.suggestions[0].why.length > 280);
    assert.ok(renderReport(parseReport(JSON.stringify(raw), c), c).length < 5500);
    raw.suggestions[0].why = 'x'.repeat(1001);
    assert.throws(() => parseReport(JSON.stringify(raw), c), /report_field_too_long:why/);
    assert.equal(reportFailure(Error('report_field_too_long:why')), 'report_field_too_long:why');
    assert.equal(reportFailure(Error('report_field_too_long:PRIVATE')), 'generation_failed');
    assert.match(reportPrompt(c, 'report_field_too_long:why'), /The field why came out far too long/);
});

test('requested completion delivers in its exact conversation outside scheduled slots and quiet periods', async () => {
    await reset();
    await query("UPDATE mtr_harness.discovery_participants SET ends_at=now()+interval '5 days',quiet_until=now()+interval '2 days'");
    await message('Quero organizar as compras da semana.');
    await store.complete(u, a, { version: 0, delivery: { threadId: t, channel: 'telegram' } });
    const snapshot = (await store.get(u))!;
    let sends = 0;
    const runner = createClosingRunner(store.closing, {
        generate: async p => report(await store.closing.context(p)),
        send: async (p, body) => { sends++; assert.equal(p.delivery_thread_id, t); assert.equal(p.delivery_channel, 'telegram'); assert.match(body, /Lista de compras/); return { ok: true, id: 'synthetic', threadId: t }; },
    });
    await runner.tick(); await runner.stop();
    assert.equal((await store.closing.owned(u, a)).state, 'ready');
    // Reconstruct the runner to model a restart between generation and delivery.
    const afterRestart = createClosingRunner(store.closing, { generate: async () => assert.fail('already generated'), send: async p => { sends++; assert.equal(p.delivery_thread_id, t); return { ok: true, id: 'synthetic', threadId: t }; } });
    await afterRestart.tick(); await afterRestart.tick(); await afterRestart.stop();
    assert.equal(sends, 1); assert.equal((await store.closing.owned(u, a)).state, 'accepted');
    assert.deepEqual((await store.get(u))!.ends_at, snapshot.ends_at);
});

test('invalid evidence drives a targeted next attempt and only validated output is saved', async () => {
    await reset(); await message('Quero organizar as compras da semana com uma lista.'); await queued();
    const prompts: string[] = [], attempts: number[] = [];
    const runner = createClosingRunner(store.closing, {
        generate: async (p, prompt) => {
            prompts.push(prompt); attempts.push(p.generation_attempt!);
            const raw = JSON.parse(report(await store.closing.context(p)));
            if (prompts.length === 1) raw.suggestions[0].evidence[0].id = 'N999';
            return JSON.stringify(raw);
        }, send: async () => assert.fail('not yet admitted'),
    });
    await runner.tick();
    let state = await store.closing.owned(u, a);
    assert.equal(state.reason, 'invalid_report_evidence'); assert.equal(state.body, null);
    await runner.tick(); await runner.stop();
    state = await store.closing.owned(u, a);
    assert.equal(state.state, 'ready'); assert.match(state.body, /Lista de compras/);
    assert.deepEqual(attempts, [1, 2]); assert.match(prompts[1], /REQUIRED FIX.*cited invalid sources/);
    assert.equal(state.coverage.journeyStartedAt, new Date((await store.get(u))!.started_at!).toISOString());
});

test('failed requested report notifies once; retry uses the same report and unchanged completed journey', async () => {
    await reset(); await query("UPDATE mtr_harness.discovery_participants SET ends_at=now()+interval '1 day'");
    await message('Quero organizar as compras da semana com uma lista.');
    await store.complete(u, a, { version: 0, delivery: { threadId: t, channel: 'telegram' } });
    const before = (await store.get(u))!;
    let notices = 0;
    const broken = createClosingRunner(store.closing, {
        generate: async () => { throw Error('private source must not enter reason'); },
        send: async (p, body) => { assert.equal(p.report_state, 'failed'); assert.match(body, /Não consegui preparar/); notices++; return { ok: true, id: 'failure-notice' }; },
    });
    for (let i = 0; i < 5; i++) await broken.tick();
    await broken.stop(); assert.equal(notices, 1);
    const failed = await store.closing.owned(u, a), expected = { id: failed.id, recoveryCount: failed.recovery_count };
    assert.equal(failed.state, 'failed'); assert.equal(failed.failure_notice, 'accepted'); assert.equal(failed.reason, 'generation_failed');
    const target = { threadId: t, channel: 'telegram' as const };
    await assert.rejects(store.closing.retry(id(2), a, expected, target));
    await assert.rejects(store.closing.retry(u, id(12), expected, target));
    await assert.rejects(store.closing.retry(u, a, expected, { threadId: id(22), channel: 'telegram' }));
    enabled = false; await assert.rejects(store.closing.retry(u, a, expected, target)); enabled = true;
    await store.closing.retry(u, a, expected, target);
    await assert.rejects(store.closing.retry(u, a, expected, target));
    const retried = await store.closing.owned(u, a);
    assert.equal(retried.id, failed.id); assert.equal(retried.state, 'pending'); assert.equal(retried.recovery_count, 1);
    assert.deepEqual((await store.get(u))!.ends_at, before.ends_at); assert.equal((await store.get(u))!.version, before.version);
    const claim = (await store.closing.claim((await store.closing.candidates())[0]))!;
    const c = await store.closing.context(claim); await store.closing.save(claim, c, report(c));
    assert.equal((await store.closing.owned(u, a)).state, 'ready');
    await assert.rejects(store.closing.retry(u, a, { ...expected, recoveryCount: 1 }, target));
});

test('deleted target blocks delivery and an interrupted failure notice is not replayed', async () => {
    await reset(); await query("UPDATE mtr_harness.discovery_participants SET ends_at=now()+interval '1 day'");
    await store.complete(u, a, { version: 0, delivery: { threadId: t, channel: 'app' } });
    const claim = (await store.closing.claim((await store.closing.candidates())[0]))!;
    const c = await store.closing.context(claim); await store.closing.save(claim, c, report(c));
    const ready = (await store.closing.candidates())[0];
    await query('UPDATE mtr_harness.threads SET deleted_at=now() WHERE id=$1', [t]);
    assert.equal(await store.closing.begin(ready), null);
    await query('UPDATE mtr_harness.threads SET deleted_at=NULL WHERE id=$1', [t]);
    await query("UPDATE mtr_harness.discovery_reports SET state='failed',body=NULL,failure_notice='pending'");
    const failed = (await store.closing.candidates())[0], notice = (await store.closing.beginFailure(failed))!;
    assert.ok(notice); assert.equal(await store.closing.beginFailure(failed), null);
    await query("UPDATE mtr_harness.discovery_reports SET lease_at=now()-interval '11 minutes'");
    await store.closing.recover();
    await store.closing.finishFailure(notice, { ok: true, id: 'late-receipt' });
    assert.equal((await store.closing.owned(u, a)).failure_notice, 'uncertain'); assert.equal((await store.closing.candidates()).length, 0);
});

test('last interrupted generation schedules a failure notice and stopping preserves an already admitted notice receipt', async () => {
    await reset(); await query("UPDATE mtr_harness.discovery_participants SET ends_at=now()+interval '1 day'");
    await store.complete(u, a, { version: 0, delivery: { threadId: t, channel: 'telegram' } });
    await store.closing.claim((await store.closing.candidates())[0]);
    await query("UPDATE mtr_harness.discovery_reports SET attempts=3,lease_at=now()-interval '11 minutes'");
    await store.closing.recover();
    const report = await store.closing.owned(u, a);
    assert.equal(report.state, 'failed'); assert.equal(report.failure_notice, 'pending');
    const notice = (await store.closing.beginFailure((await store.closing.candidates())[0]))!;
    await store.control(u, { action: 'pause' });
    await store.closing.finishFailure(notice, { ok: true, id: 'already-in-transit' });
    assert.equal((await store.closing.owned(u, a)).failure_notice, 'accepted');
    assert.equal((await store.closing.candidates()).length, 0);
});
