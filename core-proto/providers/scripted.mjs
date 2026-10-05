// ── Provider determinístico (simula um "modelo") ──
// Sem credencial externa: serve pra PROVAR que o mesmo loop + as mesmas tools
// funcionam trocando só o provider. Duas instâncias com `strategy` diferente
// representam dois "modelos" distintos. Cada uma faz: turno 1 chama a tool,
// turno 2 lê o resultado e responde. Exercita o tool-loop de verdade.

import { STOP } from '../provider.mjs';

let counter = 0;
const nextId = () => `call_${++counter}`;

export function makeScripted({ name, strategy }) {
  return {
    name,
    async complete({ messages }) {
      const lastTool = [...messages].reverse().find((m) => m.role === 'tool');

      // Ainda não buscou → chama a tool. (parse bem simples do pedido)
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

      // Já tem resultado → escolhe conforme a estratégia do "modelo" e responde.
      const produtos = JSON.parse(lastTool.content || '[]');
      if (produtos.length === 0) {
        return { stop: STOP.END, text: 'Não achei nada dentro do orçamento. Quer aumentar o limite?' };
      }
      const pick = strategy === 'melhor_nota'
        ? produtos[0]                                   // já vem ordenado por nota desc
        : [...produtos].sort((a, b) => a.preco - b.preco)[0]; // mais barato
      const justificativa = strategy === 'melhor_nota' ? 'melhor avaliação' : 'melhor preço';
      return {
        stop: STOP.END,
        text: `Recomendo o *${pick.nome}* por R$${pick.preco} (nota ${pick.nota}), priorizando ${justificativa}.`,
      };
    },
  };
}
