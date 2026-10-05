// Caminho exclusivamente textual: não conhece threads, confirmação, ferramentas,
// scheduler, delivery, housekeeping ou o modo de emergência do chat.
export class DraftUnavailableError extends Error {
  constructor(reason) {
    super('Não foi possível gerar o rascunho interno.');
    this.name = 'DraftUnavailableError';
    this.reason = reason;
  }
}

export async function generateMessageDraft({ task, readCredit, readContext, makeProvider, recordUsage }) {
  if (typeof task !== 'string' || !task.trim()) throw new DraftUnavailableError('empty_task');
  // Mantém o portão comercial existente, mas NÃO transforma bloqueio em texto
  // entregável. O chamador decide entre preservar original ou exibir erro no admin.
  const credit = await readCredit();
  if (!credit || credit.over !== false) throw new DraftUnavailableError('credit_unavailable');
  const system = await readContext();
  const provider = makeProvider();
  // Uma única etapa, sem tool-loop. Até uma chamada de tool alucinada é recusada,
  // nunca executada. Nenhum histórico anterior/prompt de rascunho é persistido.
  const result = await provider.complete({ system, messages: [{ role: 'user', content: task }], tools: [] });
  // Medição/cobrança de uso continuam existentes, sem vincular a conversa fictícia.
  // Não passar texto nem prompt ao ledger.
  if (result?.usage) await recordUsage(result.usage);
  if (result?.unavailable || result?.stop !== 'end' || result?.toolCalls?.length || typeof result?.text !== 'string' || !result.text.trim()) {
    throw new DraftUnavailableError('invalid_model_result');
  }
  return result.text.trim();
}
