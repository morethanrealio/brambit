// Idioma da resposta na saída do turno: observabilidade (logDerivaIdioma) e o
// freio que impede resposta em chinês para quem não pediu (freioDeIdioma).
import { runAgent, ToolRegistry } from '../core-proto/core.mjs';
import { derivaDeIdioma, ideogramaAcidental, reescritaNoIdioma, mesmasLinhas, avisoSemIdioma } from './locale.mjs';

// Observabilidade da diretriz de idioma. Em pt-BR não loga nada (é o esperado).
// Fora dele sai UMA linha por turno com o score, mesmo quando está limpo: sem
// número dos dois lados não dá pra dizer se a diretriz funciona nem pra calibrar
// o limiar. NUNCA interfere na resposta, só escreve no log.
export function logDerivaIdioma(texto, language, userId) {
  try {
    const d = derivaDeIdioma(texto, language);
    if (!d) return;
    console.log(`[idioma ${d.suspeita ? 'DERIVA' : 'ok'}] u=${String(userId).slice(0, 8)} lang=${d.idioma} score=${d.score} marcas=${d.marcas}/${d.palavras}`);
  } catch { /* observabilidade nunca derruba turno */ }
}

// FREIO DE IDIOMA. O lembrete de idioma por turno (30/09) é instrução, e o modelo
// às vezes não atende: em 05/10 o DeepSeek respondeu em chinês a um usuário em
// pt-BR mesmo com ele. Aqui a plataforma confere a saída antes de entregar. A
// conferência é só contagem de caracteres (sem LLM); pegou, pede ao mesmo modelo
// a MESMA mensagem reescrita no idioma da pessoa, numa chamada curta sem
// ferramentas (nada do turno roda de novo). Se nem assim sair, vai um aviso curto
// no lugar de um texto que a pessoa não consegue ler.
// pedido = mensagem da pessoa ('' em rotina); usages recebe o custo da reescrita.
// Devolve o texto a entregar (o mesmo, se não houve deriva).
export async function freioDeIdioma({ text, language, pedido = '', provider, usages, onde = '' }) {
  try {
    const deriva = ideogramaAcidental(text, language, pedido);
    if (!deriva) return text;
    let desfecho = 'aviso', saida = text, legivel = null;
    // Até 2 tentativas: vale a primeira que sai no idioma com as mesmas linhas;
    // sem nenhuma assim, a que saiu no idioma (pulou linha, mas é legível).
    const r = reescritaNoIdioma(language);
    for (let i = 0; i < 2 && desfecho === 'aviso'; i++) {
      try {
        const refeito = await runAgent({ provider, tools: new ToolRegistry(), system: r.system,
          userInput: r.entrada(pedido, text), history: [], maxSteps: 1 });
        usages?.push(...(refeito.usages || []));
        if (!refeito.text || ideogramaAcidental(refeito.text, language, '')) continue;
        if (mesmasLinhas(text, refeito.text)) { saida = refeito.text; desfecho = 'reescrito'; } else legivel ??= refeito.text;
      } catch (e) { console.error('[freio_idioma] reescrita falhou:', e?.message ?? e); }
    }
    if (desfecho === 'aviso' && legivel) { saida = legivel; desfecho = 'reescrito_linhas_diferentes'; }
    if (desfecho === 'aviso') saida = avisoSemIdioma(language);
    console.warn(`[freio_idioma] ${onde} lang=${deriva.idioma} han=${deriva.han} parte=${deriva.parte} desfecho=${desfecho}`);
    return saida;
  } catch (e) { console.error('[freio_idioma]', e?.message ?? e); return text; }
}
