// Text-only path: it doesn't know about threads, confirmation, tools,
// scheduler, delivery, housekeeping or the chat's emergency mode.
export class DraftUnavailableError extends Error {
  constructor(reason) {
    super('Não foi possível gerar o rascunho interno.');
    this.name = 'DraftUnavailableError';
    this.reason = reason;
  }
}

export async function generateMessageDraft({ task, readCredit, readContext, makeProvider, recordUsage }) {
  if (typeof task !== 'string' || !task.trim()) throw new DraftUnavailableError('empty_task');
  // Keeps the existing commercial gate, but does NOT turn a block into deliverable
  // text. The caller decides between preserving the original or showing an error in the admin.
  const credit = await readCredit();
  if (!credit || credit.over !== false) throw new DraftUnavailableError('credit_unavailable');
  const system = await readContext();
  const provider = makeProvider();
  // A single step, no tool-loop. Even a hallucinated tool call is refused,
  // never executed. No previous history/draft prompt is persisted.
  const result = await provider.complete({ system, messages: [{ role: 'user', content: task }], tools: [] });
  // Usage measurement/billing still exist, without linking to a fictitious conversation.
  // Don't pass text or prompt to the ledger.
  if (result?.usage) await recordUsage(result.usage);
  if (result?.unavailable || result?.stop !== 'end' || result?.toolCalls?.length || typeof result?.text !== 'string' || !result.text.trim()) {
    throw new DraftUnavailableError('invalid_model_result');
  }
  return result.text.trim();
}
