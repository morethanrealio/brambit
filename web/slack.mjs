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
// Connected channel (item 16 of the 10/2026 audit) depends on the assistant's category:
// - 'grupo' (team assistant): any full member of the workspace talks to it IN THE
//   CHANNEL (guests and people from other workspaces don't), in one conversation per
//   Slack thread (a new message in the channel starts one, replies in its thread
//   continue it); the turn carries none of the owner's private context (server.mjs).
//   In a DM only the owner gets it; anyone else gets the "channel only" notice.
// - 'pessoal'/'super': answers only its owner (checked by the account e-mail), DM or channel.
// Only the owner disconnects.
//
// Fires on two events: `app_mention` (app mentioned in a channel it's in)
// and `message.im` (direct message to the app). Ignores its own messages (loop)
// and subtypes (edit/delete/join).

import crypto from 'crypto';
import { hostDaMarca, marca } from './brand.mjs';
import { tagIdioma } from './locale.mjs';
import { splitMessage } from './channel-split.mjs';
import { comReenvio, criarAvisoCanal } from './channel-notice.mjs';
import { productI18n } from './i18n.mjs';

const SLACK_API = 'https://slack.com/api';

// Channel ready (needs bot token + signing secret).
export function slackEnabled() {
  return !!(process.env.SLACK_BOT_TOKEN && process.env.SLACK_SIGNING_SECRET);
}

// Normalizes an agent name to match @nickname (no accent, lowercase, alphanumeric only).
function slug(s) {
  return (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '');
}

// `get`: read methods (users.info) take their arguments only from the query string or a
// form body. Slack ignores a JSON body there and users.info answers user_not_found, which
// left a team assistant silent with everyone in its channel.
async function slackApi(method, body, { get = false } = {}) {
  const authorization = `Bearer ${process.env.SLACK_BOT_TOKEN}`;
  const r = get
    ? await fetch(`${SLACK_API}/${method}?${new URLSearchParams(body || {})}`, { headers: { authorization } })
    : await fetch(`${SLACK_API}/${method}`, {
      method: 'POST',
      headers: { authorization, 'content-type': 'application/json; charset=utf-8' },
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
  try { const j = await slackApi('auth.test', {}); cachedBotUserId = j.user_id || null; } catch { /* stays null */ }
  return cachedBotUserId;
}

// Slack user's name and email (the email needs the users:read.email scope; it's the
// routing key to the platform user), plus whether they are a full member of a workspace
// (`time`; a guest has none). Cached for a few minutes: in a connected channel every
// message asks who is speaking. A failed lookup returns no `time`: fail-closed.
const PESSOA_TTL_MS = 10 * 60 * 1000;
const pessoas = new Map();
async function pessoaDoSlack(slackUserId) {
  const c = pessoas.get(slackUserId);
  if (c && Date.now() - c.em < PESSOA_TTL_MS) return c.pessoa;
  let pessoa = { nome: null, email: null };
  try {
    const j = await slackApi('users.info', { user: slackUserId }, { get: true });
    const p = j.user?.profile || {};
    const u = j.user || {};
    pessoa = { nome: (p.display_name || p.real_name || u.real_name || u.name || '').trim() || null,
      email: (p.email || '').toLowerCase().trim() || null,
      time: (u.is_restricted || u.is_ultra_restricted || u.is_bot || u.deleted) ? null : (u.team_id || null) };
    if (pessoas.size > 5000) pessoas.clear();
    pessoas.set(slackUserId, { pessoa, em: Date.now() });
  } catch (e) {
    // Unknown: not the owner, no name. Logged because the caller then stays silent.
    console.error('[slack] users.info:', e?.message ?? e);
  }
  return pessoa;
}

// A DM is a conversation with one person ('im', id starting with D); channel, private
// group and group DM (mpim) have several people. app_mention doesn't bring channel_type.
const conversaPrivada = (evt) => evt.channel_type === 'im' || /^D/.test(String(evt.channel || ''));

// Slack accepts ~40k per message, but we break it into 3500-char pieces to format
// well. A long response goes in several, in order, with no cuts. Until 2026-09-29 there was
// a 12k-char ceiling with the notice "[…resposta muito longa, cortei o resto]" and the
// split was a hard cut every 3500; now it uses channel-split.mjs.
const SLACK_CHUNK = 3500;

// `reenvio`: repeats the part that failed with an uncertain error, without repeating what was already accepted.
// `nome`: posts under the assistant's name instead of the app's (scope chat:write.customize);
// an app without that scope still delivers, under its own name.
async function postMessage(channel, text, threadTs, { reenvio = false, nome = null } = {}) {
  const body = (text || '').trim() || '(sem resposta)';
  for (const parte of splitMessage(body, SLACK_CHUNK)) {
    const post = (username) => slackApi('chat.postMessage', {
      channel,
      text: parte,
      thread_ts: threadTs || undefined,
      username: username || undefined,
      unfurl_links: false,
      unfurl_media: false,
    });
    const enviar = () => post(nome).catch((e) => {
      if (nome && /missing_scope|not_allowed/.test(e.message)) return post(null);
      throw e;
    });
    await (reenvio ? comReenvio(enviar, { rotulo: 'slack' }) : enviar());
  }
}

// Slack's loading status in the reply's thread ("<app> is thinking...") while a turn runs.
// Works in channel threads with the chat:write scope (Slack changelog, 2026-03-05). Slack
// clears it when the app posts in the thread and after two minutes, so a long turn renews
// it, and the end clears it in case nothing was posted.
const STATUS_RENEW_MS = 90 * 1000;
function workingStatus(channel, threadTs, status) {
  if (!threadTs) return { renew() {}, stop: async () => {} };
  const set = (s) => slackApi('assistant.threads.setStatus', { channel_id: channel, thread_ts: threadTs, status: s })
    .catch((e) => console.error('[slack] setStatus:', e?.message ?? e));
  set(status);
  const timer = setInterval(() => set(status), STATUS_RENEW_MS);
  timer.unref?.();
  return { renew: () => { set(status); }, stop: () => { clearInterval(timer); return set(''); } };
}

// DM auto-reply where the team assistants live (channel only, no DM).
export const SO_NO_CANAL = {
  'pt-BR': 'Oi! Os assistentes da equipe só conversam nos canais do Slack onde estão. É só me mencionar lá. Por mensagem direta eu não respondo.',
  en: "Hi! Team assistants only talk in the Slack channels they're in. Just mention me there. I don't reply to direct messages.",
  es: '¡Hola! Los asistentes del equipo solo conversan en los canales de Slack donde están. Solo mencióname allí. No respondo mensajes directos.',
};
// Team channel conversation of one Slack thread (threadTs = the thread's first message).
// One conversation for the whole channel mixed every thread: a test from hours before
// kept steering a new request (team assistant case of 19/10/2026).
export const threadConversationTitle = (channel, threadTs) => `Slack · ${channel} · ${threadTs}`;

// Speaker's name in the shared channel conversation, without the means to fake another line.
const nomeDoFalante = (n) => String(n || '').replace(/[[\]\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'Alguém';

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
//   runConversation(agent, userId, text, onProgress, conversation) -> reply
//     conversation: title of a team channel thread's conversation (threadConversationTitle);
//     undefined = the person's "Slack" conversation.
//   loadAgent(agentId, userId) -> agent   (validates ownership)
//   db = { getSlackLink, upsertSlackLink, setSlackActiveAgent, listAgents, getUserByEmail }
// avisoCanal = { idiomaDe, registrar } (channel-notice.mjs): language of the error notice and
// its recording in the Slack thread's history.
//   pessoa(slackUserId) → {nome,email,time}: who is speaking (default: Slack users.info).
export function createSlackHandler({ runConversation, loadAgent, db, avisoCanal = {}, pessoa = pessoaDoSlack }) {
  const avisar = criarAvisoCanal({ rotulo: 'slack', ...avisoCanal });
  // Channel-only notice in the language of the assistant's owner (whoever set up the workspace).
  const soNoCanal = async (dono) => {
    try { return SO_NO_CANAL[tagIdioma((await avisoCanal.idiomaDe?.(dono))?.language)] || SO_NO_CANAL.en; } catch { return SO_NO_CANAL.en; }
  };

  // Is the Slack user the owner of the account (userId)? By the link the DM already made, or by
  // the same e-mail as the account (an account closed doesn't count).
  async function ehDono(teamId, slackUser, userId, email) {
    const link = await db.getSlackLink(teamId, slackUser);
    if (link?.enabled && link.user_id === userId) return true;
    const user = email ? await db.getUserByEmail(email) : null;
    return !!user && !user.deleted_at && user.id === userId;
  }
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

    const privado = conversaPrivada(evt);
    // Outside a DM the reply always goes in the message's thread. Deciding by event type
    // left it loose in the channel whenever Slack delivered the 'message' copy of a mention
    // before the app_mention (the dedup below keeps the first). A DM replies at the top, or
    // in the thread the person wrote in.
    const threadTs = privado ? evt.thread_ts : (evt.thread_ts || evt.ts);
    // Name the replies go out under: the assistant's, once it's known.
    let nome = null;
    const postar = (t, opts = {}) => postMessage(evt.channel, t, threadTs, { ...opts, nome });
    const reply = (t) => postar(t).catch((e) => console.error('[slack] post:', e?.message ?? e));
    // Runs the turn and delivers. Turn failure and delivery-only failure have
    // different notices (channel-notice.mjs); the ready response is resent, never redone.
    const responder = async (agent, userId, conversation) => {
      nome = agent.name;
      const enviarAviso = (t) => postar(t);
      let language = null;
      try { language = (await avisoCanal.idiomaDe?.(userId))?.language; } catch { /* instance default */ }
      const status = workingStatus(evt.channel, threadTs, productI18n().t('delivery.slack.thinking', tagIdioma(language)));
      // A progress post clears Slack's status, so it comes back right after.
      const onProgress = (t) => reply(t).then(() => status.renew());
      try {
        let res;
        try { res = await runConversation(agent, userId, text, onProgress, conversation); } catch (e) {
          console.error('[slack] conversation error:', e?.message ?? e);
          await avisar({ agent, userId, tipo: 'turno', mensagem: text, enviar: enviarAviso, conversation });
          return;
        }
        if (res?.suppressed) return;
        const out = typeof res === 'string' ? res : res?.text;
        try { await postar(out || '(sem resposta)', { reenvio: true }); } catch (e) {
          console.error('[slack] reply not delivered:', e?.message ?? e);
          await avisar({ agent, userId, tipo: 'entrega', enviar: enviarAviso, conversation });
        }
      } finally { await status.stop(); }
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
    // "assistant A in group X, B in group Y". Single use. Re-binding only by the same
    // account: a code from someone else doesn't take over a channel that's already bound.
    const mConnect = text.match(/^conectar\s+([A-Za-z0-9]{4,})\b/i);
    if (mConnect) {
      const code = mConnect[1].toUpperCase();
      const pair = await db.consumeSlackPairingCode(code);
      if (!pair) { await reply(`Código inválido ou expirado. Gere um novo no ${marca().nome} (Conexões › Slack) e mande de novo: \`conectar CÓDIGO\`.`); return; }
      const agent = await loadAgent(pair.agent_id, pair.user_id);
      if (!agent) { await reply(`Não achei o assistente desse código. Gere um novo no ${marca().nome}.`); return; }
      const ligado = await db.upsertSlackChannelLink({ teamId, channelId: channel, userId: pair.user_id, agentId: pair.agent_id, createdBy: slackUser });
      if (!ligado) { await reply('Este canal já tem um assistente conectado por outra conta. Só quem conectou pode trocar.'); return; }
      nome = agent.name;
      await reply(`Pronto! *${agent.name}* agora atende aqui. É só me mencionar (ou, num DM, mandar mensagem) que eu respondo.`);
      return;
    }

    // ── Command: disconnect — undoes this channel's link (only the owner; from anyone
    // else it's an ordinary message to the assistant) ──
    const quem = await pessoa(slackUser);
    const desconectar = /^desconectar\b/i.test(text);
    const cl0 = desconectar ? await db.getSlackChannelLink(teamId, channel) : null;
    if (desconectar && (!cl0 || await ehDono(teamId, slackUser, cl0.user_id, quem.email))) {
      if (!cl0) { await reply('Não tem assistente conectado aqui.'); return; }
      await db.deleteSlackChannelLink(teamId, channel);
      await reply(`Desconectei o assistente deste canal. Pra reconectar, gere um novo código no ${marca().nome}.`);
      return;
    }

    // ── Routing: link by CHANNEL first (fixed assistant per group/DM) ──
    const chLink = await db.getSlackChannelLink(teamId, channel);
    if (chLink) {
      const agent = await loadAgent(chLink.agent_id, chLink.user_id);
      if (!agent) { await reply(`O assistente conectado aqui não está mais disponível. Gere um novo código no ${marca().nome}.`); return; }
      nome = agent.name;
      const dono = await ehDono(teamId, slackUser, chLink.user_id, quem.email);
      const equipe = agent.category === 'grupo' && !privado;
      if (equipe ? quem.time !== teamId : !dono) {
        // Someone else's DM with a team assistant gets the notice; any other outsider, silence.
        if (privado && agent.category === 'grupo') await reply(await soNoCanal(chLink.user_id));
        return;
      }
      if (!text) { await reply(`Oi! Sou o *${agent.name}*. Pode mandar sua mensagem.`); return; }
      // Team channel: several people share a thread's conversation, so the model needs to know who is speaking.
      if (equipe) text = `[${nomeDoFalante(quem.nome)}] ${text}`;
      await responder(agent, chLink.user_id, equipe ? threadConversationTitle(channel, threadTs) : undefined);
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
      const user = quem.email ? await db.getUserByEmail(quem.email) : null;
      // `deleted_at` is checked here with !user on purpose (04/09):
      // closeUserAccount deletes slack_links, but THIS e-mail fallback would
      // recreate the link on the next DM and the assistant would answer a
      // deleted account again. Treating it as "no account" is right: for
      // access purposes, the account no longer exists.
      if (!user || user.deleted_at) {
        const donoEquipe = await db.slackDonoEquipe?.(teamId);
        if (donoEquipe) { await reply(await soNoCanal(donoEquipe)); return; }
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

    // Menu command.
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
        nome = matches[0].name;
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

    nome = agent.name;
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
