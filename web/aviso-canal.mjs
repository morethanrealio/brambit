// Aviso de erro dos canais de conversa (Telegram, Slack) e reenvio da resposta.
//
// Caso Luffy 05/10/2026: o turno terminou (gravou a memória e a resposta no
// histórico), mas o envio pelo Telegram falhou na rede. O canal mandou o aviso
// genérico "Tive um problema pra responder agora. Tenta de novo?", que NÃO ficava
// no histórico. Quando a pessoa respondeu "pode tentar de novo sim", o modelo não
// tinha a que ligar o "de novo" e foi buscar a jornada de descoberta.
//
// Duas falhas diferentes pedem dois avisos diferentes:
// - `turno`: o turno quebrou antes de responder. A pergunta da pessoa e o aviso
//   entram no histórico, então "tenta de novo" aponta pro pedido certo.
// - `entrega`: a resposta ficou pronta e já está no histórico, só não chegou.
//   Antes de avisar, o canal reenvia a mesma resposta (sem rodar o turno de
//   novo); o aviso só sai se o reenvio também falhar, e diz que nada será refeito.
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

// Esperas entre as tentativas de reenvio. Só erro incerto (rede, timeout,
// 429/5xx) é repetido: recusa determinística (`definitive`, ex.: bot bloqueado)
// não melhora tentando de novo. Erro incerto pode ter chegado, então o reenvio
// pode duplicar uma parte; resposta repetida é melhor que resposta sumida.
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

// Monta o `avisar` de um canal. Do servidor vêm o idioma da pessoa e o registro
// no histórico da thread do canal; aqui fica só a regra comum.
// avisar({ agent, userId, tipo, mensagem, enviar }): manda o aviso e, se ele não
// foi recusado com certeza, grava no histórico (com a pergunta, quando `turno`).
// Nunca lança: o aviso é o último recurso de um caminho que já falhou.
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

// Registro padrão do servidor: o aviso entra na thread fixa do canal (`title`),
// dentro da trava da thread, pra não cruzar com um turno gravando ao mesmo tempo.
export function avisoNaThread({ idiomaDe, getOrCreateThreadByTitle, withThreadLock, appendAssistantToThread }) {
  return (title) => ({
    idiomaDe,
    registrar: async ({ agent, userId, text, pergunta }) => {
      const thread = await getOrCreateThreadByTitle({ agentId: agent.id, userId, title });
      await withThreadLock(thread.id, () => appendAssistantToThread({ threadId: thread.id, userId, text, pergunta }));
    },
  });
}
