// Atendimento ao público: o turno de quem não é o dono não alcança nada do dono
// e um contato não alcança o de outro. Banco real (PGlite) e o tool-loop real do
// núcleo; só o modelo é falso, e ele grava tudo o que recebeu.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomUUID, randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { PGlite } from '@electric-sql/pglite';

process.env.VAULT_KEY = randomBytes(32).toString('base64');
const { createPublicoStore, createAtendimentoPublico, RESPOSTA_INDISPONIVEL, RESPOSTA_PARADO, RESPOSTA_VOLTOU, RESPOSTA_APAGADO, RESPOSTA_LIMITE } = await import('./web/publico.mjs');
const { registrarRotasDoDono } = await import('./web/publico-dono.mjs');
const { createRotas } = await import('./web/rotas.mjs');

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
  return { db, store, dono, outro, ag, ag2 };
}

// Modelo falso: grava o que recebeu; na 1ª chamada pode pedir uma tool.
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

test('turno público: nada do agente além do nome, só tools do contato e de plugin publico:true', async (t) => {
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
  assert.ok(!tudo.includes(SEGREDO), 'instruções/perfil/resumo do agente vazaram pro turno público');
  assert.deepEqual(m.chamadas[0].tools.sort(), ['consultar_contato', 'lembrar_do_contato', 'ver_pedido']);
  assert.match(m.chamadas[0].system, /Atenda clientes da loja/);
  assert.match(m.chamadas[0].system, /Lia/);
  assert.ok(m.chamadas[1].messages.some((x) => String(x.content).includes('pedido de 5511999990000')));
  assert.deepEqual(a.usos.map((u) => u.userId), [dono]);
  assert.deepEqual(await store.estado(r.contatoId), { pedido: 'P1' });
});

test('contatos separados: histórico e anotações de um não chegam ao outro, nem entre assistentes', async (t) => {
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
  // Mesmo contato no mesmo assistente: volta o histórico e a anotação dele.
  const m2 = modelo([{ name: 'consultar_contato', args: {} }]);
  await atendimento(store, m2).turno({ agentId: ag, canal: 'whatsapp', endereco: '5511000000001', mensagem: 'lembra de mim?' });
  assert.ok(JSON.stringify(m2.chamadas[0].messages).includes('CONVERSA-ANA'));
  assert.ok(JSON.stringify(m2.chamadas[1].messages).includes('M-ANA'));
});

test('telefone não fica em claro no banco; só o dono liga o atendimento', async (t) => {
  const { db, store, dono, outro, ag } = await montar(t);
  assert.equal(await store.configurar(ag, outro, { ativo: true }), null);
  assert.equal(await store.agente(ag), null);
  await store.configurar(ag, dono, { ativo: true });
  await store.contato(ag, 'whatsapp', '5511987654321');
  const { rows } = await db.query('SELECT * FROM mtr_harness.public_contacts');
  assert.ok(!JSON.stringify(rows).includes('987654321'));
  assert.equal((await store.contato(ag, 'whatsapp', '5511987654321')).endereco, '5511987654321');
  assert.equal((await db.query('SELECT count(*)::int n FROM mtr_harness.public_contacts')).rows[0].n, 1);
  // Desligado pelo dono: não responde nada (o canal segue o fluxo de hoje).
  await store.configurar(ag, outro, { ativo: false });
  assert.equal((await store.agente(ag)).ativo, true);
  await store.configurar(ag, dono, { ativo: false });
  const m = modelo();
  assert.equal((await atendimento(store, m).turno({ agentId: ag, canal: 'whatsapp', endereco: '1', mensagem: 'oi' })).text, null);
  assert.equal(m.chamadas.length, 0);
});

test('sem saldo do dono: resposta neutra sem chamar o modelo; turnos do mesmo contato um de cada vez', async (t) => {
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

test('ganchos do plugin: roteiro sem modelo, instruções do turno, saídas ricas; gancho quebrado não derruba', async (t) => {
  const { store, dono, ag } = await montar(t);
  await store.configurar(ag, dono, { ativo: true, instrucoes: 'do dono' });
  const vistos = [];
  const ganchos = {
    async antesDoModelo(ctx) {
      vistos.push({ primeira: ctx.primeira, endereco: ctx.contato.endereco });
      if (ctx.primeira) { await ctx.lembrar('termos', 'avisado'); return { pular: true, saidas: [{ tipo: 'texto', texto: 'Bem-vinda!' }, { tipo: 'imagem', url: 'http://inseguro/x.jpg' }] }; }
      return { instrucoes: 'roteiro da loja' };
    },
    depoisDoModelo: ({ texto }) => ({ saidas: [{ tipo: 'botao', texto, rotulo: 'Ver', url: 'https://loja.example/p' }, { tipo: 'desconhecido' }] }),
  };
  const m = modelo();
  const a = atendimento(store, m, { ganchos });
  const r1 = await a.turno({ agentId: ag, canal: 'whatsapp', endereco: '9', mensagem: 'oi' });
  assert.deepEqual(r1.saidas, [{ tipo: 'texto', texto: 'Bem-vinda!' }]);
  assert.equal(r1.text, 'Bem-vinda!'); assert.equal(m.chamadas.length, 0);
  assert.deepEqual(await store.estado(r1.contatoId), { termos: 'avisado' });
  const r2 = await a.turno({ agentId: ag, canal: 'whatsapp', endereco: '9', mensagem: 'tem blusa?' });
  assert.match(m.chamadas[0].system, /roteiro da loja/); assert.doesNotMatch(m.chamadas[0].system, /do dono/);
  assert.deepEqual(m.chamadas[0].messages.slice(0, 2).map((x) => x.content), ['oi', 'Bem-vinda!']);
  assert.deepEqual(r2.saidas, [{ tipo: 'botao', texto: 'resposta 1', rotulo: 'Ver', url: 'https://loja.example/p' }]);
  assert.deepEqual(vistos, [{ primeira: true, endereco: '9' }, { primeira: false, endereco: '9' }]);
  const quebrado = atendimento(store, modelo(), { ganchos: { antesDoModelo() { throw Error('x'); }, depoisDoModelo: async () => 'lixo' } });
  const r3 = await quebrado.turno({ agentId: ag, canal: 'whatsapp', endereco: '10', mensagem: 'oi' });
  assert.equal(r3.text, 'resposta 1'); assert.equal(r3.saidas, undefined);
});

test('parar, voltar e apagar meus dados: resolvidos antes do modelo', async (t) => {
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
  assert.equal(m.chamadas.length, chamadas, 'contato parado não pode chegar ao modelo');
  assert.equal((await fala('voltar')).text, RESPOSTA_VOLTOU);
  assert.match((await fala('tudo bem?')).text, /^resposta/);
  // Apagar: some contato, mensagens e anotações; quem volta começa do zero.
  await fala('5511000000008', '5511000000008');
  assert.equal((await fala('Apagar meus dados.')).text, RESPOSTA_APAGADO);
  const conta = async (tab) => (await db.query(`SELECT count(*)::int n FROM mtr_harness.${tab}`)).rows[0].n;
  assert.deepEqual([await conta('public_contacts'), await conta('public_contact_state')], [1, 0]);
  m.chamadas.length = 0;
  await fala('oi de novo');
  assert.ok(!JSON.stringify(m.chamadas).includes('Ana'));
});

test('limite por hora do contato e teto diário do assistente', async (t) => {
  const { db, store, dono, ag } = await montar(t);
  await store.configurar(ag, dono, { ativo: true, limitePorHora: 2 });
  const m = modelo();
  const a = atendimento(store, m);
  const fala = (mensagem, endereco = '1') => a.turno({ agentId: ag, canal: 'whatsapp', endereco, mensagem });
  for (const x of ['a', 'b']) await fala(x);
  assert.equal((await fala('c')).text, RESPOSTA_LIMITE);
  assert.equal((await fala('d')).text, null, 'um aviso por hora, depois silêncio');
  assert.equal(m.chamadas.length, 2);
  assert.match((await fala('oi', '2')).text, /^resposta/, 'o limite é por contato');
  // Teto: só conta o custo do atendimento público deste assistente, de hoje.
  await store.configurar(ag, dono, { tetoDiarioUsd: 0.5, limitePorHora: 10 });
  await db.query(`INSERT INTO mtr_harness.usage_events (agent_id, kind, cost_usd, ts) VALUES
    ($1, 'chat', 9, now()), ($1, 'publico', 9, now() - interval '2 days'), ($1, 'publico', 0.4, now())`, [ag]);
  assert.match((await fala('oi', '3')).text, /^resposta/);
  await db.query(`INSERT INTO mtr_harness.usage_events (agent_id, kind, cost_usd) VALUES ($1, 'publico', 0.1)`, [ag]);
  const r = await fala('oi', '3');
  assert.deepEqual([r.text, r.motivo], [RESPOSTA_INDISPONIVEL, 'teto_diario']);
  assert.equal((await store.configurar(ag, dono, { tetoDiarioUsd: null })).teto_diario_usd, null);
  assert.match((await fala('oi', '3')).text, /^resposta/);
});

test('retenção apaga o que passou do prazo; exportar devolve tudo do contato', async (t) => {
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

test('bloqueado pelo dono: silêncio sem gravar nada; apagar meus dados limpa a conversa e o bloqueio fica', async (t) => {
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
  // A retenção também não leva o contato bloqueado (levaria o bloqueio junto).
  await db.query(`UPDATE mtr_harness.public_contacts SET ultima_em = now() - interval '31 days'`);
  assert.equal((await store.limparVencidos()).contatos, 0);
  await store.bloquear(contatoId, false);
  assert.match((await fala('oi de novo')).text, /^resposta/);
});

// A tela do dono: toda leitura confere o dono no SQL, e id de outra conta = 404.
test('visão do dono: só os próprios assistentes, contatos e conversas', async (t) => {
  const { db, store, dono, outro, ag, ag2 } = await montar(t);
  await store.configurar(ag, dono, { ativo: true });
  const a = atendimento(store, modelo());
  const { contatoId } = await a.turno({ agentId: ag, canal: 'whatsapp', endereco: '5511000000005', mensagem: 'quero trocar' });
  await a.turno({ agentId: ag, canal: 'whatsapp', endereco: '5511000000005', mensagem: 'tamanho G' });
  const rotas = createRotas();
  const send = (res, status, corpo, headers = {}) => Object.assign(res, { status, corpo, headers });
  registrarRotasDoDono({ rotas, store, send, fail: (res, st, msg, e) => { throw e; }, tooManyRequests: () => false, agenteDoNumero: () => ag });
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
    ['POST', '/api/publico/configurar', { agentId: ag, ativo: false }], ['POST', '/api/publico/configurar', { agentId: ag2, ativo: true }]]) {
    assert.equal((await pede(outro, metodo, caminho, corpo)).status, 404, `${metodo} ${caminho}`);
  }
  assert.equal((await store.agente(ag)).ativo, true);
  assert.equal(await store.agente(ag2), null);
  assert.equal((await store.exportar(contatoId)).contato.bloqueadoEm, null);
  // Configuração: valor fora da faixa não grava; vazio no teto = sem teto.
  assert.equal((await pede(dono, 'POST', '/api/publico/configurar', { agentId: ag, retencaoDias: 0 })).status, 400);
  assert.equal((await pede(dono, 'POST', '/api/publico/configurar', { agentId: ag, tetoDiarioUsd: -1 })).status, 400);
  assert.equal((await pede(dono, 'POST', '/api/publico/configurar', { agentId: ag, ativo: 'sim' })).status, 400);
  const ok = (await pede(dono, 'POST', '/api/publico/configurar', { agentId: ag2, ativo: true, limitePorHora: 5, tetoDiarioUsd: null })).corpo;
  assert.deepEqual([ok.ativo, ok.limitePorHora, ok.tetoDiarioUsd], [true, 5, null]);
  const exp = await pede(dono, 'GET', `/api/publico/exportar?contato=${contatoId}`);
  assert.match(exp.headers['content-disposition'], /attachment/);
  assert.equal((await pede(dono, 'POST', '/api/publico/apagar', { contatoId })).status, 200);
  assert.equal(await store.exportar(contatoId), null);
});

// O isolamento é por construção: o módulo não pode passar a importar quem lê
// dado do dono (memória, conectores, canais, rotinas). Import novo aqui = revisar.
test('publico.mjs só importa o tool-loop, o cofre, a regra de saúde e as saídas', () => {
  const src = fs.readFileSync(new URL('./web/publico.mjs', import.meta.url), 'utf8');
  const imports = [...src.matchAll(/^\s*import[^'"]*['"]([^'"]+)['"]/gm)].map((x) => x[1]).sort();
  assert.deepEqual(imports, ['../core-proto/core.mjs', './health-guardrail.mjs', './publico-saidas.mjs', './vault.mjs']);
});
