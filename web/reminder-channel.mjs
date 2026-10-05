const supported = new Set(['telegram', 'email', 'whatsapp']);
const normalize = value => String(value || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

// O canal é escolha do modelo, que lê a conversa inteira (eval 28/09: a regex que
// relia a fala do dono acertava 18/22 contra 22/22 do modelo; errava "aqui pelo
// telegram" e "no zap"). O código só garante que o canal existe: sem canal
// proposto, fica no canal da conversa se ele entrega; senão, pergunta.
export function reminderChannelSelection({ kind, routineChannel, requested }) {
  const origin = normalize(kind === 'routine' ? routineChannel : kind);
  const proposed = normalize(requested).replace(/^e[- ]?mail$/, 'email').replace(/^whats\s?app$/, 'whatsapp');
  if (kind === 'routine') return { channel: proposed || (supported.has(origin) ? origin : null), reason: 'selection_required' };
  if (supported.has(proposed)) return { channel: proposed };
  if (!proposed && supported.has(origin)) return { channel: origin };
  return { channel: null, reason: 'selection_required' };
}
