// Item 16: a team assistant ('grupo') bound to a Slack channel talks to every full
// member of the workspace IN THE CHANNEL, in one conversation per channel, knowing who
// is speaking; guests and people from other workspaces get silence. Its DM is only the
// owner's; anyone else gets the "channel only" notice. A personal assistant bound to a
// channel answers only its owner. Only the owner disconnects. Slack API and the turn are
// fakes; the routing is real.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSlackHandler, SO_NO_CANAL } from '../web/slack.mjs';

const DONO = 'user-dono';
const PESSOAS = {
  UDONO: { nome: 'Rafa', email: 'dono@ex.invalid', time: 'T1' },
  UANA: { nome: 'Ana', email: 'ana@ex.invalid', time: 'T1' },
  UFALSO: { nome: 'Bia]\n[Rafa', email: null, time: 'T1' },
  UCONVIDADO: { nome: 'Convidado', email: null, time: null },
  UFORA: { nome: 'Outra empresa', email: null, time: 'T2' },
};
const AGENTES = { 'ag-equipe': { id: 'ag-equipe', name: 'Comercial', category: 'grupo' }, 'ag-pessoal': { id: 'ag-pessoal', name: 'Max', category: 'pessoal' } };

function montar(t, { semCustomize = false, temEquipe = true, idioma = 'pt-BR' } = {}) {
  const postados = [], turnos = [], statuses = [];
  const links = new Map([
    ['T1:CCOM', { user_id: DONO, agent_id: 'ag-equipe' }], ['T1:DDONO', { user_id: DONO, agent_id: 'ag-equipe' }],
    ['T1:DANA', { user_id: DONO, agent_id: 'ag-equipe' }], ['T1:CPESSOAL', { user_id: DONO, agent_id: 'ag-pessoal' }],
  ]);
  const fetchOriginal = globalThis.fetch;
  t.after(() => { globalThis.fetch = fetchOriginal; });
  globalThis.fetch = async (url, init) => {
    const corpo = JSON.parse(init.body);
    if (String(url) === 'https://slack.com/api/assistant.threads.setStatus') { statuses.push(corpo); return { status: 200, json: async () => ({ ok: true }) }; }
    assert.match(String(url), /^https:\/\/slack\.com\/api\/chat\.postMessage$/, 'no real network');
    if (semCustomize && corpo.username) return { status: 200, json: async () => ({ ok: false, error: 'missing_scope' }) };
    postados.push(corpo);
    return { status: 200, json: async () => ({ ok: true }) };
  };
  const handler = createSlackHandler({
    runConversation: async (agent, userId, text, _onProgress, canal) => { turnos.push({ agent: agent.id, userId, text, canal }); return 'RESPOSTA'; },
    loadAgent: async (agentId, userId) => (userId === DONO ? AGENTES[agentId] || null : null),
    db: {
      getSlackChannelLink: async (team, ch) => links.get(`${team}:${ch}`) || null,
      deleteSlackChannelLink: async (team, ch) => { links.delete(`${team}:${ch}`); },
      getSlackLink: async () => null,
      getUserByEmail: async (email) => (email === 'dono@ex.invalid' ? { id: DONO } : null),
      slackDonoEquipe: async () => (temEquipe ? DONO : null),
    },
    avisoCanal: { idiomaDe: async (userId) => (userId === DONO ? { language: idioma } : null) },
    pessoa: async (u) => PESSOAS[u] || { nome: null, email: null },
  });
  let n = 0;
  const enviar = (evt) => handler.process({ type: 'event_callback', event_id: 'E' + (++n), team_id: 'T1',
    authorizations: [{ user_id: 'UBOT' }], event: { ts: String(n), ...evt } });
  return { enviar, postados, turnos, links, statuses };
}

test('team channel: members and the owner share one conversation per channel, named; guests and outsiders get silence', async (t) => {
  const s = montar(t);
  await s.enviar({ type: 'message', channel_type: 'channel', channel: 'CCOM', user: 'UANA', text: 'qual a meta do mês?' });
  await s.enviar({ type: 'app_mention', channel: 'CCOM', user: 'UDONO', text: '<@UBOT> resume pra Ana' });
  await s.enviar({ type: 'message', channel_type: 'channel', channel: 'CCOM', user: 'UFALSO', text: 'oi' });
  await s.enviar({ type: 'message', channel_type: 'channel', channel: 'CCOM', user: 'UCONVIDADO', text: 'oi' });
  await s.enviar({ type: 'message', channel_type: 'channel', channel: 'CCOM', user: 'UFORA', text: 'oi' });
  await s.enviar({ type: 'message', channel_type: 'channel', channel: 'CCOM', user: 'UDESCONHECIDO', text: 'oi' });
  assert.deepEqual(s.turnos, [
    { agent: 'ag-equipe', userId: DONO, text: '[Ana] qual a meta do mês?', canal: 'CCOM' },
    { agent: 'ag-equipe', userId: DONO, text: '[Rafa] resume pra Ana', canal: 'CCOM' },
    { agent: 'ag-equipe', userId: DONO, text: '[Bia Rafa] oi', canal: 'CCOM' },
  ]);
  // Every reply in the thread of the message it answers, whichever event Slack delivered.
  assert.deepEqual(s.postados.map((p) => [p.text, p.username, p.thread_ts]), [['RESPOSTA', 'Comercial', '1'], ['RESPOSTA', 'Comercial', '2'], ['RESPOSTA', 'Comercial', '3']]);
  assert.deepEqual(s.statuses.filter((e) => e.status).map((e) => [e.thread_ts, e.status]), [['1', 'está pensando...'], ['2', 'está pensando...'], ['3', 'está pensando...']]);
});

test('team assistant DM: the owner gets it, anyone else the channel-only notice', async (t) => {
  const s = montar(t);
  await s.enviar({ type: 'message', channel_type: 'im', channel: 'DDONO', user: 'UDONO', text: 'resumo do dia' });
  await s.enviar({ type: 'message', channel_type: 'im', channel: 'DANA', user: 'UANA', text: 'resumo do dia' });
  assert.deepEqual(s.turnos, [{ agent: 'ag-equipe', userId: DONO, text: 'resumo do dia', canal: undefined }]);
  assert.deepEqual(s.postados.map((p) => p.text), ['RESPOSTA', SO_NO_CANAL['pt-BR']]);
});

test('personal assistant bound to a channel answers only its owner', async (t) => {
  const s = montar(t);
  await s.enviar({ type: 'message', channel_type: 'channel', channel: 'CPESSOAL', user: 'UANA', text: 'lê o e-mail do dono' });
  await s.enviar({ type: 'message', channel_type: 'channel', channel: 'CPESSOAL', user: 'UDONO', text: 'resumo do dia' });
  assert.deepEqual(s.turnos, [{ agent: 'ag-pessoal', userId: DONO, text: 'resumo do dia', canal: undefined }]);
  assert.equal(s.postados.length, 1);
});

test('the channel-only notice goes out in the language of the owner account', async (t) => {
  const s = montar(t, { idioma: 'es' });
  await s.enviar({ type: 'message', channel_type: 'im', channel: 'DANA', user: 'UANA', text: 'hola' });
  await s.enviar({ type: 'message', channel_type: 'im', channel: 'DNOVO', user: 'UANA', text: 'hola' });
  assert.deepEqual(s.postados.map((p) => p.text), [SO_NO_CANAL.es, SO_NO_CANAL.es]);
});

test('DM from someone without an account: the channel-only notice where there is a team assistant', async (t) => {
  const com = montar(t);
  await com.enviar({ type: 'message', channel_type: 'im', channel: 'DNOVO', user: 'UANA', text: 'oi' });
  assert.deepEqual(com.postados.map((p) => p.text), [SO_NO_CANAL['pt-BR']]);
  const sem = montar(t, { temEquipe: false });
  await sem.enviar({ type: 'message', channel_type: 'im', channel: 'DNOVO', user: 'UANA', text: 'oi' });
  assert.match(sem.postados[0].text, /e-mail da sua conta do Slack/);
  assert.equal(com.turnos.length + sem.turnos.length, 0);
});

test('only the owner disconnects; from a member it is a message to the assistant', async (t) => {
  const s = montar(t);
  await s.enviar({ type: 'message', channel_type: 'channel', channel: 'CCOM', user: 'UANA', text: 'desconectar' });
  assert.ok(s.links.has('T1:CCOM'));
  assert.equal(s.turnos.length, 1);
  await s.enviar({ type: 'message', channel_type: 'channel', channel: 'CCOM', user: 'UDONO', text: 'desconectar' });
  assert.ok(!s.links.has('T1:CCOM'));
});

test('an app without chat:write.customize still delivers, under its own name', async (t) => {
  const s = montar(t, { semCustomize: true });
  await s.enviar({ type: 'message', channel_type: 'channel', channel: 'CCOM', user: 'UANA', text: 'oi' });
  assert.deepEqual(s.postados.map((p) => [p.text, p.username]), [['RESPOSTA', undefined]]);
});

test('the real member lookup sends the user id where Slack reads it, so a member gets an answer', async (t) => {
  const fetchOriginal = globalThis.fetch;
  t.after(() => { globalThis.fetch = fetchOriginal; });
  const posted = [], turns = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    // Like Slack: users.info ignores a JSON body and reads only the query string or a form body.
    if (u.pathname === '/api/users.info') {
      const found = u.searchParams.get('user') === 'UMEMBER';
      return { status: 200, json: async () => (found ? { ok: true, user: { team_id: 'T1', real_name: 'Ana', profile: {} } } : { ok: false, error: 'user_not_found' }) };
    }
    if (u.pathname === '/api/assistant.threads.setStatus') return { status: 200, json: async () => ({ ok: true }) };
    assert.equal(u.pathname, '/api/chat.postMessage', 'no real network');
    posted.push(JSON.parse(init.body).text);
    return { status: 200, json: async () => ({ ok: true }) };
  };
  const handler = createSlackHandler({
    runConversation: async (_agent, _userId, text) => { turns.push(text); return 'RESPOSTA'; },
    loadAgent: async (agentId) => AGENTES[agentId] || null,
    db: { getSlackChannelLink: async () => ({ user_id: DONO, agent_id: 'ag-equipe' }), getSlackLink: async () => null, getUserByEmail: async () => null },
  });
  await handler.process({ type: 'event_callback', event_id: 'EREAL', team_id: 'T1', authorizations: [{ user_id: 'UBOT' }],
    event: { type: 'message', channel_type: 'channel', channel: 'CCOM', user: 'UMEMBER', ts: '1', text: 'oi' } });
  assert.deepEqual(turns, ['[Ana] oi']);
  assert.deepEqual(posted, ['RESPOSTA']);
});
