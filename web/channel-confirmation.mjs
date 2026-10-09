import { bindPendingMessage, peekPending, takePending, confirmationTargetMatches, confirmationTargetNotice } from './confirm.mjs';
import { currentConfirmationSession } from './confirmation-session.mjs';
import { proposalCard, proposalPresentation, textosConfirmacao, confirmationTargetsInMessage } from './confirmation-flow.mjs';

export { batchedConfirmationTarget } from './confirmation-target.mjs';

// Capture the proposal before sending. A slow send cannot bind its receipt to
// a different proposal created in the meantime. Only the actual confirmation
// card is eligible; progress messages and unrelated replies grant no authority.
export function withConfirmationReceipt(threadId, result) {
  if (result?.confirmationCards) return result;
  const session = currentConfirmationSession(threadId);
  if (session) {
    const text = typeof result === 'string' ? result : result?.text;
    if (!text) return result;
    const created = session.pending().filter(row => session.createdIds.has(row.id));
    const presented = Array.isArray(result?.proposalIds)
      ? session.pending().filter(row => result.proposalIds.includes(row.id)) : created;
    const grouped = presented.length > 1 && text.includes(proposalPresentation(presented));
    const rows = grouped ? presented : (presented.length ? presented : session.pending()).filter(row => text.includes(proposalCard(row)));
    if (!rows.length) return result;
    if (!grouped && new Set(rows.map(proposalCard)).size !== rows.length) return result;
    if (grouped) return { ...(typeof result === 'string' ? {text:result} : result),
      proposalIds:rows.map(row => row.id),
      confirmationCards:[{text, async onReplySent({channel,messageIds=[]}) {
        for (const messageId of messageIds) if (messageId != null) {
          await session.store.bind(session.scope,rows.map(row => row.id),{channel,messageId:String(messageId)});
        }
      }}],
    };
    let intro = text;
    for (const row of rows) intro = intro.replace(proposalCard(row), '');
    intro = intro.replace(/────/g, '').trim();
    return { ...(typeof result === 'string' ? { text: result } : result),
      proposalIds: rows.map(row => row.id),
      confirmationCards: rows.map((row, index) => ({
        id: row.id, text: `${index === 0 && intro ? intro+'\n\n' : ''}${proposalCard(row)}`,
        async onReplySent({ channel, messageIds = [] }) {
          for (const messageId of messageIds) {
            if (messageId == null) continue;
            await session.store.bind(session.scope, [row.id], { channel, messageId:String(messageId) });
          }
        },
      })),
    };
  }
  const pending = peekPending(threadId);
  const text = typeof result === 'string' ? result : result?.text;
  if (!pending?.id || !pending.confirmationText || !text?.includes(pending.confirmationText)) return result;
  const pendingId = pending.id;
  return {
    ...(typeof result === 'string' ? { text: result } : result),
    onReplySent({ channel, messageIds = [] }) {
      for (const messageId of messageIds) {
        if (messageId == null) continue;
        bindPendingMessage(threadId, pendingId, { channel, messageId: String(messageId) });
      }
    },
  };
}

// Negative reactions use the same thread lock as text turns. A cancellation
// cannot consume a newer proposal while an earlier turn is still running.
export function createReactionConfirmationHandler({ channel, getThread, withThreadLock, cancelDurable, runConversation, durable = false }) {
  return async (agent, userId, positive, target) => {
    const thread = await getThread(agent, userId);
    const confirmationTarget = target ?? { channel, messageId: null };
    if (durable) return runConversation(agent, thread, userId, positive ? '👍' : 'cancela', {
      kind:channel, viaReaction:true, confirmationTarget, confirmationInputId:target?.inputId || null,
    });
    if (!positive) {
      return withThreadLock(thread.id, async () => {
        const pending = peekPending(thread.id);
        if (!pending) return null;
        if (!confirmationTargetMatches(pending, confirmationTarget)) {
          return withConfirmationReceipt(thread.id, { text: confirmationTargetNotice(pending), attachments: [] });
        }
        if (pending.durableId) await cancelDurable(agent, thread, userId, pending.durableId);
        takePending(thread.id);
        return { text: textosConfirmacao(pending.language).canceledOne(pending.label), attachments: [] };
      });
    }
    const pending = peekPending(thread.id);
    if (!pending) return null;
    if (!confirmationTargetMatches(pending, confirmationTarget)) {
      return withConfirmationReceipt(thread.id, { text: confirmationTargetNotice(pending), attachments: [] });
    }
    // runConversation revalidates inside its own thread lock, before execution.
    return withConfirmationReceipt(thread.id, await runConversation(agent, thread, userId, '👍', {
      kind: channel, viaReaction: true, confirmationTarget,
    }));
  };
}

// A routine runs in its own conversation, but the person answers its card in
// the chat the routine was delivered to. Without this the card stayed behind:
// a reply, a 👍 on the delivered message or a plain "yes" in the chat could not
// reach it, and it expired unapproved. Moves the cards the delivered text shows
// into that chat and binds them to the delivered message ids. Best-effort:
// never breaks the delivery that already happened.
export function createRoutineConfirmationHandoff({ store, getOrCreateThreadByTitle, log = console.error }) {
  return async (routine, text, messageIds = []) => {
    const chat = routine.channel === 'telegram' ? 'Telegram' : routine.channel === 'whatsapp' ? 'WhatsApp' : null;
    if (!chat || !routine.agent_id || !routine.user_id) return [];
    const scope = thread => ({ userId: routine.user_id, agentId: routine.agent_id, threadId: thread.id });
    const thread = title => getOrCreateThreadByTitle({ agentId: routine.agent_id, userId: routine.user_id, title });
    try {
      // Same title runRoutine uses for the routine's conversation.
      const from = scope(await thread(`⏰ ${routine.title}`));
      const pending = (await store.list(from)).filter(row => row.state === 'pending');
      const ids = confirmationTargetsInMessage(pending, text);
      if (!ids.length) return [];
      const refs = messageIds.filter(id => id != null).map(id => ({ channel: routine.channel, messageId: String(id) }));
      return await store.adopt(from, scope(await thread(chat)), ids, refs);
    } catch (e) {
      log('[confirmation] routine handoff:', e?.message ?? e);
      return [];
    }
  };
}
