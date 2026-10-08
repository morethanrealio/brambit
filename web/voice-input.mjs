import { VOICE_INPUT_NOTE } from './confirm.mjs';

export { VOICE_INPUT_NOTE };

// A voice message reaches the model as a transcript. Without this marker it is
// indistinguishable from typed text: a user's 1st English-practice audio
// (2026-10-01) was read as an introduction and became just a memory, without the
// agreed feedback. userSaid strips the marker line, so a spoken "yes" still
// confirms and a "no" next to it in the same batch still cancels.
export function markVoiceInput(text) {
  const t = String(text || '').trim();
  return t ? `${VOICE_INPUT_NOTE}\n\n${t}` : t;
}

// A routine delivered via WhatsApp/Telegram/email only carries TEXT (runRoutine →
// deliverRoutine): an audio generated there used to be charged and never arrived, and the tool
// would still say "already sent". Without the tool, the model doesn't promise what it can't deliver.
const ROUTINE_TEXT_ONLY = new Set(['whatsapp', 'telegram', 'email']);
export function voiceReplyDelivered({ kind, routineChannel } = {}) {
  return !(kind === 'routine' && ROUTINE_TEXT_ONLY.has(routineChannel));
}
