import { VOICE_INPUT_NOTE } from './confirm.mjs';

export { VOICE_INPUT_NOTE };

// Mensagem de voz chega ao modelo como transcrição. Sem esta marca ela é
// indistinguível de texto digitado: o 1º áudio de treino de inglês de um usuário
// (01/10) foi lido como apresentação e virou só memória, sem o feedback
// combinado. userSaid tira a linha da marca, então um "sim" falado continua
// confirmando e um "não" vizinho no mesmo lote continua cancelando.
export function markVoiceInput(text) {
  const t = String(text || '').trim();
  return t ? `${VOICE_INPUT_NOTE}\n\n${t}` : t;
}

// Rotina entregue por WhatsApp/Telegram/e-mail só leva o TEXTO (runRoutine →
// deliverRoutine): um áudio gerado ali era cobrado e nunca chegava, e a tool
// ainda dizia "já enviado". Sem a tool, o modelo não promete o que não entrega.
const ROUTINE_TEXT_ONLY = new Set(['whatsapp', 'telegram', 'email']);
export function voiceReplyDelivered({ kind, routineChannel } = {}) {
  return !(kind === 'routine' && ROUTINE_TEXT_ONLY.has(routineChannel));
}
