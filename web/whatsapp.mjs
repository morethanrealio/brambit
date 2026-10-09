import { hostDaMarca, marca, siteDaMarca } from './marca.mjs';
import { batchedConfirmationTarget, channelReplyParts } from './confirmation-target.mjs';
// ── WhatsApp channel (WABA Cloud API, single shared number) ──
// One business number serves MULTIPLE users. Unlike Telegram (1 bot per
// user), here the webhook is shared: we route by the sender's phone number
// -> user, and inside the chat the user chooses which assistant speaks.
//
// Model: fixed ACTIVE AGENT per phone (sticky). A normal message goes to the active one.
//   "@name ..."  switches the active one and routes that message to it.
//   "menu" / "/agentes"  shows the interactive list to choose from.
// Each agent has its own "WhatsApp" thread (isolated history); USER
// memory (wiki/profile) remains shared across the person's assistants.

import crypto from 'crypto';
import { CHANNEL_CTX_END } from './confirm.mjs';
import { markVoiceInput } from './voice-input.mjs';
import { notaMidiaSemTexto } from './midia-sem-texto.mjs';
import { startTurnHeartbeat, TURN_HEARTBEAT_TEXT } from './turn-heartbeat.mjs';
import { splitMessage } from './channel-split.mjs';
import { markdownParaWa } from './wa-format.mjs';
import { comReenvio, criarAvisoCanal } from './aviso-canal.mjs';
import { imagemParaWa } from './wa-imagem.mjs';
import { avisarEntrega, esperarEntrega } from './wa-entrega.mjs';

const GRAPH = 'https://graph.facebook.com/v21.0';
const PHONE_ID = () => process.env.WA_PHONE_NUMBER_ID;
// Public base to build the absolute URL of attachments (Meta fetches the URL via link).
const PUBLIC_BASE = () => (process.env.PUBLIC_BASE_URL || siteDaMarca()).replace(/\/$/, '');
const absUrl = (u) => (/^https?:\/\//.test(u) ? u : `${PUBLIC_BASE()}${u}`);

// Channel ready (needs token + phone id + verify token + app secret). The app
// secret goes in here because without it the inbound webhook can't be
// authenticated, and a half-enabled channel is worse than a disabled one.
export function waEnabled() {
  return !!(process.env.WA_TOKEN && process.env.WA_PHONE_NUMBER_ID && process.env.WA_VERIFY_TOKEN && process.env.WA_APP_SECRET);
}

// Normalizes an agent name to match @nickname (no accents, lowercase, alphanumeric only).
function slug(s) {
  return (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '');
}

// Meta sends the generic message in error.message ("(#131009) Parameter value
// is not valid") and says WHICH parameter it rejected in error.error_data.details. Without
// that detail the journal doesn't allow debugging the rejection, so we keep both.
function graphErr(j, status) {
  const e = j?.error || {};
  const extra = [
    e?.error_data?.details,
    e?.error_data?.error_user_msg,
    e?.error_subcode ? `subcode ${e.error_subcode}` : null,
    e?.fbtrace_id ? `fbtrace ${e.fbtrace_id}` : null,
  ].filter(Boolean).join(' | ');
  const base = e?.message || `HTTP ${status}`;
  return extra ? `${base} [${extra}]` : base;
}

async function graph(path, body) {
  const r = await fetch(`${GRAPH}/${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${process.env.WA_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(`wa ${path}: ${graphErr(j, r.status)}`), {
    definitive: r.status >= 400 && r.status < 500 && r.status !== 429,
    status: r.status,
  });
  return j;
}

// Ceiling for ONE text bubble in the Cloud API. It used to be 4096 and Meta started refusing
// anything above 1024 (error "(#131009) Parameter value is not valid", with
// error_data.details = "body['text'] length is N. It cannot exceed 1024"),
// verified live on 2026-09-18: at 00:11 SP time a 2670-char message still
// got through, at 06:58 SP time a 2401-char one was already refused. This isn't our limit: if Meta
// reverses course, it's enough to raise this constant.
const WA_CHUNK = 1024;

// A long reply becomes several bubbles, in order, with no truncation. Until 2026-09-29 there was
// an 8-bubble ceiling (8192 chars): the excess disappeared and the last bubble carried
// "[…resposta muito longa, cortei o resto]". The split itself lives in
// channel-split.mjs (paragraph > line > space > blunt cut outside a URL).
// Exported because it's the rule that decides how many notifications the person gets.
// The model's Markdown becomes WhatsApp formatting here (wa-format.mjs).
export function prepararTextoWa(text) {
  const body = markdownParaWa((text || '').trim()) || '(sem resposta)';
  return splitMessage(body, WA_CHUNK);
}

// Plain text, cut into WA_CHUNK-char pieces.
// Returns the wamids of the parts that were sent (to index the reply and allow
// the user to "reply/quote" it later). Callers that ignore the return value remain fine.
// `reenvio`: retries each part that failed with an uncertain error (aviso-canal.mjs), per
// part, so as not to resend the ones Meta already accepted. On error, `error.wamids`
// carries the parts that went out (billing and quoting still apply to them).
async function sendText(to, text, { requireReceipt = false, tracking, reenvio = false } = {}) {
  const wamids = [];
  const parts = prepararTextoWa(text);
  await tracking?.start({ total: parts.length, recipient: to });
  for (const [part, parte] of parts.entries()) {
    try {
      const opaque = await tracking?.beforePart(part);
      const enviar = () => graph(`${PHONE_ID()}/messages`, {
        messaging_product: 'whatsapp', to, type: 'text',
        ...(opaque ? { biz_opaque_callback_data: opaque } : {}),
        text: { body: parte, preview_url: false },
      });
      const j = await (reenvio ? comReenvio(enviar, { rotulo: 'whatsapp' }) : enviar());
      const id = j?.messages?.[0]?.id;
      if (requireReceipt && (typeof id !== 'string' || !id.trim())) {
        throw Object.assign(new Error('WhatsApp sem recibo para uma parte da mensagem'), { definitive: false, partial: true });
      }
      if (id) wamids.push(id);
      if (id) await tracking?.accepted(part, id);
    } catch (error) {
      await tracking?.failed(part, error);
      if (wamids.length) { error.definitive = false; error.partial = true; }
      error.wamids = wamids;
      throw error;
    }
  }
  return wamids;
}

// Rich outputs from public-facing support (publico-saidas.mjs, already normalized),
// one Meta message per output, in order. Text goes through sendText (split into
// bubbles); image, link button (cta_url) and approved template go out directly, with
// images uploaded beforehand as JPEG/PNG (wa-imagem.mjs). An output with an image that
// has another one after it waits for Meta to confirm delivery (wa-entrega.mjs), otherwise the
// next text arrives before the photo. An output with a `reserva` that Meta rejects,
// right away or later via the webhook, becomes this text. Without a reserve, the error is the same
// as sendText's: `error.wamids` carries what already went out.
const ESPERA_ENTREGA_MS = () => Number(process.env.WA_ESPERA_ENTREGA_MS ?? 15000);
const RESERVA_TARDIA_MS = 5 * 60 * 1000;
const subirImagem = (url) => imagemParaWa(url, (buf, mime) => uploadMedia(buf, mime, mime === 'image/png' ? 'imagem.png' : 'imagem.jpg'));
// Replaces every {type:'image', image:{link}} in a template's components with the
// already-uploaded image (template header and carousel cards).
async function imagensDoTemplate(v) {
  if (Array.isArray(v)) return Promise.all(v.map(imagensDoTemplate));
  if (!v || typeof v !== 'object') return v;
  if (v.type === 'image' && typeof v.image?.link === 'string') return { ...v, image: await subirImagem(v.image.link) };
  return Object.fromEntries(await Promise.all(Object.entries(v).map(async ([k, x]) => [k, await imagensDoTemplate(x)])));
}
const temImagem = (s) => s.tipo === 'imagem' || !!s.imagem || (s.tipo === 'template' && JSON.stringify(s.componentes).includes('"image"'));
const corpoDaSaida = async (s) => {
  if (s.tipo === 'imagem') return { type: 'image', image: { ...await subirImagem(s.url), ...(s.legenda ? { caption: markdownParaWa(s.legenda) } : {}) } };
  if (s.tipo === 'botao') return { type: 'interactive', interactive: { type: 'cta_url', ...(s.imagem ? { header: { type: 'image', image: await subirImagem(s.imagem) } } : {}), body: { text: markdownParaWa(s.texto) },
    action: { name: 'cta_url', parameters: { display_text: s.rotulo, url: s.url } } } };
  return { type: 'template', template: { name: s.nome, language: { code: s.idioma }, ...(s.componentes.length ? { components: await imagensDoTemplate(s.componentes) } : {}) } };
};
async function sendSaidas(to, saidas, { requireReceipt = false, reenvio = false } = {}) {
  const wamids = [];
  for (const [i, s] of saidas.entries()) {
    const ultima = i === saidas.length - 1;
    try {
      if (s.tipo === 'texto') { wamids.push(...await sendText(to, s.texto, { requireReceipt, reenvio })); continue; }
      const corpo = await corpoDaSaida(s);
      const enviar = () => graph(`${PHONE_ID()}/messages`, { messaging_product: 'whatsapp', to, ...corpo });
      let id;
      try {
        id = (await (reenvio ? comReenvio(enviar, { rotulo: 'whatsapp' }) : enviar()))?.messages?.[0]?.id;
        if (requireReceipt && (typeof id !== 'string' || !id.trim())) throw Object.assign(new Error('WhatsApp sem recibo para uma saída'), { definitive: false });
      } catch (error) {
        if (!s.reserva || !error.definitive) throw error;
        console.warn(`[whatsapp] output ${s.tipo}${s.nome ? ' ' + s.nome : ''} rejected, falling back to reserve: ${error.message}`);
        wamids.push(...await sendText(to, s.reserva, { requireReceipt, reenvio }));
        continue;
      }
      if (id) wamids.push(id);
      if (!id) continue;
      if (!ultima && temImagem(s)) {
        if (await esperarEntrega(id, ESPERA_ENTREGA_MS()) === 'failed' && s.reserva) wamids.push(...await sendText(to, s.reserva, { requireReceipt, reenvio }));
      } else if (s.reserva) {
        void esperarEntrega(id, RESERVA_TARDIA_MS).then((st) => st === 'failed' && sendText(to, s.reserva))
          .catch((e) => console.error('[whatsapp] late reserve:', e?.message ?? e));
      }
    } catch (error) {
      error.wamids = [...wamids, ...(error.wamids || [])];
      if (error.wamids.length) { error.definitive = false; error.partial = true; }
      throw error;
    }
  }
  return wamids;
}

// Maximum size of a template parameter; above this the text is truncated.
export const WA_TEMPLATE_MAX = 900;

// Normalizes ONE template body parameter. The Cloud API REJECTS a parameter with a
// line break, tab, or 4+ consecutive spaces (error "(#100) Invalid parameter").
// Multi-line reminders (e.g. a task list) used to hit this and weren't delivered.
// Normalizes: line breaks become " · ", tabs become a space, runs of spaces collapse.
function normTemplateParam(v) {
  let text = markdownParaWa((v == null ? '' : String(v)).trim()) || '(sem conteúdo)';
  text = text
    .replace(/\r/g, '')
    .replace(/[ \t]*\n[ \t]*/g, ' · ')
    .replace(/\t+/g, ' ')
    .replace(/ {2,}/g, ' ')
    .replace(/(?: ?· ?){2,}/g, ' · ') // blank lines used to turn into " · · "; collapses them
    .replace(/^ ?· ?| ?· ?$/g, '')    // leftover separator at the start/end
    .trim();
  if (text.length > WA_TEMPLATE_MAX) text = text.slice(0, WA_TEMPLATE_MAX).trimEnd() + '…'; // template body is short
  return text;
}

// Sends an approved TEMPLATE message (business-initiated). Outside the 24h
// window since the user's last message, the Cloud API only allows templates.
// Names come from the brand (marca().templatesWhatsApp, each install's own):
// - notificacao (UTILITY): 1 variable ({{1}}) = content. Follow-up of something
//   agreed (reminders, routines, requested notifications). The default.
// - engajamento (MARKETING): 2 variables ({{1}}=first name, {{2}}=content).
//   UNSOLICITED proactive sends (reactivation / feature announcement).
// For multi-variable templates pass `params` (array, in order {{1}}, {{2}}, …);
// without it, falls back to the single `bodyText` ({{1}}).
export async function sendWhatsAppTemplate(to, bodyText, { name = marca().templatesWhatsApp.notificacao, lang = 'pt_BR', params = null, opaque = null } = {}) {
  const list = Array.isArray(params) && params.length ? params : [bodyText];
  const parameters = list.map((p) => ({ type: 'text', text: normTemplateParam(p) }));
  return graph(`${PHONE_ID()}/messages`, {
    messaging_product: 'whatsapp', to, type: 'template',
    ...(opaque ? { biz_opaque_callback_data: opaque } : {}),
    template: {
      name, language: { code: lang },
      components: [{ type: 'body', parameters }],
    },
  });
}

// Database hooks injected at boot (server.mjs calls setWaHooks). whatsapp.mjs
// does NOT import db.mjs on purpose: the webhook handler already receives `db` via
// injection, but PROACTIVE sending runs outside the webhook and needs to check the
// 24h window, so it gets what it needs through here.
let waHooks = { lastInboundAt: null, billMessages: null };
export function setWaHooks(h) { waHooks = { ...waHooks, ...(h || {}) }; }

// ── Billing per MESSAGE delivered (Meta's `service` category) ──
// Meta starts charging for service messages on 2026-10-01 (R$0.035 each, with 1,000
// free/month per number). The user pays, in credits (WA_MSG_CREDITS),
// counting META MESSAGES: a long reply becomes several (4000 chars each) and
// each attachment is its own message.
//
// ⚠️ The CALLER decides whether to charge, never `graph()`: inside the 24h window
// a lifecycle/marketing send goes out as a SESSION message (type:text),
// so inferring the charge from the body type would charge the user for OUR campaign.
// That's why only the points that REPLY to the user call this — system messages
// (heartbeat, error, menu, unsupported media) and templates don't charge.
//
// Deliberately fire-and-forget: a billing failure never delays or brings down the
// message delivery (the charge is recorded after sending, either way).
const PUBLICO_SO_TEXTO = 'Por enquanto só consigo ler mensagens de texto por aqui. Pode escrever, por favor?';

function billWa(userId, n, meta = {}) {
  if (!userId || !(n > 0) || !waHooks.billMessages) return;
  try {
    const p = waHooks.billMessages({ userId, messages: n, ...meta });
    if (p && typeof p.catch === 'function') p.catch((e) => console.warn('[whatsapp] billing:', e?.message ?? e));
  } catch (e) { console.warn('[whatsapp] billing:', e?.message ?? e); }
}

// 5-min margin at the edge: Meta's clock isn't ours, and a session message
// sent at 23:59 of the limit arrives as an async failure.
const WA_WINDOW_MS = 24 * 3600_000 - 5 * 60_000;

// PROACTIVE send with the BEST possible formatting. Inside the 24h window (the
// user sent a message less than 24h ago), the Cloud API allows sending a SESSION
// message (type:text), which preserves line breaks, lists and *bold*. Outside the
// window only an approved TEMPLATE works, whose parameter does NOT accept line breaks
// (normTemplateParam flattens everything into a single line).
//
// ⚠️ Meta does NOT refuse right away: it ACCEPTS the text outside the window (HTTP 200 +
// wamid) and rejects it LATER, silently, via the status webhook (error 131047
// "Re-engagement message"). In other words, `try/catch` on the send never saw this failure and
// the template fallback was dead code for exactly the case it was written for
// (202 messages lost in 30 days, almost all from routines). That's why the window
// is now decided by data of OUR OWN (whatsapp_links.last_inbound_at) BEFORE
// sending, and the status webhook still does the template resend as a safety
// net. `templateName`/`params` control the template (default: the brand
// notification one, 1 variable).
//
// `proseFallback(text) => string`: async callback called ONLY on the closed-window
// path (template). Since the template flattens lists into a zone, here we
// ask the agent to rewrite the content in RUNNING PROSE (no list/bullet/
// line break) before sending the template. If no callback comes, or it fails, it falls back
// to the original text (normTemplateParam still flattens it as a safety net).
// `templateText`: ready-made, deterministic prose for {{1}}; it takes priority over
// proseFallback and is also preserved in the async retry. The caller guarantees the limit.
export async function sendWhatsAppProactive(to, text, { templateName = marca().templatesWhatsApp.notificacao, lang = 'pt_BR', params = null, proseFallback = null, templateText = null, retryUnknown = true, tracking } = {}) {
  const viaTemplate = async (reason) => {
    let outText = templateText === null ? text : String(templateText);
    // Only rewrites to prose when it's a template with 1 variable ({{1}}=content).
    // With `params` (multi-variable) the formatting is already controlled by the caller.
    if (templateText === null && proseFallback && !params) {
      try {
        const rewritten = await proseFallback(text);
        if (rewritten && String(rewritten).trim()) outText = String(rewritten);
      } catch { /* keeps the original text */ }
    }
    await tracking?.start({ total: 1, recipient: to });
    try {
      const opaque = await tracking?.beforePart(0);
      const response = await sendWhatsAppTemplate(to, outText, { name: templateName, lang, params, opaque });
      const wamids = (response?.messages || []).map((m) => m.id).filter(id => typeof id === 'string' && id.trim());
      if (tracking && !wamids.length) throw Object.assign(new Error('WhatsApp template sem recibo'), { definitive: false });
      if (wamids.length) await tracking?.accepted(0, wamids[0]);
      return { via: 'template', reason, wamid: wamids[0] || null, wamids };
    } catch (error) { await tracking?.failed(0, error); throw error; }
  };

  // ── 1) Window known from OUR OWN data (the real fix) ──
  // `undefined` = couldn't tell (missing hook or database error): then it follows the
  // old flow, trying session. We only divert to the template when we're
  // sure the window has closed.
  let lastIn;
  if (waHooks.lastInboundAt) {
    try { lastIn = (await waHooks.lastInboundAt(to)) || null; } catch { lastIn = undefined; }
  }
  if (lastIn !== undefined) {
    const idadeMs = lastIn ? Date.now() - new Date(lastIn).getTime() : Infinity;
    if (!(idadeMs < WA_WINDOW_MS)) return viaTemplate('janela-fechada');
  }

  try {
    const wamids = await sendText(to, text, { requireReceipt: !retryUnknown || !!tracking, tracking });
    // Stores it for the safety net: if Meta rejects it later (131047), the status
    // webhook resends this via template.
    // A failure for one part is not proof that all other parts failed. Only
    // single-part sends may retry the whole body on a 131047 status webhook.
    if (!tracking && wamids.length === 1 && prepararTextoWa(text).length === 1) {
      rememberProactive(wamids, { to, text, templateName, lang, params, proseFallback, templateText });
    }
    return { via: 'session', wamid: wamids[0] || null, wamids };
  } catch (e) {
    if (e?.partial) throw e; // Some parts may exist: never resend the full body.
    const msg = String(e?.message || e).toLowerCase();
    // Closed 24h window (error 131047 / "re-engagement" / "outside allowed
    // window" / "24 hours"): only a template solves it. Any other error also falls
    // back to the template as a safety net; if the template also fails, it propagates the
    // original error (invalid number, channel down, etc.).
    const closedWindow = /131047|re-?engag|outside|allowed window|24 ?hour|last replied/.test(msg);
    if(!closedWindow&&!retryUnknown)throw e; // uncertain curation: do not risk a second send
    try {
      return await viaTemplate(closedWindow ? 'janela-fechada-sincrona' : 'erro-sessao');
    } catch (templateError) {
      // A known session rejection followed by an uncertain template attempt
      // must remain uncertain; the first error cannot hide the later send.
      if (!closedWindow) templateError.definitive = false;
      throw templateError;
    }
  }
}

// 24h window decided from OUR OWN data (whatsapp_links.last_inbound_at), the
// same way sendWhatsAppProactive does internally. Returns true/false
// when it's possible to tell and `null` when it isn't (missing hook or database error);
// the caller decides what to do with the uncertainty.
export async function whatsappWindowOpen(to) {
  if (!waHooks.lastInboundAt) return null;
  let lastIn;
  try { lastIn = (await waHooks.lastInboundAt(to)) || null; } catch { return null; }
  if (!lastIn) return false;
  return Date.now() - new Date(lastIn).getTime() < WA_WINDOW_MS;
}

// Sends a DOCUMENT proactively (outside of a conversation turn). Only a session
// path exists: an approved template can't carry a file. That's why the window is
// checked BEFORE, and a closed window becomes an explicit error instead of a message
// accepted with HTTP 200 and silently rejected later (131047).
export async function sendWhatsAppDocument(to, buffer, filename = 'documento.pdf', mime = 'application/pdf', caption = null) {
  if ((await whatsappWindowOpen(to)) === false) throw Object.assign(new Error('WhatsApp fora da janela de 24h: documento não pode ser enviado'), { definitive: true, closedWindow: true });
  const id = await uploadMedia(buffer, mime, filename);
  const document = { id, filename, ...(caption ? { caption: String(caption).slice(0, 1024) } : {}) };
  const r = await graph(`${PHONE_ID()}/messages`, { messaging_product: 'whatsapp', to, type: 'document', document });
  return (r?.messages || []).map((m) => m.id).filter((w) => typeof w === 'string' && w.trim());
}

// ── Safety net: async 131047 ──
// Meta ACCEPTS (HTTP 200 + wamid) a session message sent outside the 24h
// window and only rejects it LATER, via the status webhook, with error 131047. Without this the
// harness would consider the message delivered and it would silently disappear. We store the
// content of each proactive SESSION send by wamid; when the status comes back
// `failed/131047`, we resend via template. A template NEVER enters the map, so
// there is no resend loop by construction.
const pendingProactive = new Map();
const PENDING_TTL_MS = 30 * 60_000;

function rememberProactive(wamids, rec) {
  if (!Array.isArray(wamids) || !wamids.length) return;
  rec.at = Date.now();
  for (const w of wamids) if (w) pendingProactive.set(w, rec);
  // Pruning by TTL/size: the status arrives within seconds, this is just a backstop.
  if (pendingProactive.size > 500) {
    const corte = Date.now() - PENDING_TTL_MS;
    for (const [k, v] of pendingProactive) if (v.at < corte) pendingProactive.delete(k);
  }
}

// Returns the send a SINGLE time (a long message becomes several wamids that
// point to the same record; only the first one to fail triggers the resend).
function takeProactive(wamid) {
  const rec = pendingProactive.get(wamid);
  if (!rec) return null;
  pendingProactive.delete(wamid);
  if (rec.done) return null;
  if (Date.now() - rec.at > PENDING_TTL_MS) return null;
  rec.done = true;
  return rec;
}

export async function retryProactiveAsTemplate(wamid, recipient) {
  const rec = takeProactive(wamid);
  if (!rec) return false;
  const to = recipient || rec.to;
  let outText = rec.templateText == null ? rec.text : String(rec.templateText);
  if (rec.templateText == null && rec.proseFallback && !rec.params) {
    try {
      const rewritten = await rec.proseFallback(rec.text);
      if (rewritten && String(rewritten).trim()) outText = String(rewritten);
    } catch { /* keeps the original text */ }
  }
  await sendWhatsAppTemplate(to, outText, { name: rec.templateName, lang: rec.lang, params: rec.params });
  console.warn(`[whatsapp] 131047 at ${wamid}: window closed, resent via template to ${to}`);
  return true;
}

// Uploads a binary to WhatsApp (multipart) and returns the media id, used
// to send media WITHOUT exposing a public link (private bucket mode).
async function uploadMedia(buffer, mime, filename = 'media') {
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', mime || 'application/octet-stream');
  form.append('file', new Blob([buffer], { type: mime || 'application/octet-stream' }), filename);
  const r = await fetch(`${GRAPH}/${PHONE_ID()}/media`, {
    method: 'POST',
    headers: { authorization: `Bearer ${process.env.WA_TOKEN}` },
    body: form,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.id) throw new Error(`wa upload: ${j?.error?.message || r.status}`);
  return j.id;
}

// Downloads a card's image (URL on OUR OWN domain, e.g. /api/img?k=…) and uploads it to
// WhatsApp, returning the media id. Only accepts our own origin: the URL comes from our
// product image cache, and fetching an arbitrary host here would open up SSRF.
// A WhatsApp image message only accepts JPEG and PNG; the cache stores whatever the
// store served (webp is common in e-commerce), so an unsupported type returns an error
// and the card goes out WITHOUT a photo, instead of becoming a broken card.
async function uploadCardImage(imageUrl) {
  const url = absUrl(imageUrl);
  if (!url.startsWith(`${PUBLIC_BASE()}/`)) throw new Error('imagem de card fora do domínio próprio');
  const r = await fetch(url);
  if (!r.ok) throw new Error(`imagem do card: HTTP ${r.status}`);
  const ct = (r.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (ct !== 'image/jpeg' && ct !== 'image/png') throw new Error(`tipo não aceito no card: ${ct || 'desconhecido'}`);
  const buf = Buffer.from(await r.arrayBuffer());
  return uploadMedia(buf, ct, ct === 'image/png' ? 'card.png' : 'card.jpg');
}

// Delivers media attachments (image / audio). If getMedia returns the bytes
// (private bucket mode, no public link), uploads and sends by media id;
// otherwise (disk mode) falls back to the static public link.
// Returns HOW MANY Meta messages actually went out (each attachment is a message;
// the card fallback can generate two; a failed attachment doesn't count) — this is what
// per-message billing uses. A failed attachment doesn't generate a message and isn't charged.
async function sendAttachments(to, attachments, getMedia) {
  let sent = 0;
  for (const a of attachments || []) {
    try {
      const bytes = getMedia ? await getMedia(a).catch(() => null) : null;
      if (a.type === 'image') {
        const image = bytes ? { id: await uploadMedia(bytes.buffer, bytes.contentType || a.mime) } : { link: absUrl(a.url) };
        await graph(`${PHONE_ID()}/messages`, { messaging_product: 'whatsapp', to, type: 'image', image });
        sent++;
      } else if (a.type === 'audio') {
        try {
          const audio = bytes ? { id: await uploadMedia(bytes.buffer, bytes.contentType || a.mime) } : { link: absUrl(a.url) };
          await graph(`${PHONE_ID()}/messages`, { messaging_product: 'whatsapp', to, type: 'audio', audio });
          sent++;
        } catch (err) {
          // The text reply ("sent as voice") already went out; without this the person wouldn't
          // receive anything the voice said. Sends the speech as text.
          if (!a.fala) throw err;
          console.error('[whatsapp] audio not delivered, falling back to text:', err?.message ?? err);
          sent += (await sendText(to, `Não consegui mandar o áudio, vai em texto:\n\n${a.fala}`)).length;
        }
      } else if (a.type === 'document') {
        // Document (.docx/.pdf/etc.): the bucket URL is authenticated (WhatsApp
        // wouldn't be able to download it by link), so it ALWAYS uploads the bytes and sends by
        // media id, with the file name so it shows up correctly in the chat.
        const filename = a.filename || a.name || 'documento';
        if (bytes) {
          const id = await uploadMedia(bytes.buffer, bytes.contentType || a.mime, filename);
          await graph(`${PHONE_ID()}/messages`, { messaging_product: 'whatsapp', to, type: 'document', document: { id, filename } });
          sent++;
        } else {
          // Notice of our own failure: enters as a system message, is NOT charged.
          await sendText(to, `Gerei o arquivo "${filename}", mas não consegui anexar aqui. Você consegue baixar em ${hostDaMarca()}.`);
        }
      } else if (a.type === 'card') {
        // Card = cta_url interactive message (photo in header + body + button that
        // opens the link). Only possible with a URL; if anything fails, falls back
        // (photo + text with the link) so the product isn't lost.
        const bodyText = ([a.title, a.body].filter(Boolean).join('\n') || a.title || ' ').slice(0, 1024);
        // Header photo goes by MEDIA ID, same as the other media in this function.
        // With a raw `link`, Meta was the one downloading the image, and when that
        // fetch failed the message was rejected AFTER the HTTP 200 (status webhook,
        // 131053): the try/catch below never fired and the card silently disappeared.
        // By uploading the bytes, any image problem is synchronous and handled here.
        let headerId = null;
        if (a.image) {
          headerId = await uploadCardImage(a.image).catch((e) => {
            console.warn('[whatsapp] card without photo:', e?.message ?? e);
            return null;
          });
        }
        try {
          if (!a.url) throw new Error('card sem url');
          const interactive = {
            type: 'cta_url',
            body: { text: bodyText },
            action: { name: 'cta_url', parameters: { display_text: (a.buttonText || 'Ver produto').slice(0, 20), url: a.url } },
          };
          if (headerId) interactive.header = { type: 'image', image: { id: headerId } };
          await graph(`${PHONE_ID()}/messages`, { messaging_product: 'whatsapp', to, type: 'interactive', interactive });
          sent++;
        } catch (err) {
          // The fallback NEVER reuses an image that already failed: it only sends a
          // photo if the upload had succeeded. What can't be missing is the product (text+link).
          if (headerId) { await graph(`${PHONE_ID()}/messages`, { messaging_product: 'whatsapp', to, type: 'image', image: { id: headerId, caption: bodyText.slice(0, 1024) } }); sent++; }
          sent += (await sendText(to, a.url ? `${a.title ? a.title + '\n' : ''}${a.url}` : bodyText)).length;
        }
      }
    } catch (e) { console.error('[whatsapp] attachment:', e?.message ?? e); }
  }
  return sent;
}

// Downloads a received media (audio/image) by id: gets the URL and fetches the binary.
async function downloadMedia(mediaId) {
  const meta = await fetch(`${GRAPH}/${mediaId}`, {
    headers: { authorization: `Bearer ${process.env.WA_TOKEN}` },
  }).then((r) => r.json());
  if (!meta?.url) throw new Error('mídia sem url');
  const bin = await fetch(meta.url, { headers: { authorization: `Bearer ${process.env.WA_TOKEN}` } });
  const buf = Buffer.from(await bin.arrayBuffer());
  return { buffer: buf, mime: meta.mime_type || 'application/octet-stream' };
}

// Native interactive list: the user taps the name to switch assistants.
async function sendAgentList(to, agents, header) {
  const rows = agents.slice(0, 10).map((a) => ({
    id: `agent:${a.id}`,
    title: (a.name || 'Assistente').slice(0, 24),
    description: (a.goal || '').slice(0, 72),
  }));
  await graph(`${PHONE_ID()}/messages`, {
    messaging_product: 'whatsapp', to, type: 'interactive',
    interactive: {
      type: 'list',
      body: { text: header || 'Com qual assistente você quer falar?' },
      action: { button: 'Assistentes', sections: [{ title: 'Seus assistentes', rows }] },
    },
  });
}

// Marks the message as read (best-effort, just for UX).
// Marks the message as read AND turns on the "typing..." indicator in the same call
// (Cloud API: status:'read' + typing_indicator). The "typing" goes away on its own
// when we send the reply, or after ~25s if processing takes longer than that.
async function markRead(messageId) {
  if (!messageId) return;
  await graph(`${PHONE_ID()}/messages`, {
    messaging_product: 'whatsapp', status: 'read', message_id: messageId,
    typing_indicator: { type: 'text' },
  }).catch(() => {});
}

// ── Webhook verification (configured in the Meta dashboard) ──
// GET with hub.mode=subscribe & hub.verify_token=<ours>; we return hub.challenge.
export function verifyChallenge(params) {
  const mode = params.get('hub.mode');
  const token = params.get('hub.verify_token');
  const challenge = params.get('hub.challenge');
  if (mode === 'subscribe' && token && token === process.env.WA_VERIFY_TOKEN) return challenge || '';
  return null;
}

// POST signature: HMAC-SHA256 of the RAW body with the app secret (header
// x-hub-signature-256: "sha256=<hex>"). WITHOUT a configured secret, REJECT: the
// signature is the only authentication on this public endpoint, and letting it
// through for lack of configuration turned a forgotten env var into an open door
// for anyone to forge a message/status and trigger the assistant as if they were the owner.
export function verifySignature(rawBody, signature) {
  const secret = process.env.WA_APP_SECRET;
  if (!secret) { console.error("[whatsapp] WA_APP_SECRET missing: webhook rejected (fail-closed)"); return false; }
  if (!signature) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  try {
    const a = Buffer.from(expected), b = Buffer.from(signature);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch { return false; }
}

// Injects the server's deps (avoids circular import):
//   runConversation(agent, userId, text) -> reply
//   loadAgent(agentId, userId) -> agent   (validates ownership)
//   db = { getWhatsAppLink, listAgents, setWhatsAppActiveAgent }
// avisoCanal = { idiomaDe, registrar } (aviso-canal.mjs): language of the error notice and
// its registration in the WhatsApp thread history.
export function createWhatsAppHandler({ runConversation, reactionConfirm, loadAgent, db, transcribe, getMedia, inbox = null, aoReprovar = null, avisoCanal = {}, publico = null }) {
  const seen = new Set(); // ids already processed (dedup of Meta retries)
  const avisar = criarAvisoCanal({ rotulo: 'whatsapp', ...avisoCanal });

  const DEBOUNCE_MS = Number(process.env.WA_DEBOUNCE_MS || 3000);
  // Media is downloaded (and audio transcribed) BEFORE it enters the buffer, which
  // can take longer than the debounce. Without holding the flush, a text sent just
  // before a voice note was answered alone and the audio became a separate turn
  // (2026-10-05: "translate it" ran on the wrong content). The hold has a ceiling so
  // a stuck download never silences the person.
  const MEDIA_HOLD_MS = Number(process.env.WA_MEDIA_HOLD_MS || 30000);
  const preparing=new Map(); // phone -> media messages still being prepared
  const holdBurst=from=>preparing.set(from,(preparing.get(from)||0)+1);
  const releaseBurst=from=>{const n=(preparing.get(from)||1)-1;if(n>0)preparing.set(from,n);else preparing.delete(from);};
  const MAX_BATCH=20,MAX_IMAGES=10,MAX_FILES=3;
  // Every queue/token belongs to the original phone, account AND assistant.
  const buffers=new Map(),running=new Map(),loaded=new Set(),turns=new Set();
  const INTERJECT_ON=process.env.WA_INTERJECT!=='0';
  const configuredHeartbeatMs=Number(process.env.WA_TURN_HEARTBEAT_MS??process.env.TURN_HEARTBEAT_MS??60000);
  const TURN_HEARTBEAT_MS=Number.isFinite(configuredHeartbeatMs)&&configuredHeartbeatMs>0?configuredHeartbeatMs:0;
  const scope=(from,p)=>JSON.stringify([from,p.userId,p.agentId]);
  const ids=parts=>parts.map(p=>p.inboxId).filter(Boolean);
  const inputIds=parts=>parts.map(p=>p.inputId).filter(Boolean);
  let closing=false,pumpPromise=null,pollTimer=null,lastPrune=0;
  const failInbox=async(parts,reason)=>{const values=ids(parts);if(values.length)await inbox.uncertain(values,reason);};
  const releaseParts=parts=>{for(const id of ids(parts))loaded.delete(id);};
  async function sameRecipient(from,userId){const link=await db.getWhatsAppLink(from);return !!link?.enabled&&link.user_id===userId;}
  async function takePending(token){
    const parts=token.pending;
    if(!parts.length||parts.some(p=>p.images?.length||p.files?.length||p.confirmationTarget!==undefined))return null;
    const text=parts.map(p=>p.text).filter(Boolean).join('\n').trim();if(!text)return null;
    // Detach before the await; newer arrivals stay in their own pending array.
    token.pending=[];
    try{if(inbox)await inbox.begin(ids(parts));}
    catch(e){token.pending.unshift(...parts);throw e;}
    token.consumed.push(...parts);return {text};
  }
  function scheduleFlush(key){
    const b=buffers.get(key);if(!b||closing)return;
    clearTimeout(b.timer);b.timer=setTimeout(()=>launchFlush(key),DEBOUNCE_MS);
  }
  function launchFlush(key){
    const work=flush(key);turns.add(work);
    work.catch(e=>console.error('[whatsapp] flush:',e?.code||e?.name||'error')).finally(()=>turns.delete(work));
    return work;
  }
  async function flush(key){
    if(closing)return;
    const b=buffers.get(key);if(!b)return;
    if(running.has(key)||(preparing.has(b.from)&&Date.now()-b.since<MEDIA_HOLD_MS)){scheduleFlush(key);return;}
    clearTimeout(b.timer);buffers.delete(key);
    let count=0,imageCount=0,fileCount=0;
    for(const p of b.parts){if(count&&(count>=MAX_BATCH||imageCount+(p.images?.length||0)>MAX_IMAGES||fileCount+(p.files?.length||0)>MAX_FILES))break;count++;imageCount+=p.images?.length||0;fileCount+=p.files?.length||0;}
    if(count<b.parts.length){const remaining=b.parts.slice(count);b.parts=b.parts.slice(0,count);buffers.set(key,{...b,parts:remaining,timer:null});}
    const {from}=b,token={pending:[],consumed:[...b.parts]};running.set(key,token);
    let finishHeartbeat=async()=>{},fase='turno',text='';
    try{
      const liveAgent=await loadAgent(b.agentId,b.userId);
      if(!await sameRecipient(from,b.userId)||!liveAgent){
        if(inbox)await inbox.ignore(ids(b.parts),'recipient_or_agent_changed');return;
      }
      b.agent=liveAgent;
      if(inbox)await inbox.begin(ids(b.parts));
      const images=b.parts.flatMap(p=>p.images||[]),files=b.parts.flatMap(p=>p.files||[]);
      text=b.parts.map(p=>p.text).filter(Boolean).join('\n')||notaMidiaSemTexto({images:images.length,files:files.length});
      finishHeartbeat=startTurnHeartbeat({afterMs:TURN_HEARTBEAT_MS,send:async()=>{
        if(!await sameRecipient(from,b.userId))return;
        if(inbox)await inbox.assertRunning(ids(token.consumed));
        const wamids=await sendText(from,TURN_HEARTBEAT_TEXT);
        if(db?.saveWaMsgRef)for(const w of wamids)db.saveWaMsgRef({wamid:w,userId:b.userId,agentId:b.agentId,direction:'out',body:TURN_HEARTBEAT_TEXT}).catch(()=>{});
      },onError:e=>console.warn('[whatsapp] heartbeat:',e?.code||e?.name||'error')});
      const res=await runConversation(b.agent,b.userId,text,images.length?images:null,files.length?files:null,{
        pollNewUserMsg:INTERJECT_ON?()=>takePending(token):null,
        confirmationTarget:batchedConfirmationTarget(b.parts.map(p=>p.confirmationTarget)),
        confirmationInputId:inputIds(b.parts).length?'whatsapp:'+inputIds(b.parts).join('|'):null,
      });
      await finishHeartbeat();
      if(!await sameRecipient(from,b.userId))throw Object.assign(Error('Recipient changed'),{code:'WA_RECIPIENT_CHANGED'});
      if(inbox)await inbox.assertRunning(ids(token.consumed));
      // From here on the turn is done and the reply is in the history: a failure
      // is delivery only. Each part that fails on the network is resent (never
      // the turn); if it won't go, the person gets the delivery notice (05/10/2026).
      fase='entrega';
      const reply=typeof res==='string'?res:res?.text,attachments=typeof res==='string'?[]:(res?.attachments||[]);
      let cobraveis=0,naoEntregue=false;
      const saveRefs=(wamids,body)=>{if(db?.saveWaMsgRef)for(const w of wamids)db.saveWaMsgRef({wamid:w,userId:b.userId,agentId:b.agentId,direction:'out',body}).catch(()=>{});};
      if(reply||!attachments.length)for(const part of channelReplyParts(res,'(sem resposta)')){
        let wamids=null;
        try{wamids=await sendText(from,part.text,{requireReceipt:!!inbox||!!part.id,reenvio:true});}
        catch(e){naoEntregue=true;console.error('[whatsapp] reply not delivered:',e?.code||e?.name||'error');saveRefs(e?.wamids||[],part.text);cobraveis+=e?.wamids?.length||0;continue;}
        cobraveis+=wamids.length;
        await part.onReplySent?.({channel:'whatsapp',messageIds:wamids});
        saveRefs(wamids,part.text);
      }
      cobraveis+=await sendAttachments(from,attachments,getMedia);
      billWa(b.userId,cobraveis,{agentId:b.agentId});
      if(naoEntregue)throw Object.assign(Error('Reply not delivered'),{code:'WA_REPLY_NOT_DELIVERED'});
      if(inbox)await inbox.complete(ids(token.consumed));
    }catch(e){
      await finishHeartbeat();console.error('[whatsapp] conversation error:',e?.code||e?.name||'error');
      if(inbox)await failInbox(token.consumed,e?.code==='WA_RECIPIENT_CHANGED'?'recipient_changed':e?.code==='WA_REPLY_NOT_DELIVERED'?'delivery_failed':'execution_or_delivery_uncertain').catch(()=>{});
      // Never replay the turn: `turno` asks whether to try again, `entrega` says the
      // ready reply did not arrive. Both notices enter the thread history, so the
      // next "tenta de novo" points to the right request. The inbox keeps the
      // uncertain state for operators. A lost inbox lease or new recipient: silence.
      if(e?.code!=='WA_RECIPIENT_CHANGED'&&e?.code!=='WA_INBOX_CONFLICT'&&b.agent&&await sameRecipient(from,b.userId).catch(()=>false))
        await avisar({agent:b.agent,userId:b.userId,tipo:fase,mensagem:text,enviar:t=>sendText(from,t)});
    }finally{
      await finishHeartbeat();running.delete(key);releaseParts(token.consumed);
      for(const part of token.pending)await enqueue(from,part,{interject:false});
      if(buffers.has(key))scheduleFlush(key);
    }
  }
  async function enqueue(from,part,{interject=true}={}){
    const key=scope(from,part),tok=running.get(key);
    if(tok&&INTERJECT_ON&&interject){tok.pending.push(part);return;}
    let b=buffers.get(key);
    if(b&&!tok&&(b.parts.length>=MAX_BATCH||b.parts.reduce((n,p)=>n+(p.images?.length||0),0)+(part.images?.length||0)>MAX_IMAGES||b.parts.reduce((n,p)=>n+(p.files?.length||0),0)+(part.files?.length||0)>MAX_FILES)){
      launchFlush(key);return enqueue(from,part,{interject});
    }
    if(!b){b={from,userId:part.userId,agentId:part.agentId,agent:part.agent,parts:[],timer:null,since:Date.now()};buffers.set(key,b);}
    b.parts.push(part);scheduleFlush(key);
  }
  async function restoreBuffered(){
    for(const entry of await inbox.buffered(PHONE_ID(),[...loaded])){
      if(loaded.has(entry.id))continue;
      const p=entry.prepared;
      const agent=await loadAgent(p.agentId,p.userId);
      if(!agent||!await sameRecipient(p.from,p.userId)){await inbox.ignore([entry.id],'recipient_or_agent_changed');continue;}
      loaded.add(entry.id);
      await enqueue(p.from,{...p,agent,inboxId:entry.id,files:p.files?.map(f=>({...f,buffer:Buffer.from(f.data,'base64')}))});
    }
  }
  async function pump(){
    if(!inbox||closing||pumpPromise)return pumpPromise;
    pumpPromise=(async()=>{
      if(!inbox.isOwner()){
        if(turns.size)return;
        await inbox.acquire();for(const b of buffers.values())clearTimeout(b.timer);buffers.clear();for(const b of esperaPublico.values())clearTimeout(b.timer);esperaPublico.clear();loaded.clear();
      }
      await inbox.reconcile([...loaded]);
      await restoreBuffered();
      for(let i=0;i<20&&!closing;i++){
        const entry=await inbox.claim(PHONE_ID());if(!entry)break;if(entry.unreadable)continue;
        try{
          const buffered=await handleMessage({...entry.message,_inboxId:entry.id,_receivedUserId:entry.recipient});
          if(!buffered)await inbox.complete([entry.id]);
        }catch(e){await inbox.uncertain([entry.id],'preparation_or_reply_uncertain').catch(()=>{});console.error('[whatsapp-inbox] prepare:',e?.code||e?.name||'error');}
      }
      if(Date.now()-lastPrune>3600_000){await inbox.prune();lastPrune=Date.now();}
    })().catch(e=>console.error('[whatsapp-inbox] pump:',e?.code||e?.name||'error')).finally(()=>{pumpPromise=null;});
    return pumpPromise;
  }

  // Unknown on a number with public support (publico-canal.mjs): the one who
  // replies is the public assistant, outside the pump (the turn calls the model) and
  // without any of the owner's flow (menu, @name, reaction, confirmation, msg reference).
  // Chopped-up messages become a single turn: waits JUNTAR_MS after the last one (at
  // most JUNTAR_MAX_MS since the first), and whatever arrives during a turn waits for
  // it to finish and joins the next one. One turn per phone number. Phase 1: text only.
  const JUNTAR_MS=Number(process.env.WA_PUBLICO_JUNTAR_MS??1500),JUNTAR_MAX_MS=Number(process.env.WA_PUBLICO_JUNTAR_MAX_MS??5000);
  const filaPublico=new Map(),esperaPublico=new Map();
  function atenderPublico(msg,from){
    if(msg._inboxId)loaded.add(msg._inboxId);
    let b=esperaPublico.get(from);
    if(!b){b={msgs:[],timer:null,desde:Date.now()};esperaPublico.set(from,b);}
    b.msgs.push(msg);clearTimeout(b.timer);b.vencido=false;
    if(!closing)b.timer=setTimeout(()=>{b.vencido=true;soltarPublico(from);},Math.max(0,Math.min(JUNTAR_MS,b.desde+JUNTAR_MAX_MS-Date.now())));
    return true;
  }
  function soltarPublico(from){
    const b=esperaPublico.get(from);if(!b||closing||filaPublico.has(from))return;
    esperaPublico.delete(from);clearTimeout(b.timer);
    const inboxIds=b.msgs.map(m=>m._inboxId).filter(Boolean);
    const work=(async()=>{
      try{
        const mensagem=b.msgs.filter(m=>m.type==='text').map(m=>(m.text?.body||'').trim()).filter(Boolean).join('\n');
        if(mensagem||b.msgs.some(m=>m.type!=='text'&&m.type!=='reaction')){
          const r=mensagem?await publico.turno({endereco:from,mensagem}):{text:PUBLICO_SO_TEXTO};
          const opts={requireReceipt:inboxIds.length>0,reenvio:true};
          const wamids=r?.saidas?.length?await sendSaidas(from,r.saidas,opts):r?.text?await sendText(from,r.text,opts):[];
          if(mensagem&&r?.motivo!=='sem_saldo')billWa(r?.userId,wamids.length,{agentId:r?.agentId});
        }
        if(inboxIds.length)await inbox.complete(inboxIds);
      }catch(e){
        console.error('[whatsapp] public support:',e?.code||e?.name||'error');
        if(inboxIds.length)await inbox.uncertain(inboxIds,'publico_falhou').catch(()=>{});
      }finally{for(const id of inboxIds)loaded.delete(id);}
    })();
    filaPublico.set(from,work);turns.add(work);
    work.finally(()=>{turns.delete(work);filaPublico.delete(from);soltarSeVencido(from);});
    return true;
  }
  // At the end of a turn: whatever arrived during it goes out right away if the wait has already expired.
  function soltarSeVencido(from){const b=esperaPublico.get(from);if(b&&b.vencido)soltarPublico(from);}

  const MEDIA_TYPES=new Set(['audio','voice','image','document']);
  async function handleMessage(msg) {
    const media=!!msg.from&&MEDIA_TYPES.has(msg.type);
    if(media)holdBurst(msg.from);
    try{return await prepareMessage(msg);}finally{if(media)releaseBurst(msg.from);}
  }
  async function prepareMessage(msg) {
    const from = msg.from; // sender phone number in E.164 without '+', e.g. "5511999998888"
    if (!from) return;
    const sendReply=text=>sendText(from,text,{requireReceipt:!!msg._inboxId}).catch(e=>{if(msg._inboxId)throw e;});
    const sendMenu=(agents,header)=>sendAgentList(from,agents,header).catch(e=>{if(msg._inboxId)throw e;});
    if (msg.id && !msg._inboxId) {
      // Two layers: the Set cuts off the retry that arrives while the process is up
      // (without going to the database), and `claimWaMsg` covers what the Set doesn't
      // cover: restart, deploy and the `clear()` of the in-memory backstop. Without the
      // durable layer, Meta's retry after a deploy made the same message run again.
      if (seen.has(msg.id)) return;
      seen.add(msg.id);
      if (seen.size > 5000) seen.clear(); // in-memory backstop
      if (db?.claimWaMsg && !(await db.claimWaMsg(msg.id))) return;
    }

    // Stamps the 24h window BEFORE any routing: from Meta's point of view any
    // inbound reopens the window, including what here falls into the menu, into
    // unsupported media or into an unlinked number.
    if (db?.touchWaInbound) db.touchWaInbound(from).catch(() => {});

    const link = await db.getWhatsAppLink(from);
    if(msg._inboxId&&(link?.enabled?link.user_id:null)!==msg._receivedUserId){await inbox.ignore([msg._inboxId],'recipient_changed');return true;}
    if (!link || !link.enabled) {
      // Proof of ownership: it's HERE that a number starts to count for an account. The
      // person requests the connection in the app, gets a code and sends it from this
      // line. Since the message actually arrives from this phone, ownership is proven;
      // typing the number in the app proves nothing (see POST /api/connect/whatsapp).
      const texto = msg.type === 'text' ? (msg.text?.body || '') : '';
      let claim = null;
      if (texto && db?.consumeWaClaim) {
        try { claim = await db.consumeWaClaim(from, texto); }
        catch (e) { console.error('[whatsapp] consumeWaClaim:', e?.message ?? e); }
      }
      if (claim?.link) {
        await sendReply( `Pronto! Número confirmado e conectado à sua conta do ${marca().nome}. Pode falar comigo por aqui. 🙂`);
        return;
      }
      if (publico && await publico.atende()) return atenderPublico(msg, from);
      await sendReply( `Oi! Pra falar comigo por aqui, entre em ${hostDaMarca()}, faça login e conecte seu número de WhatsApp (com DDD e o 55 na frente).`);
      return;
    }
    const agents = await db.listAgents(link.user_id);
    if (!agents.length) {
      await sendReply( `Você ainda não tem nenhum assistente. Crie um em ${hostDaMarca()} e volte aqui.`);
      return;
    }

    // Reaction (👍/👎) on a message: confirms/cancels a pending action without
    // text. Thumbs up confirms a regular action; for irreversible ones the server asks for text.
    if (msg.type === 'reaction') {
      const emoji = msg.reaction?.emoji || '';
      const positive = ['👍', '✅', '👌', '💯'].some((e) => emoji.includes(e));
      const negative = ['👎', '❌'].some((e) => emoji.includes(e));
      if (!positive && !negative) return; // reaction removed or neutral emoji
      const activeId = link.active_agent_id || agents[0].id;
      const agent = await loadAgent(activeId, link.user_id);
      if (!agent) return;
      try {
        const res = await reactionConfirm?.(agent, link.user_id, positive, { channel: 'whatsapp', messageId: msg.reaction?.message_id || null, inputId:msg.id ? 'whatsapp:'+msg.id : null });
        if (res) {
          const reply = typeof res === 'string' ? res : res?.text;
          const atts = typeof res === 'string' ? [] : (res?.attachments || []);
          let cobraveis = 0;
          if (reply) {
            for (const part of channelReplyParts(res)) {
              const wamids = await sendText(from, part.text, {requireReceipt:!!msg._inboxId||!!part.id});
              cobraveis += wamids.length;
              await part.onReplySent?.({channel:'whatsapp',messageIds:wamids});
            }
          }
          cobraveis += (await sendAttachments(from, atts, getMedia).catch(() => 0)) || 0;
          billWa(link.user_id, cobraveis, { agentId: agent.id });
        }
      } catch (e) { if(msg._inboxId)throw e; console.error('[whatsapp] reaction:', e?.message ?? e); }
      return;
    }

    // Extracts the text (or the list tap interaction).
    let text = '';
    let images = null; // images attached to the turn (vision)
    let files = null; // documents (PDF) attached to the turn
    let voz = false; // text came from audio transcription
    if (msg.type === 'text') {
      text = (msg.text?.body || '').trim();
    } else if (msg.type === 'interactive') {
      const r = msg.interactive?.list_reply || msg.interactive?.button_reply;
      const id = r?.id || '';
      if (id.startsWith('agent:')) {
        const a = agents.find((x) => x.id === id.slice('agent:'.length));
        if (a) {
          await db.setWhatsAppActiveAgent(from, a.id);
          await sendReply( `Agora falando com *${a.name}*. Pode mandar.`);
        }
        return;
      }
      text = (r?.title || '').trim();
    } else if ((msg.type === 'audio' || msg.type === 'voice') && transcribe) {
      // Audio/voice note: downloads the binary, transcribes (STT) and proceeds as text.
      await markRead(msg.id);
      const mediaId = msg.audio?.id || msg.voice?.id;
      try {
        const { buffer, mime } = await downloadMedia(mediaId);
        text = (await transcribe(buffer, mime, link.user_id)).trim();
      } catch (e) {
        const m = String(e?.message ?? e);
        if (m === 'STT_DISABLED') {
          await sendReply( 'A transcrição de áudio está desligada nas suas configurações. Liga em Conexões > Mídia no app, ou me manda por texto. 🙂');
          return;
        }
        console.error('[whatsapp] stt:', m);
        await sendReply( 'Não consegui entender esse áudio. Pode mandar de novo ou escrever?');
        return;
      }
      if (!text) { await sendReply( 'Não consegui entender esse áudio. Pode repetir?'); return; }
      voz = true;
    } else if (msg.type === 'image') {
      // Received image: downloads the binary and sends it to the model to understand (vision).
      // The image caption (if any) becomes the request; otherwise, a generic request.
      await markRead(msg.id);
      try {
        const { buffer, mime } = await downloadMedia(msg.image?.id);
        images = [{ mimeType: mime, data: buffer.toString('base64') }];
      } catch (e) {
        console.error('[whatsapp] image:', e?.message ?? e);
        await sendReply( 'Não consegui baixar essa imagem. Tenta mandar de novo?');
        return;
      }
      // No forced default here: if the burst has several photos without a caption, the
      // flush injects a single generic request (instead of repeating the phrase N times).
      text = (msg.image?.caption || '').trim();
    } else if (msg.type === 'document') {
      // Received document: if it's a PDF, downloads the binary and sends it for text
      // extraction (the server extracts and saves it in the owner's bucket). Other formats are not handled.
      await markRead(msg.id);
      const doc = msg.document || {};
      const dmime = doc.mime_type || '';
      const dname = doc.filename || 'documento';
      const okDoc = /\.(pdf|html?|txt|md|markdown|csv|tsv|json|xml|svg)$/i.test(dname)
        || /^(text\/|application\/(pdf|json|xml|xhtml\+xml)|image\/svg\+xml)/i.test(dmime);
      if (!okDoc) {
        await sendReply( 'Por enquanto consigo ler PDF e arquivos de texto (HTML, txt, markdown, csv) por aqui. 🙂');
        return;
      }
      try {
        const { buffer, mime } = await downloadMedia(doc.id);
        files = [{ name: dname, mime: dmime || mime || '', buffer }];
      } catch (e) {
        console.error('[whatsapp] document:', e?.message ?? e);
        await sendReply( 'Não consegui baixar esse PDF. Tenta mandar de novo?');
        return;
      }
      text = (doc.caption || '').trim();
    } else {
      await sendReply( 'Por enquanto consigo ler texto, áudio, imagem e PDF por aqui. 🙂');
      return;
    }
    if (!text && !images && !files) return;
    await markRead(msg.id);

    // Menu commands.
    const low = text.toLowerCase();
    if (low === '/agentes' || low === 'agentes' || low === 'menu' || low === '/menu') {
      await sendMenu( agents);
      return;
    }

    // "@name ..." at the start: switches the active agent and routes the remaining message.
    let activeId = link.active_agent_id;
    const m = text.match(/^@(\S+)\s*([\s\S]*)$/);
    if (m) {
      const want = slug(m[1]);
      const matches = agents.filter((a) => { const s = slug(a.name); return s === want || s.startsWith(want); });
      if (matches.length === 1) {
        activeId = matches[0].id;
        await db.setWhatsAppActiveAgent(from, activeId);
        text = m[2].trim();
        if (!text) { await sendReply( `Agora falando com *${matches[0].name}*. Pode mandar.`); return; }
      } else if (matches.length === 0) {
        await sendReply( `Não achei um assistente "${m[1]}".`);
        await sendMenu( agents);
        return;
      } else {
        await sendReply( `Tem mais de um assistente parecido com "${m[1]}". Escolhe na lista:`);
        await sendMenu( agents);
        return;
      }
    }

    // Active assistant for THIS channel (WhatsApp). If no one has chosen yet, it doesn't
    // bind on its own: with 1 assistant it uses that one; with several, it shows the menu
    // and waits for the choice (it used to default to the "newest" without the user
    // asking, which is what made a user end up on another assistant without ever having activated it).
    if (!activeId) {
      if (agents.length === 1) { activeId = agents[0].id; await db.setWhatsAppActiveAgent(from, activeId); }
      else {
        await sendMenu( agents, 'Você tem mais de um assistente. Com qual quer falar aqui no WhatsApp? (Depois é só mandar "menu" pra trocar.)');
        return;
      }
    }
    const agent = await loadAgent(activeId, link.user_id);
    if (!agent) {
      await sendReply( 'Não achei esse assistente. Escolhe outro:');
      await sendMenu( agents);
      return;
    }
    // Indexes this message by wamid (to resolve future citations) and, if it is
    // a reply/quote (WhatsApp's "reply" feature), resolves the quoted text
    // and injects it as context. The webhook only sends the id of the quoted msg
    // (msg.context.id), never the text, so we look it up in the index. Without this, the
    // quote disappears and the assistant doesn't know which message the user is referring to.
    if (msg.id && text && db?.saveWaMsgRef) {
      db.saveWaMsgRef({ wamid: msg.id, userId: link.user_id, agentId: activeId, direction: 'in', body: text }).catch(() => {});
    }
    // Stamps AFTER menu/@name (spoken command still counts) and the citation
    // index (which stores only the speech).
    if (voz) text = markVoiceInput(text);
    if (msg.context?.id && db?.getWaMsgRef) {
      try {
        const q = await db.getWaMsgRef(msg.context.id, link.user_id);
        if (q?.body) {
          const quoted = q.body.length > 1200 ? q.body.slice(0, 1200) + '…' : q.body;
          const quem = q.direction === 'out' ? 'uma mensagem anterior SUA (do assistente)' : 'uma mensagem anterior do próprio usuário';
          // CHANNEL_CTX_END (invisible char) marks where the envelope ends and
          // the person's speech begins. Without it, the confirmation guard read the
          // block as if it were the user and canceled any confirmation made
          // by citation (see userSaid in confirm.mjs).
          text = `[O usuário está usando o recurso "responder/citar" do WhatsApp para se referir a ${quem}: "${quoted}"]${CHANNEL_CTX_END}\n\n${text}`;
        }
      } catch (e) { console.error('[whatsapp] resolve quote:', e?.message ?? e); }
    }

    // Doesn't run right away: queues it in the grouping window. When the person stops
    // sending (~DEBOUNCE_MS), the flush joins everything and runs the conversation once.
    const prepared={from,inputId:msg.id,userId:link.user_id,agentId:activeId,text,images,
      files:files?.map(f=>({name:f.name,mime:f.mime,data:f.buffer.toString('base64')})),
      confirmationTarget:msg.context?{channel:'whatsapp',messageId:msg.context.id==null?null:String(msg.context.id)}:undefined};
    if(msg._inboxId){await inbox.prepare(msg._inboxId,prepared);loaded.add(msg._inboxId);}
    await enqueue(from,{...prepared,files,agent,inboxId:msg._inboxId});
    return true;
  }

  // Processes the webhook payload (already validated). Does NOT block the reply to Meta:
  // the server responds 200 right away and calls this in the background.
  // Do NOT call it "process": that shadows the global `process` within this scope
  // and breaks any `process.env` in here (that's what brought down boot).
  async function processPayload(payload) {
    try {
      for (const entry of payload.entry || []) {
        for (const change of entry.changes || []) {
          const value = change.value || {};
          // DELIVERY status (sent/delivered/read/failed): Meta sends it here,
          // separate from the messages. We used to discard it, so there was no way
          // to know if a proactive (template) message actually arrived; the API "accepts" and
          // silently drops it when it hits the marketing cap (code 131049).
          // We persist it to have real delivery tracking and know who to resend to.
          if (Array.isArray(value.statuses)) {
            for (const st of value.statuses) {
              const err = Array.isArray(st.errors) && st.errors[0] ? st.errors[0] : null;
              if (db.recordWaStatus) {
                await db.recordWaStatus({
                  wamid: st.id,
                  recipient: st.recipient_id || '',
                  status: st.status || '',
                  errorCode: err?.code ?? null,
                  errorTitle: err?.title ?? null,
                  errorMessage: err?.message || err?.error_data?.details || null,
                  statusAt: st.timestamp || null,
                  raw: st,
                }).catch((e) => console.error('[whatsapp] status:', e?.message ?? e));
              }
              // EVERY async rejection becomes a log entry. Meta accepts the message with
              // HTTP 200 and rejects it later, here in the status webhook; until 2026-09-05
              // only 131047 was being watched, so any other reason disappeared silently (the
              // record went to the table and no one read it). That's how 4 product
              // cards (131053) and 2 campaign sends (131049) got lost without
              // leaving a trace in the log between 2026-09-03 and 2026-09-04.
              avisarEntrega(st.id, st.status);
              if (String(st.status) === 'failed') {
                console.warn(`[whatsapp] REJECTED by Meta: destino=${st.recipient_id || '?'} code=${err?.code ?? '?'} "${err?.title || err?.message || 'sem detalhe'}" wamid=${st.id}`);
                // Whoever registered the send as 'sent' (born from Meta's 200, which is
                // just "accepted") corrects it now, at the only moment the truth
                // about delivery exists (event whatsapp_reprovada, eventos.mjs).
                if (aoReprovar) {
                  await Promise.resolve().then(() => aoReprovar({
                    wamid: st.id,
                    errorCode: err?.code ?? null,
                    errorTitle: err?.title ?? null,
                    errorMessage: err?.message || err?.error_data?.details || null,
                  })).catch((e) => console.error('[whatsapp] rejection notice:', e?.message ?? e));
                }
              }
              // Safety net for 131047: the session message was accepted with
              // HTTP 200 and got rejected now, asynchronously, because the 24h
              // window was closed. Resends the SAME content via template instead
              // of letting it disappear. Only applies to a proactive session message kept
              // in memory; a template never enters the map, so there's no loop.
              // There is NO automatic resend for the other purpose codes:
              // 131049 is Meta holding back marketing delivery, and insisting would be
              // spam; 131053 is media, resolved at the source (see sendAttachments).
              if (String(st.status) === 'failed' && Number(err?.code) === 131047) {
                retryProactiveAsTemplate(st.id, st.recipient_id)
                  .catch((e) => console.error('[whatsapp] retry template:', e?.message ?? e));
              }
            }
          }
          if (!value.messages) continue; // no messages (it was just a status update)
          // Only handle messages addressed to OUR number. When the app is
          // subscribed to a WABA shared with other numbers, Meta fans out every
          // WABA inbound to this webhook; without this filter the harness would
          // answer messages meant for other bots (e.g. a test sent to another
          // business's number was answered by this instance).
          const dest = value.metadata?.phone_number_id;
          if (dest && PHONE_ID() && dest !== PHONE_ID()) {
            console.warn(`[whatsapp] ignoring inbound addressed to ${dest} (our number is ${PHONE_ID()})`);
            continue;
          }
          if (inbox) continue; // Messages were committed before HTTP ACK; the inbox worker owns them.
          for (const msg of value.messages) {
            await handleMessage(msg).catch((e) => console.error('[whatsapp] msg:', e?.message ?? e));
          }
        }
      }
    } catch (e) { console.error('[whatsapp] process:', e?.message ?? e); }
  }

  return {
    process: async payload=>{if(inbox)void pump();return processPayload(payload);},
    accept: payload=>{if(!inbox||closing)throw Error('WA_INBOX_UNAVAILABLE');return inbox.accept(payload,PHONE_ID());},
    async start(){if(!inbox)return;await inbox.acquire();closing=false;void pump();pollTimer=setInterval(()=>void pump(),1000);pollTimer.unref?.();},
    async stop(){closing=true;clearInterval(pollTimer);for(const b of buffers.values())clearTimeout(b.timer);for(const b of esperaPublico.values())clearTimeout(b.timer);await pumpPromise;await Promise.allSettled([...turns]);await inbox?.release();},
  };
}
