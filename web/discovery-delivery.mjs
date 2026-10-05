import { createHash } from 'node:crypto';

// Entrega da devolutiva da jornada de descoberta.
//
// O relatório inteiro nunca vai cru pro canal. Quando dá pra gerar o PDF, a
// entrega é SEMPRE texto curto + o PDF anexado, em qualquer canal; o PDF também
// fica anexado à mensagem gravada na conversa, e o texto integral continua
// guardado no banco (consultável pelo assistente). Se o PDF falhar em qualquer
// etapa, o fluxo cai exatamente no comportamento anterior (aviso com link).
//
// Dependências opcionais (`buildDocument`, `sendDocument`, `whatsappWindowOpen`,
// `emailDocument`): sem elas o módulo se comporta como antes do PDF.
export function createDiscoveryReportDelivery({ publish, deliverToChannel, push, baseUrl, buildDocument, sendDocument, whatsappWindowOpen, emailDocument }) {
  return async (p, body) => {
    const requested = !!p.delivery_thread_id;
    if (requested) p = { ...p, channel: p.delivery_channel };
    const failed = p.report_state === 'failed';

    // O aviso de falha de preparo não tem relatório, logo não tem PDF.
    let doc = null;
    if (!failed && buildDocument && p.body_markdown) {
      try { doc = (await buildDocument(p)) || null; } catch (error) { console.warn('[discovery] pdf da devolutiva:', error?.message ?? error); }
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
        // WhatsApp fora da janela de 24h não aceita arquivo: nenhum template
        // aprovado carrega documento. Nesse caso o PDF vai por e-mail e o canal
        // recebe só o aviso, que o próprio deliverToChannel manda por template
        // de utilidade.
        const closed = p.channel === 'whatsapp' && whatsappWindowOpen ? (await whatsappWindowOpen(p)) === false : false;
        if (closed) {
          const mailed = emailDocument ? await emailDocument(p, doc).catch((error) => { console.warn('[discovery] pdf por e-mail:', error?.message ?? error); return false; }) : false;
          if (mailed) {
            const aviso = `Sua devolutiva da jornada está pronta. Como já faz mais de 24 horas desde sua última mensagem por aqui, enviei o PDF para o seu e-mail. Você também pode abrir a conversa: ${link}`;
            const receipt = await deliverToChannel({ ...p, title: 'Sua jornada de descoberta' }, aviso, aviso);
            return { ok: receipt?.ok === true && typeof receipt?.id === 'string' && !!receipt.id.trim(), id: receipt?.id || null, threadId };
          }
        } else {
          try {
            const receipt = await sendDocument(p, { ...doc, caption });
            if (receipt?.ok === true && typeof receipt?.id === 'string' && receipt.id.trim()) return { ok: true, id: receipt.id, threadId };
          } catch (error) { console.warn('[discovery] envio do pdf:', error?.message ?? error); }
        }
        // Qualquer falha do PDF no canal cai no aviso com link, e o anexo segue
        // disponível na conversa.
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
