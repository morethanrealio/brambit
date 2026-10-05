// ── Canal Slack (app inscrito num workspace, Events API) ──
// Espelha o WhatsApp: um app de Slack atende VÁRIOS usuários do mesmo workspace.
// Roteamos pelo e-mail do usuário do Slack -> usuário do Brambs (mesmo caminho do
// canal de e-mail), e dentro do chat a pessoa escolhe qual assistente fala.
//
// Modelo: AGENTE ATIVO fixo por (team + usuário do Slack) (sticky). Mensagem
//   normal vai pro ativo.
//   "@nome ..."  troca o ativo e roteia aquela mensagem pra ele.
//   "menu" / "agentes"  lista os assistentes.
// Cada agente tem sua própria thread "Slack" (history isolado); a memória de
// USUÁRIO (wiki/perfil) segue compartilhada entre os assistentes da pessoa.
//
// Dispara em dois eventos: `app_mention` (menção ao app num canal onde ele está)
// e `message.im` (mensagem direta pro app). Ignora as próprias mensagens (loop) e
// subtipos (edição/remoção/join).

import crypto from 'crypto';
import { hostDaMarca, marca } from './marca.mjs';
import { splitMessage } from './channel-split.mjs';

const SLACK_API = 'https://slack.com/api';

// Canal pronto (precisa de bot token + signing secret).
export function slackEnabled() {
  return !!(process.env.SLACK_BOT_TOKEN && process.env.SLACK_SIGNING_SECRET);
}

// Normaliza um nome de agente pra casar com @apelido (sem acento, minúsculo, só alfanumérico).
function slug(s) {
  return (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '');
}

async function slackApi(method, body) {
  const r = await fetch(`${SLACK_API}/${method}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
      'content-type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify(body || {}),
  });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) throw new Error(`slack ${method}: ${j.error || r.status}`);
  return j;
}

// Id do nosso bot no Slack: usado pra tirar a menção do texto e pra ignorar as
// próprias mensagens (anti-loop). Vem do payload (authorizations) quando possível;
// senão cai no auth.test cacheado.
let cachedBotUserId = null;
async function getBotUserId() {
  if (cachedBotUserId) return cachedBotUserId;
  try { const j = await slackApi('auth.test', {}); cachedBotUserId = j.user_id || null; } catch { /* fica null */ }
  return cachedBotUserId;
}

// E-mail do usuário do Slack (precisa do escopo users:read.email). É a chave de
// roteamento pro usuário do Brambs.
async function slackEmail(slackUserId) {
  try {
    const j = await slackApi('users.info', { user: slackUserId });
    return (j.user?.profile?.email || '').toLowerCase().trim() || null;
  } catch { return null; }
}

// Slack aceita ~40k por mensagem, mas quebramos em pedaços de 3500 pra formatar
// bem. Resposta longa vai em várias, na ordem, sem corte. Até 29/09/2026 havia
// teto de 12k chars com o aviso "[…resposta muito longa, cortei o resto]" e a
// quebra era seca a cada 3500; agora usa channel-split.mjs.
const SLACK_CHUNK = 3500;

async function postMessage(channel, text, threadTs) {
  const body = (text || '').trim() || '(sem resposta)';
  for (const parte of splitMessage(body, SLACK_CHUNK)) {
    await slackApi('chat.postMessage', {
      channel,
      text: parte,
      thread_ts: threadTs || undefined,
      unfurl_links: false,
      unfurl_media: false,
    });
  }
}

// Lista os assistentes em texto (o Slack MVP troca por "@nome", sem lista interativa).
function agentListText(agents, header) {
  const lines = agents.slice(0, 10).map((a) => {
    const goal = (a.goal || '').trim();
    return `• *${a.name}*${goal ? ` — ${goal.slice(0, 72)}` : ''}`;
  });
  return `${header || 'Seus assistentes:'}\n${lines.join('\n')}\n\nPra falar com um, comece a mensagem com \`@nome\` (ex: \`@${slug(agents[0].name) || 'assistente'} ...\`).`;
}

// ── Verificação de assinatura do Slack (Signing Secret) ──
// Basestring `v0:${timestamp}:${rawBody}`; esperado = 'v0=' + HMAC-SHA256(secret)
// hex; compara com X-Slack-Signature em timing-safe. Rejeita timestamp com mais de
// 5 min (proteção de replay). Sem secret configurado, não bloqueia (dev), mesmo
// padrão do WhatsApp.
export function verifySlackSignature(rawBody, timestamp, signature) {
  const secret = process.env.SLACK_SIGNING_SECRET;
  if (!secret) return true;
  if (!timestamp || !signature) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 300) return false;
  const base = `v0:${timestamp}:${rawBody}`;
  const expected = 'v0=' + crypto.createHmac('sha256', secret).update(base).digest('hex');
  try {
    const a = Buffer.from(expected), b = Buffer.from(signature);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch { return false; }
}

// Injeta as deps do server (evita import circular):
//   runConversation(agent, userId, text) -> reply
//   loadAgent(agentId, userId) -> agent   (valida ownership)
//   db = { getSlackLink, upsertSlackLink, setSlackActiveAgent, listAgents, getUserByEmail }
export function createSlackHandler({ runConversation, loadAgent, db }) {
  const seen = new Set(); // event_id já processados (dedup de retries do Slack)
  const seenMsg = new Set(); // channel:ts já processados (colapsa app_mention + message)

  async function handleEvent(evt, meta) {
    const type = evt.type;
    if (type !== 'app_mention' && type !== 'message') return;
    // Ignora edição/remoção/join e mensagens de bot (subtype != undefined cobre
    // message_changed, message_deleted, bot_message, channel_join, etc.).
    if (evt.subtype) return;
    if (evt.bot_id) return;
    // DM ('message' channel_type im) e app_mention seguem sempre. 'message' num
    // canal/grupo é tratado mais abaixo, só se o canal estiver conectado por código.

    const slackUser = evt.user;
    if (!slackUser) return;
    const botId = meta.authedUserId || await getBotUserId();
    if (botId && slackUser === botId) return; // nossa própria mensagem (anti-loop)

    // Texto: tira QUALQUER menção (<@U123> ou <@U123|label>) e colapsa espaços.
    // Importante remover todas, não só a do bot pelo id: o id do payload
    // (authorizations) nem sempre bate com o da menção, e um resquício de
    // `<@...>` no começo quebra o match de comandos como `conectar CÓDIGO`.
    let text = (evt.text || '').trim();
    text = text.replace(/<@[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

    // app_mention responde na thread da menção; DM responde no topo (ou na thread
    // se a pessoa mencionou dentro de uma).
    const threadTs = type === 'app_mention' ? (evt.thread_ts || evt.ts) : evt.thread_ts;
    const reply = (t) => postMessage(evt.channel, t, threadTs).catch((e) => console.error('[slack] post:', e?.message ?? e));

    const teamId = meta.teamId || evt.team || '';
    const channel = evt.channel;

    // Canal/grupo (não-DM) via evento 'message': só responde se o canal está
    // conectado por código (senão o bot viraria ruído em canal alheio). Sem
    // binding, ignora sem marcar dedup, deixando o app_mention pedir o pareamento.
    const isChannelMsg = type === 'message' && evt.channel_type !== 'im';
    if (isChannelMsg) {
      const bound = await db.getSlackChannelLink(teamId, channel);
      if (!bound) return;
      if (!text) return; // não responde a post sem texto (anexo/imagem só)
    }

    // Dedup por mensagem: num canal conectado, uma menção ao bot dispara DOIS
    // eventos (app_mention + message.channels) com o MESMO evt.ts. Processa uma vez.
    const msgKey = evt.ts ? `${teamId}:${channel}:${evt.ts}` : null;
    if (msgKey) {
      if (seenMsg.has(msgKey)) return;
      seenMsg.add(msgKey);
      if (seenMsg.size > 5000) seenMsg.clear();
    }

    // ── Comando: conectar <código> — pareia ESTE canal a um assistente ──
    // O código é gerado no Brambs (logado, pra um agente do dono). Consumi-lo
    // amarra o assistente àquele canal (grupo ou DM): é assim que se tem "assistente
    // A no grupo X, B no grupo Y". Uso único; sobrescreve um vínculo anterior.
    const mConnect = text.match(/^conectar\s+([A-Za-z0-9]{4,})\b/i);
    if (mConnect) {
      const code = mConnect[1].toUpperCase();
      const pair = await db.consumeSlackPairingCode(code);
      if (!pair) { await reply(`Código inválido ou expirado. Gere um novo no ${marca().nome} (Conexões › Slack) e mande de novo: \`conectar CÓDIGO\`.`); return; }
      const agent = await loadAgent(pair.agent_id, pair.user_id);
      if (!agent) { await reply(`Não achei o assistente desse código. Gere um novo no ${marca().nome}.`); return; }
      await db.upsertSlackChannelLink({ teamId, channelId: channel, userId: pair.user_id, agentId: pair.agent_id, createdBy: slackUser });
      await reply(`Pronto! *${agent.name}* agora atende aqui. É só me mencionar (ou, num DM, mandar mensagem) que eu respondo.`);
      return;
    }

    // ── Comando: desconectar — desfaz o vínculo deste canal ──
    if (/^desconectar\b/i.test(text)) {
      const cl = await db.getSlackChannelLink(teamId, channel);
      if (!cl) { await reply('Não tem assistente conectado aqui.'); return; }
      await db.deleteSlackChannelLink(teamId, channel);
      await reply(`Desconectei o assistente deste canal. Pra reconectar, gere um novo código no ${marca().nome}.`);
      return;
    }

    // ── Roteamento: vínculo por CANAL primeiro (assistente fixo por grupo/DM) ──
    const chLink = await db.getSlackChannelLink(teamId, channel);
    if (chLink) {
      const agent = await loadAgent(chLink.agent_id, chLink.user_id);
      if (!agent) { await reply(`O assistente conectado aqui não está mais disponível. Gere um novo código no ${marca().nome}.`); return; }
      if (!text) { await reply(`Oi! Sou o *${agent.name}*. Pode mandar sua mensagem.`); return; }
      try {
        const res = await runConversation(agent, chLink.user_id, text, reply);
        if (res?.suppressed) return;
        const out = typeof res === 'string' ? res : res?.text;
        await reply(out || '(sem resposta)');
      } catch (e) {
        console.error('[slack] erro na conversa:', e?.message ?? e);
        await reply('Tive um problema pra responder agora. Tenta de novo?');
      }
      return;
    }

    // Menção em grupo SEM vínculo: peça o pareamento por código (não adivinha agente).
    if (type === 'app_mention') {
      await reply(`Ainda não tem assistente conectado aqui. No ${marca().nome}, em *Conexões › Slack*, escolha um assistente e gere um código; depois mande aqui: \`conectar CÓDIGO\`.`);
      return;
    }

    // DM sem vínculo de canal: fallback por e-mail (conveniência) + escolha por @nome.
    // Roteamento por identidade: link sticky, ou resolve pelo e-mail do Slack.
    let link = await db.getSlackLink(teamId, slackUser);
    let userId = link && link.enabled ? link.user_id : null;
    if (!userId) {
      const email = await slackEmail(slackUser);
      const user = email ? await db.getUserByEmail(email) : null;
      // `deleted_at` entra aqui junto com o !user de propósito (Marcos 04/09):
      // closeUserAccount apaga slack_links, mas ESTE fallback por e-mail recriaria
      // o vínculo no próximo DM e o assistente voltaria a responder pra uma conta
      // excluída. Tratar como "não tem conta" é o certo: a conta, pra efeito de
      // acesso, não existe mais.
      if (!user || user.deleted_at) {
        await reply(`Oi! Pra falar comigo por aqui, o e-mail da sua conta do Slack precisa ser o mesmo da sua conta no ${marca().nome} (${hostDaMarca()}). Faça login lá com esse e-mail e me chame de novo.`);
        return;
      }
      link = await db.upsertSlackLink({ teamId, slackUserId: slackUser, userId: user.id });
      userId = user.id;
    }

    const agents = await db.listAgents(userId);
    if (!agents.length) {
      await reply(`Você ainda não tem nenhum assistente. Crie um em ${hostDaMarca()} e volte aqui.`);
      return;
    }

    // Comando de menu.
    const low = text.toLowerCase();
    if (low === 'menu' || low === 'agentes' || low === '/agentes' || low === '/menu') {
      await reply(agentListText(agents));
      return;
    }

    // "@nome ..." no começo: troca o agente ativo e roteia o restante.
    let activeId = link.active_agent_id;
    const m = text.match(/^@(\S+)\s*([\s\S]*)$/);
    if (m) {
      const want = slug(m[1]);
      const matches = agents.filter((a) => { const s = slug(a.name); return s === want || s.startsWith(want); });
      if (matches.length === 1) {
        activeId = matches[0].id;
        await db.setSlackActiveAgent(teamId, slackUser, activeId);
        text = m[2].trim();
        if (!text) { await reply(`Agora falando com *${matches[0].name}*. Pode mandar.`); return; }
      } else if (matches.length === 0) {
        await reply(`Não achei um assistente "${m[1]}".\n\n${agentListText(agents)}`);
        return;
      } else {
        await reply(`Tem mais de um assistente parecido com "${m[1]}".\n\n${agentListText(agents)}`);
        return;
      }
    }

    // Sem ativo definido: com 1 assistente usa ele; com vários, mostra a lista e
    // espera a escolha (não cola sozinho no "mais novo").
    if (!activeId) {
      if (agents.length === 1) { activeId = agents[0].id; await db.setSlackActiveAgent(teamId, slackUser, activeId); }
      else { await reply(agentListText(agents, 'Você tem mais de um assistente. Com qual quer falar aqui no Slack?')); return; }
    }

    const agent = await loadAgent(activeId, userId);
    if (!agent) {
      await reply(`Não achei esse assistente.\n\n${agentListText(agents)}`);
      return;
    }

    if (!text) { await reply(`Falando com *${agent.name}*. Pode mandar sua mensagem.`); return; }

    try {
      const res = await runConversation(agent, userId, text, reply);
      if (res?.suppressed) return;
      const out = typeof res === 'string' ? res : res?.text;
      await reply(out || '(sem resposta)');
    } catch (e) {
      console.error('[slack] erro na conversa:', e?.message ?? e);
      await reply('Tive um problema pra responder agora. Tenta de novo?');
    }
  }

  // Processa o payload do webhook (já validado). NÃO bloqueia a resposta ao Slack:
  // o server responde 200 na hora e chama isto em background. O `url_verification`
  // (challenge) é tratado no server, síncrono, antes de chegar aqui.
  async function processPayload(payload) {
    try {
      if (payload.type !== 'event_callback') return;
      const eventId = payload.event_id;
      if (eventId) {
        if (seen.has(eventId)) return;
        seen.add(eventId);
        if (seen.size > 5000) seen.clear(); // backstop de memória
      }
      const evt = payload.event || {};
      const meta = {
        teamId: payload.team_id || evt.team || '',
        authedUserId: payload.authorizations?.[0]?.user_id || null,
      };
      await handleEvent(evt, meta).catch((e) => console.error('[slack] event:', e?.message ?? e));
    } catch (e) { console.error('[slack] process:', e?.message ?? e); }
  }

  return { process: processPayload };
}
