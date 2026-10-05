import { hostDaMarca, marca, siteDaMarca } from './marca.mjs';
import { batchedConfirmationTarget, channelReplyParts } from './confirmation-target.mjs';
// ── Canal WhatsApp (WABA Cloud API, número único compartilhado) ──
// Um número de negócio atende VÁRIOS usuários. Diferente do Telegram (1 bot por
// usuário), aqui o webhook é compartilhado: roteamos pelo telefone do remetente
// -> usuário, e dentro do chat o usuário escolhe qual assistente fala.
//
// Modelo: AGENTE ATIVO fixo por telefone (sticky). Mensagem normal vai pro ativo.
//   "@nome ..."  troca o ativo e roteia aquela mensagem pra ele.
//   "menu" / "/agentes"  mostra a lista interativa pra escolher.
// Cada agente tem sua própria thread "WhatsApp" (history isolado); a memória de
// USUÁRIO (wiki/perfil) segue compartilhada entre os assistentes da pessoa.

import crypto from 'crypto';
import { CHANNEL_CTX_END } from './confirm.mjs';
import { markVoiceInput } from './voice-input.mjs';
import { notaMidiaSemTexto } from './midia-sem-texto.mjs';
import { startTurnHeartbeat, TURN_HEARTBEAT_TEXT } from './turn-heartbeat.mjs';
import { splitMessage } from './channel-split.mjs';
import { markdownParaWa } from './wa-format.mjs';

const GRAPH = 'https://graph.facebook.com/v21.0';
const PHONE_ID = () => process.env.WA_PHONE_NUMBER_ID;
// Base pública pra montar a URL absoluta dos anexos (a Meta busca a URL via link).
const PUBLIC_BASE = () => (process.env.PUBLIC_BASE_URL || siteDaMarca()).replace(/\/$/, '');
const absUrl = (u) => (/^https?:\/\//.test(u) ? u : `${PUBLIC_BASE()}${u}`);

// Canal pronto (precisa de token + phone id + verify token + app secret). O app
// secret entra aqui porque sem ele o webhook de entrada não tem como ser
// autenticado, e meio canal ligado é pior que canal desligado.
export function waEnabled() {
  return !!(process.env.WA_TOKEN && process.env.WA_PHONE_NUMBER_ID && process.env.WA_VERIFY_TOKEN && process.env.WA_APP_SECRET);
}

// Normaliza um nome de agente pra casar com @apelido (sem acento, minúsculo, só alfanumérico).
function slug(s) {
  return (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '');
}

// A Meta manda a mensagem genérica em error.message ("(#131009) Parameter value
// is not valid") e diz QUAL parâmetro recusou em error.error_data.details. Sem
// esse detalhe o journal não permite depurar a recusa, então guardamos os dois.
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

// Teto de UM balão de texto na Cloud API. Era 4096 e a Meta passou a recusar
// acima de 1024 (erro "(#131009) Parameter value is not valid", com
// error_data.details = "body['text'] length is N. It cannot exceed 1024"),
// verificado ao vivo em 18/09/2026: às 00:11 SP uma mensagem de 2670 chars ainda
// passou, às 06:58 SP a de 2401 já foi recusada. Não é limite nosso: se a Meta
// voltar atrás, basta subir esta constante.
const WA_CHUNK = 1024;

// Resposta longa vira vários balões, na ordem, sem corte. Até 29/09/2026 havia
// teto de 8 balões (8192 chars): o excesso sumia e o último balão levava
// "[…resposta muito longa, cortei o resto]". A quebra em si mora em
// channel-split.mjs (parágrafo > linha > espaço > corte seco fora de URL).
// Exportada porque é a regra que decide quantas notificações a pessoa recebe.
// Markdown do modelo vira formatação do WhatsApp aqui (wa-format.mjs).
export function prepararTextoWa(text) {
  const body = markdownParaWa((text || '').trim()) || '(sem resposta)';
  return splitMessage(body, WA_CHUNK);
}

// Texto puro, cortado em pedaços de WA_CHUNK chars.
// Devolve os wamids das partes enviadas (pra indexar a resposta e permitir que
// o usuário "responda/cite" ela depois). Callers que ignoram o retorno seguem ok.
async function sendText(to, text, { requireReceipt = false, tracking } = {}) {
  const wamids = [];
  const parts = prepararTextoWa(text);
  await tracking?.start({ total: parts.length, recipient: to });
  for (const [part, parte] of parts.entries()) {
    try {
      const opaque = await tracking?.beforePart(part);
      const j = await graph(`${PHONE_ID()}/messages`, {
        messaging_product: 'whatsapp', to, type: 'text',
        ...(opaque ? { biz_opaque_callback_data: opaque } : {}),
        text: { body: parte, preview_url: false },
      });
      const id = j?.messages?.[0]?.id;
      if (requireReceipt && (typeof id !== 'string' || !id.trim())) {
        throw Object.assign(new Error('WhatsApp sem recibo para uma parte da mensagem'), { definitive: false, partial: true });
      }
      if (id) wamids.push(id);
      if (id) await tracking?.accepted(part, id);
    } catch (error) {
      await tracking?.failed(part, error);
      if (wamids.length) { error.definitive = false; error.partial = true; }
      throw error;
    }
  }
  return wamids;
}

// Tamanho máximo de um parâmetro de template; acima disso o texto é cortado.
export const WA_TEMPLATE_MAX = 900;

// Normaliza UM parâmetro de corpo de template. A Cloud API REJEITA parâmetro com
// quebra de linha, tab ou 4+ espaços seguidos (erro "(#100) Invalid parameter").
// Lembretes multi-linha (ex: lista de tarefas) batiam nisso e não eram entregues.
// Normaliza: quebras viram " · ", tabs viram espaço, runs de espaço colapsam.
function normTemplateParam(v) {
  let text = markdownParaWa((v == null ? '' : String(v)).trim()) || '(sem conteúdo)';
  text = text
    .replace(/\r/g, '')
    .replace(/[ \t]*\n[ \t]*/g, ' · ')
    .replace(/\t+/g, ' ')
    .replace(/ {2,}/g, ' ')
    .replace(/(?: ?· ?){2,}/g, ' · ') // linhas em branco viravam " · · "; colapsa
    .replace(/^ ?· ?| ?· ?$/g, '')    // separador sobrando no início/fim
    .trim();
  if (text.length > WA_TEMPLATE_MAX) text = text.slice(0, WA_TEMPLATE_MAX).trimEnd() + '…'; // corpo de template é curto
  return text;
}

// Envia uma mensagem de TEMPLATE aprovado (business-initiated). Fora da janela de
// 24h da última mensagem do usuário, a Cloud API só deixa enviar template.
// Os nomes vêm da marca (marca().templatesWhatsApp; no Brambs, brambs_*):
// - notificacao (UTILITY): 1 variável ({{1}}) = conteúdo. Follow-up de algo
//   combinado (lembretes, rotinas, notificações pedidas). É o default.
// - engajamento (MARKETING): 2 variáveis ({{1}}=primeiro nome, {{2}}=conteúdo).
//   Envios proativos NÃO solicitados (reativação / anúncio de novidade).
// Para templates multi-variável passe `params` (array, em ordem {{1}}, {{2}}, …);
// sem ele, cai no `bodyText` único ({{1}}).
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

// Hooks de banco injetados no boot (server.mjs chama setWaHooks). whatsapp.mjs
// NÃO importa db.mjs de propósito: o handler do webhook já recebe `db` por
// injeção, mas o envio PROATIVO roda fora do webhook e precisa consultar a
// janela de 24h, então pega o que precisa por aqui.
let waHooks = { lastInboundAt: null, billMessages: null };
export function setWaHooks(h) { waHooks = { ...waHooks, ...(h || {}) }; }

// ── Cobrança por MENSAGEM entregue (categoria `service` da Meta) ──
// A Meta passa a cobrar mensagem de serviço em 1/10/26 (R$0,035 cada, com 1.000
// grátis/mês por número). Quem paga é o usuário, em créditos (WA_MSG_CREDITS),
// contando MENSAGEM DA META: uma resposta longa vira várias (4000 chars cada) e
// cada anexo é uma mensagem própria.
//
// ⚠️ Quem decide cobrar é o CHAMADOR, nunca o `graph()`: dentro da janela de 24h
// um disparo de ciclo de vida/marketing sai como mensagem de SESSÃO (type:text),
// então inferir a cobrança pelo tipo do corpo cobraria do usuário a NOSSA campanha.
// Por isso só os pontos de RESPOSTA ao usuário chamam isto — mensagem de sistema
// (heartbeat, erro, menu, mídia não suportada) e template não cobram.
//
// Fire-and-forget de propósito: falha de cobrança nunca atrasa nem derruba a
// entrega da mensagem (o lançamento é gravado depois do envio, de qualquer forma).
function billWa(userId, n, meta = {}) {
  if (!userId || !(n > 0) || !waHooks.billMessages) return;
  try {
    const p = waHooks.billMessages({ userId, messages: n, ...meta });
    if (p && typeof p.catch === 'function') p.catch((e) => console.warn('[whatsapp] cobrança:', e?.message ?? e));
  } catch (e) { console.warn('[whatsapp] cobrança:', e?.message ?? e); }
}

// Margem de 5 min na borda: o relógio da Meta não é o nosso, e uma mensagem de
// sessão mandada a 23h59 do limite chega como falha assíncrona.
const WA_WINDOW_MS = 24 * 3600_000 - 5 * 60_000;

// Envio PROATIVO com a MELHOR formatação possível. Dentro da janela de 24h (o
// usuário mandou mensagem há menos de 24h), a Cloud API deixa mandar mensagem de
// SESSÃO (type:text), que preserva quebra de linha, listas e *negrito*. Fora da
// janela só rola TEMPLATE aprovado, cujo parâmetro NÃO aceita quebra de linha
// (normTemplateParam achata tudo numa linha só).
//
// ⚠️ A Meta NÃO recusa na hora: ela ACEITA o texto fora da janela (HTTP 200 +
// wamid) e reprova DEPOIS, em silêncio, pelo webhook de status (erro 131047
// "Re-engagement message"). Ou seja, `try/catch` no envio nunca via essa falha e
// o fallback de template era código morto justamente no caso pra que foi escrito
// (202 mensagens perdidas em 30 dias, quase todas de rotina). Por isso a janela
// agora é decidida por dado NOSSO (whatsapp_links.last_inbound_at) ANTES de
// mandar, e o webhook de status ainda faz o reenvio por template como rede de
// segurança. `templateName`/`params` controlam o template (default: o de
// notificação da marca, 1 variável).
//
// `proseFallback(text) => string`: callback assíncrono chamado SÓ no caminho
// de janela fechada (template). Como o template achata listas numa zona, aqui a
// gente pede pro agente reescrever o conteúdo em TEXTO CORRIDO (sem lista/bullet/
// quebra) antes de mandar o template. Se não vier callback, ou ele falhar, cai
// no texto original (o normTemplateParam ainda achata como rede de segurança).
// `templateText`: prosa pronta e determinística para {{1}}; tem prioridade sobre
// proseFallback e é preservada também no retry assíncrono. Chamador garante limite.
export async function sendWhatsAppProactive(to, text, { templateName = marca().templatesWhatsApp.notificacao, lang = 'pt_BR', params = null, proseFallback = null, templateText = null, retryUnknown = true, tracking } = {}) {
  const viaTemplate = async (reason) => {
    let outText = templateText === null ? text : String(templateText);
    // Só reescreve pra prosa quando é template com 1 variável ({{1}}=conteúdo).
    // Com `params` (multi-variável) a formatação já é controlada por quem chamou.
    if (templateText === null && proseFallback && !params) {
      try {
        const rewritten = await proseFallback(text);
        if (rewritten && String(rewritten).trim()) outText = String(rewritten);
      } catch { /* mantém o texto original */ }
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

  // ── 1) Janela conhecida por dado NOSSO (o conserto de verdade) ──
  // `undefined` = não deu pra saber (hook ausente ou erro no banco): aí segue o
  // fluxo antigo, tentando sessão. Só desviamos pro template quando temos
  // certeza de que a janela fechou.
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
    // Guarda pra rede de segurança: se a Meta reprovar depois (131047), o webhook
    // de status reenvia isto por template.
    // A failure for one part is not proof that all other parts failed. Only
    // single-part sends may retry the whole body on a 131047 status webhook.
    if (!tracking && wamids.length === 1 && prepararTextoWa(text).length === 1) {
      rememberProactive(wamids, { to, text, templateName, lang, params, proseFallback, templateText });
    }
    return { via: 'session', wamid: wamids[0] || null, wamids };
  } catch (e) {
    if (e?.partial) throw e; // Some parts may exist: never resend the full body.
    const msg = String(e?.message || e).toLowerCase();
    // Janela de 24h fechada (erro 131047 / "re-engagement" / "outside allowed
    // window" / "24 hours"): só template resolve. Qualquer outro erro também cai
    // no template como rede de segurança; se o template também falhar, propaga o
    // erro original (número inválido, canal fora, etc.).
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

// Janela de 24h decidida por dado NOSSO (whatsapp_links.last_inbound_at), do
// mesmo jeito que sendWhatsAppProactive faz internamente. Devolve true/false
// quando dá pra saber e `null` quando não dá (hook ausente ou erro no banco);
// quem chama decide o que fazer com a incerteza.
export async function whatsappWindowOpen(to) {
  if (!waHooks.lastInboundAt) return null;
  let lastIn;
  try { lastIn = (await waHooks.lastInboundAt(to)) || null; } catch { return null; }
  if (!lastIn) return false;
  return Date.now() - new Date(lastIn).getTime() < WA_WINDOW_MS;
}

// Envia um DOCUMENTO de forma proativa (fora de um turno de conversa). Só existe
// caminho de sessão: template aprovado não carrega arquivo. Por isso a janela é
// checada ANTES, e a janela fechada vira erro explícito em vez de uma mensagem
// aceita com HTTP 200 e reprovada depois em silêncio (131047).
export async function sendWhatsAppDocument(to, buffer, filename = 'documento.pdf', mime = 'application/pdf', caption = null) {
  if ((await whatsappWindowOpen(to)) === false) throw Object.assign(new Error('WhatsApp fora da janela de 24h: documento não pode ser enviado'), { definitive: true, closedWindow: true });
  const id = await uploadMedia(buffer, mime, filename);
  const document = { id, filename, ...(caption ? { caption: String(caption).slice(0, 1024) } : {}) };
  const r = await graph(`${PHONE_ID()}/messages`, { messaging_product: 'whatsapp', to, type: 'document', document });
  return (r?.messages || []).map((m) => m.id).filter((w) => typeof w === 'string' && w.trim());
}

// ── Rede de segurança: 131047 assíncrono ──
// A Meta ACEITA (HTTP 200 + wamid) uma mensagem de sessão enviada fora da janela
// de 24h e só reprova DEPOIS, pelo webhook de status, com erro 131047. Sem isto o
// harness dava a mensagem por entregue e ela sumia em silêncio. Guardamos o
// conteúdo de cada envio proativo de SESSÃO por wamid; quando o status vem
// `failed/131047`, reenviamos por template. Template NUNCA entra no mapa, então
// não há laço de reenvio por construção.
const pendingProactive = new Map();
const PENDING_TTL_MS = 30 * 60_000;

function rememberProactive(wamids, rec) {
  if (!Array.isArray(wamids) || !wamids.length) return;
  rec.at = Date.now();
  for (const w of wamids) if (w) pendingProactive.set(w, rec);
  // Poda por TTL/tamanho: o status chega em segundos, isto é só backstop.
  if (pendingProactive.size > 500) {
    const corte = Date.now() - PENDING_TTL_MS;
    for (const [k, v] of pendingProactive) if (v.at < corte) pendingProactive.delete(k);
  }
}

// Devolve o envio uma ÚNICA vez (uma mensagem longa vira vários wamids que
// apontam pro mesmo registro; só o primeiro que falhar dispara o reenvio).
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
    } catch { /* mantém o texto original */ }
  }
  await sendWhatsAppTemplate(to, outText, { name: rec.templateName, lang: rec.lang, params: rec.params });
  console.warn(`[whatsapp] 131047 em ${wamid}: janela fechada, reenviado por template pra ${to}`);
  return true;
}

// Faz upload de um binário pro WhatsApp (multipart) e devolve o media id, usado
// pra enviar a mídia SEM expor link público (modo bucket privado).
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

// Baixa a imagem de um card (URL do NOSSO domínio, ex /api/img?k=…) e sobe pro
// WhatsApp, devolvendo o media id. Só aceita origem própria: a URL sai do nosso
// cache de imagem de produto, e buscar host arbitrário aqui abriria SSRF.
// Mensagem de imagem do WhatsApp aceita só JPEG e PNG; o cache guarda o que a
// loja serviu (webp é comum em e-commerce), então tipo não suportado devolve erro
// e o card sai SEM foto, em vez de virar card quebrado.
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

// Entrega anexos de mídia (imagem / áudio). Se getMedia devolver os bytes
// (modo bucket privado, sem link público), faz upload e envia por media id;
// senão (modo disco) cai no link público estático.
// Devolve QUANTAS mensagens da Meta saíram de fato (cada anexo é uma mensagem;
// o fallback de card pode gerar duas; anexo que falhou não conta) — é isso que a
// cobrança por mensagem usa. Anexo que falha não gera mensagem e não é cobrado.
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
          // A resposta de texto ("mandei em voz") já saiu; sem isto a pessoa não
          // recebia nada do que a voz dizia. Manda a fala em texto.
          if (!a.fala) throw err;
          console.error('[whatsapp] áudio não entregue, indo em texto:', err?.message ?? err);
          sent += (await sendText(to, `Não consegui mandar o áudio, vai em texto:\n\n${a.fala}`)).length;
        }
      } else if (a.type === 'document') {
        // Documento (.docx/.pdf/etc.): a URL do bucket é autenticada (o WhatsApp
        // não conseguiria baixar por link), então SEMPRE sobe os bytes e envia por
        // media id, com o nome de arquivo pra aparecer certinho no chat.
        const filename = a.filename || a.name || 'documento';
        if (bytes) {
          const id = await uploadMedia(bytes.buffer, bytes.contentType || a.mime, filename);
          await graph(`${PHONE_ID()}/messages`, { messaging_product: 'whatsapp', to, type: 'document', document: { id, filename } });
          sent++;
        } else {
          // Aviso de falha nossa: entra como mensagem de sistema, NÃO é cobrada.
          await sendText(to, `Gerei o arquivo "${filename}", mas não consegui anexar aqui. Você consegue baixar em ${hostDaMarca()}.`);
        }
      } else if (a.type === 'card') {
        // Card = mensagem interativa cta_url (foto no header + corpo + botão que
        // abre o link). Só é possível com URL; se algo falhar, cai no fallback
        // (foto + texto com o link) pra não perder o produto.
        const bodyText = ([a.title, a.body].filter(Boolean).join('\n') || a.title || ' ').slice(0, 1024);
        // Foto do header vai por MEDIA ID, igual às outras mídias desta função.
        // Com `link` cru quem baixava a imagem era a Meta, e quando essa busca
        // falhava a mensagem era reprovada DEPOIS do HTTP 200 (webhook de status,
        // 131053): o try/catch abaixo nunca disparava e o card sumia calado. Subindo
        // os bytes, qualquer problema de imagem é síncrono e tratado aqui.
        let headerId = null;
        if (a.image) {
          headerId = await uploadCardImage(a.image).catch((e) => {
            console.warn('[whatsapp] card sem foto:', e?.message ?? e);
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
          // O fallback NUNCA reusa uma imagem que já falhou: só manda foto se o
          // upload tinha dado certo. O que não pode faltar é o produto (texto+link).
          if (headerId) { await graph(`${PHONE_ID()}/messages`, { messaging_product: 'whatsapp', to, type: 'image', image: { id: headerId, caption: bodyText.slice(0, 1024) } }); sent++; }
          sent += (await sendText(to, a.url ? `${a.title ? a.title + '\n' : ''}${a.url}` : bodyText)).length;
        }
      }
    } catch (e) { console.error('[whatsapp] anexo:', e?.message ?? e); }
  }
  return sent;
}

// Baixa uma mídia recebida (áudio/imagem) pelo id: pega a URL e busca o binário.
async function downloadMedia(mediaId) {
  const meta = await fetch(`${GRAPH}/${mediaId}`, {
    headers: { authorization: `Bearer ${process.env.WA_TOKEN}` },
  }).then((r) => r.json());
  if (!meta?.url) throw new Error('mídia sem url');
  const bin = await fetch(meta.url, { headers: { authorization: `Bearer ${process.env.WA_TOKEN}` } });
  const buf = Buffer.from(await bin.arrayBuffer());
  return { buffer: buf, mime: meta.mime_type || 'application/octet-stream' };
}

// Lista interativa nativa: o usuário toca no nome pra trocar de assistente.
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

// Marca a mensagem como lida (best-effort, só pra UX).
// Marca a mensagem como lida E liga o indicador "digitando..." na mesma chamada
// (Cloud API: status:'read' + typing_indicator). O "digitando" some sozinho
// quando enviamos a resposta, ou após ~25s se o processamento estourar isso.
async function markRead(messageId) {
  if (!messageId) return;
  await graph(`${PHONE_ID()}/messages`, {
    messaging_product: 'whatsapp', status: 'read', message_id: messageId,
    typing_indicator: { type: 'text' },
  }).catch(() => {});
}

// ── Verificação do webhook (configuração no painel da Meta) ──
// GET com hub.mode=subscribe & hub.verify_token=<nosso>; devolvemos hub.challenge.
export function verifyChallenge(params) {
  const mode = params.get('hub.mode');
  const token = params.get('hub.verify_token');
  const challenge = params.get('hub.challenge');
  if (mode === 'subscribe' && token && token === process.env.WA_VERIFY_TOKEN) return challenge || '';
  return null;
}

// Assinatura do POST: HMAC-SHA256 do corpo CRU com o app secret (header
// x-hub-signature-256: "sha256=<hex>"). SEM secret configurado, REJEITA: a
// assinatura é a única autenticação deste endpoint público, e deixar passar por
// falta de configuração transformava uma variável esquecida em porta aberta pra
// qualquer um forjar mensagem/status e acionar assistente como se fosse o dono.
export function verifySignature(rawBody, signature) {
  const secret = process.env.WA_APP_SECRET;
  if (!secret) { console.error("[whatsapp] WA_APP_SECRET ausente: webhook recusado (fail-closed)"); return false; }
  if (!signature) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  try {
    const a = Buffer.from(expected), b = Buffer.from(signature);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch { return false; }
}

// Injeta as deps do server (evita import circular):
//   runConversation(agent, userId, text) -> reply
//   loadAgent(agentId, userId) -> agent   (valida ownership)
//   db = { getWhatsAppLink, listAgents, setWhatsAppActiveAgent }
export function createWhatsAppHandler({ runConversation, reactionConfirm, loadAgent, db, transcribe, getMedia, inbox = null, aoReprovar = null }) {
  const seen = new Set(); // ids já processados (dedup de retries do Meta)

  const DEBOUNCE_MS = Number(process.env.WA_DEBOUNCE_MS || 3000);
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
    if(running.has(key)){scheduleFlush(key);return;}
    clearTimeout(b.timer);buffers.delete(key);
    let count=0,imageCount=0,fileCount=0;
    for(const p of b.parts){if(count&&(count>=MAX_BATCH||imageCount+(p.images?.length||0)>MAX_IMAGES||fileCount+(p.files?.length||0)>MAX_FILES))break;count++;imageCount+=p.images?.length||0;fileCount+=p.files?.length||0;}
    if(count<b.parts.length){const remaining=b.parts.slice(count);b.parts=b.parts.slice(0,count);buffers.set(key,{...b,parts:remaining,timer:null});}
    const {from}=b,token={pending:[],consumed:[...b.parts]};running.set(key,token);
    let finishHeartbeat=async()=>{};
    try{
      const liveAgent=await loadAgent(b.agentId,b.userId);
      if(!await sameRecipient(from,b.userId)||!liveAgent){
        if(inbox)await inbox.ignore(ids(b.parts),'recipient_or_agent_changed');return;
      }
      b.agent=liveAgent;
      if(inbox)await inbox.begin(ids(b.parts));
      const images=b.parts.flatMap(p=>p.images||[]),files=b.parts.flatMap(p=>p.files||[]);
      const text=b.parts.map(p=>p.text).filter(Boolean).join('\n')||notaMidiaSemTexto({images:images.length,files:files.length});
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
      const reply=typeof res==='string'?res:res?.text,attachments=typeof res==='string'?[]:(res?.attachments||[]);
      let cobraveis=0;
      if(reply||!attachments.length)for(const part of channelReplyParts(res,'(sem resposta)')){
        const wamids=await sendText(from,part.text,{requireReceipt:!!inbox||!!part.id});cobraveis+=wamids.length;
        await part.onReplySent?.({channel:'whatsapp',messageIds:wamids});
        if(db?.saveWaMsgRef)for(const w of wamids)db.saveWaMsgRef({wamid:w,userId:b.userId,agentId:b.agentId,direction:'out',body:part.text}).catch(()=>{});
      }
      cobraveis+=await sendAttachments(from,attachments,getMedia);
      billWa(b.userId,cobraveis,{agentId:b.agentId});
      if(inbox)await inbox.complete(ids(token.consumed));
    }catch(e){
      await finishHeartbeat();console.error('[whatsapp] erro na conversa:',e?.code||e?.name||'error');
      if(inbox)await failInbox(token.consumed,e?.code==='WA_RECIPIENT_CHANGED'?'recipient_changed':'execution_or_delivery_uncertain').catch(()=>{});
      // A failed send may already have reached the user; do not send a second
      // speculative reply or replay effects. The inbox exposes the uncertainty.
      else if(await sameRecipient(from,b.userId).catch(()=>false))await sendText(from,'Tive um problema pra responder agora. Tenta de novo?').catch(()=>{});
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
    if(!b){b={from,userId:part.userId,agentId:part.agentId,agent:part.agent,parts:[],timer:null};buffers.set(key,b);}
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
        await inbox.acquire();for(const b of buffers.values())clearTimeout(b.timer);buffers.clear();loaded.clear();
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

  async function handleMessage(msg) {
    const from = msg.from; // telefone do remetente em E.164 sem '+', ex: "5511999998888"
    if (!from) return;
    const sendReply=text=>sendText(from,text,{requireReceipt:!!msg._inboxId}).catch(e=>{if(msg._inboxId)throw e;});
    const sendMenu=(agents,header)=>sendAgentList(from,agents,header).catch(e=>{if(msg._inboxId)throw e;});
    if (msg.id && !msg._inboxId) {
      // Duas camadas: o Set corta o retry que chega enquanto o processo está de pé
      // (sem ida ao banco), e o `claimWaMsg` cobre o que o Set não cobre — restart,
      // deploy e o `clear()` do backstop de memória. Sem a camada durável, o retry
      // da Meta depois de um deploy fazia a mesma mensagem rodar de novo.
      if (seen.has(msg.id)) return;
      seen.add(msg.id);
      if (seen.size > 5000) seen.clear(); // backstop de memória
      if (db?.claimWaMsg && !(await db.claimWaMsg(msg.id))) return;
    }

    // Carimba a janela de 24h ANTES de qualquer roteamento: do ponto de vista da
    // Meta qualquer inbound reabre a janela, inclusive o que aqui cai no menu, em
    // mídia não suportada ou em número não vinculado.
    if (db?.touchWaInbound) db.touchWaInbound(from).catch(() => {});

    const link = await db.getWhatsAppLink(from);
    if(msg._inboxId&&(link?.enabled?link.user_id:null)!==msg._receivedUserId){await inbox.ignore([msg._inboxId],'recipient_changed');return true;}
    if (!link || !link.enabled) {
      // Prova de posse: é AQUI que um número passa a valer pra uma conta. A pessoa
      // pede a conexão no app, recebe um código e manda ele desta linha. Como a
      // mensagem chega de fato deste telefone, a posse está provada; digitar o
      // número no app não prova nada (ver POST /api/connect/whatsapp).
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
      await sendReply( `Oi! Pra falar comigo por aqui, entre em ${hostDaMarca()}, faça login e conecte seu número de WhatsApp (com DDD e o 55 na frente).`);
      return;
    }
    const agents = await db.listAgents(link.user_id);
    if (!agents.length) {
      await sendReply( `Você ainda não tem nenhum assistente. Crie um em ${hostDaMarca()} e volte aqui.`);
      return;
    }

    // Reaction (👍/👎) numa mensagem: confirma/cancela uma ação pendente sem
    // texto. Joinha confirma ação comum; irreversível o server pede texto.
    if (msg.type === 'reaction') {
      const emoji = msg.reaction?.emoji || '';
      const positive = ['👍', '✅', '👌', '💯'].some((e) => emoji.includes(e));
      const negative = ['👎', '❌'].some((e) => emoji.includes(e));
      if (!positive && !negative) return; // reação removida ou emoji neutro
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

    // Extrai o texto (ou a interação de toque na lista).
    let text = '';
    let images = null; // imagens anexadas ao turno (visão)
    let files = null; // documentos (PDF) anexados ao turno
    let voz = false; // texto veio de transcrição de áudio
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
      // Áudio/nota de voz: baixa o binário, transcreve (STT) e segue como texto.
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
      // Imagem recebida: baixa o binário e manda pro modelo entender (visão).
      // A legenda da imagem (se houver) vira o pedido; senão, um pedido genérico.
      await markRead(msg.id);
      try {
        const { buffer, mime } = await downloadMedia(msg.image?.id);
        images = [{ mimeType: mime, data: buffer.toString('base64') }];
      } catch (e) {
        console.error('[whatsapp] image:', e?.message ?? e);
        await sendReply( 'Não consegui baixar essa imagem. Tenta mandar de novo?');
        return;
      }
      // Sem default forçado aqui: se a rajada tiver várias fotos sem legenda, o
      // flush injeta um único pedido genérico (em vez de repetir a frase N vezes).
      text = (msg.image?.caption || '').trim();
    } else if (msg.type === 'document') {
      // Documento recebido: se for PDF, baixa o binário e manda pra extração de
      // texto (o server extrai e salva no bucket do dono). Outros formatos não.
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

    // Comandos de menu.
    const low = text.toLowerCase();
    if (low === '/agentes' || low === 'agentes' || low === 'menu' || low === '/menu') {
      await sendMenu( agents);
      return;
    }

    // "@nome ..." no começo: troca o agente ativo e roteia a mensagem restante.
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

    // Assistente ativo pra ESTE canal (WhatsApp). Se ninguém escolheu ainda, não
    // amarra sozinho: com 1 assistente usa ele; com vários, mostra o menu e
    // espera a escolha (antes colava no "mais novo" sem o usuário pedir, foi o
    // que fez um usuário cair em outro assistente sem nunca ter ativado).
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
    // Indexa esta mensagem por wamid (pra resolver citações futuras) e, se ela
    // for uma resposta/citação (recurso "responder" do WhatsApp), resolve o texto
    // citado e injeta como contexto. O webhook só manda o id da msg citada
    // (msg.context.id), nunca o texto, então buscamos no índice. Sem isto, a
    // citação some e o assistente não sabe a que mensagem o usuário se refere.
    if (msg.id && text && db?.saveWaMsgRef) {
      db.saveWaMsgRef({ wamid: msg.id, userId: link.user_id, agentId: activeId, direction: 'in', body: text }).catch(() => {});
    }
    // Marca DEPOIS de menu/@nome (comando falado continua valendo) e do índice
    // de citações (que guarda só a fala).
    if (voz) text = markVoiceInput(text);
    if (msg.context?.id && db?.getWaMsgRef) {
      try {
        const q = await db.getWaMsgRef(msg.context.id, link.user_id);
        if (q?.body) {
          const quoted = q.body.length > 1200 ? q.body.slice(0, 1200) + '…' : q.body;
          const quem = q.direction === 'out' ? 'uma mensagem anterior SUA (do assistente)' : 'uma mensagem anterior do próprio usuário';
          // O CHANNEL_CTX_END (char invisível) marca onde o envelope termina e
          // começa a fala da pessoa. Sem ele, a trava de confirmação lia o
          // bloco como se fosse o usuário e cancelava toda confirmação feita
          // por citação (ver userSaid em confirm.mjs).
          text = `[O usuário está usando o recurso "responder/citar" do WhatsApp para se referir a ${quem}: "${quoted}"]${CHANNEL_CTX_END}\n\n${text}`;
        }
      } catch (e) { console.error('[whatsapp] resolver citação:', e?.message ?? e); }
    }

    // Não roda na hora: enfileira na janela de agrupamento. Quando a pessoa parar
    // de mandar (~DEBOUNCE_MS), o flush junta tudo e roda a conversa uma vez só.
    const prepared={from,inputId:msg.id,userId:link.user_id,agentId:activeId,text,images,
      files:files?.map(f=>({name:f.name,mime:f.mime,data:f.buffer.toString('base64')})),
      confirmationTarget:msg.context?{channel:'whatsapp',messageId:msg.context.id==null?null:String(msg.context.id)}:undefined};
    if(msg._inboxId){await inbox.prepare(msg._inboxId,prepared);loaded.add(msg._inboxId);}
    await enqueue(from,{...prepared,files,agent,inboxId:msg._inboxId});
    return true;
  }

  // Processa o payload do webhook (já validado). NÃO bloqueia a resposta ao Meta:
  // o server responde 200 na hora e chama isto em background.
  // NÃO chamar de "process": isso sombreia o global `process` dentro deste escopo
  // e quebra qualquer `process.env` aqui dentro (foi o que derrubou o boot).
  async function processPayload(payload) {
    try {
      for (const entry of payload.entry || []) {
        for (const change of entry.changes || []) {
          const value = change.value || {};
          // Status de ENTREGA (sent/delivered/read/failed): a Meta manda aqui,
          // separado das mensagens. Antes a gente descartava, então não dava pra
          // saber se um proativo (template) chegou de fato — a API "aceita" e
          // dropa em silêncio quando bate teto de marketing (code 131049).
          // Persistimos pra ter rastreio real de entrega e saber pra quem reenviar.
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
              // TODA reprovação assíncrona vira log. A Meta aceita a mensagem com
              // HTTP 200 e reprova depois, aqui no webhook de status; até 05/09 só
              // o 131047 era olhado, então qualquer outro motivo sumia calado (o
              // registro ia pra tabela e ninguém lia). Foi assim que 4 cards de
              // produto (131053) e 2 envios de campanha (131049) se perderam sem
              // deixar rastro em log entre 03 e 04/09.
              if (String(st.status) === 'failed') {
                console.warn(`[whatsapp] REPROVADA pela Meta: destino=${st.recipient_id || '?'} code=${err?.code ?? '?'} "${err?.title || err?.message || 'sem detalhe'}" wamid=${st.id}`);
                // Quem registrou o envio como 'sent' (nasceu no 200 da Meta, que é
                // só "aceitei") corrige agora, no único momento em que a verdade
                // sobre a entrega existe (evento whatsapp_reprovada, eventos.mjs).
                if (aoReprovar) {
                  await Promise.resolve().then(() => aoReprovar({
                    wamid: st.id,
                    errorCode: err?.code ?? null,
                    errorTitle: err?.title ?? null,
                    errorMessage: err?.message || err?.error_data?.details || null,
                  })).catch((e) => console.error('[whatsapp] aviso de reprovação:', e?.message ?? e));
                }
              }
              // Rede de segurança do 131047: a mensagem de sessão foi aceita com
              // HTTP 200 e reprovada agora, de forma assíncrona, porque a janela
              // de 24h estava fechada. Reenvia o MESMO conteúdo por template em
              // vez de deixar sumir. Só vale pra proativo de sessão guardado em
              // memória; template nunca entra no mapa, então não há laço.
              // NÃO existe reenvio automático pros outros códigos de propósito:
              // 131049 é a Meta segurando entrega de marketing, e insistir seria
              // spam; 131053 é mídia, resolvido na origem (ver sendAttachments).
              if (String(st.status) === 'failed' && Number(err?.code) === 131047) {
                retryProactiveAsTemplate(st.id, st.recipient_id)
                  .catch((e) => console.error('[whatsapp] retry template:', e?.message ?? e));
              }
            }
          }
          if (!value.messages) continue; // sem mensagens (era só status update)
          // Só atende mensagens endereçadas ao NOSSO número. Quando o app está
          // inscrito numa WABA compartilhada com outros números, a Meta faz
          // fan-out de todo inbound da WABA pra este webhook; sem esse filtro o
          // harness responderia mensagens destinadas a outros bots (ex: um
          // teste enviado ao número do Renner era respondido pelo Brambs).
          const dest = value.metadata?.phone_number_id;
          if (dest && PHONE_ID() && dest !== PHONE_ID()) {
            console.warn(`[whatsapp] ignorando inbound endereçado a ${dest} (nosso número é ${PHONE_ID()})`);
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
    async stop(){closing=true;clearInterval(pollTimer);for(const b of buffers.values())clearTimeout(b.timer);await pumpPromise;await Promise.allSettled([...turns]);await inbox?.release();},
  };
}
