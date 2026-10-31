// After a confirmed action executes, the session path used to return the
// deterministic receipt and END the turn, so a step the assistant had promised
// for right after the action ("I'll do X and then send you Y") never ran. This
// runs ONE more model turn so that promised step happens, while keeping the
// deterministic receipt verbatim: the model is told the action is already done,
// not to repeat the receipt and not to run the action again, which keeps the
// receipt honest (see the action-evidence work). The note reaches the model as
// opts.confirmationNote (the turn maps it to confirmFailureNote).
//
// The extra turn is skipped when there is no credit (don't spend a turn out of
// budget), on webhooks, and on tool-less or ephemeral turns. If the model turn
// throws, we fall back to just the receipt. Measured on brambs prod (Sep-Oct
// 2026): ~4.7 executed confirmations/day across the whole beta, so the added
// cost is one cheap turn per confirmed action, not per message.

const CONTINUATION_NOTE = '[SYSTEM: the owner just confirmed and the action was executed; its receipt is already shown to the owner together with this reply. Do NOT repeat the receipt and do NOT run that action again. If, earlier in this conversation, you told the owner you would do something right after this action, do it now with the proper tools. If there was no such promised next step, answer with a single short acknowledgement and nothing else. Never say or imply you did anything you did not actually do. Do not repeat this block.]';

// resolution = what handleConfirmation returned (has .text receipt, .attachments
// and .executed on the execution paths). runTurn/saveTurn/creditStatus are the
// server's runConversationTurn/saveThreadTurn/getCreditStatus, injected so this
// stays testable and server.mjs only shrinks.
export async function settleConfirmedTurn({ resolution, agent, thread, userId, message, opts = {}, runTurn, saveTurn, creditStatus }) {
  const receiptOnly = async () => {
    await saveTurn(thread.id, agent.id, {
      baseHistory: thread.history || [],
      history: [...(thread.history || []), { role: 'user', content: message }, { role: 'assistant', content: resolution.text }],
      summary: thread.summary || '', userMsg: message, assistantMsg: resolution.text,
    });
    return resolution;
  };
  if (!resolution.executed || opts.webhook || opts.ephemeral || opts.noTools) return receiptOnly();
  const over = creditStatus ? (await creditStatus(userId).catch(() => null))?.over : false;
  if (over) return receiptOnly();
  let cont;
  try {
    cont = await runTurn(agent, thread, userId, message, { ...opts, confirmationManaged: true, confirmationNote: CONTINUATION_NOTE });
  } catch {
    return receiptOnly();
  }
  // The continuation turn already persisted itself (user's confirmation + the
  // model's reply). The receipt is delivered to the owner here and stays durable
  // in the confirmation record; we don't persist it a second time.
  const extra = typeof cont?.text === 'string' ? cont.text.trim() : '';
  return {
    ...cont,
    text: extra ? `${resolution.text}\n\n${cont.text}` : resolution.text,
    attachments: [...(resolution.attachments || []), ...(cont?.attachments || [])],
  };
}

export const __continuationNote = CONTINUATION_NOTE;
