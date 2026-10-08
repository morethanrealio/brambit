// Offline test of the confirmation parser. Nothing goes out to the network, nothing touches the database.
// Run with: node confirm.test.mjs
import { isConfirmation } from './web/confirm.mjs';

let ok = 0, fail = 0;
const t = (nome, cond) => { if (cond) { ok++; console.log('  ok  ', nome); } else { fail++; console.log('  FALHA', nome); } };
const confirma = (txt) => t(`confirma: ${JSON.stringify(txt)}`, isConfirmation(txt) === true);
const cancela = (txt) => t(`cancela : ${JSON.stringify(txt)}`, isConfirmation(txt) === false);

// 1) Simple confirmations in pt (old behavior, must not regress).
['sim', 'sim!', 'pode', 'pode sim', 'pode mandar', 'manda', 'manda ver', 'manda aí',
 'ok', 'beleza', 'blz', 'claro', 'isso', 'isso mesmo', 'positivo', 'bora',
 'aprovo', 'aprovado', 'confirmo', 'confirmado', 'autorizo', 'tá certo',
 'envia', 'envie', 'publica', 'sobe', 'cria', 'faz', '👍', '✅'].forEach(confirma);

// 2) Negatives in pt (old behavior, must not regress).
['não', 'nao', 'não, cancela', 'cancela', 'cancelar', 'espera', 'esquece',
 'deixa pra lá', 'deixa pra depois', 'nem', 'melhor não', 'aguarda', 'peraí',
 'não confirma', 'não manda'].forEach(cancela);

// 3) The "para" bug: \bpara\b matched the PREPOSITION and cancelled silently.
//    Applies to both pt and es. These lines were all CANCELLED before the fix.
['pode enviar para a Ana', 'sim, para o cliente',
 'confirmo, manda para ele', 'ok, envia para ana@x.com', 'pode mandar para mim',
 'sim, envia para nós', 'manda para você mesmo', 'pode, para os dois',
 'sí, para el cliente', 'sí, mándalo para Juan', 'ok para mí',
 'sí, es para mañana', 'claro, para ella'].forEach(confirma);

// 4) "para" as the VERB parar (to stop) has to keep cancelling. That's the risk of the fix
//    above: if loosened too much, "ok, para" (= stop) would turn into a confirmation.
['para', 'para!', 'para.', 'para com isso', 'para tudo', 'para de mandar',
 'para aí', 'para agora', 'ok, para', 'sim, para', 'para, cancela',
 'pare', 'pare com isso', 'para ya', 'PARA', 'Para!', 'ok PARA'].forEach(cancela);

// 5) English (positives and negatives), unchanged.
['yes', 'yeah', 'yep', 'sure', 'go ahead', 'do it', 'send it', 'proceed',
 'lgtm', 'looks good', 'yes please', 'i confirm', 'approved'].forEach(confirma);
['no', 'nope', 'cancel', 'wait', 'stop', 'hold on', 'never mind', 'forget it',
 'not yet', "don't send it", 'no, cancel that'].forEach(cancela);

// 6) Spanish, behavior that already existed (must not regress).
['sí', 'si', 'claro que sí', 'adelante'].forEach(confirma);
['no', 'no lo envíes', 'cancela', 'espera'].forEach(cancela);

// 6b) Spanish: its own dictionary (before it was only 'sí' and 'adelante', tacked
//     onto the English regex).
// Explicit authorization, valid in a sentence of any length:
['hazlo', 'házlo', 'hágalo', 'envíalo', 'mándalo', 'publícalo', 'súbelo',
 'apruebo', 'lo apruebo', 'estoy de acuerdo', 'está bien', 'me parece bien',
 'sí, puedes enviar el correo ahora mismo', 'puedes publicarlo',
 'adelante, mándalo al equipo de ventas hoy'].forEach(confirma);
// Positivas curtas:
['de acuerdo', 'dale', 'perfecto', 'así es', 'eso es', 'exacto', 'por supuesto',
 'correcto', 'correcta', 'hecho', 'sí, correcto'].forEach(confirma);

// 6c) Negatives in Spanish. BEFORE there was NONE: only the English `^no`
//     caught anything, and any refusal in another form went right through.
['nunca', 'olvídalo', 'olvidalo', 'olvídate', 'déjalo', 'dejalo', 'déjame',
 'todavía no', 'aún no', 'aun no', 'ahora no', 'mejor no', 'detente', 'párate',
 'para nada', 'de ninguna manera', 'no lo hagas', 'no lo mandes', 'no la subas',
 'no me lo envíes', 'no, perfecto así', 'sí pero mejor no'].forEach(cancela);

// 6d) The unaccented "si" is the Spanish conditional "if". Alone it counts as
//     yes (it's how people type it on their phones); inside a sentence it does NOT, otherwise the
//     4-word limit would execute a real action on top of a conditional.
['si', 'si!', 'si.'].forEach(confirma);
['si puedes', 'si es posible', 'si eso ayuda'].forEach(cancela);
// ("si quieres, mándalo" confirms, and that's correct: the strong verb 'mándalo' drives it,
//  not the 'si'.)
['si quieres, mándalo'].forEach(confirma);

// 6e) KNOWN LIMIT kept on purpose: without a strong verb, it only confirms a sentence
//     of up to 4 words. Applies equally in pt and es, it's not a missing dictionary entry.
['sim, manda para o João', 'sí, envía para el equipo'].forEach(cancela);

// 6f) The standalone Spanish "no" was deliberately NOT added to the negative set: in Portuguese
//     "no" is the contraction em+o (in+the). If it were added, these legitimate pt confirmations
//     would be silently cancelled (same trap as "para").
['publica no LinkedIn', 'sobe no servidor', 'ok, manda no grupo',
 'pode subir no Drive'].forEach(confirma);

// 6g) ASCII boundary: JS's \b closes right after an accented letter, so `^no\b`
//     matched a word that only STARTS with "no" ("noções") and cancelled it.
['noções alinhadas, pode enviar'].forEach(confirma);

// 6h) A Spanish word INSIDE a Portuguese word does not confirm. The strong verb
//     is tested before the 4-word limit, so without a boundary it would execute an
//     irreversible action in the middle of a sentence that confirmed nothing.
['o mandaloriano é minha série favorita', 'nunca vi o mandaloriano',
 'só falta subelo no ar amanhã'].forEach(cancela);

// 6i) Spanish imperative with an attached pronoun requires the ACCENT, which in Spanish is
//     mandatory in these forms. Without the accent, "mandalo"/"envialo" are the crooked
//     way of writing "mandá-lo"/"enviá-lo" in Portuguese, and the sentence below
//     would trigger the action. With the accent, it keeps confirming real Spanish.
['preciso pensar antes de mandalo', 'vou revisar antes de envialo',
 'falta publicalo ainda'].forEach(cancela);
['mándalo', 'envíalo', 'publícalo', 'súbelo', 'hazlo', 'hágalo',
 'puedes publicarlo'].forEach(confirma);

// 6j) "nunca" is a common PORTUGUESE word in a sentence that confirms, and that's why
//     it was never in the pt negative set. In the Spanish negative set it only counts as a
//     whole utterance or attached to a pronoun/verb that doesn't exist in pt. Left out
//     were "nunca te" and "nunca se", which are Portuguese ("nunca se sabe").
['isso nunca falha, pode enviar', 'nunca deu problema, pode subir',
 'nunca se sabe, mas pode mandar'].forEach(confirma);
['nunca', 'nunca lo hagas', 'nunca la publiques'].forEach(cancela);

// 6k) The Spanish "no" with a pronoun ("no lo hagas") collided with the Portuguese
//     contraction em+o followed by a proper noun. In Spanish a lowercase verb follows;
//     in Portuguese, an uppercase proper noun follows.
// (sentences of up to 4 words: above that the conservative limit already cancels
//  on its own, for a different reason, and the test wouldn't prove anything.)
['manda no La Nación', 'publica no Los Angeles',
 'envia no Le Monde'].forEach(confirma);
['no lo hagas', 'No lo hagas', 'no la envíes', 'no te preocupes'].forEach(cancela);

// 7) No accidental confirmation: question, long sentence, empty.
['deu certo?', 'pode?', 'quando publicar o app me avisa', 'depois eu vejo se pode',
 'você acha que pode mandar isso hoje ainda ou é melhor esperar?',
 '', '   ', 'não\nsim', 'sim\nnão'].forEach(cancela);

console.log(`\n${ok} ok, ${fail} falha(s)`);
process.exit(fail ? 1 : 0);
