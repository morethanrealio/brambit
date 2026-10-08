import { tagIdioma } from './locale.mjs';
import { hostDaMarca } from './marca.mjs';

// Texts the platform writes on its own around what the routine or
// the reminder produced. No model in the middle, so they need to exist in the three
// languages. In pt-BR they come out byte for byte identical to how they were before.
const TEXTOS_ENTREGA = {
  'pt-BR': {
    oi: nome => `Oi, ${nome}!`,
    lembrete: '⏰ Lembrete',
    longo: titulo => `Seu "${titulo}" de hoje ficou longo, então te mandei o conteúdo completo por e-mail. Se quiser receber aqui, é só pedir. 📧`,
    get longoPassagens() { return `O relatório de passagens ficou longo. O conteúdo completo foi enviado por e-mail e está salvo no app ${hostDaMarca()}.`; },
    prontoHoje: titulo => `O "${titulo}" de hoje ficou pronto.`,
    sobreHoje: tema => `O conteúdo de hoje é sobre ${tema}.`,
    conteudoEmail: 'Conteúdo completo (enviado por e-mail):',
    emailJanela: 'Como o WhatsApp tem limite de caracteres para mensagens depois de 24h de inatividade, enviei o conteúdo completo no teu e-mail. Se você me responder agora, a janela de 24h abre novamente.',
    emailTamanho: 'Como ficou grande demais para mandar por aqui, enviei o conteúdo completo no teu e-mail. Se quiser aqui também, é só me pedir.',
    notaEmail: canal => `Esta rotina é do ${canal}. Ficou grande demais pra lá, então veio por e-mail. As respostas e os áudios, manda lá no ${canal}.`,
  },
  en: {
    oi: nome => `Hi, ${nome}!`,
    lembrete: '⏰ Reminder',
    longo: titulo => `Today's "${titulo}" turned out long, so I sent you the full content by email. If you want it here, just ask. 📧`,
    get longoPassagens() { return `The flight report turned out long. The full content was sent by email and is saved in the app at ${hostDaMarca()}.`; },
    prontoHoje: titulo => `Today's "${titulo}" is ready.`,
    sobreHoje: tema => `Today's content is about ${tema}.`,
    conteudoEmail: 'Full content (sent by email):',
    emailJanela: 'Since WhatsApp limits the length of messages after 24h of inactivity, I sent the full content to your email. If you reply now, the 24h window opens again.',
    emailTamanho: 'Since it was too long to send here, I sent the full content to your email. If you want it here too, just ask.',
    notaEmail: canal => `This routine belongs to ${canal}. It was too long for it, so it came by email. Send your answers and voice messages there on ${canal}.`,
  },
  es: {
    oi: nome => `¡Hola, ${nome}!`,
    lembrete: '⏰ Recordatorio',
    longo: titulo => `Tu "${titulo}" de hoy quedó largo, así que te envié el contenido completo por correo. Si lo quieres aquí, solo pídelo. 📧`,
    get longoPassagens() { return `El informe de vuelos quedó largo. El contenido completo se envió por correo y está guardado en la app ${hostDaMarca()}.`; },
    prontoHoje: titulo => `El "${titulo}" de hoy está listo.`,
    sobreHoje: tema => `El contenido de hoy trata sobre ${tema}.`,
    conteudoEmail: 'Contenido completo (enviado por correo):',
    emailJanela: 'Como WhatsApp limita el largo de los mensajes después de 24h de inactividad, te envié el contenido completo por correo. Si me respondes ahora, la ventana de 24h se abre de nuevo.',
    emailTamanho: 'Como quedó demasiado largo para enviarlo por aquí, te envié el contenido completo por correo. Si lo quieres aquí también, solo pídelo.',
    notaEmail: canal => `Esta rutina es de ${canal}. Quedó demasiado larga para allí, así que llegó por correo. Las respuestas y los audios, mándalos allí en ${canal}.`,
  },
};
export const textosEntrega = l => TEXTOS_ENTREGA[tagIdioma(l)] || TEXTOS_ENTREGA['pt-BR'];
const primeiroNome = n => (n || '').split(' ')[0] || '';

// A long routine goes whole by email and the chat only notifies. The notice is: a fixed sentence
// with today's TOPIC (otherwise it would be the same every night) + a fixed explanation of the email.
// No greeting: the template already opens with "Oi! Conforme combinado:". The agent only
// fills in the topic, short: free-form text came out telegraphic and with jargon from the
// material (2026-10-02 test: "o risco de sequenciamento"). A topic outside the format becomes null
// and falls back to `prontoHoje`.
export const TEMA_MAX_PALAVRAS = 8;
const TEMA_MAX_CHARS = 80; // 8 normal words fit; one giant garbage word doesn't
const MOLDE_TEMA = { 'pt-BR': ['Brazilian Portuguese', 'O conteúdo de hoje é sobre ___.', 'o futuro do trabalho com a IA'],
  en: ['English', "Today's content is about ___.", 'the future of work with AI'],
  es: ['Spanish', 'El contenido de hoy trata sobre ___.', 'el futuro del trabajo con la IA'] };
export function pedidoTemaAviso(titulo, body, idioma) {
  const [lingua, molde, exemplo] = MOLDE_TEMA[tagIdioma(idioma)] || MOLDE_TEMA['pt-BR'];
  return `DRAFT (do not send anything, do not use any tool): your routine "${titulo}" for today ` +
    `went entirely to your owner's email, and WhatsApp only gets a short notice with the sentence "${molde}". ` +
    `Fill in ONLY the blank ___ with the topic of TODAY's content, in ${lingua}: at most ${TEMA_MAX_PALAVRAS} ` +
    `words, simple everyday words, no technical term or expression copied from the material, no ` +
    `colon, no list, no link. Example answer: ${exemplo}. Do not make up anything that is not ` +
    `in the content. Reply ONLY with the topic, without quotes and without a final period.` +
    `\n\n---\n${body}`;
}
const SAUDACAO = /^(oi|olá|ola|bom dia|boa tarde|boa noite|e a[ií]|hi|hello|hey|good (morning|afternoon|evening)|hola|buen[oa]s)\b/i;
const ECO_MOLDE = /^(o conteúdo de hoje é sobre|today's content is about|el contenido de hoy trata sobre|sobre|about)\s+/i;
export function temaAvisoValido(out) {
  let t = String(out || '').replace(/\s+/g, ' ').trim().replace(/^["“'‘]+|["”'’]+$/g, '').replace(/[.!]+$/, '').trim();
  t = t.replace(ECO_MOLDE, '');
  if (!t || t.length > TEMA_MAX_CHARS || t.split(' ').length > TEMA_MAX_PALAVRAS || /[:;•|()[\]"“”]|https?:|www\./i.test(t) || SAUDACAO.test(t)) return null;
  // "O futuro..." becomes "o futuro..." in the middle of the sentence. Only an article: proper
  // noun and acronym ("Netflix", "IA") stay as they came.
  return t.replace(/^(O|A|Os|As|Um|Uma|The|An|El|La|Los|Las|Un|Una)(?= )/, w => w.toLowerCase());
}

// The content was written for the chat ("send me the audio here") and goes by email.
// The agent rewrites ONLY the sentences that talk about the channel; the rest has to come back
// unchanged. Validation: same lines, few changed, no lost link. If it doesn't
// pass, null (falls back to the fixed note at the top of the email).
export function pedidoAdaptarEmail(canal, body) {
  return `DRAFT (do not send anything, do not use any tool): the text below was written for ${canal}, ` +
    `but it will be delivered by email. Rewrite ONLY the sentences that refer to the channel as if the person were ` +
    `in it ("por aqui", "aqui", "responde aqui", "manda aqui", "reply here"...) to make it clear that answers and voice messages ` +
    `go on ${canal}. Everything else stays IDENTICAL, word for word, same lines, same formatting and same language as the text. If ` +
    `no sentence needs to change, return the text unchanged. Reply ONLY with the complete text, no comments.` +
    `\n\n---\n${body}`;
}
const urls = t => t.match(/https?:\/\/\S+/g) || [];
export function adaptacaoEmailValida(body, out) {
  const t = String(out || '').trim();
  const a = body.split('\n'), b = t.split('\n');
  if (!t || a.length !== b.length) return null;
  const mudadas = a.filter((l, i) => l.trim() !== b[i].trim()).length;
  if (mudadas > Math.max(3, Math.ceil(a.length * 0.15))) return null;
  return urls(body).every(u => t.includes(u)) ? t : null;
}

// Scheduled sends are accepted only with a provider receipt. The receipt is
// evidence of acceptance, never proof that the person received/read a message.
export function deliveryFailure(code, message, definitive = true) {
  return Object.assign(new Error(message), { code, definitive });
}

export function requireDeliveryReceipt(receipt, channel) {
  if (receipt?.skipped || receipt?.ok === false) {
    throw deliveryFailure('DELIVERY_REJECTED', `O canal ${channel} não aceitou o envio.`);
  }
  const id = receipt?.id;
  if (receipt?.ok !== true || typeof id !== 'string' || !id.trim()) {
    throw deliveryFailure('DELIVERY_RECEIPT_MISSING', `O canal ${channel} não retornou comprovante de aceite. Não reenviar automaticamente.`, false);
  }
  return { ok: true, id, channel, status: 'accepted' };
}

export function createScheduledDelivery({
  sendEmail, getTelegramBotForDelivery, sendTelegramMessage,
  waEnabled, getWhatsAppLinkForUser, sendWhatsAppProactive, whatsappProse,
  persistProactiveToThread, deliverCurationEdition, sendCurationChannel, curationStore,
  whatsappWindowOpen = null, whatsappTemplateMax = 900, runAgentMessageDraft = null,
}) {
  async function avisoLongo(r, body, janelaFechada) {
    const tx = textosEntrega(r.user_language);
    let frase = null;
    if (runAgentMessageDraft) {
      try {
        const tema = temaAvisoValido(await runAgentMessageDraft({ agent_id: r.agent_id, user_id: r.user_id }, pedidoTemaAviso(r.title, body, r.user_language)));
        if (tema) frase = tx.sobreHoje(tema);
      } catch { /* falls back to the fixed phrase */ }
    }
    return `${frase || tx.prontoHoje(r.title)} ${janelaFechada ? tx.emailJanela : tx.emailTamanho}`;
  }

  // Outside the 24h window WhatsApp only accepts a template, and the template cuts
  // the text at `whatsappTemplateMax`. A routine bigger than that would go truncated (the
  // questions at the end would disappear), so it goes whole by email and WhatsApp only notifies.
  async function whatsappWouldTruncate(r, fullText) {
    if (r.channel !== 'whatsapp' || !whatsappWindowOpen || fullText.length <= whatsappTemplateMax) return false;
    try {
      const link = await getWhatsAppLinkForUser(r.user_id);
      return !!link?.wa_phone && await whatsappWindowOpen(link.wa_phone) === false;
    } catch { return false; }
  }

  async function corpoEmailDoChat(r, body) {
    const canal = r.channel === 'telegram' ? 'Telegram' : 'WhatsApp';
    if (runAgentMessageDraft) {
      try {
        const t = adaptacaoEmailValida(body, await runAgentMessageDraft({ agent_id: r.agent_id, user_id: r.user_id }, pedidoAdaptarEmail(canal, body)));
        if (t) return t;
      } catch { /* falls back to the fixed note */ }
    }
    return `${textosEntrega(r.user_language).notaEmail(canal)}\n\n${body}`;
  }

  async function sendRoutineEmail(r, body) {
    if (!r.email) throw deliveryFailure('EMAIL_NOT_CONNECTED', 'Usuário sem e-mail.');
    return requireDeliveryReceipt(await sendEmail({
      to: r.email, subject: r.title,
      text: `${textosEntrega(r.user_language).oi(primeiroNome(r.user_name))}\n\n${body}\n\n— ${r.agent_name}`,
      fromName: r.agent_name,
    }), 'email');
  }

  async function deliverToChannel(r, body, templateText = null) {
    if (r.channel === 'email') return sendRoutineEmail(r, body);
    if (r.channel === 'telegram') {
      const bot = await getTelegramBotForDelivery(r.user_id, r.agent_id);
      if (!bot?.token || !bot.chat_id) throw deliveryFailure('TELEGRAM_NOT_CONNECTED', 'Telegram não conectado.');
      const receipt = await sendTelegramMessage(bot.token, bot.chat_id, `⏰ ${r.title}\n\n${body}`);
      return requireDeliveryReceipt({ ok: true, id: receipt?.message_id == null ? null : String(receipt.message_id) }, 'telegram');
    }
    if (r.channel === 'whatsapp') {
      if (!waEnabled()) throw deliveryFailure('WHATSAPP_NOT_CONFIGURED', 'WhatsApp não configurado.');
      const link = await getWhatsAppLinkForUser(r.user_id);
      if (!link?.wa_phone || link.enabled === false) throw deliveryFailure('WHATSAPP_NOT_CONNECTED', 'WhatsApp não conectado.');
      const receipt = await sendWhatsAppProactive(link.wa_phone, `*${r.title}*\n\n${body}`, {
        templateText, retryUnknown: false,
        proseFallback: templateText === null ? (text) => whatsappProse({ agent_id: r.agent_id, user_id: r.user_id }, text) : null,
      });
      return requireDeliveryReceipt({ ok: true, id: receipt?.wamid || null }, 'whatsapp');
    }
    throw deliveryFailure('DELIVERY_CHANNEL_UNSUPPORTED', 'Canal de entrega não suportado.');
  }

  async function deliverRoutine(r, text) {
    if (text?.type === 'curation-v1') {
      if (text.channel !== (r.channel || 'none') || text.userId !== r.user_id || text.routineId !== r.id) {
        throw deliveryFailure('CURATION_SCOPE_INVALID', 'Escopo da entrega de curadoria inválido.');
      }
      let accepted, acceptedParts = 0;
      const trackPart = send => async (...args) => {
        try {
          const receipt = await send(...args);
          if (receipt?.ok === true && receipt.id) acceptedParts++;
          return receipt;
        } catch (error) {
          // Curation has its own packet loop above each transport's chunking.
          // Refusing a later packet does not undo earlier accepted packets.
          if (acceptedParts) error.definitive = false;
          throw error;
        }
      };
      await deliverCurationEdition(text, {
        store: curationStore,
        send: async () => {
          accepted = await sendCurationChannel(r, text, {
            email: trackPart(sendRoutineEmail),
            telegram: trackPart((routine, body) => deliverToChannel({ ...routine, title: String(routine.title).slice(0, 100) }, body)),
            whatsapp: trackPart((routine, body) => deliverToChannel({ ...routine, title: String(routine.title).slice(0, 100) }, body, body.replace(/\s+/g,' ').trim())),
            app: trackPart((routine, edition) => curationStore.appReceipt(routine, edition)),
          });
          return requireDeliveryReceipt(accepted, r.channel || 'app');
        },
        persist: (body) => persistProactiveToThread(r, body),
      });
      const receipt = requireDeliveryReceipt(accepted, r.channel || 'app');
      return { ...receipt, status: !r.channel || ['none', 'app'].includes(r.channel) ? 'saved' : 'accepted' };
    }
    if (!r.channel || ['none', 'app'].includes(r.channel)) return { channel: 'app', status: 'saved' };
    const typed = text?.type === 'flight-monitor-v1';
    if (typed && text.deliver === false) return { channel: r.channel, status: 'saved' };
    const body = String(typed ? text.text : (text || '')).trim();
    if (!body) return;
    const templateText = typed ? text.templateText : null;
    const isChat = ['whatsapp', 'telegram'].includes(r.channel);
    const janelaFechada = !typed && await whatsappWouldTruncate(r, `*${r.title}*\n\n${body}`);
    const longo = body.length > 3500 || janelaFechada;
    if (isChat && longo && r.email) {
      const emailReceipt = await sendRoutineEmail(r, typed ? body : await corpoEmailDoChat(r, body));
      let channelReceipt, aviso;
      try {
        aviso = typed ? textosEntrega(r.user_language).longo(r.title) : await avisoLongo(r, body, janelaFechada);
        channelReceipt = await deliverToChannel(r, aviso, typed ? textosEntrega(r.user_language).longoPassagens : aviso);
      } catch (error) {
        // The full report was accepted by email. Preserve that evidence and
        // record the separate notice failure; never resend the accepted email.
        await persistProactiveToThread({ ...r, channel: 'email' }, body);
        return { ...emailReceipt, fullContent: 'email', notification: {
          channel: r.channel, status: error?.definitive === true ? 'failed' : 'uncertain',
        } };
      }
      // The thread keeps what the person SAW on the channel (the notice) and the content marked
      // as email. With only the content, the assistant thought it had already sent
      // everything here and, on "send me the content here," picked up something else
      // (real 2026-10-02 case: it sent the journey feedback).
      await persistProactiveToThread(r, `${aviso}\n\n${textosEntrega(r.user_language).conteudoEmail}\n\n${body}`);
      return { ...channelReceipt, fullContent: 'email', fullContentReceiptId: emailReceipt.id };
    }
    const receipt = await deliverToChannel(r, body, templateText);
    await persistProactiveToThread(r, body);
    return receipt;
  }

  async function deliverReminder(rem, { tracking } = {}) {
    const text = String(rem.message || '').trim();
    if (!text) throw deliveryFailure('REMINDER_EMPTY', 'Lembrete sem mensagem.');
    const prefix = textosEntrega(rem.user_language).lembrete;
    if (rem.channel === 'telegram') {
      const bot = await getTelegramBotForDelivery(rem.user_id, rem.agent_id);
      if (!bot?.token || !bot.chat_id) throw deliveryFailure('TELEGRAM_NOT_CONNECTED', 'Telegram não conectado.');
      const receipt = await sendTelegramMessage(bot.token, bot.chat_id, `${prefix}: ${text}`);
      return requireDeliveryReceipt({ ok: true, id: receipt?.message_id == null ? null : String(receipt.message_id) }, 'telegram');
    }
    if (rem.channel === 'email') {
      if (!rem.email) throw deliveryFailure('EMAIL_NOT_CONNECTED', 'Usuário sem e-mail.');
      return requireDeliveryReceipt(await sendEmail({
        to: rem.email, subject: `${prefix}${text.length <= 60 ? ': ' + text : ''}`,
        text: `${textosEntrega(rem.user_language).oi(primeiroNome(rem.user_name))}\n\n${text}\n\n— ${rem.agent_name}`,
        fromName: rem.agent_name,
      }), 'email');
    }
    if (rem.channel === 'whatsapp') {
      if (!waEnabled()) throw deliveryFailure('WHATSAPP_NOT_CONFIGURED', 'WhatsApp não configurado.');
      const link = await getWhatsAppLinkForUser(rem.user_id);
      if (!link?.wa_phone || link.enabled === false) throw deliveryFailure('WHATSAPP_NOT_CONNECTED', 'WhatsApp não conectado.');
      const receipt = await sendWhatsAppProactive(link.wa_phone, `${prefix}: ${text}`, {
        retryUnknown: false, tracking,
        proseFallback: (body) => whatsappProse({ agent_id: rem.agent_id, user_id: rem.user_id }, body),
      });
      return requireDeliveryReceipt({ ok: true, id: receipt?.wamid || null }, 'whatsapp');
    }
    throw deliveryFailure('DELIVERY_CHANNEL_UNSUPPORTED', 'Canal de lembrete não suportado.');
  }
  // Discovery uses the receipt-checked transport without the routine's email
  // fallback or implicit history persistence.
  return { deliverRoutine, deliverReminder, deliverToChannel };
}
