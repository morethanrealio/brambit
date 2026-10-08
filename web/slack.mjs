// ── Slack channel (app installed in a workspace, Events API) ──
// Mirrors WhatsApp: one Slack app serves SEVERAL users of the same workspace.
// We route by the Slack user's email -> platform user (same path as the email
// channel), and inside the chat the person picks which assistant speaks.
//
// Model: ACTIVE AGENT fixed per (team + Slack user) (sticky). A normal
//   message goes to the active one.
//   "@name ..."  switches the active one and routes that message to it.
//   "menu" / "agentes"  lists the assistants.
// Each agent has its own "Slack" thread (isolated history); USER memory
// (wiki/profile) stays shared across the person's assistants.
//
// Fires on two events: `app_mention` (app mentioned in a channel it's in)
// and `message.im` (direct message to the app). Ignores its own messages (loop)
// and subtypes (edit/delete/join).

import crypto from 'crypto';
import { hostDaMarca, marca } from './marca.mjs';
import { splitMessage } from './channel-split.mjs';
import { comReenvio, criarAvisoCanal } from './aviso-canal.mjs';

const SLACK_API = 'https://slack.com/api';

// Canal pronto (precisa de bot token + signing secret).
export function slackEnabled() {
  return !!(process.env.SLACK_BOT_TOKEN && process.env.SLACK_SIGNING_SECRET);
}

// Normalizes an agent name to match @nickname (no accent, lowercase, alphanumeric only).
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
  if (!j.ok) {
    // Same as Telegram: a Slack refusal (channel doesn't exist, no permission) is
    // deterministic; rate limit and 5xx are uncertain and warrant a retry.
    throw Object.assign(new Error(`slack ${method}: ${j.error || r.status}`),
      { definitive: r.status < 500 && r.status !== 429 && j.error !== 'ratelimited' });
  }
  return j;
}

// Our bot's id on Slack: used to strip the mention from the text and to ignore its
// own messages (anti-loop). Comes from the payload (authorizations) when possible;
// otherwise falls back to the cached auth.test.
let cachedBotUserId = null;
async function getBotUserId() {
  if (cachedBotUserId) return cachedBotUserId;
  try { const j = await slackApi('auth.test', {}); cachedBotUserId = j.user_id || null; } catch { /* fica null */ }
  return cachedBotUserId;
}

// Slack user's email (needs the users:read.email scope). It's the routing key
// to the platform user.
async function slackEmail(slackUserId) {
  try {
    const j = await slackApi('users.info', { user: slackUserId });
    return (j.user?.profile?.email || '').toLowerCase().trim() || null;
  } catch { return null; }
}

// Slack accepts ~40k per message, but we break it into 3500-char pieces to format
// well. A long response goes in several, in order, with no cuts. Until 2026-09-29 there was
// a 12k-char ceiling with the notice "[…resposta muito longa, cortei o resto]" and the
// split was a hard cut every 3500; now it uses channel-split.mjs.
const SLACK_CHUNK = 3500;

// `reenvio`: repeats the part that failed with an uncertain error, without repeating what was already accepted.
async function postMessage(channel, text, threadTs, { reenvio = false } = {}) {
  const body = (text || '').trim() || '(sem resposta)';
  for (const parte of splitMessage(body, SLACK_CHUNK)) {
    const enviar = () => slackApi('chat.postMessage', {
      channel,
      text: parte,
      thread_ts: threadTs || undefined,
      unfurl_links: false,
      unfurl_media: false,
    });
    await (reenvio ? comReenvio(enviar, { rotulo: 'slack' }) : enviar());
  }
}

// Lists the assistants in text (the Slack MVP swaps for "@name", no interactive list).
function agentListText(agents, header) {
  const lines = agents.slice(0, 10).map((a) => {
    const goal = (a.goal || '').trim();
    return `• *${a.name}*${goal ? ` — ${goal.slice(0, 72)}` : ''}`;
  });
  return `${header || 'Seus assistentes:'}\n${lines.join('\n')}\n\nPra falar com um, comece a mensagem com \`@nome\` (ex: \`@${slug(agents[0].name) || 'assistente'} ...\`).`;
}

// ── Slack signature verification (Signing Secret) ──
// Basestring `v0:${timestamp}:${rawBody}`; expected = 'v0=' + HMAC-SHA256(secret)
// hex; compares with X-Slack-Signature in timing-safe. Rejects a timestamp more than
// 5 min old (replay protection). Without a configured secret, doesn't block (dev), same
// pattern as WhatsApp.
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

// Injects the server's deps (avoids circular import):
//   runConversation(agent, userId, text) -> reply
//   loadAgent(agentId, userId) -> agent   (validates ownership)
//   db = { getSlackLink, upsertSlackLink, setSlackActiveAgent, listAgents, getUserByEmail }
// avisoCanal = { idiomaDe, registrar } (aviso-canal.mjs): language of the error notice and
// its recording in the Slack thread's history.
export function createSlackHandler({ runConversation, loadAgent, db, avisoCanal = {} }) {
  const avisar = criarAvisoCanal({ rotulo: 'slack', ...avisoCanal });
  const seen = new Set(); // event_id already processed (dedup of Slack retries)
  const seenMsg = new Set(); // channel:ts already processed (collapses app_mention + message)

  async function handleEvent(evt, meta) {
    const type = evt.type;
    if (type !== 'app_mention' && type !== 'message') return;
    // Ignores edit/removal/join and bot messages (subtype != undefined covers
    // message_changed, message_deleted, bot_message, channel_join, etc.).
    if (evt.subtype) return;
    if (evt.bot_id) return;
    // DM ('message' channel_type im) and app_mention always go through. A 'message' in a
    // channel/group is handled further below, only if the channel is connected by code.

    const slackUser = evt.user;
    if (!slackUser) return;
    const botId = meta.authedUserId || await getBotUserId();
    if (botId && slackUser === botId) return; // our own message (anti-loop)

    // Text: strips ANY mention (<@U123> or <@U123|label>) and collapses spaces.
    // Important to remove all of them, not just the bot's by id: the payload's id
    // (authorizations) doesn't always match the mention's, and a leftover
    // `<@...>` at the start breaks the match of commands like `conectar CÓDIGO`.
    let text = (evt.text || '').trim();
    text = text.replace(/<@[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

    // app_mention replies in the mention's thread; DM replies at the top (or in the thread
    // if the person mentioned it inside one).
    const threadTs = type === 'app_mention' ? (evt.thread_ts || evt.ts) : evt.thread_ts;
    const reply = (t) => postMessage(evt.channel, t, threadTs).catch((e) => console.error('[slack] post:', e?.message ?? e));
    // Runs the turn and delivers. Turn failure and delivery-only failure have
    // different notices (aviso-canal.mjs); the ready response is resent, never redone.
    const responder = async (agent, userId) => {
      const enviarAviso = (t) => postMessage(evt.channel, t, threadTs);
      let res;
      try { res = await runConversation(agent, userId, text, reply); } catch (e) {
        console.error('[slack] erro na conversa:', e?.message ?? e);
        await avisar({ agent, userId, tipo: 'turno', mensagem: text, enviar: enviarAviso });
        return;
      }
      if (res?.suppressed) return;
      const out = typeof res === 'string' ? res : res?.text;
      try { await postMessage(evt.channel, out || '(sem resposta)', threadTs, { reenvio: true }); } catch (e) {
        console.error('[slack] resposta não entregue:', e?.message ?? e);
        await avisar({ agent, userId, tipo: 'entrega', enviar: enviarAviso });
      }
    };

    const teamId = meta.teamId || evt.team || '';
    const channel = evt.channel;

    // Channel/group (non-DM) via the 'message' event: only responds if the channel is
    // connected by code (otherwise the bot would become noise in someone else's channel). Without
    // a binding, ignores without marking dedup, leaving app_mention to request the pairing.
    const isChannelMsg = type === 'message' && evt.channel_type !== 'im';
    if (isChannelMsg) {
      const bound = await db.getSlackChannelLink(teamId, channel);
      if (!bound) return;
      if (!text) return; // doesn't reply to a post with no text (attachment/image only)
    }

    // Dedup by message: in a connected channel, a mention to the bot fires TWO
    // events (app_mention + message.channels) with the SAME evt.ts. Processes once.
    const msgKey = evt.ts ? `${teamId}:${channel}:${evt.ts}` : null;
    if (msgKey) {
      if (seenMsg.has(msgKey)) return;
      seenMsg.add(msgKey);
      if (seenMsg.size > 5000) seenMsg.clear();
    }

    // ── Command: conectar <code>, pairs THIS channel with an assistant ──
    // The code is generated in the web app (logged in, for one of the owner's agents).
    // Using it binds the assistant to that channel (group or DM): that's how you get
    // "assistant A in group X, B in group Y". Single use; overwrites a prior binding.
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

    // ── Command: disconnect — undoes this channel's link ──
    if (/^desconectar\b/i.test(text)) {
      const cl = await db.getSlackChannelLink(teamId, channel);
      if (!cl) { await reply('Não tem assistente conectado aqui.'); return; }
      await db.deleteSlackChannelLink(teamId, channel);
      await reply(`Desconectei o assistente deste canal. Pra reconectar, gere um novo código no ${marca().nome}.`);
      return;
    }

    // ── Routing: link by CHANNEL first (fixed assistant per group/DM) ──
    const chLink = await db.getSlackChannelLink(teamId, channel);
    if (chLink) {
      const agent = await loadAgent(chLink.agent_id, chLink.user_id);
      if (!agent) { await reply(`O assistente conectado aqui não está mais disponível. Gere um novo código no ${marca().nome}.`); return; }
      if (!text) { await reply(`Oi! Sou o *${agent.name}*. Pode mandar sua mensagem.`); return; }
      await responder(agent, chLink.user_id);
      return;
    }

    // Mention in a group WITHOUT a link: ask for the pairing code (doesn't guess the agent).
    if (type === 'app_mention') {
      await reply(`Ainda não tem assistente conectado aqui. No ${marca().nome}, em *Conexões › Slack*, escolha um assistente e gere um código; depois mande aqui: \`conectar CÓDIGO\`.`);
      return;
    }

    // DM without a channel link: fallback by email (convenience) + choice by @name.
    // Routing by identity: sticky link, or resolves by the Slack email.
    let link = await db.getSlackLink(teamId, slackUser);
    let userId = link && link.enabled ? link.user_id : null;
    if (!userId) {
      const email = await slackEmail(slackUser);
      const user = email ? await db.getUserByEmail(email) : null;
      // `deleted_at` is checked here with !user on purpose (04/09):
      // closeUserAccount deletes slack_links, but THIS e-mail fallback would
      // recreate the link on the next DM and the assistant would answer a
      // deleted account again. Treating it as "no account" is right: for
      // access purposes, the account no longer exists.
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

    // "@name ..." at the start: swaps the active agent and routes the rest.
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

    // With no active one defined: with 1 assistant uses it; with several, shows the
    // list and waits for the choice (doesn't just stick to the "newest").
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

    await responder(agent, userId);
  }

  // Processes the webhook payload (already validated). Does NOT block the response to Slack:
  // the server replies 200 right away and calls this in the background. The `url_verification`
  // (challenge) is handled in the server, synchronously, before reaching here.
  async function processPayload(payload) {
    try {
      if (payload.type !== 'event_callback') return;
      const eventId = payload.event_id;
      if (eventId) {
        if (seen.has(eventId)) return;
        seen.add(eventId);
        if (seen.size > 5000) seen.clear(); // memory backstop
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
