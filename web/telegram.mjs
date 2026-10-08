import { hostDaMarca, siteDaMarca } from './marca.mjs';
import { channelReplyParts } from './confirmation-target.mjs';
// ── Telegram channel (bot per user, their own BotFather token) ──
// Each user brings their own token; we run their bot with long-polling
// (getUpdates), no need for a public webhook. Routes the message to the agent
// linked to the bot and replies. The chat_id is bound on "/start <pairing
// code>" (the code only appears on the owner's Connections screen); only that
// chat is served (the bot is private to the owner).

import { timingSafeEqual } from 'node:crypto';
import { notaMidiaSemTexto } from './midia-sem-texto.mjs';
import { startTurnHeartbeat, TURN_HEARTBEAT_TEXT } from './turn-heartbeat.mjs';
import { splitMessage } from './channel-split.mjs';
import { markVoiceInput } from './voice-input.mjs';
import { comReenvio, criarAvisoCanal } from './aviso-canal.mjs';

// Compares the pairing code without leaking partial matches through response time.
export function codeEq(a, b) {
  const x = Buffer.from(String(a ?? ''), 'utf8');
  const y = Buffer.from(String(b ?? ''), 'utf8');
  if (!x.length || x.length !== y.length) return false;
  return timingSafeEqual(x, y);
}

const API = (token) => `https://api.telegram.org/bot${token}`;
// Public base to build the absolute URL of attachments (Telegram fetches the URL).
const PUBLIC_BASE = () => (process.env.PUBLIC_BASE_URL || siteDaMarca()).replace(/\/$/, '');
const absUrl = (u) => (/^https?:\/\//.test(u) ? u : `${PUBLIC_BASE()}${u}`);

// Wait ceiling for a Bot API call. Without this the fetch could hang
// indefinitely and the caller (e.g. discovery journey) wouldn't know whether the
// message went out or not.
const TG_TIMEOUT_MS = Number(process.env.TELEGRAM_TIMEOUT_MS || 20000);

// Separates DETERMINISTIC refusal from uncertainty. 4xx (except 429) is Telegram
// saying "I won't deliver this": bot blocked, chat doesn't exist, invalid
// token. 429/5xx, timeout and network errors are UNCERTAIN: the message may have
// gone out. The caller decides what to do with each case (`e.definitive`).
function tgError(method, description, status) {
  const e = new Error(`telegram ${method}: ${description || status}`);
  e.definitive = Number(status) >= 400 && Number(status) < 500 && Number(status) !== 429;
  e.status = Number(status) || null;
  return e;
}

async function tg(token, method, params) {
  // Long-polling (`getUpdates` with `timeout`) has its own deadline: the default
  // ceiling would abort Telegram's legitimate wait on every cycle.
  const poll = Number(params?.timeout);
  const deadline = Number.isFinite(poll) && poll > 0 ? poll * 1000 + 10000 : TG_TIMEOUT_MS;
  let r;
  try {
    r = await fetch(`${API(token)}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params || {}),
      signal: AbortSignal.timeout(deadline),
    });
  } catch (e) {
    // Network/timeout: NEVER a deterministic refusal, it may have reached the server.
    throw Object.assign(new Error(`telegram ${method}: ${e?.name === 'TimeoutError' ? 'timeout' : 'falha de rede'}`), { definitive: false, status: null });
  }
  const j = await r.json().catch(() => null);
  if (!j || !j.ok) throw tgError(method, j?.description, r.status);
  return j.result;
}

// Validates a token and returns the bot's @username (or throws).
export async function validateBotToken(token) {
  const me = await tg(token, 'getMe', {});
  return { username: me.username, name: me.first_name };
}

// Telegram accepts up to 4096 chars per message; a long reply goes out in several,
// in order, with no truncation. Until 2026-09-29 there was a 12k char ceiling with
// the notice "[…resposta muito longa, cortei o resto]" and the split was blunt every 4000
// chars (it would cut words and URLs mid-way); now it uses channel-split.mjs.
const TG_CHUNK = 4000;

// `reenvio`: retries each part that failed with an uncertain error (aviso-canal.mjs). It's
// per part, so as not to resend the ones Telegram already accepted.
async function sendMessage(token, chatId, text, { requireReceipt = false, reenvio = false } = {}) {
  // Plain text (no parse_mode) so malformed markdown from the model doesn't break it.
  const chunks = splitMessage(text || '', TG_CHUNK);
  if (!chunks.length) chunks.push('');
  const receipts=[];
  for (const c of chunks) {
    try {
      const enviar = () => tg(token, 'sendMessage', { chat_id: chatId, text: c });
      const receipt = await (reenvio ? comReenvio(enviar, { rotulo: 'telegram' }) : enviar());
      if (requireReceipt && (!Number.isSafeInteger(receipt?.message_id) || receipt.message_id <= 0)) {
        throw Object.assign(new Error('Telegram sem recibo para uma parte da mensagem'), { definitive: false });
      }
      receipts.push(receipt);
    } catch (error) {
      // A later rejection does not undo an earlier accepted part.
      if (receipts.length) error.definitive = false;
      throw error;
    }
  }
  return {message_id:receipts[0]?.message_id,message_ids:receipts.map(r=>r?.message_id)};
}

// One-off send (used by the proactive reminders dispatcher). Reuses the line
// wrapping from the internal sendMessage.
export async function sendTelegramMessage(token, chatId, text) {
  return sendMessage(token, chatId, text, { requireReceipt: true });
}

// Sends a file via multipart (direct upload, no public link). `extra`
// carries additional method fields (caption, reply_markup): a string goes
// straight through, an object is serialized to JSON (the format the Bot API expects in the form).
async function tgUpload(token, method, chatId, field, buffer, filename, contentType, extra) {
  const form = new FormData();
  form.append('chat_id', chatId);
  for (const [k, v] of Object.entries(extra || {})) {
    if (v === undefined || v === null) continue;
    form.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
  }
  form.append(field, new Blob([buffer], { type: contentType || 'application/octet-stream' }), filename);
  const r = await fetch(`${API(token)}/${method}`, { method: 'POST', body: form });
  const j = await r.json();
  if (!j.ok) throw new Error(`telegram ${method}: ${j.description || r.status}`);
  return j.result;
}

// Downloads the bytes of a URL on our domain (e.g. /api/img?k=...). Never throws.
async function fetchBytes(u) {
  try {
    const r = await fetch(absUrl(u), { signal: AbortSignal.timeout(9000) });
    if (!r.ok) return null;
    const ct = (r.headers.get('content-type') || '').toLowerCase().split(';')[0].trim();
    const buf = Buffer.from(await r.arrayBuffer());
    if (!buf.length) return null;
    return { buffer: buf, contentType: ct };
  } catch { return null; }
}

// Delivers media attachments (image as photo, audio as voice). If getMedia
// returns the bytes (private bucket mode, no public link), uploads directly;
// otherwise (disk mode) uses the static public link.
async function sendAttachments(token, chatId, attachments, getMedia) {
  for (const a of attachments || []) {
    try {
      const bytes = getMedia ? await getMedia(a).catch(() => null) : null;
      if (a.type === 'image') {
        if (bytes) await tgUpload(token, 'sendPhoto', chatId, 'photo', bytes.buffer, 'image.png', bytes.contentType || a.mime);
        else await tg(token, 'sendPhoto', { chat_id: chatId, photo: absUrl(a.url) });
      } else if (a.type === 'audio') {
        try {
          if (bytes) await tgUpload(token, 'sendVoice', chatId, 'voice', bytes.buffer, 'voice.ogg', bytes.contentType || a.mime);
          else await tg(token, 'sendVoice', { chat_id: chatId, voice: absUrl(a.url) });
        } catch (err) {
          // Same case as WhatsApp: the confirmation already went out, so the speech goes as text.
          if (!a.fala) throw err;
          console.error('[telegram] áudio não entregue, indo em texto:', err?.message ?? err);
          await tg(token, 'sendMessage', { chat_id: chatId, text: `Não consegui mandar o áudio, vai em texto:\n\n${a.fala}` });
        }
      } else if (a.type === 'document') {
        // Generated document (.docx/.pdf/etc.): the bucket URL is authenticated, so
        // it uploads the bytes directly via sendDocument, with the correct file name.
        const filename = a.filename || a.name || 'documento';
        if (bytes) await tgUpload(token, 'sendDocument', chatId, 'document', bytes.buffer, filename, bytes.contentType || a.mime);
        else await tg(token, 'sendMessage', { chat_id: chatId, text: `Gerei o arquivo "${filename}", mas não consegui anexar aqui. Dá pra baixar em ${hostDaMarca()}.` });
      } else if (a.type === 'video') {
        // Generated video (mp4): uploads the bytes directly via sendVideo (inline player).
        const filename = a.filename || a.name || 'video.mp4';
        if (bytes) await tgUpload(token, 'sendVideo', chatId, 'video', bytes.buffer, filename, bytes.contentType || a.mime || 'video/mp4');
        else await tg(token, 'sendMessage', { chat_id: chatId, text: `Gerei um vídeo, mas não consegui anexar aqui. Dá pra ver em ${hostDaMarca()}.` });
      } else if (a.type === 'card') {
        // Product card. Telegram does NOT render the image by URL when it is
        // webp/avif (common e-commerce photo formats) — sendPhoto by link
        // returns "failed to get HTTP URL content" and the card disappeared, leaving only the
        // text. Fix: downloads the bytes on OUR server and uploads directly (multipart).
        // jpeg/png/gif becomes a photo; webp/avif/others go as a document (still opens
        // the image) — always with caption + link button. Any failure falls back to a
        // text message with the button, so title/price/link never disappear.
        const caption = [a.title, a.body].filter(Boolean).join('\n').slice(0, 1000) || undefined;
        const markup = a.url ? { reply_markup: { inline_keyboard: [[{ text: (a.buttonText || 'Ver produto').slice(0, 64), url: a.url }]] } } : {};
        let delivered = false;
        if (a.image) {
          const img = await fetchBytes(a.image);
          if (img && img.buffer) {
            const photoOk = /^image\/(jpe?g|png|gif)$/.test(img.contentType || '');
            const method = photoOk ? 'sendPhoto' : 'sendDocument';
            const field = photoOk ? 'photo' : 'document';
            const ext = (img.contentType || 'image/jpg').split('/')[1] || 'jpg';
            try {
              await tgUpload(token, method, chatId, field, img.buffer, `produto.${ext}`, img.contentType, { caption, ...markup });
              delivered = true;
            } catch (e) { console.error('[telegram] card img:', e?.message ?? e); }
          }
        }
        if (!delivered) await tg(token, 'sendMessage', { chat_id: chatId, text: caption || a.url || ' ', ...markup });
      }
    } catch (e) { console.error('[telegram] anexo:', e?.message ?? e); }
  }
}

// Sends a video (bytes) to the chat as an inline player. Used by the proactive
// delivery of generated video (video_jobs poller), outside of a turn.
export async function sendTelegramVideo(token, chatId, buffer, filename = 'video.mp4', contentType = 'video/mp4') {
  return tgUpload(token, 'sendVideo', chatId, 'video', buffer, filename, contentType);
}

// Sends a document (bytes) to the chat. Used by the proactive delivery of the
// discovery journey feedback (PDF), outside of a conversation turn.
export async function sendTelegramDocument(token, chatId, buffer, filename = 'documento.pdf', contentType = 'application/pdf', caption) {
  return tgUpload(token, 'sendDocument', chatId, 'document', buffer, filename, contentType, caption ? { caption: String(caption).slice(0, 1000) } : undefined);
}

// Downloads a received media file (voice/audio/photo) by file_id: getFile returns the
// file_path, the binary comes from the /file/bot<token>/<path> endpoint.
async function downloadFile(token, fileId, mimeHint) {
  const file = await tg(token, 'getFile', { file_id: fileId });
  const path = file.file_path;
  if (!path) throw new Error('mídia sem file_path');
  const r = await fetch(`https://api.telegram.org/file/bot${token}/${path}`);
  if (!r.ok) throw new Error(`telegram download: ${r.status}`);
  const buffer = Buffer.from(await r.arrayBuffer());
  let mime = mimeHint;
  if (!mime) {
    const ext = (path.split('.').pop() || '').toLowerCase();
    mime = (ext === 'oga' || ext === 'ogg') ? 'audio/ogg'
      : ext === 'mp3' ? 'audio/mpeg'
      : ext === 'm4a' ? 'audio/mp4'
      : ext === 'wav' ? 'audio/wav'
      : (ext === 'jpg' || ext === 'jpeg') ? 'image/jpeg'
      : ext === 'png' ? 'image/png'
      : ext === 'webp' ? 'image/webp'
      : 'application/octet-stream';
  }
  return { buffer, mime };
}

// Manages the pollers. Injects the server's dependencies (avoids circular import).
// runConversation(agent, userId, text, images) -> reply ; loadAgent(agentId, userId) -> agent
// transcribe(buffer, mime, userId) -> text (STT); db = { getTelegramBot, bindTelegramChat, setTelegramOffset }
// avisoCanal = { idiomaDe, registrar } (aviso-canal.mjs): language of the error notice and
// its logging in the Telegram thread history.
export function createTelegramManager({ runConversation, reactionConfirm, loadAgent, db, getMedia, transcribe, avisoCanal = {} }) {
  const avisar = criarAvisoCanal({ rotulo: 'telegram', ...avisoCanal });
  const running = new Map(); // token -> { stop: boolean }
  const configuredHeartbeatMs = Number(process.env.TELEGRAM_TURN_HEARTBEAT_MS ?? process.env.TURN_HEARTBEAT_MS ?? 60000);
  const TURN_HEARTBEAT_MS = Number.isFinite(configuredHeartbeatMs) && configuredHeartbeatMs > 0
    ? configuredHeartbeatMs : 0;

  // Reaction (👍/👎) on a msg: confirms/cancels the pending action without text.
  async function handleReaction(bot, mr, updateId) {
    const chatId = String(mr.chat?.id ?? '');
    const fresh = await db.getTelegramBot(bot.token);
    if (!fresh || !fresh.enabled || !fresh.chat_id || fresh.chat_id !== chatId) return;
    const emojis = (mr.new_reaction || []).filter((r) => r.type === 'emoji').map((r) => r.emoji);
    if (!emojis.length) return; // reaction removed
    const positive = emojis.some((e) => ['👍', '✅', '👌', '💯'].includes(e));
    const negative = emojis.some((e) => ['👎', '❌'].includes(e));
    if (!positive && !negative) return;
    const agent = await loadAgent(fresh.agent_id, fresh.user_id);
    if (!agent) return;
    const res = await reactionConfirm?.(agent, fresh.user_id, positive, { channel: 'telegram', messageId: mr.message_id == null ? null : `${chatId}:${mr.message_id}`, inputId:updateId == null ? null : `telegram:${bot.token.split(':')[0]}:${updateId}` });
    if (!res) return; // nada pendente
    const reply = typeof res === 'string' ? res : res?.text;
    const attachments = typeof res === 'string' ? [] : (res?.attachments || []);
    await sendAttachments(bot.token, chatId, attachments, getMedia).catch(() => {});
    if (reply) {
      for (const part of channelReplyParts(res)) {
        const receipt = await sendMessage(bot.token, chatId, part.text, {requireReceipt:!!part.id});
        await part.onReplySent?.({channel:'telegram',messageIds:(receipt?.message_ids || []).filter(id=>id!=null).map(id=>`${chatId}:${id}`)});
      }
    }
  }

  async function handleUpdate(bot, update) {
    if (update.message_reaction) {
      await handleReaction(bot, update.message_reaction, update.update_id).catch((e) => console.error('[telegram] reaction:', e?.message ?? e));
      return;
    }
    const msg = update.message;
    if (!msg) return;
    const chatId = String(msg.chat.id);

    // First contact: the chat is only bound via "/start <pairing code>".
    // The code is created when the owner registers the token and only appears on their
    // Connections screen (authenticated session). Without this, ANY message from
    // ANY person would be enough to bind the bot: whoever found the @username before the owner
    // would become the owner of their private chat.
    let fresh = await db.getTelegramBot(bot.token);
    if (!fresh || !fresh.enabled) return;
    if (!fresh.chat_id) {
      const arg = (msg.text || '').trim().match(/^\/start(?:@\S+)?(?:\s+(\S+))?$/);
      const codigo = arg && arg[1] ? arg[1] : '';
      if (!fresh.pair_code || !codigo || !codeEq(codigo, fresh.pair_code)) {
        await sendMessage(bot.token, chatId, 'Pra ativar este assistente, abra o link de ativação que está em Conexões › Telegram, no site.').catch(() => {});
        return;
      }
      await db.bindTelegramChat(bot.token, chatId);
      fresh = { ...fresh, chat_id: chatId };
    }
    // Only serves the bound chat (bot private to the owner).
    if (fresh.chat_id !== chatId) {
      await sendMessage(bot.token, chatId, 'Este assistente é privado.').catch(() => {});
      return;
    }
    if (msg.text && msg.text.trim() === '/start') {
      await sendMessage(bot.token, chatId, 'Conectado! Pode falar comigo por aqui. 🙂');
      return;
    }

    // Builds the turn input: text + caption, audio (transcribed) and/or image (vision).
    let text = (msg.text || msg.caption || '').trim();
    let images = null;
    let files = null;
    try {
      if (msg.voice || msg.audio) {
        if (!transcribe) { await sendMessage(bot.token, chatId, 'Não consigo processar áudio agora.').catch(() => {}); return; }
        const fileId = msg.voice?.file_id || msg.audio?.file_id;
        const mimeHint = msg.voice?.mime_type || msg.audio?.mime_type;
        const { buffer, mime } = await downloadFile(bot.token, fileId, mimeHint);
        try {
          const t = (await transcribe(buffer, mime, fresh.user_id)).trim();
          text = markVoiceInput(text ? `${text}\n${t}` : t);
        } catch (e) {
          if (String(e?.message ?? e).includes('STT_DISABLED')) {
            await sendMessage(bot.token, chatId, 'A transcrição de áudio está desligada. Dá pra ligar em Conexões › Mídia no site.').catch(() => {});
            return;
          }
          throw e;
        }
      } else if (msg.photo) {
        // msg.photo is an array of sizes; the last one is the biggest.
        const largest = msg.photo[msg.photo.length - 1];
        const { buffer, mime } = await downloadFile(bot.token, largest.file_id, 'image/jpeg');
        images = [{ mimeType: mime, data: buffer.toString('base64') }];
      } else if (msg.document) {
        // Document: PDF or text file (HTML/txt/markdown/csv/json/xml)
        // used as reference. The server extracts/reads it and injects it into the turn.
        const dmime = msg.document.mime_type || '';
        const dname = msg.document.file_name || 'documento';
        const okDoc = /\.(pdf|html?|txt|md|markdown|csv|tsv|json|xml|svg)$/i.test(dname)
          || /^(text\/|application\/(pdf|json|xml|xhtml\+xml)|image\/svg\+xml)/i.test(dmime);
        if (!okDoc) {
          await sendMessage(bot.token, chatId, 'Por enquanto consigo ler PDF e arquivos de texto (HTML, txt, markdown, csv) por aqui. 🙂').catch(() => {});
          return;
        }
        const { buffer, mime } = await downloadFile(bot.token, msg.document.file_id, dmime);
        files = [{ name: dname, mime: dmime || mime || '', buffer }];
      }
    } catch (e) {
      console.error('[telegram] mídia:', e?.message ?? e);
      await sendMessage(bot.token, chatId, 'Não consegui baixar essa mídia. Tenta mandar de novo?').catch(() => {});
      return;
    }

    if (!text && !images && !files) return;
    if (!text) text = notaMidiaSemTexto({ images: images?.length || 0, files: files?.length || 0 });

    const agent = await loadAgent(fresh.agent_id, fresh.user_id);
    if (!agent) { await sendMessage(bot.token, chatId, 'Não achei seu agente. Recrie a conexão no site.'); return; }
    const finishHeartbeat = startTurnHeartbeat({
      afterMs: TURN_HEARTBEAT_MS,
      send: () => sendMessage(bot.token, chatId, TURN_HEARTBEAT_TEXT),
      onError: (e) => console.warn('[telegram] heartbeat:', e?.message ?? e),
    });
    const enviarAviso = (t) => sendMessage(bot.token, chatId, t);
    let res;
    try {
      await tg(bot.token, 'sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
      res = await runConversation(agent, fresh.user_id, text, images, files, {
        confirmationInputId: msg.message_id == null ? null : `telegram:${chatId}:${msg.message_id}`,
        confirmationTarget: msg.reply_to_message ? { channel: 'telegram', messageId: msg.reply_to_message.message_id == null ? null : `${chatId}:${msg.reply_to_message.message_id}` } : undefined,
      });
    } catch (e) {
      await finishHeartbeat();
      console.error('[telegram] erro na conversa:', e?.message ?? e);
      await avisar({ agent, userId: fresh.user_id, tipo: 'turno', mensagem: text, enviar: enviarAviso });
      return;
    } finally {
      await finishHeartbeat();
    }
    // From here on the turn has already finished and the reply is in the history: a failure
    // here is delivery-only, and rerunning the turn could repeat actions.
    let entregou = true;
    const reply = typeof res === 'string' ? res : res?.text;
    const attachments = typeof res === 'string' ? [] : (res?.attachments || []);
    try { await sendAttachments(bot.token, chatId, attachments, getMedia); } catch (e) {
      entregou = false;
      console.error('[telegram] anexo não entregue:', e?.message ?? e);
    }
    if (reply || !attachments.length) {
      for (const part of channelReplyParts(res, '(sem resposta)')) {
        let receipt;
        try { receipt = await sendMessage(bot.token, chatId, part.text, { requireReceipt: !!part.id, reenvio: true }); } catch (e) {
          entregou = false;
          console.error('[telegram] resposta não entregue:', e?.message ?? e);
          continue;
        }
        await Promise.resolve(part.onReplySent?.({channel:'telegram',messageIds:(receipt?.message_ids || []).filter(id=>id!=null).map(id=>`${chatId}:${id}`)}))
          .catch((e) => console.error('[telegram] recibo da resposta:', e?.message ?? e));
      }
    }
    if (!entregou) await avisar({ agent, userId: fresh.user_id, tipo: 'entrega', enviar: enviarAviso });
  }

  async function poll(bot) {
    // Resumes from the persisted offset: with an in-memory-only offset, a restart would go
    // back to 0 and getUpdates would redeliver everything that hadn't yet been confirmed
    // (double reply to the user). 0 = new bot, picks up whatever is pending.
    let offset = Number(bot.last_update_id || 0) > 0 ? Number(bot.last_update_id) + 1 : 0;
    const state = running.get(bot.token);
    while (state && !state.stop) {
      try {
        const updates = await tg(bot.token, 'getUpdates', {
          offset, timeout: 30, allowed_updates: ['message', 'message_reaction'],
        });
        for (const u of updates) {
          offset = u.update_id + 1;
          await handleUpdate(bot, u).catch((e) => console.error('[telegram] update:', e?.message ?? e));
          // Persists AFTER handling: a crash in the middle redelivers only the update
          // in progress (replying again is better than losing the message).
          await db.setTelegramOffset(bot.token, u.update_id).catch(() => {});
        }
      } catch (e) {
        const m = String(e?.message ?? e);
        // 401 = revoked/wrong token: stops the poller for this bot.
        if (m.includes('401') || m.toLowerCase().includes('unauthorized')) {
          console.error('[telegram] token inválido, parando poller:', bot.token.slice(0, 8));
          running.delete(bot.token);
          return;
        }
        console.error('[telegram] getUpdates:', m);
        await new Promise((r) => setTimeout(r, 3000)); // backoff
      }
    }
  }

  return {
    addBot(bot) {
      if (running.has(bot.token)) return; // already running
      running.set(bot.token, { stop: false });
      poll(bot); // not awaited: runs in background
    },
    removeBot(token) {
      const s = running.get(token);
      if (s) s.stop = true;
      running.delete(token);
    },
    isRunning(token) { return running.has(token); },
    // Entry point for ONE update, without the long-polling wrapper. Exposed because
    // this is where the chat pairing rule lives, which needs direct testing.
    handleUpdate,
  };
}
