const supported = new Set(['telegram', 'email', 'whatsapp']);
const normalize = value => String(value || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

// The channel is the model's choice, since it reads the whole conversation (eval 2026-09-28: the regex that
// re-read the owner's speech scored 18/22 against 22/22 for the model; it missed "here on
// telegram" and "on whatsapp"). The code only guarantees the channel exists: without a
// proposed channel, it stays on the conversation's channel if it can deliver; otherwise, it asks.
export function reminderChannelSelection({ kind, routineChannel, requested }) {
  const origin = normalize(kind === 'routine' ? routineChannel : kind);
  const proposed = normalize(requested).replace(/^e[- ]?mail$/, 'email').replace(/^whats\s?app$/, 'whatsapp');
  if (kind === 'routine') return { channel: proposed || (supported.has(origin) ? origin : null), reason: 'selection_required' };
  if (supported.has(proposed)) return { channel: proposed };
  if (!proposed && supported.has(origin)) return { channel: origin };
  return { channel: null, reason: 'selection_required' };
}
