// Teste offline do parser de confirmação. Nada sai pra rede, nada toca banco.
// Roda com: node confirm.test.mjs
import { isConfirmation } from './web/confirm.mjs';

let ok = 0, fail = 0;
const t = (nome, cond) => { if (cond) { ok++; console.log('  ok  ', nome); } else { fail++; console.log('  FALHA', nome); } };
const confirma = (txt) => t(`confirma: ${JSON.stringify(txt)}`, isConfirmation(txt) === true);
const cancela = (txt) => t(`cancela : ${JSON.stringify(txt)}`, isConfirmation(txt) === false);

// 1) Confirmações simples em pt (comportamento antigo, não pode regredir).
['sim', 'sim!', 'pode', 'pode sim', 'pode mandar', 'manda', 'manda ver', 'manda aí',
 'ok', 'beleza', 'blz', 'claro', 'isso', 'isso mesmo', 'positivo', 'bora',
 'aprovo', 'aprovado', 'confirmo', 'confirmado', 'autorizo', 'tá certo',
 'envia', 'envie', 'publica', 'sobe', 'cria', 'faz', '👍', '✅'].forEach(confirma);

// 2) Negativas em pt (comportamento antigo, não pode regredir).
['não', 'nao', 'não, cancela', 'cancela', 'cancelar', 'espera', 'esquece',
 'deixa pra lá', 'deixa pra depois', 'nem', 'melhor não', 'aguarda', 'peraí',
 'não confirma', 'não manda'].forEach(cancela);

// 3) O bug do "para": \bpara\b casava com a PREPOSIÇÃO e cancelava em silêncio.
//    Vale pra pt e pra es. Estas linhas eram todas CANCELADA antes do conserto.
['pode enviar para a Ana', 'sim, para o cliente',
 'confirmo, manda para ele', 'ok, envia para ana@x.com', 'pode mandar para mim',
 'sim, envia para nós', 'manda para você mesmo', 'pode, para os dois',
 'sí, para el cliente', 'sí, mándalo para Juan', 'ok para mí',
 'sí, es para mañana', 'claro, para ella'].forEach(confirma);

// 4) "para" como VERBO parar tem que continuar cancelando. É o risco do conserto
//    acima: se afrouxar demais, "ok, para" (= pare) viraria confirmação.
['para', 'para!', 'para.', 'para com isso', 'para tudo', 'para de mandar',
 'para aí', 'para agora', 'ok, para', 'sim, para', 'para, cancela',
 'pare', 'pare com isso', 'para ya', 'PARA', 'Para!', 'ok PARA'].forEach(cancela);

// 5) Inglês (positivas e negativas), sem mudança.
['yes', 'yeah', 'yep', 'sure', 'go ahead', 'do it', 'send it', 'proceed',
 'lgtm', 'looks good', 'yes please', 'i confirm', 'approved'].forEach(confirma);
['no', 'nope', 'cancel', 'wait', 'stop', 'hold on', 'never mind', 'forget it',
 'not yet', "don't send it", 'no, cancel that'].forEach(cancela);

// 6) Espanhol, comportamento que já existia (não pode regredir).
['sí', 'si', 'claro que sí', 'adelante'].forEach(confirma);
['no', 'no lo envíes', 'cancela', 'espera'].forEach(cancela);

// 6b) Espanhol: dicionário próprio (antes eram só 'sí' e 'adelante', penduradas
//     dentro da regex de inglês).
// Autorização explícita, vale em frase de qualquer tamanho:
['hazlo', 'házlo', 'hágalo', 'envíalo', 'mándalo', 'publícalo', 'súbelo',
 'apruebo', 'lo apruebo', 'estoy de acuerdo', 'está bien', 'me parece bien',
 'sí, puedes enviar el correo ahora mismo', 'puedes publicarlo',
 'adelante, mándalo al equipo de ventas hoy'].forEach(confirma);
// Positivas curtas:
['de acuerdo', 'dale', 'perfecto', 'así es', 'eso es', 'exacto', 'por supuesto',
 'correcto', 'correcta', 'hecho', 'sí, correcto'].forEach(confirma);

// 6c) Negativas em espanhol. ANTES não existia NENHUMA: só o `^no` do inglês
//     pegava algo, e qualquer recusa em outra forma passava batido.
['nunca', 'olvídalo', 'olvidalo', 'olvídate', 'déjalo', 'dejalo', 'déjame',
 'todavía no', 'aún no', 'aun no', 'ahora no', 'mejor no', 'detente', 'párate',
 'para nada', 'de ninguna manera', 'no lo hagas', 'no lo mandes', 'no la subas',
 'no me lo envíes', 'no, perfecto así', 'sí pero mejor no'].forEach(cancela);

// 6d) O "si" sem acento é o "se" condicional do espanhol. Sozinho conta como
//     sim (é como as pessoas escrevem no celular); dentro de frase NÃO, senão o
//     limite de 4 palavras executaria ação real em cima de uma condicional.
['si', 'si!', 'si.'].forEach(confirma);
['si puedes', 'si es posible', 'si eso ayuda'].forEach(cancela);
// ("si quieres, mándalo" confirma, e está certo: o verbo forte 'mándalo' manda,
//  não o 'si'.)
['si quieres, mándalo'].forEach(confirma);

// 6e) LIMITE CONHECIDO mantido de propósito: sem verbo forte, só confirma frase
//     de até 4 palavras. Vale igual em pt e em es, não é falta de dicionário.
['sim, manda para o João', 'sí, envía para el equipo'].forEach(cancela);

// 6f) O "no" solto do espanhol NÃO entrou na negativa de propósito: em português
//     "no" é a contração em+o. Se entrasse, estas confirmações legítimas em pt
//     seriam canceladas em silêncio (mesma armadilha do "para").
['publica no LinkedIn', 'sobe no servidor', 'ok, manda no grupo',
 'pode subir no Drive'].forEach(confirma);

// 6g) Fronteira ASCII: o \b do JS fecha depois de letra acentuada, então `^no\b`
//     casava em palavra que só COMEÇA com "no" ("noções") e cancelava.
['noções alinhadas, pode enviar'].forEach(confirma);

// 6h) Palavra espanhola DENTRO de palavra portuguesa não confirma. O verbo forte
//     é testado antes do limite de 4 palavras, então sem fronteira ele executava
//     ação irreversível no meio de uma frase que não confirmava nada.
['o mandaloriano é minha série favorita', 'nunca vi o mandaloriano',
 'só falta subelo no ar amanhã'].forEach(cancela);

// 6i) Imperativo espanhol com pronome colado exige o ACENTO, que em espanhol é
//     obrigatório nessas formas. Sem acento, "mandalo"/"envialo" são o jeito
//     torto de escrever "mandá-lo"/"enviá-lo" em português, e a frase abaixo
//     disparava a ação. Com acento, segue confirmando espanhol de verdade.
['preciso pensar antes de mandalo', 'vou revisar antes de envialo',
 'falta publicalo ainda'].forEach(cancela);
['mándalo', 'envíalo', 'publícalo', 'súbelo', 'hazlo', 'hágalo',
 'puedes publicarlo'].forEach(confirma);

// 6j) "nunca" é palavra corrente do PORTUGUÊS em frase que confirma, e por isso
//     nunca esteve na negativa em pt. Na negativa espanhola ele só vale como
//     fala inteira ou colado a pronome/verbo que não existe em pt. De fora
//     ficaram "nunca te" e "nunca se", que são português ("nunca se sabe").
['isso nunca falha, pode enviar', 'nunca deu problema, pode subir',
 'nunca se sabe, mas pode mandar'].forEach(confirma);
['nunca', 'nunca lo hagas', 'nunca la publiques'].forEach(cancela);

// 6k) O "no" espanhol com pronome ("no lo hagas") colidia com a contração em+o
//     do português seguida de nome próprio. Em espanhol vem verbo em minúscula;
//     em português, nome próprio em maiúscula.
// (frases de até 4 palavras: acima disso o limite conservador já cancela
//  sozinho, por outro motivo, e o teste não provaria nada.)
['manda no La Nación', 'publica no Los Angeles',
 'envia no Le Monde'].forEach(confirma);
['no lo hagas', 'No lo hagas', 'no la envíes', 'no te preocupes'].forEach(cancela);

// 7) Nada de confirmar por engano: pergunta, frase longa, vazio.
['deu certo?', 'pode?', 'quando publicar o app me avisa', 'depois eu vejo se pode',
 'você acha que pode mandar isso hoje ainda ou é melhor esperar?',
 '', '   ', 'não\nsim', 'sim\nnão'].forEach(cancela);

console.log(`\n${ok} ok, ${fail} falha(s)`);
process.exit(fail ? 1 : 0);
