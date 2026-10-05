import { hostDaMarca, siteDaMarca } from './marca.mjs';
import { channelReplyParts } from './confirmation-target.mjs';
// ── Canal Telegram (bot por usuário, token do BotFather dele) ──
// Cada usuário traz o próprio token; a gente roda o bot dele com long-polling
// (getUpdates), sem precisar de webhook público. Roteia a mensagem pro agente
// ligado ao bot e responde. O chat_id é amarrado no "/start <código de
// pareamento>" (o código só aparece na tela de Conexões do dono); só esse chat é
// atendido (o bot é privado do dono).

import { timingSafeEqual } from 'node:crypto';
import { notaMidiaSemTexto } from './midia-sem-texto.mjs';
import { startTurnHeartbeat, TURN_HEARTBEAT_TEXT } from './turn-heartbeat.mjs';
import { splitMessage } from './channel-split.mjs';
import { markVoiceInput } from './voice-input.mjs';

// Compara o código de pareamento sem vazar acerto parcial pelo tempo de resposta.
export function codeEq(a, b) {
  const x = Buffer.from(String(a ?? ''), 'utf8');
  const y = Buffer.from(String(b ?? ''), 'utf8');
  if (!x.length || x.length !== y.length) return false;
  return timingSafeEqual(x, y);
}

const API = (token) => `https://api.telegram.org/bot${token}`;
// Base pública pra montar a URL absoluta dos anexos (o Telegram busca a URL).
const PUBLIC_BASE = () => (process.env.PUBLIC_BASE_URL || siteDaMarca()).replace(/\/$/, '');
const absUrl = (u) => (/^https?:\/\//.test(u) ? u : `${PUBLIC_BASE()}${u}`);

// Teto de espera de uma chamada à Bot API. Sem isso o fetch podia ficar pendurado
// indefinidamente e o chamador (ex.: jornada de descoberta) não sabia se a
// mensagem saiu ou não.
const TG_TIMEOUT_MS = Number(process.env.TELEGRAM_TIMEOUT_MS || 20000);

// Separa recusa DETERMINÍSTICA de incerteza. 4xx (menos 429) é o Telegram
// dizendo "não vou entregar isso": bot bloqueado, chat inexistente, token
// inválido. 429/5xx, timeout e erro de rede são INCERTOS: a mensagem pode ter
// saído. Quem chama decide o que fazer com cada caso (`e.definitive`).
function tgError(method, description, status) {
  const e = new Error(`telegram ${method}: ${description || status}`);
  e.definitive = Number(status) >= 400 && Number(status) < 500 && Number(status) !== 429;
  e.status = Number(status) || null;
  return e;
}

async function tg(token, method, params) {
  // Long-polling (`getUpdates` com `timeout`) tem prazo próprio: o teto padrão
  // abortaria a espera legítima do Telegram a cada ciclo.
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
    // Rede/timeout: NUNCA é recusa determinística, pode ter chegado no servidor.
    throw Object.assign(new Error(`telegram ${method}: ${e?.name === 'TimeoutError' ? 'timeout' : 'falha de rede'}`), { definitive: false, status: null });
  }
  const j = await r.json().catch(() => null);
  if (!j || !j.ok) throw tgError(method, j?.description, r.status);
  return j.result;
}

// Valida um token e devolve o @username do bot (ou lança).
export async function validateBotToken(token) {
  const me = await tg(token, 'getMe', {});
  return { username: me.username, name: me.first_name };
}

// Telegram aceita até 4096 chars por mensagem; resposta longa vai em várias,
// na ordem, sem corte. Até 29/09/2026 havia teto de 12k chars com o aviso
// "[…resposta muito longa, cortei o resto]" e a quebra era seca a cada 4000
// (partia palavra e URL); agora usa channel-split.mjs.
const TG_CHUNK = 4000;

async function sendMessage(token, chatId, text, { requireReceipt = false } = {}) {
  // Texto puro (sem parse_mode) pra não quebrar com markdown malformado do modelo.
  const chunks = splitMessage(text || '', TG_CHUNK);
  if (!chunks.length) chunks.push('');
  const receipts=[];
  for (const c of chunks) {
    try {
      const receipt = await tg(token, 'sendMessage', { chat_id: chatId, text: c });
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

// Envio avulso (usado pelo despachante de lembretes proativos). Reusa a quebra
// em mensagens do sendMessage interno.
export async function sendTelegramMessage(token, chatId, text) {
  return sendMessage(token, chatId, text, { requireReceipt: true });
}

// Envia um arquivo por multipart (upload direto, sem link público). `extra`
// carrega campos adicionais do método (caption, reply_markup): string vai
// direto, objeto é serializado em JSON (formato que a Bot API espera no form).
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

// Baixa os bytes de uma URL do nosso domínio (ex.: /api/img?k=...). Nunca lança.
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

// Entrega anexos de mídia (imagem como foto, áudio como voz). Se getMedia
// devolver os bytes (modo bucket privado, sem link público), faz upload direto;
// senão (modo disco) usa o link público estático.
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
          // Mesmo caso do WhatsApp: a confirmação já saiu, então a fala vai em texto.
          if (!a.fala) throw err;
          console.error('[telegram] áudio não entregue, indo em texto:', err?.message ?? err);
          await tg(token, 'sendMessage', { chat_id: chatId, text: `Não consegui mandar o áudio, vai em texto:\n\n${a.fala}` });
        }
      } else if (a.type === 'document') {
        // Documento gerado (.docx/.pdf/etc.): a URL do bucket é autenticada, então
        // sobe os bytes direto via sendDocument, com o nome de arquivo certo.
        const filename = a.filename || a.name || 'documento';
        if (bytes) await tgUpload(token, 'sendDocument', chatId, 'document', bytes.buffer, filename, bytes.contentType || a.mime);
        else await tg(token, 'sendMessage', { chat_id: chatId, text: `Gerei o arquivo "${filename}", mas não consegui anexar aqui. Dá pra baixar em ${hostDaMarca()}.` });
      } else if (a.type === 'video') {
        // Vídeo gerado (mp4): sobe os bytes direto via sendVideo (player inline).
        const filename = a.filename || a.name || 'video.mp4';
        if (bytes) await tgUpload(token, 'sendVideo', chatId, 'video', bytes.buffer, filename, bytes.contentType || a.mime || 'video/mp4');
        else await tg(token, 'sendMessage', { chat_id: chatId, text: `Gerei um vídeo, mas não consegui anexar aqui. Dá pra ver em ${hostDaMarca()}.` });
      } else if (a.type === 'card') {
        // Card de produto. O Telegram NÃO renderiza a imagem por URL quando ela é
        // webp/avif (formatos comuns de foto de e-commerce) — sendPhoto por link
        // devolve "failed to get HTTP URL content" e o card sumia, sobrando só o
        // texto. Fix: baixa os bytes no NOSSO servidor e sobe direto (multipart).
        // jpeg/png/gif vira foto; webp/avif/outros vão como documento (ainda abre
        // a imagem) — sempre com legenda + botão do link. Qualquer falha cai pra
        // mensagem de texto com o botão, então título/preço/link nunca somem.
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

// Envia um vídeo (bytes) pro chat como player inline. Usado pela entrega
// proativa de vídeo gerado (poller de video_jobs), fora de um turno.
export async function sendTelegramVideo(token, chatId, buffer, filename = 'video.mp4', contentType = 'video/mp4') {
  return tgUpload(token, 'sendVideo', chatId, 'video', buffer, filename, contentType);
}

// Envia um documento (bytes) pro chat. Usado pela entrega proativa da devolutiva
// da jornada de descoberta (PDF), fora de um turno de conversa.
export async function sendTelegramDocument(token, chatId, buffer, filename = 'documento.pdf', contentType = 'application/pdf', caption) {
  return tgUpload(token, 'sendDocument', chatId, 'document', buffer, filename, contentType, caption ? { caption: String(caption).slice(0, 1000) } : undefined);
}

// Baixa uma mídia recebida (voz/áudio/foto) pelo file_id: getFile devolve o
// file_path, o binário vem do endpoint /file/bot<token>/<path>.
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

// Gerencia os pollers. Injeta as dependências do server (evita import circular).
// runConversation(agent, userId, text, images) -> reply ; loadAgent(agentId, userId) -> agent
// transcribe(buffer, mime, userId) -> texto (STT); db = { getTelegramBot, bindTelegramChat, setTelegramOffset }
export function createTelegramManager({ runConversation, reactionConfirm, loadAgent, db, getMedia, transcribe }) {
  const running = new Map(); // token -> { stop: boolean }
  const configuredHeartbeatMs = Number(process.env.TELEGRAM_TURN_HEARTBEAT_MS ?? process.env.TURN_HEARTBEAT_MS ?? 60000);
  const TURN_HEARTBEAT_MS = Number.isFinite(configuredHeartbeatMs) && configuredHeartbeatMs > 0
    ? configuredHeartbeatMs : 0;

  // Reaction (👍/👎) numa msg: confirma/cancela a ação pendente sem texto.
  async function handleReaction(bot, mr, updateId) {
    const chatId = String(mr.chat?.id ?? '');
    const fresh = await db.getTelegramBot(bot.token);
    if (!fresh || !fresh.enabled || !fresh.chat_id || fresh.chat_id !== chatId) return;
    const emojis = (mr.new_reaction || []).filter((r) => r.type === 'emoji').map((r) => r.emoji);
    if (!emojis.length) return; // reação removida
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

    // Primeiro contato: o chat só é amarrado por "/start <código de pareamento>".
    // O código nasce quando o dono cadastra o token e só aparece na tela de
    // Conexões dele (sessão autenticada). Sem isso, bastava QUALQUER mensagem de
    // QUALQUER pessoa pra amarrar o bot: quem achasse o @username antes do dono
    // virava o dono do chat privado dele.
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
    // Só atende o chat amarrado (bot privado do dono).
    if (fresh.chat_id !== chatId) {
      await sendMessage(bot.token, chatId, 'Este assistente é privado.').catch(() => {});
      return;
    }
    if (msg.text && msg.text.trim() === '/start') {
      await sendMessage(bot.token, chatId, 'Conectado! Pode falar comigo por aqui. 🙂');
      return;
    }

    // Monta a entrada do turno: texto + legenda, áudio (transcrito) e/ou imagem (visão).
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
        // msg.photo é um array de tamanhos; o último é o maior.
        const largest = msg.photo[msg.photo.length - 1];
        const { buffer, mime } = await downloadFile(bot.token, largest.file_id, 'image/jpeg');
        images = [{ mimeType: mime, data: buffer.toString('base64') }];
      } else if (msg.document) {
        // Documento: PDF ou arquivo de texto (HTML/txt/markdown/csv/json/xml)
        // usado como referência. O server extrai/lê e injeta no turno.
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
    try {
      await tg(bot.token, 'sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
      const res = await runConversation(agent, fresh.user_id, text, images, files, {
        confirmationInputId: msg.message_id == null ? null : `telegram:${chatId}:${msg.message_id}`,
        confirmationTarget: msg.reply_to_message ? { channel: 'telegram', messageId: msg.reply_to_message.message_id == null ? null : `${chatId}:${msg.reply_to_message.message_id}` } : undefined,
      });
      await finishHeartbeat();
      const reply = typeof res === 'string' ? res : res?.text;
      const attachments = typeof res === 'string' ? [] : (res?.attachments || []);
      await sendAttachments(bot.token, chatId, attachments, getMedia);
      if (reply || !attachments.length) {
        for (const part of channelReplyParts(res, '(sem resposta)')) {
          const receipt = await sendMessage(bot.token, chatId, part.text, {requireReceipt:!!part.id});
          await part.onReplySent?.({channel:'telegram',messageIds:(receipt?.message_ids || []).filter(id=>id!=null).map(id=>`${chatId}:${id}`)});
        }
      }
    } catch (e) {
      await finishHeartbeat();
      console.error('[telegram] erro na conversa:', e?.message ?? e);
      await sendMessage(bot.token, chatId, 'Tive um problema pra responder agora. Tenta de novo?').catch(() => {});
    } finally {
      await finishHeartbeat();
    }
  }

  async function poll(bot) {
    // Retoma do offset persistido: com offset só em memória, um restart voltava
    // pro 0 e o getUpdates re-entregava tudo que ainda não tinha sido confirmado
    // (resposta em dobro pro usuário). 0 = bot novo, pega o que estiver pendente.
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
          // Persiste DEPOIS de tratar: crash no meio re-entrega só o update em
          // curso (responder de novo é melhor que perder a mensagem).
          await db.setTelegramOffset(bot.token, u.update_id).catch(() => {});
        }
      } catch (e) {
        const m = String(e?.message ?? e);
        // 401 = token revogado/errado: para o poller desse bot.
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
      if (running.has(bot.token)) return; // já rodando
      running.set(bot.token, { stop: false });
      poll(bot); // não-await: roda em background
    },
    removeBot(token) {
      const s = running.get(token);
      if (s) s.stop = true;
      running.delete(token);
    },
    isRunning(token) { return running.has(token); },
    // Ponto de entrada de UM update, sem o long-polling em volta. Exposto porque
    // é onde mora a regra de pareamento do chat, que precisa de teste direto.
    handleUpdate,
  };
}
