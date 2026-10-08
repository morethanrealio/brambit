import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { createDiscoveryStore, SCHEMA, preferences, dueSlot, silenceStep, QUIET_DAYS, REENGAGE_DAYS, SILENCE_DAYS, type Pool, type Journey } from './store.mjs';
import { incoming, createDiscoveryRunner, sourceId, prompt, CLOSING } from './runtime.mjs';
const pg = new PGlite();
let runtime = true;
const db = { query: async (sql: string, args?: unknown[]) => sql === SCHEMA ? (await pg.exec(sql)).at(-1)! : pg.query(sql, args), release: () => { } };
const store = createDiscoveryStore({ ...db, connect: async () => db } as Pool, () => runtime);
const id = (n: number) => '00000000-0000-0000-0000-' + String(n).padStart(12, '0'), u = id(1), a = id(11), other = id(2), thread = id(90);
const prefs = { lunch: '12:30', evening: '20:30', timezone: 'America/Sao_Paulo', channel: 'telegram', frequency: 'twice', duration: 7, sensitive: false };
const sql = (s: string, v: unknown[] = []) => pg.query(s, v);
const reset = async () => { runtime = true; await pg.exec('TRUNCATE mtr_harness.discovery_participants CASCADE; UPDATE mtr_harness.discovery_settings SET enabled=true,version=0'); await store.invite({ user_id: u, agent_id: a }); };
const accept = async () => { const p = (await store.get(u))!; await store.control(u, { ...prefs, action: 'accept', version: p.version, consent: true, consentVersion: 'discovery-v1' }); return (await store.get(u))!; };
const control = async (action: string, extra: object = {}) => store.control(u, { action, version: (await store.get(u))!.version, ...extra });
before(async () => { await pg.exec(`CREATE SCHEMA mtr_harness; CREATE TABLE mtr_harness.users(id uuid PRIMARY KEY,name text,deleted_at timestamptz); CREATE TABLE mtr_harness.agents(id uuid PRIMARY KEY,user_id uuid REFERENCES mtr_harness.users(id),name text,archived_at timestamptz,created_at timestamptz DEFAULT now());`); for (let n = 1; n <= 7; n++) {
    await sql('INSERT INTO mtr_harness.users VALUES($1,$2,NULL)', [id(n), n === 1 ? '<img src=x onerror=alert(1)>' : 'Conta sintética ' + n]);
    await sql('INSERT INTO mtr_harness.agents(id,user_id,name) VALUES($1,$2,$3)', [id(n + 10), id(n), 'Assistente sintético ' + n]);
} await store.init(); });
after(async () => { await pg.close(); });
test('default is disabled and raw control cannot self-enroll or consent without the global gate', async () => { assert.equal((await store.overview()).settings.enabled, false); await assert.rejects(store.request(u, a)); await store.invite({ user_id: u, agent_id: a }); assert.equal((await store.get(u))!.status, 'invited'); await assert.rejects(store.control(other, { action: 'accept', version: 0, ...prefs, consent: true, consentVersion: 'discovery-v1' })); await assert.rejects(store.control(u, { action: 'accept', version: 0, ...prefs, consent: true, consentVersion: 'discovery-v1' })); });
test('preferences enforce timezone, clock boundaries and cadence while personal notes are always enabled', () => { assert.equal(preferences(prefs).duration, 7); assert.equal(preferences(prefs).sensitive, true); assert.equal(preferences({ ...prefs, sensitive: 'false' }).sensitive, true); for (const p of [{ timezone: 'invalid' }, { lunch: '03:00' }, { evening: '23:00' }, { channel: 'email' }, { duration: 30 }, { frequency: 'spam' }, { lunch: '25:99' }])
    assert.throws(() => preferences({ ...prefs, ...p })); });
test('ownership, universal availability and duplicate enrollment', async () => { await reset(); await assert.rejects(store.invite({ user_id: other, agent_id: a })); await assert.rejects(store.invite({ user_id: u, agent_id: a })); for (let n = 2; n <= 6; n++)
    await store.invite({ user_id: id(n), agent_id: id(n + 10) }); assert.equal((await store.overview()).participants.length, 6); });
test('explicit consent and optimistic version, runtime kill switch', async () => { await reset(); await assert.rejects(store.control(u, { ...prefs, action: 'accept', version: 0, consent: false, consentVersion: 'discovery-v1' })); runtime = false; await assert.rejects(accept()); runtime = true; const p = await accept(); assert.equal(p.status, 'active'); assert.equal(p.consent_version, 'discovery-v1'); await assert.rejects(store.control(u, { ...prefs, action: 'settings', version: 0 })); assert.ok(p.ends_at); });
test('schema migration preserves legacy notes and removes their automatic expiry', async () => {
    await reset();
    await accept();
    await store.remember(u, a, { text: 'Faço compras na quarta', id: 'legacy', thread }, { kind: 'context', text: 'Compras na quarta', quote: 'Faço compras na quarta', sensitive: true });
    await pg.exec(`UPDATE mtr_harness.discovery_participants SET sensitive=false;
        UPDATE mtr_harness.discovery_notes SET expires_at=now()+interval '30 days';
        ALTER TABLE mtr_harness.discovery_participants ALTER COLUMN sensitive SET DEFAULT false;
        ALTER TABLE mtr_harness.discovery_notes ALTER COLUMN expires_at SET DEFAULT now()+interval '30 days';
        ALTER TABLE mtr_harness.discovery_notes ALTER COLUMN expires_at SET NOT NULL;
        CREATE INDEX discovery_notes_expiry ON mtr_harness.discovery_notes(expires_at);`);
    await store.init();
    assert.equal((await store.get(u))!.sensitive, true);
    assert.equal((await store.notes(u)).length, 1);
    assert.equal(((await sql('SELECT expires_at FROM mtr_harness.discovery_notes')).rows[0] as { expires_at: unknown }).expires_at, null);
    const expiry = (await sql("SELECT column_default,is_nullable FROM information_schema.columns WHERE table_schema='mtr_harness' AND table_name='discovery_notes' AND column_name='expires_at'")).rows[0] as { column_default: unknown; is_nullable: string };
    assert.equal(expiry.column_default, null);
    assert.equal(expiry.is_nullable, 'YES');
    assert.equal(((await sql("SELECT count(*)::int AS n FROM pg_indexes WHERE schemaname='mtr_harness' AND indexname='discovery_notes_expiry'")).rows[0] as { n: number }).n, 0);
});
test('timezone day, ten-minute slot, no catch-up and evening only', async () => { await reset(); const p = await accept(); assert.equal(dueSlot(p, new Date('2026-09-13T15:30:00Z')), '2026-09-13:lunch'); assert.equal(dueSlot(p, new Date('2026-09-13T15:39:00Z')), '2026-09-13:lunch'); assert.equal(dueSlot(p, new Date('2026-09-13T15:40:00Z')), null); assert.equal(dueSlot({ ...p, frequency: 'evening' }, new Date('2026-09-13T15:30:00Z')), null); assert.equal(dueSlot({ ...p, timezone: 'Asia/Tokyo', ends_at: '2099-01-01' }, new Date('2026-09-13T03:30:00Z')), '2026-09-13:lunch'); });
test('incoming: other agent, invited state is silent, opt-in and controls', async () => { await reset(); assert.equal((await incoming(store, u, id(12), thread, 'oi', 0)).context, ''); assert.equal((await incoming(store, u, a, thread, 'oi', 0)).context, ''); assert.equal((await store.notes(u)).length, 0); await accept(); const r = await incoming(store, u, a, thread, 'Hoje tive uma reunião difícil', 2); assert.ok(r.source); assert.match(r.context, /UMA pergunta/); assert.ok((await store.get(u))!.last_response_at); assert.match((await incoming(store, u, a, thread, 'pausar jornada', 4)).reply!, /pausada/); assert.equal((await store.get(u))!.status, 'paused'); assert.match((await incoming(store, u, a, thread, 'retomar jornada', 6)).reply!, /retomada/); await incoming(store, u, a, thread, 'menos mensagens', 8); assert.equal((await store.get(u))!.frequency, 'evening'); });
test('grounded personal notes are allowed by default; credentials remain blocked', async () => {
    await reset();
    await accept();
    const source = { text: 'Faço compras na quarta. Fico ansiosa com as compras.', id: 'turn1', thread };
    await assert.rejects(store.remember(u, a, source, { kind: 'context', text: 'Inventou', quote: 'não disse isso', sensitive: false }));
    assert.equal((await store.remember(u, a, source, { kind: 'concern', text: 'Ansiedade relatada', quote: 'Fico ansiosa', sensitive: true })).saved, true);
    await store.remember(u, a, source, { kind: 'preference', text: 'Compras na quarta', quote: 'Faço compras na quarta', sensitive: false });
    await store.remember(u, a, source, { kind: 'hypothesis', text: 'Talvez ajude organizar a semana', quote: 'Faço compras na quarta', sensitive: false });
    const notes = await store.notes(u);
    assert.equal(notes.length, 3);
    assert.equal(notes.find(n => n.kind === 'hypothesis')!.basis, 'hypothesis');
    await store.editNote(other, { id: notes[0].id, action: 'delete' });
    assert.equal((await store.notes(u)).length, 3);
    await store.editNote(u, { id: notes[0].id, action: 'correct', text: 'Prefiro organizar na terça' });
    assert.equal((await store.notes(u))[0].basis, 'user_corrected');
    await store.remember(u, a, source, { kind: 'context', text: 'Compras', quote: 'Faço compras', sensitive: false });
    assert.equal((await store.remember(u, a, source, { kind: 'context', text: 'Outra nota', quote: 'Faço compras', sensitive: false })).saved, false);
    const overview = JSON.stringify(await store.overview());
    assert.ok(!overview.includes('Prefiro organizar'));
    assert.ok(!overview.includes(source.text));
    await control('settings', prefs);
    assert.ok((await store.notes(u)).some(n => n.sensitive));
});
test('same response dedup and no invented result evidence', async () => { await reset(); await accept(); const sid = sourceId(thread, 'sim', 4); await store.observe(u, a, sid); await store.observe(u, a, sid); assert.equal((await store.overview()).metrics.find(m => m.kind === 'response')!.count, 1); await assert.rejects(store.outcome(u, a, { text: 'bom dia', id: 'x' }, { outcome: 'useful_reported', quote: 'ajudou' })); await store.outcome(u, a, { text: 'isso me ajudou', id: 'x' }, { outcome: 'useful_reported', quote: 'me ajudou' }); assert.equal((await store.overview()).metrics.find(m => m.kind === 'help')!.outcome, 'useful_reported'); });
test('claim dedup, recent conversation suppresses slot, and contatos sem resposta não pausam nada', async () => {
    await reset();
    await accept();
    const now = new Date();
    now.setUTCHours(15, 30, 0, 0);
    await sql("UPDATE mtr_harness.discovery_participants SET ends_at=now()+interval '10 days'");
    const date = now.toISOString().slice(0, 10);
    let p = await store.claim(u, date + ':lunch', now);
    assert.ok(p);
    assert.equal(await store.claim(u, date + ':lunch', now), null);
    await store.finish(p!, 'accepted', 'receipt1');
    assert.equal(await store.claim(u, date + ':lunch', now), null);
    now.setUTCHours(23, 30);
    p = await store.claim(u, date + ':evening', now);
    assert.ok(p);
    await store.finish(p!, 'accepted', 'receipt2');
    // Two unanswered contacts no longer pause anything: the journey stays alive and
    // the next day goes on being a normal check-in.
    now.setUTCDate(now.getUTCDate() + 1);
    now.setUTCHours(15, 30);
    const next = await store.claim(u, now.toISOString().slice(0, 10) + ':lunch', now);
    assert.ok(next);
    const state = (await store.get(u))!;
    assert.equal(state.status, 'active');
    assert.equal(state.pause_reason, null);
    assert.equal(state.silence_stage, 'none');
    await store.finish(next!, 'accepted', 'receipt3');
    now.setUTCDate(now.getUTCDate() + 1);
    now.setUTCHours(15, 30);
    await sql('UPDATE mtr_harness.discovery_participants SET last_response_at=$1', [now]);
    assert.equal(await store.claim(u, now.toISOString().slice(0, 10) + ':lunch', now), null);
    assert.ok((await store.overview()).metrics.some(m => m.outcome === 'recent_conversation'));
});
test('escadinha do silêncio: avisa no terceiro dia, cala o combinado, convida depois e só então pausa', async () => {
    await reset();
    await accept();
    const base = new Date();
    base.setUTCHours(15, 30, 0, 0); // 12:30 in São Paulo, within the lunch window
    const at = (days: number) => new Date(base.getTime() + days * 86400000);
    const day = (d: Date) => d.toISOString().slice(0, 10);
    await sql("UPDATE mtr_harness.discovery_participants SET ends_at=now()+interval '30 days',started_at=$1,last_response_at=$1", [base]);
    // Before the third day it's a normal check-in, no notice and no pause.
    for (const d of [1, 2]) {
        const t = at(d), state = (await store.get(u))!;
        assert.equal(silenceStep(state, t), 'check');
        assert.equal(dueSlot(state, t), `${day(t)}:lunch`);
        const c = await store.claim(u, `${day(t)}:lunch`, t);
        assert.ok(c);
        await store.finish(c!, 'accepted', 'receipt-check-' + d);
    }
    assert.equal((await store.get(u))!.status, 'active');
    // Third day of silence: the day's contact becomes the short-pause notice.
    const t3 = at(SILENCE_DAYS);
    assert.equal(dueSlot((await store.get(u))!, t3), `${day(t3)}:notice`);
    assert.equal(await store.claim(u, `${day(t3)}:lunch`, t3), null);
    const notice = await store.claim(u, `${day(t3)}:notice`, t3);
    assert.ok(notice);
    const noticePrompt = prompt(notice!, [], `${day(t3)}:notice`);
    assert.match(noticePrompt, /short-pause notice/);
    assert.match(noticePrompt, /Do not ask any question/);
    assert.ok(noticePrompt.includes(CLOSING.notice));
    await store.finish(notice!, 'accepted', 'receipt-notice');
    let state = (await store.get(u))!;
    assert.equal(state.silence_stage, 'notified');
    assert.equal(state.status, 'active');
    assert.equal(state.pause_reason, null);
    const quiet = new Date(state.quiet_until as string).getTime() - Date.now();
    assert.ok(quiet > (QUIET_DAYS - 0.1) * 86400000 && quiet <= (QUIET_DAYS + 0.01) * 86400000);
    // During the promised pause nobody is bothered, and maintenance pauses nothing.
    await sql('UPDATE mtr_harness.discovery_participants SET quiet_until=$1', [at(SILENCE_DAYS + QUIET_DAYS)]);
    for (const d of [SILENCE_DAYS + 1, SILENCE_DAYS + 2]) {
        assert.equal(silenceStep((await store.get(u))!, at(d)), null);
        assert.equal(dueSlot((await store.get(u))!, at(d)), null);
        assert.equal(await store.claim(u, `${day(at(d))}:lunch`, at(d)), null);
    }
    await store.maintenance();
    assert.equal((await store.get(u))!.status, 'active');
    // Once the pause is over, the contact is the invite to share how life has been.
    const t6 = at(SILENCE_DAYS + QUIET_DAYS);
    assert.equal(dueSlot((await store.get(u))!, t6), `${day(t6)}:reengage`);
    const invite = await store.claim(u, `${day(t6)}:reengage`, t6);
    assert.ok(invite);
    const invitePrompt = prompt(invite!, [], `${day(t6)}:reengage`);
    assert.match(invitePrompt, /how their life has been/);
    assert.ok(invitePrompt.includes(CLOSING.reengage));
    assert.match(prompt(invite!, [], `${day(t6)}:lunch`), /lunch: invite/);
    await store.finish(invite!, 'accepted', 'receipt-reengage');
    state = (await store.get(u))!;
    assert.equal(state.silence_stage, 'reengaged');
    assert.equal(state.status, 'active');
    const last = new Date(state.quiet_until as string).getTime() - Date.now();
    assert.ok(last > (REENGAGE_DAYS - 0.1) * 86400000 && last <= (REENGAGE_DAYS + 0.01) * 86400000);
    assert.equal(dueSlot(state, at(SILENCE_DAYS + QUIET_DAYS + 1)), null);
    await store.maintenance();
    assert.equal((await store.get(u))!.status, 'active');
    // Only after the final two days, and only then, does the journey pause, with an event.
    await sql("UPDATE mtr_harness.discovery_participants SET quiet_until=now()-interval '1 minute'");
    await store.maintenance();
    state = (await store.get(u))!;
    assert.equal(state.status, 'paused');
    assert.equal(state.pause_reason, 'no_response');
    assert.ok((await store.overview()).metrics.some(m => m.kind === 'auto_paused' && m.outcome === 'no_response'));
    // Resuming resets the ladder back to the start.
    await control('resume');
    const resumed = (await store.get(u))!;
    assert.equal(resumed.status, 'active');
    assert.equal(resumed.silence_stage, 'none');
    assert.equal(resumed.quiet_until, null);
});
test('qualquer resposta zera a escadinha do silêncio', async () => {
    await reset();
    await accept();
    await sql("UPDATE mtr_harness.discovery_participants SET silence_stage='notified',quiet_until=now()+interval '3 days',unanswered=2");
    await store.observe(u, a, sourceId(thread, 'oi, desculpa a demora', 3));
    const back = (await store.get(u))!;
    assert.equal(back.silence_stage, 'none');
    assert.equal(back.quiet_until, null);
    assert.equal(back.unanswered, 0);
    assert.equal(silenceStep(back, new Date()), 'check');
});
test('pause while generating prevents send; unknown result never pauses and definitive failure pauses only at the limit', async () => {
    await reset();
    await accept();
    const at = (offset: number) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + offset); d.setUTCHours(15, 30, 0, 0); return d; };
    const slotOf = (d: Date) => d.toISOString().slice(0, 10) + ':lunch';
    const now = at(0), slot = slotOf(now);
    const c = (await store.claim(u, slot, now))!;
    assert.ok(await store.canSend(c));
    await control('pause');
    assert.equal(await store.canSend(c), false);
    await store.finish(c, 'skipped');
    assert.equal((await store.get(u))!.status, 'paused');
    // Unknown result (timeout, 5xx, network) NEVER pauses: the message may
    // have arrived. The slot is also never resent, to avoid duplicating.
    await reset();
    await accept();
    const c2 = (await store.claim(u, slot, now))!;
    await store.finish(c2, 'uncertain', null, 'telegram sendMessage: timeout');
    const unknown = (await store.get(u))!;
    assert.equal(unknown.status, 'active');
    assert.equal(unknown.pause_reason, null);
    assert.equal(unknown.failures, 0);
    assert.equal(await store.claim(u, slot, now), null);
    assert.equal((await store.deliveries(u))[0].delivery, 'desconhecida');
    // A deterministic refusal counts, but just one doesn't pause: three in a row are needed.
    for (let d = 1; d <= 3; d++) {
        const t = at(d), s = slotOf(t);
        // Silence ladder aside: what's under test here is delivery failure,
        // so the person is recorded as having responded just over two hours ago.
        await sql('UPDATE mtr_harness.discovery_participants SET last_response_at=$1', [new Date(t.getTime() - 3 * 3600000)]);
        const claim = (await store.claim(u, s, t))!;
        assert.ok(claim);
        await store.finish(claim, 'failed', null, 'telegram sendMessage: bot was blocked by the user');
        const state = (await store.get(u))!;
        assert.equal(state.failures, d);
        assert.equal(state.status, d < 3 ? 'active' : 'paused');
    }
    assert.equal((await store.get(u))!.pause_reason, 'delivery_failed');
    assert.equal((await store.deliveries(u))[0].delivery, 'falhou');
    // Resuming clears the counter: the journey doesn't go back one step from pausing again.
    await control('resume');
    const resumed = (await store.get(u))!;
    assert.equal(resumed.status, 'active');
    assert.equal(resumed.failures, 0);
    assert.equal(resumed.pause_reason, null);
});
test('notes never expire automatically; explicit erase and crash recovery still work', async () => { await reset(); await accept(); await store.remember(u, a, { text: 'Faço compras na quarta', id: 'x', thread }, { kind: 'context', text: 'Compras', quote: 'Faço compras', sensitive: false }); assert.equal(((await sql('SELECT expires_at FROM mtr_harness.discovery_notes')).rows[0] as { expires_at: unknown }).expires_at, null); await sql("UPDATE mtr_harness.discovery_notes SET expires_at=now()-interval '1 day'"); await store.maintenance(); assert.equal((await store.notes(u)).length, 1); await sql("UPDATE mtr_harness.discovery_participants SET lease_token=$1,lease_at=now()-interval '11 minutes'", [id(81)]); await store.maintenance(); const recovered = (await store.get(u))!; assert.equal(recovered.lease_token, null); assert.equal(recovered.status, 'active'); assert.equal(recovered.pause_reason, null); await sql("UPDATE mtr_harness.discovery_participants SET ends_at=now()-interval '1 day'"); await store.maintenance(); assert.equal((await store.get(u))!.status, 'completed'); await control('erase'); assert.equal((await store.get(u))!.status, 'ended'); assert.equal((await store.notes(u)).length, 0); });
test('runner real store, mocked provider/transport: no tools, receipt != delivery; privacy-safe overview', async () => {
    await reset();
    const p = await accept();
    const now = new Date();
    now.setUTCHours(15, 30, 0, 0);
    const slot = now.toISOString().slice(0, 10) + ':lunch';
    let sends = 0, persists = 0;
    const scoped = { ...store, due: async () => [{ p, slot }], claim: (user: string, s: string) => store.claim(user, s, now) };
    const runner = createDiscoveryRunner(scoped, { prepare: async () => { }, generate: async (_p, prompt) => { assert.match(prompt, /No tools/); return 'Como foi sua manhã?'; }, send: async () => { sends++; return { ok: true, id: 'test-only' }; }, persist: async () => { persists++; } });
    await runner.tick();
    await runner.tick();
    assert.equal(sends, 1);
    assert.equal(persists, 1);
    assert.ok((await store.overview()).metrics.some(m => m.outcome === 'accepted'));
    await runner.stop();
});
test('global pause during generation suppresses transport', async () => { await reset(); const p = await accept(); const now = new Date(); now.setUTCHours(15, 30, 0, 0); const slot = now.toISOString().slice(0, 10) + ':lunch'; let sends = 0; const runner = createDiscoveryRunner({ ...store, due: async () => [{ p, slot }], claim: (user: string, s: string) => store.claim(user, s, now) }, { prepare: async () => { }, generate: async () => { runtime = false; return 'Como foi?'; }, send: async () => { sends++; return { ok: true, id: 'x' }; }, persist: async () => { } }); await runner.tick(); assert.equal(sends, 0); await runner.stop(); });
test('obvious credentials and identifiers are refused while personal notes are allowed', async () => { await reset(); await accept(); const text = 'senha: segredo-de-teste'; const result = await store.remember(u, a, { text, id: 'secret', thread }, { kind: 'context', text, quote: text, sensitive: true }); assert.equal(result.saved, false); assert.equal((await store.notes(u)).length, 0); });
test('stop/erase remain effective with stale UI version', async () => {
    await reset(); await accept();
    await store.control(u, { action: 'pause', version: 0 });
    assert.equal((await store.get(u))!.status, 'paused');
    await store.control(u, { action: 'erase', version: 0 });
    assert.equal((await store.get(u))!.status, 'ended');
});
test('in-flight stop drains and never sends a prepared message', async () => {
    await reset(); const p = await accept(); const now = new Date(); now.setUTCHours(15, 30, 0, 0);
    const slot = now.toISOString().slice(0, 10) + ':lunch'; let sends = 0;
    let release!: (text: string) => void, enter!: () => void;
    const ready = new Promise<void>(r => enter = r), pending = new Promise<string>(r => release = r);
    const runner = createDiscoveryRunner({ ...store, due: async () => [{ p, slot }], claim: (user: string, s: string) => store.claim(user, s, now) }, {
        prepare: async () => {}, generate: async () => { enter(); return pending; },
        send: async () => { sends++; return { ok: true, id: 'x' }; }, persist: async () => {}
    });
    const tick = runner.tick(); await ready; const duplicate = runner.tick(); let drained = false;
    const stop = runner.stop().then(() => { drained = true; }); await Promise.resolve(); assert.equal(drained, false);
    release('Como foi sua manhã?'); await Promise.all([tick, duplicate, stop]); assert.equal(drained, true); assert.equal(sends, 0);
});
test('history persistence failure does not turn receipt into retry', async () => {
    await reset(); const p = await accept(); const now = new Date(); now.setUTCHours(15, 30, 0, 0);
    const slot = now.toISOString().slice(0, 10) + ':lunch'; let sends = 0;
    const runner = createDiscoveryRunner({ ...store, due: async () => [{ p, slot }], claim: (user: string, s: string) => store.claim(user, s, now) }, {
        prepare: async () => {}, generate: async () => 'Como foi sua manhã?', send: async () => { sends++; return { ok: true, id: 'receipt' }; },
        persist: async () => { throw Error('synthetic history failure'); }
    });
    await runner.tick(); await runner.tick(); assert.equal(sends, 1); assert.ok((await store.overview()).metrics.some(m => m.outcome === 'accepted')); await runner.stop();
});
