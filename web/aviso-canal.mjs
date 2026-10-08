// Error notice for conversation channels (Telegram, Slack) and reply resend.
//
// A user report on 05/10/2026: the turn finished (memory and reply saved in the
// history), but the Telegram send failed on the network. The channel sent the
// generic "I had a problem replying now. Try again?", which was NOT kept in the
// history. When the person answered "yes, try again", the model had nothing to
// tie "again" to and went for the discovery journey.
//
// Two different failures need two different notices:
// - `turno`: the turn broke before replying. The person's question and the
//   notice enter the history, so "try again" points to the right request.
// - `entrega`: the reply was ready and is already in the history, it just didn't
//   arrive. Before notifying, the channel resends the same reply (without
//   rerunning the turn); the notice only goes out if the resend also fails, and
//   says nothing will be redone.
import { tagIdioma } from './locale.mjs';

const TEXTOS = {
  'pt-BR': {
    turno: 'Tive um problema e não consegui terminar de responder à sua última mensagem. Quer que eu tente de novo?',
    entrega: 'Terminei de responder, mas a resposta não chegou inteira por aqui. Me peça pra repetir que eu mando de novo, sem refazer nada.',
  },
  en: {
    turno: "I ran into a problem and couldn't finish replying to your last message. Want me to try again?",
    entrega: "I finished replying, but the answer didn't fully come through here. Ask me to repeat it and I'll resend it without redoing anything.",
  },
  es: {
    turno: 'Tuve un problema y no pude terminar de responder a tu último mensaje. ¿Quieres que lo intente de nuevo?',
    entrega: 'Terminé de responder, pero la respuesta no llegó completa por aquí. Pídeme que la repita y te la reenvío sin rehacer nada.',
  },
};

export function textoAvisoCanal(language, tipo) {
  return (TEXTOS[tagIdioma(language)] || TEXTOS['pt-BR'])[tipo];
}

// Waits between resend attempts. Only an uncertain error (network, timeout,
// 429/5xx) gets retried: a deterministic refusal (`definitive`, e.g. bot
// blocked) does not improve by trying again. An uncertain error may have
// actually arrived, so the resend can duplicate a part; a repeated answer is
// better than a missing one.
export function esperasDeReenvio() {
  const env = process.env.CANAL_REENVIO_MS;
  if (env === undefined) return [2000, 8000];
  return env.split(',').map(Number).filter(n => Number.isFinite(n) && n >= 0);
}

export async function comReenvio(enviar, { esperas = esperasDeReenvio(), rotulo = 'canal' } = {}) {
  for (let i = 0; ; i++) {
    try { return await enviar(); } catch (e) {
      if (e?.definitive === true || i >= esperas.length) throw e;
      console.warn(`[${rotulo}] envio falhou, tentando de novo:`, e?.message ?? e);
      await new Promise(r => setTimeout(r, esperas[i]));
    }
  }
}

// Builds a channel's `avisar`. The person's language and the logging into the
// channel thread's history come from the server; only the shared rule stays here.
// avisar({ agent, userId, tipo, mensagem, enviar }): sends the notice and, if
// it was not definitely refused, logs it to the history (with the question,
// when `turno`). Never throws: the notice is the last resort of a path that
// already failed.
export function criarAvisoCanal({ rotulo, idiomaDe, registrar }) {
  return async function avisar({ agent, userId, tipo, mensagem, enviar }) {
    let text = textoAvisoCanal(null, tipo);
    try { text = textoAvisoCanal((await idiomaDe?.(userId))?.language, tipo); } catch { /* fica pt-BR */ }
    let recusado = false;
    try { await enviar(text); } catch (e) {
      recusado = e?.definitive === true;
      console.error(`[${rotulo}] aviso de erro não entregue:`, e?.message ?? e);
    }
    if (recusado || !registrar) return;
    try { await registrar({ agent, userId, text, pergunta: tipo === 'turno' ? mensagem : null }); } catch (e) {
      console.error(`[${rotulo}] aviso de erro fora do histórico:`, e?.message ?? e);
    }
  };
}

// Server's default logging: the notice enters the channel's fixed thread
// (`title`), inside the thread lock, so it doesn't cross with a turn writing
// at the same time.
export function avisoNaThread({ idiomaDe, getOrCreateThreadByTitle, withThreadLock, appendAssistantToThread }) {
  return (title) => ({
    idiomaDe,
    registrar: async ({ agent, userId, text, pergunta }) => {
      const thread = await getOrCreateThreadByTitle({ agentId: agent.id, userId, title });
      await withThreadLock(thread.id, () => appendAssistantToThread({ threadId: thread.id, userId, text, pergunta }));
    },
  });
}
