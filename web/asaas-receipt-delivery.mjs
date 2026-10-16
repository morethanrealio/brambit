const ORIGIN_CHANNELS = new Set(['web', 'telegram', 'whatsapp', 'email']);

export function normalizeAsaasOriginChannel(channel) {
  const value = String(channel || '').toLowerCase();
  return ORIGIN_CHANNELS.has(value) ? value : 'web';
}

function dataHoraTentativa(value) {
  const date = value instanceof Date ? value : new Date(value || '');
  if (!Number.isFinite(date.getTime())) return null;
  const parts = Object.fromEntries(new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  if (!parts.day || !parts.month || !parts.year || !parts.hour || !parts.minute) return null;
  return `${parts.day}/${parts.month}/${parts.year} às ${parts.hour}:${parts.minute}`;
}

function dataConclusao(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value || ''));
  return match ? `${match[3]}/${match[2]}/${match[1]}` : null;
}

export function asaasReceiptText(n = {}) {
  const kind = n.kind;
  const status = String(n.status || '').toUpperCase();
  const value = n.value == null ? null : Number(n.value);
  const receiptUrl = n.receipt_url || n.receiptUrl;
  const name = kind === 'pix' ? 'Pix' : 'pagamento de conta';
  const amount = Number.isFinite(value) ? ` de R$ ${value.toFixed(2).replace('.', ',')}` : '';
  const startedAt = dataHoraTentativa(n.created_at || n.createdAt);
  const started = startedAt ? ` iniciado em ${startedAt}` : '';
  const attemptStarted = startedAt ? ` iniciada em ${startedAt}` : '';
  const finishedAt = dataConclusao(n.date);
  const finished = finishedAt ? ` em ${finishedAt}` : '';
  const later = n.has_later_attempt === true || n.hasLaterAttempt === true;
  const scope = later
    ? 'Essa era uma tentativa anterior; este aviso não altera pagamentos ou transferências solicitados depois.'
    : 'Este aviso se refere somente a essa tentativa.';
  if (receiptUrl) return `${name}${amount}${started} foi concluído${finished}.\nComprovante oficial:\n${receiptUrl}`;
  if (status === 'CANCELLED') return `A tentativa de ${name}${amount}${attemptStarted} foi cancelada. ${scope}`;
  if (status === 'REFUNDED') return `${name}${amount}${started} foi estornado pela Asaas. ${scope}`;
  return `A tentativa de ${name}${amount}${attemptStarted} não foi concluída${status ? ` (status ${status})` : ''}. ${scope}`;
}

// A financial operation has a single conversation/origin channel. While the
// turn's response can still deliver the receipt inline, the webhook waits the
// short window and re-reads the state. After it, the conversation becomes the
// canonical delivery; push only exists when the request itself came from a
// push channel.
export async function deliverAsaasReceipt(n, {
  getOperation,
  appendToThread,
  notifyOwner,
  finishNotification,
  inlineWaitMs = 10_000,
  now = () => Date.now(),
  delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  logger = console,
} = {}) {
  const operationId = n?.provider_operation_id || n?.operationId;
  const userId = n?.owner_user_id || n?.userId;
  if (!operationId || !userId) return false;

  let current = null;
  try { current = await getOperation(userId, operationId); }
  catch (e) { logger.error('[asaas] não consegui conferir a operação do comprovante:', e?.message || e); }

  // The webhook's DTO did not carry created_at and zeroed out this wait. The
  // source of truth is the persisted row, which also works for outbox resumes.
  const createdAt = new Date(current?.created_at || n?.created_at || 0).getTime();
  const waitLeft = Number.isFinite(createdAt)
    ? Math.max(0, createdAt + inlineWaitMs + 250 - now())
    : 0;
  if (waitLeft) await delay(waitLeft);

  try {
    current = await getOperation(userId, operationId);
    if (current?.receipt_notification_state === 'delivered') return true;
  } catch (e) {
    logger.error('[asaas] não consegui conferir deduplicação do comprovante:', e?.message || e);
  }

  // The event can arrive much later and coexist with another attempt of the
  // same value. The text always uses the record tied to the conversation to
  // identify when THIS attempt started and whether a later attempt already exists.
  const text = asaasReceiptText({
    ...n,
    created_at: current?.created_at || n?.created_at || n?.createdAt || null,
    has_later_attempt: current?.has_later_attempt === true || n?.has_later_attempt === true,
  });
  const originChannel = normalizeAsaasOriginChannel(
    current?.origin_channel || n?.origin_channel || n?.originChannel,
  );
  const threadId = current?.thread_id || n?.thread_id || n?.threadId || null;
  let delivered = false;

  if (threadId) {
    try {
      delivered = !!(await appendToThread({
        threadId,
        userId,
        text,
        deliveryKey: `asaas-operation:${operationId}:done`,
      }));
    } catch (e) { logger.error('[asaas] falha ao registrar comprovante na conversa:', e?.message || e); }
  }

  // A request made on the web/app stays in its own thread. For
  // Telegram/WhatsApp/email, push only uses the same channel; it does not
  // fall back to another channel.
  if (originChannel !== 'web') {
    try {
      const out = await notifyOwner(userId, text, {
        channel: originChannel,
        keepBreaks: true,
        strictChannel: true,
      });
      delivered = delivered || !!out?.ok;
    } catch (e) { logger.error('[asaas] falha ao avisar comprovante:', e?.message || e); }
  }

  try { await finishNotification(operationId, delivered); }
  catch (e) { logger.error('[asaas] falha ao finalizar aviso de comprovante:', e?.message || e); }
  return delivered;
}
