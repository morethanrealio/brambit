// ── Deterministic provider (simulates a "model") ──
// No external credential: used to PROVE that the same loop + the same tools
// work just by swapping the provider. Two instances with different `strategy`
// represent two distinct "models". Each one does: turn 1 calls the tool,
// turn 2 reads the result and responds. Exercises the tool-loop for real.

import { STOP } from '../provider.mjs';

let counter = 0;
const nextId = () => `call_${++counter}`;

export function makeScripted({ name, strategy }) {
  return {
    name,
    async complete({ messages }) {
      const lastTool = [...messages].reverse().find((m) => m.role === 'tool');

      // Hasn't searched yet → calls the tool. (very simple parse of the request)
      if (!lastTool) {
        const userText = messages.find((m) => m.role === 'user')?.content ?? '';
        const precoMatch = userText.match(/(\d{2,5})/);
        return {
          stop: STOP.TOOL,
          toolCalls: [{
            id: nextId(),
            name: 'search_products',
            args: { categoria: 'corrida', preco_max: precoMatch ? Number(precoMatch[1]) : undefined },
          }],
        };
      }

      // Already has a result → chooses according to the "model"'s strategy and responds.
      const produtos = JSON.parse(lastTool.content || '[]');
      if (produtos.length === 0) {
        return { stop: STOP.END, text: 'Não achei nada dentro do orçamento. Quer aumentar o limite?' };
      }
      const pick = strategy === 'melhor_nota'
        ? produtos[0]                                   // already comes sorted by score desc
        : [...produtos].sort((a, b) => a.preco - b.preco)[0]; // mais barato
      const justificativa = strategy === 'melhor_nota' ? 'melhor avaliação' : 'melhor preço';
      return {
        stop: STOP.END,
        text: `Recomendo o *${pick.nome}* por R$${pick.preco} (nota ${pick.nota}), priorizando ${justificativa}.`,
      };
    },
  };
}
