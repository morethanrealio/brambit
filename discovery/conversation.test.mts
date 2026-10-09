// These cases expect the Portuguese texts on an instance whose default language is pt-BR.
process.env.BRAMBIT_DEFAULT_LANGUAGE = 'pt-BR';
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { createDiscoveryStore, SCHEMA, type Pool } from './store.mjs';
import { conversationTools, CHAT_CONSENT, configurationConfirmation, configurationIntent, configurationText, controlIntent, completionIntent, retryIntent } from './conversation.mjs';
import { incoming } from './runtime.mjs';
const { addGated, takePending, hasPending, confirmsPending, isReactionConfirmable } = await import('../web/' + 'confirm.mjs');
const pg = new PGlite();
let enabled = true;
const db = { query: async (s: string, v?: unknown[]) => s === SCHEMA ? (await pg.exec(s)).at(-1)! : pg.query(s, v), release: () => { } };
const store = createDiscoveryStore({ ...db, connect: async () => db } as Pool, () => enabled);
const id = (n: number) => '00000000-0000-0000-0000-' + String(n).padStart(12, '0');
const u = id(1), a = id(11), thread = id(90);
const prefs = { action: 'accept', lunch: '12:30', evening: '20:30', timezone: 'America/Sao_Paulo', channel: 'telegram', frequency: 'twice', duration: 7, sensitive: false };
function registry(message = 'Quero participar da jornada de descoberta', user = u, agent = a, channel = true) {
    const tools = conversationTools(store, { user, agent, message, thread, channel: 'telegram', validateChannel: async () => { if (!channel)
            throw Error('Canal desconectado.'); } });
    const map = new Map<string, {
        run(input: unknown): Promise<unknown>;
    }>();
    for (const t of tools.direct)
        map.set(t.name, t);
    addGated({ add: (t: {
            name: string;
            run(input: unknown): Promise<unknown>;
        }) => map.set(t.name, t) }, tools.gated, thread);
    return { tools, run: (name: string, args: unknown = {}) => map.get(name)!.run(args) };
}
async function answer(text: string) { const p = takePending(thread); if (p && confirmsPending(p, text))
    return p.run(p.args); return null; }
async function activate() { const r = registry(); await r.run('jornada_configurar', prefs); await answer('sim'); return r; }
before(async () => { await pg.exec('CREATE SCHEMA mtr_harness; CREATE TABLE mtr_harness.users(id uuid PRIMARY KEY,name text,deleted_at timestamptz); CREATE TABLE mtr_harness.agents(id uuid PRIMARY KEY,user_id uuid REFERENCES mtr_harness.users(id),name text,archived_at timestamptz,created_at timestamptz DEFAULT now());'); await pg.query('INSERT INTO mtr_harness.users VALUES($1,$2,NULL)', [u, 'Pessoa sintética']); await pg.query('INSERT INTO mtr_harness.agents(id,user_id,name) VALUES($1,$2,$3)', [a, u, 'Assistente sintético']); await pg.exec('CREATE TABLE mtr_harness.threads(id uuid PRIMARY KEY,user_id uuid,agent_id uuid,deleted_at timestamptz,webhook_skill text)'); await pg.query('INSERT INTO mtr_harness.threads VALUES($1,$2,$3,NULL,NULL)', [thread,u,a]); await store.init(); });
beforeEach(async () => { takePending(thread); enabled = true; await pg.exec('TRUNCATE mtr_harness.discovery_participants CASCADE; UPDATE mtr_harness.discovery_settings SET enabled=true,version=0'); await store.invite({ user_id: u, agent_id: a }); });
after(async () => { takePending(thread); await pg.close(); });
test('consent entirely through real confirmation gate, accepting text or reaction only after a proposal', async () => { assert.equal(await answer('sim'), null); const r = registry(); const state = await r.run('jornada_consultar') as {
    status: string;
}; assert.equal(state.status, 'invited'); const label = String(await r.run('jornada_configurar', prefs)); assert.match(label, /JORNADA AGUARDANDO CONFIRMAÇÃO/); for (const text of ['12:30', '20:30', '7 dias', 'pausar', 'apagar essas anotações', '“sim” ou 👍'])
    assert.ok(label.includes(text), text); for (const scary of ['30 dias', 'histórico normal', 'Sem autorização', 'dados sensíveis', 'não dá pra desfazer', 'America/Sao_Paulo'])
    assert.ok(!label.includes(scary), scary); assert.equal((await store.get(u))!.status, 'invited'); assert.equal(isReactionConfirmable('jornada_configurar'), true); assert.equal(takePending('other-thread'), undefined); await answer('👍'); const p = (await store.get(u))!; assert.equal(p.status, 'active'); assert.equal(p.consent_version, CHAT_CONSENT); assert.equal(p.sensitive, true); });
test('confirmation copy stays short and calm in all supported languages', () => {
    const cases = [
        ['pt-BR', ['Começar sua jornada', '12:30', '20:30', '7 dias'], ['30 dias', 'dados sensíveis', 'histórico normal', 'irreversível', 'fuso']],
        ['en', ['Start your', '12:30', '20:30', '7-day'], ['30 days', 'sensitive', 'normal chat history', 'irreversible', 'timezone']],
        ['es', ['Comenzar tu', '12:30', '20:30', '7 días'], ['30 días', 'sensibles', 'historial normal', 'irreversible', 'zona horaria']]
    ] as const;
    for (const [language, expected, avoided] of cases) {
        const text = configurationText(prefs, language);
        assert.ok(text.length < 520, `${language}: ${text.length}`);
        for (const value of expected)
            assert.ok(text.includes(value), `${language}: ${value}`);
        for (const value of avoided)
            assert.ok(!text.toLowerCase().includes(value.toLowerCase()), `${language}: ${value}`);
    }
    assert.equal(configurationText({ ...prefs, sensitive: true }), configurationText({ ...prefs, sensitive: false }));
});
test('invited journey stays absent from unrelated turns and ambiguous replies cannot create a proposal', async () => {
    for (const message of ['quero', 'sim', 'pode', 'continue o Naval Strike', 'quero participar']) {
        const result = await incoming(store, u, a, thread, message, 2);
        assert.equal(result.context, '');
        assert.equal(result.reply, null);
        assert.equal(configurationIntent(message), null);
        assert.match(String(await registry(message).run('jornada_configurar', prefs)), /NÃO registrei/);
        assert.equal(hasPending(thread), false);
        assert.equal((await store.get(u))!.status, 'invited');
    }
    const events = await pg.query<{ count: string }>("SELECT count(*)::text AS count FROM mtr_harness.discovery_events WHERE kind='invitation_context'");
    assert.equal(events.rows[0].count, '0');
});
test('only an explicit current-message request can propose starting or changing the journey', async () => {
    assert.equal(configurationIntent('Quero começar a jornada de descoberta'), 'accept');
    for (const message of [
        'Quero iniciar a rotina de descoberta', 'Quero participar da jornada de descoberta', 'Quero fazer a jornada de descoberta', 'Gostaria de iniciar a rotina de descoberta', 'Vamos iniciar a jornada de descoberta', 'Pode iniciar a jornada de descoberta', 'Bento, por favor, inicie a rotina de descoberta',
        'Please start the discovery journey', 'I want to join the discovery journey', "I'd like to begin the discovery routine", "Let's start the discovery journey", 'Can you start the discovery journey?',
        'Quiero participar del recorrido de descubrimiento', 'Quiero iniciar la rutina de descubrimiento', 'Me gustaría comenzar la jornada de descubrimiento', 'Vamos a iniciar el viaje de descubrimiento', '¿Puedes iniciar la rutina de descubrimiento?'
    ])
        assert.equal(configurationIntent(message), 'accept', message);
    for (const message of [
        'Quero começar a jornada', 'Quero iniciar minha jornada de compras', 'Quero iniciar a jornada do onboarding',
        'Please start the journey', 'How do I start the discovery journey?', "I don't want to start the discovery journey", 'He said: start the discovery journey', 'The manual says to start the discovery routine', '"Start the discovery journey"',
        'Quiero iniciar mi rutina diaria', '¿Cómo inicio la jornada de descubrimiento?', 'No quiero iniciar la rutina de descubrimiento', 'Ella pidió iniciar el recorrido de descubrimiento', 'El manual dice que inicie la jornada de descubrimiento',
        'Ele disse: “quero iniciar a jornada de descoberta”', 'O manual diz para iniciar a rotina de descoberta', 'Texto: iniciar a jornada de descoberta', 'Como faço para iniciar a jornada de descoberta?', 'Não quero iniciar a jornada de descoberta'
    ])
        assert.equal(configurationIntent(message), null, message);
    const r = registry('Quero começar a jornada de descoberta');
    assert.doesNotMatch(String(await r.run('jornada_configurar', prefs)), /NÃO registrei/);
    await answer('sim');
    assert.equal((await store.get(u))!.status, 'active');
    assert.equal(configurationIntent('Quero mudar o horário da jornada'), null);
    assert.match(String(await registry('Quero mudar o horário da jornada').run('jornada_configurar', prefs)), /NÃO registrei/);
    assert.equal(hasPending(thread), false);
    const settings = { ...prefs, action: 'settings', evening: '21:00' };
    for (const message of ['Quero ajustar a rotina de descoberta', 'I want to change the discovery journey', "I'd like to configure the discovery routine", 'Quiero ajustar el recorrido de descubrimiento', 'Me gustaría cambiar la rutina de descubrimiento']) {
        assert.equal(configurationIntent(message), 'settings', message);
        takePending(thread);
        assert.doesNotMatch(String(await registry(message).run('jornada_configurar', settings)), /NÃO registrei/);
    }
});
test('a pending journey accepts natural confirmation without a magic phrase', async () => {
    for (const message of ['Ok, podemos começar a de hj', 'Sim, quero iniciar a jornada de descoberta', 'Pode começar hoje', 'Pode começar no WhatsApp', 'Quero iniciar no app', "Yes, let's start", 'Sí, podemos empezar'])
        assert.equal(configurationConfirmation(message), true, message);
    for (const message of ['Ainda não podemos começar', 'Ele disse: podemos começar', 'Como podemos começar?', 'No, podemos empezar después', 'Pode começar no WhatsApp, não agora', 'Quiero iniciar, pero no ahora'])
        assert.equal(configurationConfirmation(message), false, message);
    const r = registry();
    await r.run('jornada_configurar', prefs);
    assert.equal(await answer('Ok, podemos começar a de hj'), 'Pronto, sua jornada de descoberta começou. Você pode mudar os horários, pausar ou encerrar quando quiser.');
    assert.equal((await store.get(u))!.status, 'active');
});
test('any owner can request the journey without prior admin selection, but only by an exact explicit name', async () => {
    await pg.exec('TRUNCATE mtr_harness.discovery_participants CASCADE');
    enabled = false;
    const disabled = await incoming(store, u, a, thread, 'Quero começar a jornada de descoberta', 0);
    assert.equal(disabled.participant, null);
    assert.equal(await store.get(u), null);
    enabled = true;
    for (const message of ['quero', 'quero começar a jornada', 'quero iniciar minha jornada de compras', 'quero começar uma rotina', 'jornada de descoberta', 'ela pediu para iniciar a jornada de descoberta']) {
        const result = await incoming(store, u, a, thread, message, 0);
        assert.equal(result.participant, null);
        assert.equal(await store.get(u), null);
    }
    const requested = await incoming(store, u, a, thread, 'I want to start the discovery journey', 0);
    assert.equal(requested.participant?.status, 'invited');
    assert.match(requested.context, /pediu explicitamente/);
    const events = await pg.query<{ kind: string }>('SELECT kind FROM mtr_harness.discovery_events ORDER BY created_at');
    assert.deepEqual(events.rows.map(x => x.kind), ['requested']);
    const r = registry('I want to start the discovery journey');
    assert.doesNotMatch(String(await r.run('jornada_configurar', prefs)), /NÃO registrei/);
    await answer('sim');
    assert.equal((await store.get(u))!.status, 'active');
});
test('raw tools cannot bypass gate; denied/restarted pending never activates', async () => { const r = registry(); await assert.rejects(r.tools.gated[0].run(prefs)); await r.run('jornada_configurar', prefs); await answer('não, espera'); assert.equal((await store.get(u))!.status, 'invited'); await r.run('jornada_configurar', prefs); takePending(thread); assert.equal(await answer('sim'), null); assert.equal((await store.get(u))!.status, 'invited'); });
test('scope, channel and disabled pilot fail closed before any pending action', async () => { for (const r of [registry('oi', id(2)), registry('oi', u, id(12)), registry('oi', u, a, false)]) {
    assert.match(String(await r.run('jornada_configurar', prefs)), /NÃO registrei/);
    assert.equal(hasPending(thread), false);
} enabled = false; const r = registry(); assert.match(String(await r.run('jornada_configurar', prefs)), /NÃO registrei/); assert.equal(hasPending(thread), false); assert.equal((await store.get(u))!.status, 'invited'); });
test('proposal binds preferences and version, rechecks channel and active date', async () => { await activate(); const ends = (await store.get(u))!.ends_at; const proposed = { ...prefs, action: 'settings', evening: '21:00', frequency: 'evening' }; const r = registry('Quero ajustar a jornada de descoberta'); await r.run('jornada_configurar', proposed); proposed.evening = '22:00'; assert.equal((await store.get(u))!.evening, '20:30'); await answer('pode'); assert.equal((await store.get(u))!.evening, '21:00'); assert.deepEqual((await store.get(u))!.ends_at, ends); await r.run('jornada_configurar', { ...prefs, action: 'settings' }); await store.control(u, { action: 'pause', version: (await store.get(u))!.version }); await assert.rejects(answer('sim')); assert.equal((await store.get(u))!.status, 'paused'); });
test('chat controls, third-party quotes rejected, disabled pilot still permits stopping', async () => { await activate(); assert.equal(controlIntent('ele disse pausar jornada'), null); await assert.rejects(registry('ele disse pausar jornada').run('jornada_controlar')); for (const [message, expected] of [['quero pausar a jornada', 'paused'], ['retomar jornada', 'active']]) {
    await incoming(store, u, a, thread, message, 0);
    assert.equal((await store.get(u))!.status, expected);
} await incoming(store, u, a, thread, 'quero receber menos mensagens', 0); assert.equal((await store.get(u))!.frequency, 'evening'); enabled = false; await incoming(store, u, a, thread, 'não quero receber essas mensagens', 0); assert.equal((await store.get(u))!.status, 'paused'); assert.ok((await incoming(store, u, a, thread, 'ver notas', 0)).participant); });
test('resume accepts the direct wording that failed before, without swallowing ordinary talk', () => {
    for (const m of ['Pode retomar', 'retoma a jornada', 'retomar', 'Retome a jornada de descoberta.', 'despausar', 'volta a rotina', 'quero continuar a jornada'])
        assert.equal(controlIntent(m), 'resume');
    for (const m of ['continuar', 'seguir', 'voltar amanhã', 'ele pediu para retomar a jornada', 'retomar o trabalho'])
        assert.notEqual(controlIntent(m), 'resume');
});
async function note() { await store.remember(u, a, { text: 'Faço compras na quarta', id: 'source', thread }, { kind: 'context', text: 'Compras na quarta', quote: 'Faço compras na quarta', sensitive: false }); return (await store.notes(u))[0]; }
test('note review/correction/deletion through chat gate with old/new text and no history deletion', async () => { const r = await activate(); const n = await note(); assert.equal((await r.run('jornada_consultar') as {
    notes: unknown[];
}).notes.length, 1); const label = String(await r.run('jornada_editar_nota', { id: n.id, action: 'correct', text: 'Compras na quinta' })); assert.match(label, /Compras na quarta/); assert.match(label, /Compras na quinta/); assert.equal((await store.notes(u))[0].text, 'Compras na quarta'); assert.equal(isReactionConfirmable('jornada_editar_nota'), false); await answer('sim'); assert.equal((await store.notes(u))[0].text, 'Compras na quinta'); await r.run('jornada_editar_nota', { id: n.id, action: 'delete' }); assert.match(String(await answer('sim')), /histórico normal/); assert.equal((await store.notes(u)).length, 0); });
test('note stale content and wrong account/assistant fail closed', async () => { const r = await activate(); const n = await note(); await r.run('jornada_editar_nota', { id: n.id, action: 'delete' }); await store.editNote(u, { id: n.id, action: 'correct', text: 'Mudou antes de confirmar' }); await assert.rejects(answer('sim')); assert.equal((await store.notes(u)).length, 1); for (const other of [registry('oi', id(2)), registry('oi', u, id(12))]) {
    assert.match(String(await other.run('jornada_editar_nota', { id: n.id, action: 'delete' })), /NÃO registrei/);
    assert.equal(hasPending(thread), false);
} const response = await incoming(store, u, a, thread, 'pode apagar as notas da jornada', 0); assert.match(response.reply!, /não apaga o histórico/); assert.equal((await store.notes(u)).length, 0); assert.equal((await store.get(u))!.status, 'ended'); });
test('confirmation rechecks disconnected transport and global activation gate', async () => { let connected = true; const tools = conversationTools(store, { user: u, agent: a, message: 'Quero participar da jornada de descoberta', validateChannel: async () => { if (!connected)
        throw Error('Canal desconectado.'); } }); const map = new Map<string, {
    run(input: unknown): Promise<unknown>;
}>(); addGated({ add: (t: {
        name: string;
        run(input: unknown): Promise<unknown>;
    }) => map.set(t.name, t) }, tools.gated, thread); await map.get('jornada_configurar')!.run(prefs); connected = false; await assert.rejects(answer('sim')); assert.equal((await store.get(u))!.status, 'invited'); connected = true; await map.get('jornada_configurar')!.run(prefs); enabled = false; await assert.rejects(answer('sim')); assert.equal((await store.get(u))!.status, 'invited'); });
test('normal human confirmation observation does not invalidate proposed preference change', async () => { await activate(); const r = registry('Quero ajustar a jornada de descoberta'); await r.run('jornada_configurar', { ...prefs, action: 'settings', evening: '21:30' }); await incoming(store, u, a, thread, 'sim', 2); await answer('sim'); assert.equal((await store.get(u))!.evening, '21:30'); });
test('active journey keeps an ordinary direct request as the priority, never a proactive check-in', async () => {
    await activate();
    const result = await incoming(store, u, a, thread, 'vc consegue descobrir o nome da empresa, pelo CNPJ?', 4);
    assert.match(result.context, /TURNO NORMAL iniciado pela pessoa/);
    assert.match(result.context, /mensagem humana atual é sempre o pedido prioritário/i);
    assert.match(result.context, /Nunca abra com check-in/);
    assert.match(result.context, /nunca apresente o pedido atual como pendência anterior/i);
    assert.equal(result.reply, null);
    assert.ok(result.source);
});

test('early completion recognizes direct requests and keeps cancellation, questions and quoted content separate', () => {
    for (const message of ['Quero concluir minha jornada agora e preparar minha devolutiva', 'Pode finalizar a minha jornada de descoberta?', 'Por favor, conclua minha jornada com a devolutiva.', 'Quero encerrar minha jornada e receber minha avaliação final', 'Finalize minha jornada agora', 'podemos fechar minha jornada agora? É possível?', 'Pode fechar a minha jornada?']) {
        assert.equal(completionIntent(message), true, message);
        assert.equal(controlIntent(message), null, message);
    }
    for (const message of ['encerrar jornada', 'cancelar jornada', 'Não quero concluir minha jornada', 'Posso concluir minha jornada?', 'Você consegue finalizar minha jornada?', 'Como finalizar minha jornada?', 'Se eu pedir para concluir minha jornada?', 'Ela disse: conclua minha jornada', 'Documento: conclua minha jornada', '"Conclua minha jornada"', 'Conclua minha jornada e apague minhas notas', 'sim', 'pode', 'Finalize a jornada de outra pessoa', 'Quero finalizar o relatório'])
        assert.equal(completionIntent(message), false, message);
    assert.equal(controlIntent('encerrar jornada'), 'end');
});

test('early completion is a text-confirmed proposal, preserves notes and queues exactly one consultable report', async () => {
    await activate(); await note();
    const message = 'Quero concluir minha jornada agora e preparar minha devolutiva';
    const input = await incoming(store, u, a, thread, message, 4);
    assert.equal(input.reply, null); assert.match(input.context, /use jornada_concluir/);
    assert.equal((await store.get(u))!.status, 'active');
    const r = registry(message), tool = r.tools.gated.find(t => t.name === 'jornada_concluir')!;
    await assert.rejects(tool.run({}), /confirmação por texto/);
    const oldEnd = new Date((await store.get(u))!.ends_at!);
    const label = String(await r.run('jornada_concluir'));
    assert.match(label, /20 dias/); assert.match(label, /avisar aqui/);
    assert.equal(isReactionConfirmable('jornada_concluir'), false);
    assert.equal((await store.get(u))!.status, 'active'); assert.equal((await store.closing.overview()).length, 0);
    await incoming(store, u, a, thread, 'sim', 6);
    assert.match(String(await answer('sim')), /Estou preparando/);
    const state = (await store.get(u))!;
    assert.equal(state.status, 'completed'); assert.ok(new Date(state.ends_at!) < oldEnd);
    assert.equal((await store.notes(u)).length, 1);
    const report = await store.closing.owned(u, a);
    assert.equal(report.state, 'pending'); assert.equal(report.auto_send, true);
    assert.equal(report.reason, 'user_requested_completion');
    assert.equal(await answer('sim'), null);
    await store.maintenance(); assert.equal((await store.closing.overview()).length, 1);
    assert.match(String(await r.run('jornada_concluir')), /NÃO registrei/);
    const consult = await r.run('jornada_consultar') as { devolutiva: { estado: string } };
    assert.equal(consult.devolutiva.estado, 'pending');
});

test('early completion rejects generic intent, wrong owner/assistant, expired period and disabled pilot before proposal', async () => {
    await activate();
    for (const r of [registry('encerrar jornada'), registry('conclua minha jornada', id(2)), registry('conclua minha jornada', u, id(12))]) {
        assert.match(String(await r.run('jornada_concluir')), /NÃO registrei/);
        assert.equal(hasPending(thread), false);
    }
    enabled = false;
    assert.match(String(await registry('conclua minha jornada').run('jornada_concluir')), /NÃO registrei/);
    enabled = true;
    await pg.exec("UPDATE mtr_harness.discovery_participants SET ends_at=now()-interval '1 second'");
    assert.match(String(await registry('conclua minha jornada').run('jornada_concluir')), /NÃO registrei/);
    assert.equal((await store.closing.overview()).length, 0);
});

test('a refusal does not complete the journey; pause or kill switch after proposal prevents confirmation', async () => {
    await activate(); const r = registry('conclua minha jornada');
    await r.run('jornada_concluir'); await answer('não');
    assert.equal((await store.get(u))!.status, 'active');
    await r.run('jornada_concluir'); await store.control(u, { action: 'pause' });
    await assert.rejects(answer('sim')); assert.equal((await store.get(u))!.status, 'paused');
    await r.run('jornada_concluir'); enabled = false;
    await assert.rejects(answer('sim')); assert.equal((await store.get(u))!.status, 'paused');
    assert.equal((await store.closing.overview()).length, 0);
});

test('retry accepts natural requests but never status queries, quotations or refusals', () => {
    for (const text of ['Pode refazer minha devolutiva?', 'vamos tentar de novo a devolutiva da jornada', 'Quero preparar minha devolutiva novamente', 'Refaça minha avaliação final da jornada.']) assert.equal(retryIntent(text), true, text);
    for (const text of ['pode mostrar minha devolutiva?', 'a devolutiva está pronta?', 'Não refaça minha devolutiva', 'Ela disse: refaça minha devolutiva', '"refaça minha devolutiva"', 'sim', 'refaça minha devolutiva e apague as notas']) assert.equal(retryIntent(text), false, text);
});

test('the human sequence can complete, discover failure and confirm a retry without reopening the journey', async () => {
    await activate(); await note();
    const completion = registry('podemos fechar minha jornada agora? É possível?');
    await completion.run('jornada_concluir');
    assert.match(String(await answer('pode')), /Jornada concluída/);
    const ended = (await store.get(u))!;
    await pg.query("UPDATE mtr_harness.discovery_reports SET state='failed',attempts=3,reason='invalid_report_evidence'");
    const message = 'Pode refazer minha devolutiva?';
    const incomingResult = await incoming(store, u, a, thread, message, 10);
    assert.match(incomingResult.context, /jornada_refazer_devolutiva/);
    const r = registry(message);
    const label = String(await r.run('jornada_refazer_devolutiva'));
    assert.match(label, /20 dias anteriores/);
    assert.equal(isReactionConfirmable('jornada_refazer_devolutiva'), false);
    assert.equal((await store.closing.owned(u, a)).state, 'failed');
    await answer('cancela'); assert.equal((await store.closing.owned(u, a)).state, 'failed');
    await r.run('jornada_refazer_devolutiva'); await answer('pode');
    assert.equal((await store.closing.owned(u, a)).state, 'pending');
    assert.equal((await store.closing.owned(u, a)).recovery_count, 1);
    assert.deepEqual((await store.get(u))!.ends_at, ended.ends_at);
    assert.equal((await store.notes(u)).length, 1);
    assert.match(String(await r.run('jornada_refazer_devolutiva')), /NÃO registrei/);
});
