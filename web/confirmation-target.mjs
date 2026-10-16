// Transport-only metadata. This module must not load the gate or app services.
// A batch may only confirm one explicitly quoted message. Mixing targets (or
// a quoted message with an unquoted one) must not silently choose the last one.
export function batchedConfirmationTarget(targets = []) {
  if (!targets.some(target => target !== undefined)) return undefined;
  const first = targets[0];
  if (!first?.channel || !first?.messageId
      || targets.some(target => target?.channel !== first.channel || target?.messageId !== first.messageId)) {
    return { channel: first?.channel || 'whatsapp', messageId: null };
  }
  return { channel: first.channel, messageId: String(first.messageId) };
}

// Each card is sent separately so its channel message IDs select just that
// proposal. Ordinary replies keep the existing single-message behavior.
export function channelReplyParts(result, fallbackText = '') {
  // Repeated balance reply in a burst: nothing to send (see push-repeat-guard.mjs).
  if (result?.suppressed) return [];
  if (Array.isArray(result?.confirmationCards) && result.confirmationCards.length) return result.confirmationCards;
  return [{ text: typeof result === 'string' ? result : result?.text || fallbackText,
    onReplySent: result?.onReplySent }];
}
