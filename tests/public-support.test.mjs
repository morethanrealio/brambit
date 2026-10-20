// Public support: the turn of someone who is not the owner does not reach anything of the owner's
// and one contact does not reach another's. Real database (PGlite) and the real tool-loop of the
// core; only the model is fake, and it records everything it received.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomUUID, randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { PGlite } from '@electric-sql/pglite';

process.env.VAULT_KEY = randomBytes(32).toString('base64');
const { createPublicoStore, createAtendimentoPublico, RESPOSTA_INDISPONIVEL, RESPOSTA_PARADO, RESPOSTA_VOLTOU, RESPOSTA_APAGADO, RESPOSTA_LIMITE } = await import('../web/public-support.mjs');
const { registrarRotasDoDono } = await import('../web/public-support-owner.mjs');
const { createRotas } = await import('../web/routes.mjs');
const { createPublicWebStore, registerPublicWebRoutes, contactFromToken } = await import('../web/public-web.mjs');
const { criarAtendimentoDoServidor } = await import('../web/public-support-channel.mjs');

const SEGREDO = 'SEGREDO-DO-DONO-' + randomUUID();

async function montar(t) {
  const db = new PGlite(); t.after(() => db.close());
  await db.exec(`CREATE SCHEMA mtr_harness;
    CREATE TABLE mtr_harness.users(id uuid PRIMARY KEY);
    CREATE TABLE mtr_harness.agents(id uuid PRIMARY KEY, user_id uuid REFERENCES mtr_harness.users(id) ON DELETE CASCADE,
      name text, instructions text, profile text, summary text, archived_at timestamptz);
    CREATE TABLE mtr_harness.usage_events(id bigserial PRIMARY KEY, ts timestamptz DEFAULT now(), agent_id uuid, kind text, cost_usd numeric(12,6));`);
  const dono = randomUUID(), outro = randomUUID(), ag = randomUUID(), ag2 = randomUUID();
  await db.query('INSERT INTO mtr_harness.users VALUES ($1), ($2)', [dono, outro]);
  await db.query(`INSERT INTO mtr_harness.agents VALUES ($1,$3,'Lia',$4,$4,$4,null), ($2,$3,'Bia',$4,$4,$4,null)`, [ag, ag2, dono, SEGREDO]);
  let fila = Promise.resolve();
  const query = (sql, v) => v ? db.query(sql, v) : db.exec(sql);
  const pool = { query, async connect() { const antes = fila; let soltar; fila = new Promise((r) => { soltar = r; }); await antes; return { query, release: soltar }; } };
  const store = createPublicoStore(pool); await store.init(); await store.init();
  return { db, pool, store, dono, outro, ag, ag2 };
}

// Fake model: records what it received; on the 1st call it may request a tool.
function modelo(roteiro = []) {
  const chamadas = [];
  return { chamadas, provider: () => ({ name: 'falso', async complete(input) {
    chamadas.push(structuredClone({ system: input.system, messages: input.messages, tools: input.tools.map((x) => x.name) }));
    const passo = roteiro.shift();
    if (passo) return { stop: 'tool', toolCalls: [{ id: randomUUID(), name: passo.name, args: passo.args }], usage: { in: 1, out: 1 } };
    return { stop: 'end', text: 'resposta ' + chamadas.length, usage: { in: 1, out: 1 } };
  } }) };
}

function atendimento(store, m, extra = {}) {
  const usos = [];
  const a = createAtendimentoPublico({ store, makeProvider: m.provider, recordUsage: async (u, d) => usos.push(d),
    saldo: async () => ({ over: false }), agora: () => 'segunda, 5 de outubro', log: { error() {} }, ...extra });
  return { ...a, usos };
}

test('public turn: nothing from the agent beyond the name, only the contact\'s tools and plugin tools with publico:true', async (t) => {
  const { store, dono, ag } = await montar(t);
  await store.configurar(ag, dono, { ativo: true, instrucoes: 'Atenda clientes da loja.' });
  const plugin = { doTurno: ({ contato, lembrar }) => [
      { name: 'ver_pedido', publico: true, description: 'x', parameters: { type: 'object', properties: {} }, run: async () => { await lembrar('pedido', 'P1'); return 'pedido de ' + contato.endereco; } },
      { name: 'ler_email_do_dono', description: 'x', parameters: { type: 'object', properties: {} }, run: async () => SEGREDO },
      { name: 'consultar_contato', publico: true, description: 'sombra', parameters: { type: 'object', properties: {} }, run: async () => SEGREDO },
    ], vetar: () => null, instrucoes: (nomes) => [...nomes].map((n) => 'instrução ' + n) };
  const m = modelo([{ name: 'ver_pedido', args: {} }, { name: 'consultar_contato', args: {} }]);
  const a = atendimento(store, m, { ferramentas: plugin });
  const r = await a.turno({ agentId: ag, canal: 'whatsapp', endereco: '5511999990000', mensagem: 'cadê meu pedido?' });
  assert.equal(r.text, 'resposta 3');
  const tudo = JSON.stringify(m.chamadas);
  assert.ok(!tudo.includes(SEGREDO), 'agent instructions/profile/summary leaked into the public turn');
  assert.deepEqual(m.chamadas[0].tools.sort(), ['consultar_contato', 'lembrar_do_contato', 'ver_pedido']);
  assert.match(m.chamadas[0].system, /Atenda clientes da loja/);
  assert.match(m.chamadas[0].system, /Lia/);
  assert.ok(m.chamadas[1].messages.some((x) => String(x.content).includes('pedido de 5511999990000')));
  assert.deepEqual(a.usos.map((u) => u.userId), [dono]);
  assert.deepEqual(await store.estado(r.contatoId), { pedido: 'P1' });
});

test('separate contacts: one contact\'s history and notes don\'t reach another, nor across assistants', async (t) => {
  const { store, dono, ag, ag2 } = await montar(t);
  await store.configurar(ag, dono, { ativo: true });
  await store.configurar(ag2, dono, { ativo: true });
  const m = modelo([{ name: 'lembrar_do_contato', args: { chave: 'tamanho', valor: 'M-ANA' } }]);
  const a = atendimento(store, m);
  await a.turno({ agentId: ag, canal: 'whatsapp', endereco: '5511000000001', mensagem: 'sou a ana, CONVERSA-ANA' });
  m.chamadas.length = 0;
  await a.turno({ agentId: ag, canal: 'whatsapp', endereco: '5511000000002', mensagem: 'oi' });
  await a.turno({ agentId: ag2, canal: 'whatsapp', endereco: '5511000000001', mensagem: 'oi' });
  assert.ok(!JSON.stringify(m.chamadas).includes('ANA'));
  // Same contact on the same assistant: brings back its history and its note.
  const m2 = modelo([{ name: 'consultar_contato', args: {} }]);
  await atendimento(store, m2).turno({ agentId: ag, canal: 'whatsapp', endereco: '5511000000001', mensagem: 'lembra de mim?' });
  assert.ok(JSON.stringify(m2.chamadas[0].messages).includes('CONVERSA-ANA'));
  assert.ok(JSON.stringify(m2.chamadas[1].messages).includes('M-ANA'));
});

test('the phone number is not stored in the clear in the database; only the owner turns support on', async (t) => {
  const { db, store, dono, outro, ag } = await montar(t);
  assert.equal(await store.configurar(ag, outro, { ativo: true }), null);
  assert.equal(await store.agente(ag), null);
  await store.configurar(ag, dono, { ativo: true });
  await store.contato(ag, 'whatsapp', '5511987654321');
  const { rows } = await db.query('SELECT * FROM mtr_harness.public_contacts');
  assert.ok(!JSON.stringify(rows).includes('987654321'));
  assert.equal((await store.contato(ag, 'whatsapp', '5511987654321')).endereco, '5511987654321');
  assert.equal((await db.query('SELECT count(*)::int n FROM mtr_harness.public_contacts')).rows[0].n, 1);
  // Turned off by the owner: does not respond at all (the channel follows today's flow).
  await store.configurar(ag, outro, { ativo: false });
  assert.equal((await store.agente(ag)).ativo, true);
  await store.configurar(ag, dono, { ativo: false });
  const m = modelo();
  assert.equal((await atendimento(store, m).turno({ agentId: ag, canal: 'whatsapp', endereco: '1', mensagem: 'oi' })).text, null);
  assert.equal(m.chamadas.length, 0);
});

test('no owner balance: neutral response without calling the model; turns from the same contact go one at a time', async (t) => {
  const { store, dono, ag } = await montar(t);
  await store.configurar(ag, dono, { ativo: true });
  const m = modelo();
  const r = await atendimento(store, m, { saldo: async () => ({ over: true }) }).turno({ agentId: ag, canal: 'whatsapp', endereco: '1', mensagem: 'oi' });
  assert.equal(r.text, RESPOSTA_INDISPONIVEL);
  assert.equal(m.chamadas.length, 0);
  let dentro = 0, max = 0;
  const lento = { name: 'lento', async complete() { dentro++; max = Math.max(max, dentro); await new Promise((ok) => setTimeout(ok, 20)); dentro--; return { stop: 'end', text: 'ok' }; } };
  const a = atendimento(store, { provider: () => lento });
  await Promise.all([1, 2, 3].map((i) => a.turno({ agentId: ag, canal: 'whatsapp', endereco: '7', mensagem: 'msg ' + i })));
  assert.equal(max, 1);
});

test('plugin hooks: script without the model, turn instructions plus the owner\'s, rich and data outputs; a broken hook doesn\'t crash the turn', async (t) => {
  const { store, dono, ag } = await montar(t);
  await store.configurar(ag, dono, { ativo: true, instrucoes: 'do dono' });
  const vistos = [];
  const ganchos = {
    async antesDoModelo(ctx) {
      vistos.push({ primeira: ctx.primeira, endereco: ctx.contato.endereco });
      if (ctx.primeira) { await ctx.lembrar('termos', 'avisado'); return { pular: true, saidas: [{ tipo: 'texto', texto: 'Bem-vinda!' }, { tipo: 'imagem', url: 'http://inseguro/x.jpg' }] }; }
      return { instrucoes: 'roteiro da loja' };
    },
    depoisDoModelo: ({ texto }) => ({ saidas: [{ tipo: 'botao', texto, rotulo: 'Ver', url: 'https://loja.example/p' }, { tipo: 'desconhecido' },
      { tipo: 'data', nome: 'produto', data: { id: 7, tons: ['a'] }, reserva: 'Batom' }, { tipo: 'data', nome: 'grande', data: { x: 'y'.repeat(9000) } }] }),
  };
  const m = modelo();
  const a = atendimento(store, m, { ganchos });
  const r1 = await a.turno({ agentId: ag, canal: 'whatsapp', endereco: '9', mensagem: 'oi' });
  assert.deepEqual(r1.saidas, [{ tipo: 'texto', texto: 'Bem-vinda!' }]);
  assert.equal(r1.text, 'Bem-vinda!'); assert.equal(m.chamadas.length, 0);
  assert.deepEqual(await store.estado(r1.contatoId), { termos: 'avisado' });
  const r2 = await a.turno({ agentId: ag, canal: 'whatsapp', endereco: '9', mensagem: 'tem blusa?' });
  assert.match(m.chamadas[0].system, /roteiro da loja[\s\S]*do dono/);
  assert.deepEqual(m.chamadas[0].messages.slice(0, 2).map((x) => x.content), ['oi', 'Bem-vinda!']);
  assert.deepEqual(r2.saidas, [{ tipo: 'botao', texto: 'resposta 1', rotulo: 'Ver', url: 'https://loja.example/p' },
    { tipo: 'data', nome: 'produto', data: { id: 7, tons: ['a'] }, reserva: 'Batom' }]);
  assert.equal(r2.text, 'resposta 1\n[Ver: https://loja.example/p]\n\nBatom');
  assert.deepEqual(vistos, [{ primeira: true, endereco: '9' }, { primeira: false, endereco: '9' }]);
  const quebrado = atendimento(store, modelo(), { ganchos: { antesDoModelo() { throw Error('x'); }, depoisDoModelo: async () => 'lixo' } });
  const r3 = await quebrado.turno({ agentId: ag, canal: 'whatsapp', endereco: '10', mensagem: 'oi' });
  assert.equal(r3.text, 'resposta 1'); assert.equal(r3.saidas, undefined);
});

test('a button label is cut at the limit of the channel it goes out on: 20 on WhatsApp, more on the web', async (t) => {
  const { store, dono, ag } = await montar(t);
  await store.configurar(ag, dono, { ativo: true });
  const rotulo = 'Start the skin analysis';
  const a = atendimento(store, modelo(), { ganchos: { depoisDoModelo: ({ texto }) => ({ saidas: [{ tipo: 'botao', texto, rotulo, url: 'https://loja.example/p' }] }) } });
  const turno = async (canal) => (await a.turno({ agentId: ag, canal, endereco: '9', mensagem: 'oi' })).saidas[0].rotulo;
  assert.equal(await turno('whatsapp'), 'Start the skin analy');
  assert.equal(await turno('web'), rotulo);
});

// A message can try to talk the assistant into sending people to another site.
test('sites the assistant may send people to: other sites\' buttons and addresses leave the answer', async (t) => {
  const { store, dono, ag } = await montar(t);
  await store.configurar(ag, dono, { ativo: true, linkSites: ['shop.example'] });
  const respostas = ['See https://evil.example/promo or talk to us at https://help.shop.example/chat',
    'https://evil.example',
    'Write to refund@evil.example or help@shop.example, or go to EVIL.EXAMPLE. The manual.pdf has the sizes.',
    'All set.'];
  const m = { provider: () => ({ name: 'falso', async complete() { return { stop: 'end', text: respostas.shift(), usage: { in: 1, out: 1 } }; } }) };
  const a = atendimento(store, m);
  const turno = (mensagem) => a.turno({ agentId: ag, canal: 'whatsapp', endereco: '9', mensagem });
  assert.equal((await turno('hi')).text, 'See or talk to us at https://help.shop.example/chat');
  assert.equal((await turno('link?')).text, RESPOSTA_INDISPONIVEL);
  assert.equal((await turno('refund?')).text, 'Write to or help@shop.example, or go to. The manual.pdf has the sizes.');
  const comBotoes = atendimento(store, modelo(), { ganchos: { depoisDoModelo: ({ texto }) => ({ saidas: [
    { tipo: 'botao', texto, rotulo: 'Pay', url: 'https://evil.example/pix' },
    { tipo: 'botao', texto: 'This one', rotulo: 'See', url: 'https://www.shop.example/p' },
    { tipo: 'imagem', url: 'https://cdn.example/a.jpg', legenda: 'More at evil.example' }] }) } });
  const r = await comBotoes.turno({ agentId: ag, canal: 'whatsapp', endereco: '9', mensagem: 'I want it' });
  assert.deepEqual(r.saidas, [{ tipo: 'texto', texto: 'resposta 1' },
    { tipo: 'botao', texto: 'This one', rotulo: 'See', url: 'https://www.shop.example/p' },
    { tipo: 'imagem', url: 'https://cdn.example/a.jpg', legenda: 'More at' }]);
  await store.configurar(ag, dono, { linkSites: [] });
  assert.equal((await turno('and now?')).text, 'All set.');
});

test('stop, resume and delete my data: resolved before the model', async (t) => {
  const { db, store, dono, ag } = await montar(t);
  await store.configurar(ag, dono, { ativo: true });
  const m = modelo([{ name: 'lembrar_do_contato', args: { chave: 'nome', valor: 'Ana' } }]);
  const a = atendimento(store, m);
  const fala = (mensagem, endereco = '5511000000009') => a.turno({ agentId: ag, canal: 'whatsapp', endereco, mensagem });
  await fala('oi, sou a Ana');
  assert.equal((await fala('quero parar de receber promoção')).motivo, undefined);
  const chamadas = m.chamadas.length;
  assert.equal((await fala('  Parar! ')).text, RESPOSTA_PARADO);
  assert.equal((await fala('oi?')).text, null);
  assert.equal(m.chamadas.length, chamadas, 'a stopped contact cannot reach the model');
  assert.equal((await fala('voltar')).text, RESPOSTA_VOLTOU);
  assert.match((await fala('tudo bem?')).text, /^resposta/);
  // Delete: contact, messages and notes disappear; whoever comes back starts from zero.
  await fala('5511000000008', '5511000000008');
  assert.equal((await fala('Apagar meus dados.')).text, RESPOSTA_APAGADO);
  const conta = async (tab) => (await db.query(`SELECT count(*)::int n FROM mtr_harness.${tab}`)).rows[0].n;
  assert.deepEqual([await conta('public_contacts'), await conta('public_contact_state')], [1, 0]);
  m.chamadas.length = 0;
  await fala('oi de novo');
  assert.ok(!JSON.stringify(m.chamadas).includes('Ana'));
});

test('per-contact and per-assistant hourly limits and the assistant\'s daily cap', async (t) => {
  const { db, store, dono, ag } = await montar(t);
  await store.configurar(ag, dono, { ativo: true, limitePorHora: 2 });
  const m = modelo();
  const a = atendimento(store, m);
  const fala = (mensagem, endereco = '1') => a.turno({ agentId: ag, canal: 'whatsapp', endereco, mensagem });
  for (const x of ['a', 'b']) await fala(x);
  assert.equal((await fala('c')).text, RESPOSTA_LIMITE);
  assert.equal((await fala('d')).text, null, 'one warning per hour, then silence');
  assert.equal(m.chamadas.length, 2);
  assert.match((await fala('oi', '2')).text, /^resposta/, 'the limit is per contact');
  // All contacts together: a new contact is refused without reaching the model or being recorded.
  await store.configurar(ag, dono, { agentHourlyLimit: 3 });
  const cheio = await fala('oi', '9');
  assert.deepEqual([cheio.text, cheio.motivo, m.chamadas.length], [RESPOSTA_INDISPONIVEL, 'agent_hourly_limit', 3]);
  assert.deepEqual(await store.historico(cheio.contatoId), []);
  await store.configurar(ag, dono, { agentHourlyLimit: 1000 });
  // Cap: only counts the cost of this assistant's public support, from today.
  await store.configurar(ag, dono, { tetoDiarioUsd: 0.5, limitePorHora: 10 });
  await db.query(`INSERT INTO mtr_harness.usage_events (agent_id, kind, cost_usd, ts) VALUES
    ($1, 'chat', 9, now()), ($1, 'publico', 9, now() - interval '2 days'), ($1, 'publico', 0.4, now())`, [ag]);
  assert.match((await fala('oi', '3')).text, /^resposta/);
  await db.query(`INSERT INTO mtr_harness.usage_events (agent_id, kind, cost_usd) VALUES ($1, 'publico', 0.1)`, [ag]);
  const r = await fala('oi', '3');
  assert.deepEqual([r.text, r.motivo], [RESPOSTA_INDISPONIVEL, 'teto_diario']);
  // Empty cap = the default US$10.
  assert.equal((await store.configurar(ag, dono, { tetoDiarioUsd: null })).teto_diario_usd, 10);
  assert.match((await fala('oi', '3')).text, /^resposta/);
  await db.query(`INSERT INTO mtr_harness.usage_events (agent_id, kind, cost_usd) VALUES ($1, 'publico', 9.5)`, [ag]);
  assert.equal((await fala('oi', '3')).motivo, 'teto_diario');
});

test('retention deletes what is past the deadline; export returns everything for the contact', async (t) => {
  const { db, store, dono, ag } = await montar(t);
  await store.configurar(ag, dono, { ativo: true, retencaoDias: 30 });
  const a = atendimento(store, modelo([{ name: 'lembrar_do_contato', args: { chave: 'tamanho', valor: 'M' } }]));
  const r1 = await a.turno({ agentId: ag, canal: 'whatsapp', endereco: '5511000000001', mensagem: 'antiga' });
  await a.turno({ agentId: ag, canal: 'whatsapp', endereco: '5511000000001', mensagem: 'nova' });
  await a.turno({ agentId: ag, canal: 'whatsapp', endereco: '5511000000002', mensagem: 'sumido' });
  const exp = await store.exportar(r1.contatoId);
  assert.equal(exp.contato.endereco, '5511000000001');
  assert.deepEqual(exp.anotacoes.map((x) => x.valor), ['M']);
  assert.deepEqual(exp.mensagens.filter((x) => x.role === 'user').map((x) => x.content), ['antiga', 'nova']);
  await db.query(`UPDATE mtr_harness.public_messages SET criado_em = now() - interval '31 days' WHERE content = 'antiga'`);
  await db.query(`UPDATE mtr_harness.public_contact_state SET atualizado_em = now() - interval '31 days'`);
  const sumido = await store.contato(ag, 'whatsapp', '5511000000002');
  await db.query(`UPDATE mtr_harness.public_contacts SET ultima_em = now() - interval '31 days' WHERE id = $1`, [sumido.id]);
  assert.deepEqual(await store.limparVencidos(), { contatos: 1, mensagens: 1, anotacoes: 1 });
  assert.equal(await store.exportar(sumido.id), null);
  const depois = await store.exportar(r1.contatoId);
  assert.deepEqual(depois.mensagens.filter((x) => x.role === 'user').map((x) => x.content), ['nova']);
  assert.deepEqual(depois.anotacoes, []);
});

test('blocked by the owner: silence without recording anything; deleting my data clears the conversation but the block stays', async (t) => {
  const { db, store, dono, ag } = await montar(t);
  await store.configurar(ag, dono, { ativo: true, retencaoDias: 30 });
  const m = modelo([{ name: 'lembrar_do_contato', args: { chave: 'nome', valor: 'Ana' } }]);
  const a = atendimento(store, m);
  const fala = (mensagem) => a.turno({ agentId: ag, canal: 'whatsapp', endereco: '5511000000007', mensagem });
  const { contatoId } = await fala('oi');
  const conta = async (tab) => (await db.query(`SELECT count(*)::int n FROM mtr_harness.${tab}`)).rows[0].n;
  const antes = [await conta('public_messages'), m.chamadas.length];
  await store.bloquear(contatoId, true);
  for (const x of ['oi?', 'parar', 'voltar']) assert.deepEqual([(await fala(x)).text, (await fala(x)).motivo], [null, 'bloqueado']);
  assert.deepEqual([await conta('public_messages'), m.chamadas.length], antes);
  await fala('apagar meus dados');
  assert.deepEqual([await conta('public_messages'), await conta('public_contact_state')], [0, 0]);
  assert.ok((await store.exportar(contatoId)).contato.bloqueadoEm);
  // Retention also doesn't carry the blocked contact (it would carry the block along).
  await db.query(`UPDATE mtr_harness.public_contacts SET ultima_em = now() - interval '31 days'`);
  assert.equal((await store.limparVencidos()).contatos, 0);
  await store.bloquear(contatoId, false);
  assert.match((await fala('oi de novo')).text, /^resposta/);
});

test('a turn that fails reaches only its caller: no unhandled rejection, the next turn runs', async (t) => {
  const { store, dono, ag } = await montar(t);
  await store.configurar(ag, dono, { ativo: true });
  const unhandled = []; const record = (e) => unhandled.push(e);
  process.on('unhandledRejection', record); t.after(() => process.off('unhandledRejection', record));
  const real = store.contato; let failing = true;
  store.contato = (...x) => (failing ? Promise.reject(Error('database down')) : real(...x));
  const a = atendimento(store, modelo());
  const send = () => a.turno({ agentId: ag, canal: 'whatsapp', endereco: '5511000000008', mensagem: 'hi' });
  await assert.rejects(send(), /database down/);
  failing = false;
  assert.match((await send()).text, /^resposta/);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(unhandled, []);
});

// A tela do dono: toda leitura confere o dono no SQL, e id de outra conta = 404.
test('owner view: only their own assistants, contacts and conversations', async (t) => {
  const { db, pool, store, dono, outro, ag, ag2 } = await montar(t);
  await store.configurar(ag, dono, { ativo: true });
  const a = atendimento(store, modelo());
  const { contatoId } = await a.turno({ agentId: ag, canal: 'whatsapp', endereco: '5511000000005', mensagem: 'quero trocar' });
  await a.turno({ agentId: ag, canal: 'whatsapp', endereco: '5511000000005', mensagem: 'tamanho G' });
  const rotas = createRotas();
  const send = (res, status, corpo, headers = {}) => Object.assign(res, { status, corpo, headers });
  registrarRotasDoDono({ rotas, store, webStore: createPublicWebStore(pool), send, fail: (res, st, msg, e) => { throw e; }, tooManyRequests: () => false, agenteDoNumero: () => ag });
  const pede = async (quem, metodo, caminho, corpo) => {
    const req = Readable.from(corpo ? [JSON.stringify(corpo)] : []); req.method = metodo;
    const res = { setHeader() {} };
    await rotas.atender(req, res, new URL('http://x' + caminho), { currentUser: async () => quem && { id: quem } });
    return res;
  };
  assert.equal((await pede(null, 'GET', '/api/publico/agentes')).status, 401);
  const lista = (await pede(dono, 'GET', '/api/publico/agentes')).corpo.agentes;
  assert.deepEqual(lista.map((x) => [x.nome, x.ativo, x.contatos, x.doNumero]), [['Bia', false, 0, false], ['Lia', true, 1, true]]);
  const contatos = (await pede(dono, 'GET', `/api/publico/contatos?agente=${ag}`)).corpo.contatos;
  assert.deepEqual(contatos.map((c) => [c.endereco, c.mensagens]), [['5511000000005', 4]]);
  const conversa = (await pede(dono, 'GET', `/api/publico/conversa?contato=${contatoId}`)).corpo.mensagens;
  assert.deepEqual(conversa.filter((x) => x.role === 'user').map((x) => x.content), ['quero trocar', 'tamanho G']);
  const pagina = await store.conversaDoDono(dono, contatoId, { antes: conversa.at(-1).id, limite: 2 });
  assert.deepEqual(pagina.map((x) => x.id), conversa.slice(1, 3).map((x) => x.id));
  // Outra conta: nada aparece e nada muda.
  await db.query(`INSERT INTO mtr_harness.agents VALUES ($1,$2,'Zé',null,null,null,null)`, [randomUUID(), outro]);
  assert.deepEqual((await pede(outro, 'GET', '/api/publico/agentes')).corpo.agentes.map((x) => x.nome), ['Zé']);
  assert.deepEqual((await pede(outro, 'GET', `/api/publico/contatos?agente=${ag}`)).corpo.contatos, []);
  for (const [metodo, caminho, corpo] of [['GET', `/api/publico/conversa?contato=${contatoId}`], ['GET', `/api/publico/exportar?contato=${contatoId}`],
    ['POST', '/api/publico/bloquear', { contatoId, bloqueado: true }], ['POST', '/api/publico/apagar', { contatoId }],
    ['POST', '/api/publico/configurar', { agentId: ag, ativo: false }], ['POST', '/api/publico/configurar', { agentId: ag2, ativo: true }],
    ['POST', '/api/publico/web-key', { agentId: ag }]]) {
    assert.equal((await pede(outro, metodo, caminho, corpo)).status, 404, `${metodo} ${caminho}`);
  }
  assert.equal((await store.agente(ag)).ativo, true);
  assert.equal(await store.agente(ag2), null);
  assert.equal((await store.exportar(contatoId)).contato.bloqueadoEm, null);
  // Configuration: value outside the range is not saved; empty cap = the default cap.
  assert.equal((await pede(dono, 'POST', '/api/publico/configurar', { agentId: ag, retencaoDias: 0 })).status, 400);
  assert.equal((await pede(dono, 'POST', '/api/publico/configurar', { agentId: ag, tetoDiarioUsd: -1 })).status, 400);
  assert.equal((await pede(dono, 'POST', '/api/publico/configurar', { agentId: ag, agentHourlyLimit: 0 })).status, 400);
  assert.equal((await pede(dono, 'POST', '/api/publico/configurar', { agentId: ag, ativo: 'sim' })).status, 400);
  for (const webOrigins of [['http://shop.example.com'], ['https://shop.example.com/chat'], ['https://user:pw@shop.example.com']]) {
    assert.equal((await pede(dono, 'POST', '/api/publico/configurar', { agentId: ag, webOrigins })).status, 400, webOrigins[0]);
  }
  for (const webKeyIps of [['shop.example.com'], ['203.0.113.0/0'], ['10.0.0.1/33']]) {
    assert.equal((await pede(dono, 'POST', '/api/publico/configurar', { agentId: ag, webKeyIps })).status, 400, webKeyIps[0]);
  }
  for (const linkSites of [['shop.example/p'], ['198.51.100.1'], ['localhost'], 'shop.example', Array(21).fill('shop.example')]) {
    assert.equal((await pede(dono, 'POST', '/api/publico/configurar', { agentId: ag, linkSites })).status, 400, String(linkSites[0]));
  }
  const ok = (await pede(dono, 'POST', '/api/publico/configurar', { agentId: ag2, ativo: true, limitePorHora: 5, tetoDiarioUsd: null,
    agentHourlyLimit: 500, webKeyIps: ['203.0.113.7', '::ffff:198.51.100.1'], linkSites: ['https://Shop.Example/', 'shop.example'] })).corpo;
  assert.deepEqual([ok.ativo, ok.limitePorHora, ok.tetoDiarioUsd, ok.agentHourlyLimit, ok.webKeyIps, ok.linkSites],
    [true, 5, 10, 500, ['203.0.113.7', '198.51.100.1'], ['shop.example']]);
  const exp = await pede(dono, 'GET', `/api/publico/exportar?contato=${contatoId}`);
  assert.match(exp.headers['content-disposition'], /attachment/);
  assert.equal((await pede(dono, 'POST', '/api/publico/apagar', { contatoId })).status, 200);
  assert.equal(await store.exportar(contatoId), null);
});

// Website and API channel: who may call, and which contact each call reaches.
test('public web channel: listed origins only, signed contact, key for servers, no reading another contact, page events', async (t) => {
  const { pool, store, dono, ag, ag2 } = await montar(t);
  const webStore = createPublicWebStore(pool);
  const m = modelo(), eventos = [];
  const a = atendimento(store, m, { ganchos: { antesDoModelo: (ctx) => { eventos.push(ctx.event); } } });
  const rotas = createRotas();
  const send = (res, status, corpo) => Object.assign(res, { status, corpo });
  registerPublicWebRoutes({ rotas, webStore, turno: a.turno, send, fail: (res, st, msg, e) => { throw e; }, tooManyRequests: () => false,
    clientIp: (req) => req.headers['x-ip'] });
  const pede = async (metodo, caminho, { corpo, headers = {} } = {}) => {
    const req = Readable.from(corpo ? [Buffer.from(JSON.stringify(corpo))] : []); req.method = metodo; req.headers = headers;
    const res = { cabecalhos: {}, setHeader(k, v) { this.cabecalhos[k] = v; }, writeHead(st, h) { Object.assign(this, { status: st }); Object.assign(this.cabecalhos, h); }, end() {} };
    await rotas.atender(req, res, new URL('http://x' + caminho), {});
    return res;
  };
  const SITE = { origin: 'https://shop.example.com' };
  const msgs = (ag) => `/api/public/messages?agent=${ag}`;
  // Off (not configured, public mode off, web off) answers like an unknown agent.
  assert.equal((await pede('POST', msgs(ag), { corpo: { message: 'hi' }, headers: SITE })).status, 404);
  await store.configurar(ag, dono, { ativo: true });
  assert.equal((await pede('POST', msgs(ag), { corpo: { message: 'hi' }, headers: SITE })).status, 404);
  await webStore.configure(ag, dono, { enabled: true, origins: [SITE.origin] });
  assert.equal((await pede('POST', msgs(ag2), { corpo: { message: 'hi' }, headers: SITE })).status, 404);
  // Browser: only from a listed origin, and the preflight only opens to it.
  assert.equal((await pede('POST', msgs(ag), { corpo: { message: 'hi' }, headers: { origin: 'https://evil.example.com' } })).status, 403);
  assert.equal((await pede('POST', msgs(ag), { corpo: { message: 'hi' } })).status, 403);
  assert.equal((await pede('OPTIONS', msgs(ag), { headers: { origin: 'https://evil.example.com' } })).cabecalhos['Access-Control-Allow-Origin'], undefined);
  assert.equal((await pede('OPTIONS', msgs(ag), { headers: SITE })).cabecalhos['Access-Control-Allow-Origin'], SITE.origin);
  const r1 = await pede('POST', msgs(ag), { corpo: { message: 'my order is 123' }, headers: SITE });
  assert.equal(r1.status, 200);
  assert.equal(r1.cabecalhos['Access-Control-Allow-Origin'], SITE.origin);
  assert.ok(contactFromToken(r1.corpo.contact));
  assert.match(r1.corpo.text, /^resposta/);
  const r2 = await pede('POST', msgs(ag), { corpo: { message: 'hi, someone else' }, headers: SITE });
  assert.notEqual(r2.corpo.contact, r1.corpo.contact);
  // A token that was not issued here (or was altered) does not name a contact.
  const [id] = r1.corpo.contact.split('.');
  for (const contact of [id + '.' + 'A'.repeat(22), r1.corpo.contact.slice(0, -1) + (r1.corpo.contact.endsWith('A') ? 'B' : 'A'), 'anything']) {
    assert.equal((await pede('POST', msgs(ag), { corpo: { message: 'hi', contact }, headers: SITE })).status, 400, contact);
  }
  // History: only the caller's own conversation.
  const h1 = (await pede('GET', msgs(ag), { headers: { ...SITE, 'brambit-contact': r1.corpo.contact } })).corpo.messages;
  assert.deepEqual(h1.filter((m) => m.role === 'user').map((m) => m.text), ['my order is 123']);
  assert.equal((await pede('GET', msgs(ag), { headers: SITE })).status, 400);
  // Not from the address, which ends up in proxy logs.
  assert.equal((await pede('GET', `${msgs(ag)}&contact=${encodeURIComponent(r1.corpo.contact)}`, { headers: SITE })).status, 400);
  // Server: needs the current key; its contacts never meet the browser's.
  const api = (key, corpo) => pede('POST', msgs(ag), { corpo, headers: { authorization: 'Bearer ' + key } });
  assert.equal((await api('bpk_wrong', { message: 'hi', contact: 'c1' })).status, 401);
  const k1 = await webStore.newKey(ag, dono);
  assert.equal(await webStore.newKey(ag, randomUUID()), null);
  assert.equal((await api(k1, { message: 'hi' })).status, 400);
  assert.equal((await api(k1, { message: 'hi from the server', contact: id })).status, 200);
  const k2 = await webStore.newKey(ag, dono);
  assert.equal((await api(k1, { message: 'hi', contact: id })).status, 401);
  assert.equal((await api(k2, { message: 'again', contact: id })).status, 200);
  const hApi = (await pede('GET', msgs(ag), { headers: { authorization: 'Bearer ' + k2, 'brambit-contact': id } })).corpo.messages;
  assert.deepEqual(hApi.filter((m) => m.role === 'user').map((m) => m.text), ['hi from the server', 'again']);
  assert.equal((await pede('GET', msgs(ag), { headers: { ...SITE, 'brambit-contact': r1.corpo.contact } })).corpo.messages.length, 2);
  // Key locked to the owner's servers: from elsewhere even the right key is refused; browsers are not affected.
  await webStore.configure(ag, dono, { keyIps: ['203.0.113.0/24', '2001:db8::7'] });
  const apiFrom = (ip) => pede('POST', msgs(ag), { corpo: { message: 'hi', contact: id }, headers: { authorization: 'Bearer ' + k2, 'x-ip': ip } });
  assert.deepEqual([(await apiFrom('198.51.100.9')).status, (await apiFrom(undefined)).status], [403, 403]);
  for (const ip of ['203.0.113.50', '::ffff:203.0.113.50', '2001:DB8::7']) assert.equal((await apiFrom(ip)).status, 200, ip);
  // A page event takes the place of the message: the hook and the model get it, the history marks it.
  const ev = await pede('POST', msgs(ag), { corpo: { event: { type: 'color_picked', data: { sku: 'A1' } }, contact: r1.corpo.contact }, headers: SITE });
  assert.equal(ev.status, 200);
  assert.deepEqual(eventos.at(-1), { type: 'color_picked', data: { sku: 'A1' } });
  assert.equal(m.chamadas.at(-1).messages.at(-1).content, '[event: color_picked] {"sku":"A1"}');
  for (const corpo of [{ event: { type: 'Not valid' } }, { event: { type: 'ok', data: 'x' } }, { event: { type: 'ok', data: { x: 'y'.repeat(3000) } } }, { message: 'hi', event: { type: 'ok' } }]) {
    assert.equal((await pede('POST', msgs(ag), { corpo: { ...corpo, contact: r1.corpo.contact }, headers: SITE })).status, 400, JSON.stringify(corpo).slice(0, 60));
  }
  const h2 = (await pede('GET', msgs(ag), { headers: { ...SITE, 'brambit-contact': r1.corpo.contact } })).corpo.messages;
  assert.deepEqual(h2.map((x) => x.event ?? null), [null, null, { type: 'color_picked', data: { sku: 'A1' } }, null]);
  // Oversized body is refused before it reaches the turn.
  assert.equal((await pede('POST', msgs(ag), { corpo: { message: 'x'.repeat(70 * 1024) }, headers: SITE })).status, 413);
});

// A photo from a server reaches the model with the message and is never stored; from a
// browser (no key) or in a format the model can't read, the call is refused.
test('public web channel: a server may send one photo with the message; it reaches the model and is not stored', async (t) => {
  const { pool, store, dono, ag } = await montar(t);
  const webStore = createPublicWebStore(pool);
  const m = modelo();
  const a = atendimento(store, m);
  const rotas = createRotas();
  registerPublicWebRoutes({ rotas, webStore, turno: a.turno, send: (res, status, corpo) => Object.assign(res, { status, corpo }),
    fail: (res, st, msg, e) => { throw e; }, tooManyRequests: () => false });
  const pede = async (corpo, headers) => {
    const req = Readable.from([Buffer.from(JSON.stringify(corpo))]); req.method = 'POST'; req.headers = headers;
    const res = { setHeader() {}, writeHead(st) { this.status = st; }, end() {} };
    await rotas.atender(req, res, new URL(`http://x/api/public/messages?agent=${ag}`), {});
    return res;
  };
  await store.configurar(ag, dono, { ativo: true });
  await webStore.configure(ag, dono, { enabled: true, origins: ['https://shop.example.com'] });
  const key = { authorization: 'Bearer ' + await webStore.newKey(ag, dono) };
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), randomBytes(64)]).toString('base64');
  // The bytes decide the type: a PNG declared as JPEG goes to the model as PNG.
  const r = await pede({ message: 'what do you see?', contact: 'c1', image: `data:image/jpeg;base64,${png}` }, key);
  assert.equal(r.status, 200);
  assert.deepEqual(m.chamadas.at(-1).messages.at(-1).images, [{ mimeType: 'image/png', data: png }]);
  assert.ok(!JSON.stringify(await webStore.history(ag, 'api:c1')).includes(png.slice(0, 40)), 'the photo was stored');
  // The next turn's history has the text only.
  await pede({ message: 'and now?', contact: 'c1' }, key);
  assert.deepEqual(m.chamadas.at(-1).messages.flatMap((x) => x.images || []), []);
  const chamadas = m.chamadas.length;
  const recusa = async (corpo, headers = key) => { const x = await pede({ contact: 'c1', ...corpo }, headers); return [x.status, x.corpo.error]; };
  assert.deepEqual(await recusa({ message: 'hi', image: png, contact: undefined }, { origin: 'https://shop.example.com' }), [400, 'image_needs_key']);
  assert.deepEqual(await recusa({ event: { type: 'photo_taken' }, image: png }), [400, 'image_needs_message']);
  assert.deepEqual(await recusa({ message: 'hi', image: Buffer.from('%PDF-1.7 not a photo').toString('base64') }), [400, 'invalid_image']);
  assert.deepEqual(await recusa({ message: 'hi', image: 'not base64!' }), [400, 'invalid_image']);
  assert.deepEqual(await recusa({ message: 'hi', image: Buffer.alloc(1024 * 1024 + 1, 0xFF).toString('base64') }), [413, 'image_too_large']);
  // The larger cap is for the photo only: the rest of a call with a key keeps the 64 KB.
  assert.deepEqual(await recusa({ message: 'x'.repeat(70 * 1024), image: png }), [413, 'body_too_large']);
  assert.equal(m.chamadas.length, chamadas, 'a refused call reached the model');
});

// With the core's sign-up rule, open sign-up keeps public support off on WhatsApp and on the
// website, and the owner's screen says why; closing sign-up turns it back on, no restart.
test('open sign-up keeps public support off on every channel until it is closed', async (t) => {
  const { pool, store, dono, ag } = await montar(t);
  await store.configurar(ag, dono, { ativo: true });
  await createPublicWebStore(pool).configure(ag, dono, { enabled: true, origins: ['https://shop.example.com'] });
  let open = true;
  const rotas = createRotas(), avisos = [];
  const s = criarAtendimentoDoServidor({ pool, makeProvider: modelo().provider, recordUsages: async () => {}, creditStatus: async () => ({ over: false }),
    agenteDoNumero: () => ag, limpezaMs: 0, log: { warn: (m) => avisos.push(m), error() {}, log() {} }, signupOpen: async () => open,
    rotas, send: (res, status, corpo) => Object.assign(res, { status, corpo }), fail: (res, st, msg, e) => { throw e; }, tooManyRequests: () => false });
  const pede = async (metodo, caminho, corpo, headers = {}) => {
    const req = Readable.from(corpo ? [Buffer.from(JSON.stringify(corpo))] : []); req.method = metodo; req.headers = headers;
    const res = { setHeader() {} };
    await rotas.atender(req, res, new URL('http://x' + caminho), { currentUser: async () => ({ id: dono }) });
    return res;
  };
  const estado = async () => [await s.whatsapp.atende(),
    (await pede('POST', `/api/public/messages?agent=${ag}`, { message: 'hi' }, { origin: 'https://shop.example.com' })).status,
    (await pede('GET', '/api/publico/agentes')).corpo.signupOpen];
  assert.deepEqual(await estado(), [false, 404, true]);
  assert.equal(avisos.length, 1);
  open = false;
  assert.deepEqual(await estado(), [true, 200, false]);
});

// Isolation is by construction: the module must not start importing whatever reads
// the owner's data (memory, connectors, channels, routines). A new import here = review it.
test('public-support.mjs only imports the tool loop, the vault, the health rule, the outputs and the locale rules', () => {
  const src = fs.readFileSync(new URL('../web/public-support.mjs', import.meta.url), 'utf8');
  const imports = [...src.matchAll(/^\s*import[^'"]*['"]([^'"]+)['"]/gm)].map((x) => x[1]).sort();
  assert.deepEqual(imports, ['../core-proto/core.mjs', './health-guardrail.mjs', './locale.mjs', './public-support-outputs.mjs', './vault.mjs']);
});
