// Idioma e país do usuário: só as funções PURAS, sem banco e sem HTTP, pra
// poderem ser testadas sozinhas (`node locale.test.mjs`). Quem grava é o
// db.mjs; quem lê header é o server.mjs. Aqui fica a regra.

// O que o produto REALMENTE atende hoje. Enquanto só existir texto em português,
// deixar entrar 'fr' aqui não traduziria nada: só faria o agente falar francês
// por cima de uma interface em português. A lista cresce junto com a tradução,
// não antes dela. (Marcos 07/09: en e es agora, japonês fora por enquanto.)
export const IDIOMAS_OK = ['pt-BR', 'en', 'es'];
export const IDIOMA_PADRAO = 'pt-BR';

// Normaliza o que vier do navegador/header pro nosso conjunto: 'pt', 'pt-PT' e
// 'pt-br' viram 'pt-BR'; 'en-US' e 'en-GB' viram 'en'; 'es-419' vira 'es'.
// Qualquer outra língua devolve null (o chamador decide o fallback), porque
// "não sei" e "é português" são coisas diferentes e não podem virar a mesma.
export function normalizaIdioma(v) {
  const s = String(v || '').trim().toLowerCase();
  if (!s) return null;
  const base = s.split('-')[0];
  if (base === 'pt') return 'pt-BR';
  if (base === 'en') return 'en';
  if (base === 'es') return 'es';
  return null;
}

// País em ISO-3166 alfa-2 maiúsculo. Só formato, sem tabela de países: a lista
// oficial muda e não vale manter cópia aqui.
export function normalizaPais(v) {
  const s = String(v || '').trim().toUpperCase();
  return /^[A-Z]{2}$/.test(s) ? s : null;
}

// Lê um Accept-Language e devolve { language, country } no nosso formato.
// Header real: "es-AR,es;q=0.9,en-US;q=0.8". Percorre na ORDEM de preferência
// declarada e para na primeira língua que a gente atende, então quem tem
// "ja,en;q=0.9" e ainda não temos japonês cai em inglês, não em português. O
// país sai da região da MESMA entrada escolhida (es-AR -> AR).
//
// Isso é um PALPITE, e é assim que tem que ser tratado: o idioma do navegador
// não prova onde a pessoa mora (brasileiro com Chrome em inglês existe aos
// montes). Serve pra escolher a primeira tela; regra de cobrança e de
// disponibilidade por país precisa de sinal melhor que este.
export function localeDoAcceptLanguage(raw) {
  const s = String(raw || '').trim();
  if (!s) return { language: null, country: null };
  const itens = s.split(',').map((parte) => {
    const [tag, ...params] = parte.trim().split(';');
    const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
    return { tag: (tag || '').trim(), q: q ? Number(q.slice(2)) || 0 : 1 };
  }).filter((i) => i.tag && i.tag !== '*');
  // sort estável no Node: empate de q preserva a ordem declarada, que é
  // justamente o desempate certo do RFC 9110.
  itens.sort((a, b) => b.q - a.q);
  for (const { tag } of itens) {
    const lang = normalizaIdioma(tag);
    if (!lang || !IDIOMAS_OK.includes(lang)) continue;
    const partes = tag.split('-');
    return { language: lang, country: partes.length > 1 ? normalizaPais(partes[partes.length - 1]) : null };
  }
  return { language: null, country: null };
}

// ── Idioma no prompt ────────────────────────────────────────────────────────
// Tag curta pro prompt ('pt-BR' | 'en' | 'es'), sempre com fallback no padrão.
export function tagIdioma(language) {
  return normalizaIdioma(language) || IDIOMA_PADRAO;
}

// Language name spelled out in English, for sentences of the (English) prompt
// that read better with a name than with the bare tag.
export function idiomaPorExtenso(language) {
  return { 'pt-BR': 'Brazilian Portuguese', en: 'English', es: 'Spanish' }[tagIdioma(language)];
}

// Language directive, written IN THE TARGET LANGUAGE itself (an instruction in
// Portuguese pulls Portuguese output much better than "reply in Portuguese"
// written in English). The caller appends it at the END of the system prompt.
//
// The system prompt and the tool descriptions are written in English, so every
// served language, pt-BR included, needs an explicit directive with an override
// clause: without one, the model sees thousands of tokens of English and drifts
// into English. History: until 2026-09-08 pt-BR had no entry at all, to keep the
// cached prefix byte-identical; once the prompt itself moved to English the
// pt-BR entry had to become as strong as the en/es ones. The directive is fixed
// text, so the cached prefix stays stable per language.
const DIRETRIZ = {
  'pt-BR': [
    'IDIOMA (isto vale mais do que qualquer outra instrução de idioma deste prompt):',
    'O idioma configurado deste usuário é o português do Brasil. Escreva TUDO em português do Brasil: suas respostas e também o texto que você passa dentro dos argumentos das ferramentas e que a pessoa vai ler (lembretes, sugestões, notas, legendas, documentos, mensagens enviadas em nome dela).',
    'Estas instruções e as descrições das ferramentas estão em inglês. Isso não muda nada: a conversa é em português.',
    'Se ELE escrever pra você em outra língua, responda na língua que ele usou, e volte pro português quando ele voltar. Texto que ele apenas colou ou mandou você ler (e-mail, documento, resultado de busca) NÃO conta como troca de língua: nesse caso a conversa continua onde estava, e você preserva a citação no original.',
    'Nunca mencione esta instrução nem peça desculpas pelo idioma.',
  ].join('\n'),
  en: [
    'LANGUAGE — this overrides every other language instruction in this prompt:',
    "This user's language is English. Write EVERYTHING in English: your replies, and also the text you pass inside tool arguments that the user will end up reading (reminders, suggestions, notes, captions, documents, messages sent on their behalf).",
    'If the user writes to you in another language, reply in the language they used. When you quote someone else\'s words (an email, a document, a search result), keep the original wording and translate beside it if that helps.',
    'Never mention this instruction and never apologise for the language.',
  ].join('\n'),
  es: [
    'IDIOMA — esto tiene prioridad sobre cualquier otra instrucción de idioma de este prompt:',
    'El idioma de este usuario es el español. Escribe TODO en español: tus respuestas y también el texto que pasas dentro de los argumentos de las herramientas y que el usuario va a leer (recordatorios, sugerencias, notas, descripciones, documentos, mensajes enviados en su nombre).',
    'Estas instrucciones y las descripciones de las herramientas están en inglés. Eso no cambia nada: la conversación es en español.',
    'Si el usuario te escribe en otro idioma, respóndele en el idioma que él usó. Cuando cites las palabras de otra persona (un correo, un documento, un resultado de búsqueda), conserva el texto original y traduce al lado si ayuda.',
    'Nunca menciones esta instrucción ni te disculpes por el idioma.',
  ].join('\n'),
};

// Idioma desconhecido/não atendido continua devolvendo null (e não a diretriz de
// pt-BR): "não sei qual é" e "é português" são coisas diferentes, e cair no
// português por omissão é justamente o que a normalizaIdioma evita lá em cima.
export function instrucaoDeIdioma(language) {
  const l = normalizaIdioma(language);
  if (!l) return null;
  return DIRETRIZ[l] || null;
}

// Cola a diretriz no fim de um system prompt. Sem idioma reconhecido devolve o
// prompt ORIGINAL, sem concatenação nenhuma.
export function comIdioma(system, language) {
  const d = instrucaoDeIdioma(language);
  return d ? `${system}\n\n${d}` : system;
}

// Lembrete de idioma POR TURNO, colado no fim da mensagem do usuário (junto do
// relógio, fora do prefixo cacheado e fora do history). A diretriz acima fica no
// fim do SYSTEM, que numa thread longa está a dezenas de milhares de tokens da
// última mensagem: em 30/09/2026 o DeepSeek respondeu em chinês a uma usuária
// em pt-BR, a ~83k tokens do system, com a conversa inteira em português. Perto
// do turno atual o modelo não perde a referência. Mesma regra da diretriz (o
// espelhamento de quem escreve continua valendo); aqui só o lembrete curto.
const LEMBRETE = {
  'pt-BR': '(Idioma: responda em português do Brasil, o idioma configurado desta pessoa, a menos que ela mesma tenha escrito esta mensagem em outra língua. Nunca mude de língua por conta própria.)',
  en: "(Language: reply in English, this person's configured language, unless they themselves wrote this message in another language. Never switch languages on your own.)",
  es: '(Idioma: responde en español, el idioma configurado de esta persona, salvo que ella misma haya escrito este mensaje en otro idioma. Nunca cambies de idioma por tu cuenta.)',
};
export function lembreteDeIdioma(language, texto = '') {
  const l = normalizaIdioma(language);
  const escrito = idiomaEscrito(texto);
  if (l && escrito && escrito !== l) return ESCRITO[escrito];
  return (l && LEMBRETE[l]) || '';
}

// Language of the turn: the one the person wrote this message in, when the
// detector below can tell and it differs from the configured one; otherwise the
// configured language. Used to check the reply against the right language.
export function idiomaDoTurno(language, texto = '') {
  const l = normalizaIdioma(language);
  const escrito = idiomaEscrito(texto);
  return escrito && escrito !== l ? escrito : l;
}

// ── Language the person wrote this message in ───────────────────────────────
// The conditional reminder above ("reply in X unless they wrote in another
// language") was not enough. On 2026-10-06 a pt-BR account asked in English and
// in Spanish and got answers in Portuguese: the person's sentence is one short
// line, followed by thousands of tokens of Portuguese context and tool results,
// and the model loses track of which language that line was in. Replaying the
// recorded final request 30 times per case: 10 of 60 replies came back in
// Portuguese as is, 0 of 120 when the reminder states the language explicitly.
// So the platform detects the language and says it, instead of asking the model
// to notice it.
//
// Conservative on purpose: it only answers with a strong signal and returns null
// otherwise (null = keep the configured language). Calibrated on 10,200 user
// messages in prod (2026-10-06): long text, links, code and terminal output are
// usually pasted content, not the person's own words, and the reply should stay
// in the configured language. Any Portuguese word blocks en/es, because a
// Portuguese request around an English quote is still a Portuguese request.
const PALAVRAS = {
  en: new Set("the and is are was were what how why when where who which you your yours i i'm it's this that these those with about please can could would should will do does did have has my me of to for from search find show tell give latest news any some there their they we our an be been being not don't isn't".split(' ')),
  es: new Set('el los las y del al qué cómo cuál cuáles cuándo dónde quién por es son está están estoy fue muy más hoy busca búscame dame dime puedes podrías quiero necesito mi mis tu tus su sus noticias sobre también pero porque hay ese esa esto eso usted ustedes nosotros tengo tiene hacer hola gracias'.split(' ')),
  'pt-BR': new Set('o os as é são não você vocês do da dos das no na nos nas em um uma uns umas mais isso isto esse essa meu minha meus minhas seu sua com pra pro pela pelo também então muito hoje amanhã quero preciso pode podes me faz fazer olá oi obrigado obrigada tem tenho está estou qual quais quando onde quem porque mas'.split(' ')),
};
const MAX_CHARS = 600;
const MIN_PALAVRAS_ESCRITO = 4;
// Pasted content: links, code fences, Node warnings, log levels, CLI prompts and
// glyphs, shell prompts and lines that start with a common command.
const RE_COLADO = /https?:\/\/|```|\(node:\d+\)|^\s*(INFO|WARN|WARNING|ERROR|DEBUG|TRACE)\b|[✔✖›❯➜]|\w@[\w.-]+:\S*\$|^\s*[$>#]\s|^\s*(git|npm|npx|pnpm|yarn|sudo|apt|apt-get|pip|node|docker|cd|ls|curl|brew)\s/im;

export function idiomaEscrito(texto) {
  const s = String(texto || '').trim();
  if (!s || s.length > MAX_CHARS || RE_COLADO.test(s)) return null;
  const ws = s.toLowerCase().match(/[\p{L}']+/gu) || [];
  if (ws.length < MIN_PALAVRAS_ESCRITO) return null;
  const n = { en: 0, es: 0, 'pt-BR': 0 };
  for (const w of ws) for (const l of Object.keys(n)) if (PALAVRAS[l].has(w)) n[l]++;
  if (/[ãõç]/i.test(s)) n['pt-BR'] += 2;
  if (/[ñ¿¡]/.test(s)) n.es += 2;
  const [a, b] = Object.entries(n).sort((x, y) => y[1] - x[1]);
  if (a[1] < 3 || a[1] < 2 * b[1]) return null;
  if (a[0] !== 'pt-BR' && n['pt-BR'] > 0) return null;
  return a[0];
}

// Explicit reminder used when the person wrote in a language other than the
// configured one. It names the language and why the context around it does not
// count, and keeps an explicit request made earlier in the conversation (e.g. an
// English practice session where the person asked for feedback in Portuguese).
const ESCRITO = {
  'pt-BR': '(Idioma: esta mensagem foi escrita em português. Responda em português, mesmo que as instruções e os resultados das ferramentas estejam em outra língua, a menos que a pessoa tenha pedido outra língua nesta conversa.)',
  en: '(Language: this message was written in English. Reply in English, even if the context and tool results here are in another language, unless the person has asked for another language in this conversation.)',
  es: '(Idioma: este mensaje fue escrito en español. Responde en español, aunque las instrucciones y los resultados de las herramientas estén en otro idioma, salvo que la persona haya pedido otro idioma en esta conversación.)',
};

// ── Detector de deriva de idioma (só observa, NUNCA bloqueia) ───────────────
// A diretriz acima é instrução MOLE: reduz o vazamento de português, não zera.
// O problema é que hoje, se o modelo derrapar, ninguém fica sabendo: não existe
// sinal nenhum, então a pergunta "a diretriz funciona?" só tem resposta de
// opinião. Isto existe pra ter número.
//
// É HEURÍSTICA, e está declarada como tal. Procura marcas que são de português
// e NÃO de espanhol nem de inglês, porque o caso difícil é pt vs es: as duas
// compartilham quase todo o vocabulário. O que separa barato é 'ã/õ/ç', os
// dígrafos 'nh/lh' (es usa 'ñ/ll'), os sufixos '-ção/-ões' e um punhado de
// palavras funcionais ('não', 'você', 'com', 'então', 'isso', 'muito').
const MARCAS_PT = [
  /[ãõç]/gi,                                                    // es não tem; en não tem
  /\w(nh|lh)\w/gi,                                              // es escreve ñ / ll
  /\B(ção|ções|ão|ões)\b/gi,                                    // sufixo típico
  /\b(não|você|vocês|então|isso|isto|também|muito|muita|obrigado|obrigada|amanhã|tem|têm|fazer|minha|até|já)\b/gi,
];

// Devolve null quando não há nada pra medir (usuário em pt-BR, texto curto ou
// vazio). Fora disso devolve o score, pra ir pro log SEMPRE, não só quando passa
// do limiar: sem usuário en/es de verdade eu não tenho amostra pra calibrar, e
// fingir que o corte está certo seria pior que medir. O limiar é palpite inicial
// e está aqui pra ser ajustado com dado real depois.
const MIN_PALAVRAS = 8;
const LIMIAR = 0.06;

export function derivaDeIdioma(texto, language) {
  const l = normalizaIdioma(language);
  if (!l || l === IDIOMA_PADRAO) return null;   // em pt-BR português é o esperado
  const s = String(texto || '').trim();
  if (!s) return null;
  const palavras = (s.match(/\p{L}+/gu) || []).length;
  if (palavras < MIN_PALAVRAS) return null;     // frase curta dá score sem sentido
  let marcas = 0;
  for (const re of MARCAS_PT) marcas += (s.match(re) || []).length;
  const score = marcas / palavras;
  return {
    idioma: l,
    palavras,
    marcas,
    score: Number(score.toFixed(3)),
    suspeita: score >= LIMIAR,
  };
}

// ── Freio de ideograma (este BLOQUEIA, ao contrário do detector acima) ──────
// O lembrete por turno (30/09) não bastou: em 05/10/2026 o DeepSeek V4.1 Flash
// respondeu em chinês de novo a um usuário em pt-BR, no WhatsApp, a ~114k
// tokens, depois de cancelar 4 lembretes. Instrução é pedido, e o modelo às
// vezes não atende; o que falta é a plataforma conferir a saída antes de
// entregar. Todo idioma atendido (pt-BR, en, es) é escrito em alfabeto latino,
// então resposta dominada por ideograma chinês é deriva, salvo dois casos
// legítimos que existem em prod: japonês pedido de propósito (lista de tarefas
// em japonês, sempre com kana) e pedido explícito de chinês/japonês/coreano.
//
// Calibrado nas 79 respostas com ideograma gravadas em prod até 05/10/2026: só
// 4 passam pela regra, e as 4 são deriva (17/07 e 14/08 no GLM, 30/09 e 05/10 no
// DeepSeek), com 30% a 100% de ideograma entre as letras. As demais têm menos de
// 20 ideogramas ou têm kana (japonês pedido pelo dono). O corte de 15% deixa
// folga dos dois lados: nenhuma resposta legítima chega perto dele.
const RE_HAN = /\p{Script=Han}/gu;
const RE_KANA_HANGUL = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const RE_CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const PEDIU_CJK = /chin[eê]s|chinese|chino|mandarim|mandarin|canton[eê]s|cantonese|japon[eê]s|japanese|japon[eé]s|coreano|korean|kanji|hanzi|kana|hiragana|katakana|ideograma/i;
const MIN_HAN = 20;
const PARTE_HAN = 0.15;

export function ideogramaAcidental(texto, language, textoDoDono = '') {
  const s = String(texto || '');
  const han = (s.match(RE_HAN) || []).length;
  if (han < MIN_HAN || RE_KANA_HANGUL.test(s)) return null;
  const dono = String(textoDoDono || '');
  if (RE_CJK.test(dono) || PEDIU_CJK.test(dono)) return null;
  const latinas = (s.match(/\p{Script=Latin}/gu) || []).length;
  const parte = han / (han + latinas);
  if (parte < PARTE_HAN) return null;
  return { idioma: normalizaIdioma(language) || IDIOMA_PADRAO, han, parte: Number(parte.toFixed(2)) };
}

// Pedido de reescrita: chamada curta, SEM ferramentas e sem a conversa, então
// nada do turno roda de novo (os lembretes cancelados não são cancelados duas
// vezes) e custa uns poucos milhares de tokens.
export function reescritaNoIdioma(language) {
  const nome = idiomaPorExtenso(language);
  return {
    system: `You rewrite messages from a personal assistant. Your only task is to return the SAME message written entirely in ${nome}. Translate line by line without skipping any (bold headings and list items too), so the rewritten message has exactly the same lines as the original. Keep numbers, dates, names, links, emojis and formatting. Do not add or remove information, do not answer the person's request and do not comment on the task. Return only the rewritten message.`,
    entrada: (pedido, mensagem) => `${pedido ? `Context, do NOT answer this. The person's request:\n<<<\n${pedido}\n>>>\n\n` : ''}Message to rewrite in ${nome}:\n<<<\n${mensagem}\n>>>`,
  };
}

// Se nem a reescrita sair no idioma, a pessoa recebe isto em vez de um texto
// que não consegue ler. Os recibos de ação continuam indo logo abaixo.
const SEM_IDIOMA = {
  'pt-BR': 'Tive um problema ao escrever esta resposta no seu idioma. Pode me pedir de novo?',
  en: 'I had a problem writing this reply in your language. Could you ask me again?',
  es: 'Tuve un problema al escribir esta respuesta en tu idioma. ¿Me lo pides de nuevo?',
};
// Mesmo número de linhas com texto: a reescrita que pula uma linha (o título
// "Lembretes cancelados", no teste de 05/10) perde informação sem ninguém ver.
export function mesmasLinhas(original, reescrito) {
  const n = (t) => String(t || '').split('\n').filter((l) => l.trim()).length;
  return n(original) === n(reescrito);
}
export function avisoSemIdioma(language) {
  return SEM_IDIOMA[normalizaIdioma(language) || IDIOMA_PADRAO];
}
