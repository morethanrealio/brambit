import { createHash } from 'node:crypto';

// Delivery of the discovery journey feedback.
//
// The full report never goes raw to the channel. When the PDF can be generated,
// delivery is ALWAYS short text + the attached PDF, on any channel; the PDF also
// stays attached to the message recorded in the conversation, and the full text
// keeps being stored in the database (queryable by the assistant). If the PDF
// fails at any step, the flow falls back exactly to the previous behavior
// (notice with a link).
//
// Optional dependencies (`buildDocument`, `sendDocument`, `whatsappWindowOpen`,
// `emailDocument`): without them the module behaves as before the PDF.
export function createDiscoveryReportDelivery({ publish, deliverToChannel, push, baseUrl, buildDocument, sendDocument, whatsappWindowOpen, emailDocument }) {
  return async (p, body) => {
    const requested = !!p.delivery_thread_id;
    if (requested) p = { ...p, channel: p.delivery_channel };
    const failed = p.report_state === 'failed';

    // The preparation-failure notice has no report, so it has no PDF.
    let doc = null;
    if (!failed && buildDocument && p.body_markdown) {
      try { doc = (await buildDocument(p)) || null; } catch (error) { console.warn('[discovery] feedback pdf:', error?.message ?? error); }
    }

    const withPdf = 'Preparei sua devolutiva da jornada, com ideias de como posso ajudar no seu dia a dia. Está no PDF em anexo. Depois de ler, me diga por onde você quer começar.';
    let threadId;
    try {
      const revision = createHash('sha256').update(body).digest('hex');
      threadId = await publish(p, doc ? withPdf : body, `discovery-report:${p.report_id}:${revision}${requested ? `:${p.recovery_count || 0}` : ''}`, doc ? [doc.attachment] : null);
      if (!threadId) throw Error('missing_thread');
    } catch { return { ok: false, definitive: true, reason: 'report_not_saved' }; }

    const link = `${baseUrl()}/inicio?c=${encodeURIComponent(threadId)}`;
    const notice = (failed ? 'Não consegui preparar sua devolutiva. Sua jornada e anotações estão preservadas. Abra a conversa para tentar novamente: ' : 'Preparei sua devolutiva da jornada, com ideias de como posso ajudar no seu dia a dia. Abra para ler e escolher por onde começamos: ') + link;
    const caption = `${withPdf} Se preferir, abra a conversa: ${link}`;
    try {
      if (p.channel === 'app') {
        const receipt = await push(p.user_id, { title: 'Sua jornada de descoberta',
          body: failed ? 'O preparo da devolutiva falhou. Abra a conversa para tentar novamente.' : doc ? 'Sua devolutiva está pronta em PDF, com ideias para facilitar seu dia. Abra para ler e escolher o próximo passo.' : 'Sua devolutiva está pronta, com ideias para facilitar seu dia. Abra para escolher o próximo passo.',
          data: { kind: 'chat', threadId, agentId: p.agent_id } });
        if (receipt?.ok && receipt.ids?.length) return { ok: true, id: `expo:${receipt.ids[0]}`, threadId };
        if (requested) return { ok: true, id: `chat:${threadId}`, threadId };
        return { ok: false, definitive: receipt?.reason === 'sem_token' || receipt?.definitive === true, reason: 'report_saved_push_unconfirmed', threadId };
      }

      if (doc && sendDocument) {
        // WhatsApp outside the 24h window does not accept files: no approved
        // template carries a document. In that case the PDF goes by email and the
        // channel receives only the notice, which deliverToChannel itself sends via
        // a utility template.
        const closed = p.channel === 'whatsapp' && whatsappWindowOpen ? (await whatsappWindowOpen(p)) === false : false;
        if (closed) {
          const mailed = emailDocument ? await emailDocument(p, doc).catch((error) => { console.warn('[discovery] pdf by email:', error?.message ?? error); return false; }) : false;
          if (mailed) {
            const aviso = `Sua devolutiva da jornada está pronta. Como já faz mais de 24 horas desde sua última mensagem por aqui, enviei o PDF para o seu e-mail. Você também pode abrir a conversa: ${link}`;
            const receipt = await deliverToChannel({ ...p, title: 'Sua jornada de descoberta' }, aviso, aviso);
            return { ok: receipt?.ok === true && typeof receipt?.id === 'string' && !!receipt.id.trim(), id: receipt?.id || null, threadId };
          }
        } else {
          try {
            const receipt = await sendDocument(p, { ...doc, caption });
            if (receipt?.ok === true && typeof receipt?.id === 'string' && receipt.id.trim()) return { ok: true, id: receipt.id, threadId };
          } catch (error) { console.warn('[discovery] pdf delivery:', error?.message ?? error); }
        }
        // Any PDF failure on the channel falls back to the notice with a link, and
        // the attachment remains available in the conversation.
        const receipt = await deliverToChannel({ ...p, title: 'Sua jornada de descoberta' }, notice, notice);
        return { ok: receipt?.ok === true && typeof receipt?.id === 'string' && !!receipt.id.trim(), id: receipt?.id || null, threadId };
      }

      const textLimit = p.channel === 'telegram' ? 12000 : 3500;
      const content = requested && body.length <= textLimit ? body : notice;
      const receipt = await deliverToChannel({ ...p, title: 'Sua jornada de descoberta' }, content, notice);
      return { ok: receipt?.ok === true && typeof receipt?.id === 'string' && !!receipt.id.trim(), id: receipt?.id || null, threadId };
    } catch (error) {
      if (requested && p.channel === 'app') return { ok: true, id: `chat:${threadId}`, threadId };
      return { ok: false, definitive: error?.definitive === true, reason: 'report_saved_notice_failed', threadId };
    }
  };
}
