// Response language at turn output: observability (logDerivaIdioma) and the
// guard that blocks a Chinese response for whoever didn't ask for it
// (freioDeIdioma).
import { runAgent, ToolRegistry } from '../core-proto/core.mjs';
import { derivaDeIdioma, ideogramaAcidental, reescritaNoIdioma, mesmasLinhas, avisoSemIdioma } from './locale.mjs';

// Observability for the language directive. In pt-BR it logs nothing (that's
// expected). Outside it, ONE line per turn goes out with the score, even when
// it's clean: without numbers on both sides there's no way to tell whether
// the directive works or to calibrate the threshold. NEVER interferes with
// the response, only writes to the log.
export function logDerivaIdioma(texto, language, userId) {
  try {
    const d = derivaDeIdioma(texto, language);
    if (!d) return;
    console.log(`[idioma ${d.suspeita ? 'DERIVA' : 'ok'}] u=${String(userId).slice(0, 8)} lang=${d.idioma} score=${d.score} marcas=${d.marcas}/${d.palavras}`);
  } catch { /* observabilidade nunca derruba turno */ }
}

// LANGUAGE GUARD. The per-turn language reminder (2026-09-30) is an instruction,
// and the model sometimes doesn't follow it: on 2026-10-05 DeepSeek replied in
// Chinese to a pt-BR user even with it in place. Here the platform checks the
// output before delivering it. The check is just a character count (no LLM);
// if it catches something, it asks the same model to rewrite the SAME message
// in the person's language, in a short call with no tools (nothing from the
// turn runs again). If it still doesn't come out right, a short notice goes
// out instead of text the person can't read.
// pedido = the person's message ('' in a routine); usages receives the cost
// of the rewrite.
// Returns the text to deliver (the same one, if there was no drift).
export async function freioDeIdioma({ text, language, pedido = '', provider, usages, onde = '' }) {
  try {
    const deriva = ideogramaAcidental(text, language, pedido);
    if (!deriva) return text;
    let desfecho = 'aviso', saida = text, legivel = null;
    // Up to 2 attempts: the first one that comes out in the right language
    // with the same lines wins; failing that, whichever came out in the
    // right language (skipped a line, but is readable).
    const r = reescritaNoIdioma(language);
    for (let i = 0; i < 2 && desfecho === 'aviso'; i++) {
      try {
        const refeito = await runAgent({ provider, tools: new ToolRegistry(), system: r.system,
          userInput: r.entrada(pedido, text), history: [], maxSteps: 1 });
        usages?.push(...(refeito.usages || []));
        if (!refeito.text || ideogramaAcidental(refeito.text, language, '')) continue;
        if (mesmasLinhas(text, refeito.text)) { saida = refeito.text; desfecho = 'reescrito'; } else legivel ??= refeito.text;
      } catch (e) { console.error('[freio_idioma] rewrite failed:', e?.message ?? e); }
    }
    if (desfecho === 'aviso' && legivel) { saida = legivel; desfecho = 'reescrito_linhas_diferentes'; }
    if (desfecho === 'aviso') saida = avisoSemIdioma(language);
    console.warn(`[freio_idioma] ${onde} lang=${deriva.idioma} han=${deriva.han} parte=${deriva.parte} desfecho=${desfecho}`);
    return saida;
  } catch (e) { console.error('[freio_idioma]', e?.message ?? e); return text; }
}
