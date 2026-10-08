// User language and country: only PURE functions, no database and no HTTP, so
// they can be tested on their own (`node locale.test.mjs`). db.mjs does the writing;
// server.mjs reads the header. The rule lives here.

// What the product REALLY supports today. While only Portuguese text exists,
// letting 'fr' in here would translate nothing: it would just make the agent
// speak French over a Portuguese interface. The list grows with the
// translation, not before it. (07/09: en and es now, Japanese out for now.)
export const IDIOMAS_OK = ['pt-BR', 'en', 'es'];
// Language the texts not yet in the catalogs (docs/i18n.md) are written in. It is
// not a default: it only says which literals can be shown as they are.
export const LEGACY_TEXT_LANGUAGE = 'pt-BR';

// Language of the instance, used when nothing is known about the person:
// BRAMBIT_DEFAULT_LANGUAGE if it is one of IDIOMAS_OK, else English. Read on each
// call so a test or the installer can set it after this module loads.
export function defaultLanguage() {
  return normalizaIdioma(process.env.BRAMBIT_DEFAULT_LANGUAGE) || 'en';
}

// Time zone of the instance, for a person whose own is not known and for
// instance-wide views: BRAMBIT_DEFAULT_TIMEZONE if it is a valid IANA name, else
// the time zone of the machine (a local install runs where its owner lives),
// else UTC. Read on each call, like defaultLanguage().
export function defaultTimezone() {
  for (const tz of [process.env.BRAMBIT_DEFAULT_TIMEZONE, Intl.DateTimeFormat().resolvedOptions().timeZone]) {
    if (validTimezone(tz)) return tz;
  }
  return 'UTC';
}

export function validTimezone(tz) {
  if (typeof tz !== 'string' || !tz.trim()) return false;
  try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; }
}

// Normalizes whatever comes from the browser/header into our set: 'pt', 'pt-PT' and
// 'pt-br' become 'pt-BR'; 'en-US' and 'en-GB' become 'en'; 'es-419' becomes 'es'.
// Any other language returns null (the caller decides the fallback), because
// "I don't know" and "it's Portuguese" are different things and can't become the same.
export function normalizaIdioma(v) {
  const s = String(v || '').trim().toLowerCase();
  if (!s) return null;
  const base = s.split('-')[0];
  if (base === 'pt') return 'pt-BR';
  if (base === 'en') return 'en';
  if (base === 'es') return 'es';
  return null;
}

// Country in uppercase ISO-3166 alpha-2. Format only, no country table: the
// official list changes and it's not worth keeping a copy here.
export function normalizaPais(v) {
  const s = String(v || '').trim().toUpperCase();
  return /^[A-Z]{2}$/.test(s) ? s : null;
}

// Reads an Accept-Language and returns { language, country } in our format.
// Real header: "es-AR,es;q=0.9,en-US;q=0.8". Walks in the declared preference
// ORDER and stops at the first language we support, so someone with
// "ja,en;q=0.9" when we still don't have Japanese falls back to English, not Portuguese. The
// country comes from the region of the SAME chosen entry (es-AR -> AR).
//
// This is a GUESS, and it must be treated as such: the browser's language
// doesn't prove where the person lives (a Brazilian with Chrome in English exists in
// droves). It serves to pick the first screen; billing and per-country
// availability rules need a better signal than this.
export function localeDoAcceptLanguage(raw) {
  const s = String(raw || '').trim();
  if (!s) return { language: null, country: null };
  const itens = s.split(',').map((parte) => {
    const [tag, ...params] = parte.trim().split(';');
    const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
    return { tag: (tag || '').trim(), q: q ? Number(q.slice(2)) || 0 : 1 };
  }).filter((i) => i.tag && i.tag !== '*');
  // stable sort in Node: a q tie preserves the declared order, which is
  // exactly the correct tiebreaker per RFC 9110.
  itens.sort((a, b) => b.q - a.q);
  for (const { tag } of itens) {
    const lang = normalizaIdioma(tag);
    if (!lang || !IDIOMAS_OK.includes(lang)) continue;
    const partes = tag.split('-');
    return { language: lang, country: partes.length > 1 ? normalizaPais(partes[partes.length - 1]) : null };
  }
  return { language: null, country: null };
}

// ── Language in the prompt ───────────────────────────────────────────────────
// Short tag for the prompt ('pt-BR' | 'en' | 'es'), always with a fallback to the default.
export function tagIdioma(language) {
  return normalizaIdioma(language) || defaultLanguage();
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

// Unknown/unsupported language keeps returning null (and not the pt-BR
// directive): "I don't know which it is" and "it's Portuguese" are different things, and
// falling back to Portuguese by default is exactly what normalizaIdioma avoids above.
export function instrucaoDeIdioma(language) {
  const l = normalizaIdioma(language);
  if (!l) return null;
  return DIRETRIZ[l] || null;
}

// Appends the directive to the end of a system prompt. Without a recognized language it
// returns the ORIGINAL prompt, with no concatenation at all.
export function comIdioma(system, language) {
  const d = instrucaoDeIdioma(language);
  return d ? `${system}\n\n${d}` : system;
}

// PER-TURN language reminder, appended at the end of the user's message (next to the
// clock, outside the cached prefix and outside the history). The directive above stays at
// the end of the SYSTEM prompt, which in a long thread is tens of thousands of tokens from
// the last message: on 2026-09-30 DeepSeek answered in Chinese to a user
// in pt-BR, ~83k tokens from the system prompt, with the entire conversation in Portuguese. Close
// to the current turn the model doesn't lose the reference. Same rule as the directive (the
// mirroring of whoever is writing still applies); here it's just the short reminder.
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
// configured language. Used to check the reply against the right language, and
// (via idiomaDaResposta in server.mjs) for every text the platform adds to the
// reply: credit stops, receipts, source lists, search notices, corrections. The
// system prompt keeps the configured language (its prefix is cached per user).
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
// Only words that are Portuguese alone count for that block: "me" and "do" are
// English too, and they used to hide short English requests such as "Remind me
// tomorrow at 9am to call the dentist". The prepositions and articles in the
// lists ("in", "at", "la", "en") exist for the same kind of short sentence.
// Rechecked on 10,211 prod messages: 18 English sentences newly recognized,
// none of them Portuguese.
const PALAVRAS = {
  en: new Set("the and is are was were what how why when where who which you your yours i i'm it's this that these those with about please can could would should will do does did have has my me of to for from search find show tell give latest news any some there their they we our an be been being not don't isn't in at on by it if or but all so just more out up into than then its he she him his her".split(' ')),
  es: new Set('el los las y del al qué cómo cuál cuáles cuándo dónde quién por es son está están estoy fue muy más hoy busca búscame dame dime puedes podrías quiero necesito mi mis tu tus su sus noticias sobre también pero porque hay ese esa esto eso usted ustedes nosotros tengo tiene hacer hola gracias la en un una lo ya'.split(' ')),
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
  let ptProprio = 0;
  for (const w of ws) {
    for (const l of Object.keys(n)) if (PALAVRAS[l].has(w)) n[l]++;
    if (PALAVRAS['pt-BR'].has(w) && !PALAVRAS.en.has(w) && !PALAVRAS.es.has(w)) ptProprio++;
  }
  if (/[ãõç]/i.test(s)) { n['pt-BR'] += 2; ptProprio++; }
  if (/[ñ¿¡]/.test(s)) n.es += 2;
  const [a, b] = Object.entries(n).sort((x, y) => y[1] - x[1]);
  if (a[1] < 3 || a[1] < 2 * b[1]) return null;
  if (a[0] !== 'pt-BR' && ptProprio > 0) return null;
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

// ── Language drift detector (only observes, NEVER blocks) ──────────────────
// The directive above is a SOFT instruction: it reduces Portuguese leakage, doesn't zero it out.
// The problem is that today, if the model slips, nobody finds out: there is no
// signal at all, so the question "does the directive work?" only has an
// opinion-based answer. This exists to produce a number.
//
// It is a HEURISTIC, and declared as such. It looks for markers that are Portuguese
// and NOT Spanish or English, because the hard case is pt vs es: the two
// share almost all their vocabulary. What separates them cheaply is 'ã/õ/ç', the
// digraphs 'nh/lh' (es uses 'ñ/ll'), the suffixes '-ção/-ões' and a handful of
// function words ('não', 'você', 'com', 'então', 'isso', 'muito').
const MARCAS_PT = [
  /[ãõç]/gi,                                                    // es doesn't have it; en doesn't have it
  /\w(nh|lh)\w/gi,                                              // es escreve ñ / ll
  /\B(ção|ções|ão|ões)\b/gi,                                    // typical suffix
  /\b(não|você|vocês|então|isso|isto|também|muito|muita|obrigado|obrigada|amanhã|tem|têm|fazer|minha|até|já)\b/gi,
];

// Returns null when there's nothing to measure (user in pt-BR, short or
// empty text). Otherwise it returns the score, so it ALWAYS goes to the log, not just when it
// passes the threshold: without a real en/es user I have no sample to calibrate against, and
// pretending the cutoff is right would be worse than measuring. The threshold is an initial guess
// and is here to be adjusted with real data later.
const MIN_PALAVRAS = 8;
const LIMIAR = 0.06;

export function derivaDeIdioma(texto, language) {
  const l = normalizaIdioma(language);
  if (!l || l === 'pt-BR') return null;   // in pt-BR Portuguese is expected
  const s = String(texto || '').trim();
  if (!s) return null;
  const palavras = (s.match(/\p{L}+/gu) || []).length;
  if (palavras < MIN_PALAVRAS) return null;     // a short phrase gives a meaningless score
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

// ── Ideogram guard (this one BLOCKS, unlike the detector above) ────────────
// The per-turn reminder (2026-09-30) wasn't enough: on 2026-10-05 DeepSeek V4.1 Flash
// again replied in Chinese to a pt-BR user, on WhatsApp, at ~114k
// tokens, after cancelling 4 reminders. An instruction is a request, and the model
// sometimes doesn't comply; what's missing is the platform checking the output before
// delivering it. Every supported language (pt-BR, en, es) is written in the Latin alphabet,
// so a response dominated by Chinese ideograms is drift, except for two
// legitimate cases that exist in prod: Japanese requested on purpose (a task list
// in Japanese, always with kana) and an explicit request for Chinese/Japanese/Korean.
//
// Calibrated on the 79 ideogram-containing responses recorded in prod through 2026-10-05: only
// 4 pass the rule, and those 4 are drift (2026-07-17 and 2026-08-14 on GLM, 2026-09-30 and 2026-10-05 on
// DeepSeek), with 30% to 100% ideograms among the letters. The rest have fewer than
// 20 ideograms or have kana (Japanese requested by the owner). The 15% cutoff leaves
// margin on both sides: no legitimate response comes close to it.
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
  return { idioma: normalizaIdioma(language) || defaultLanguage(), han, parte: Number(parte.toFixed(2)) };
}

// Rewrite request: a short call, WITHOUT tools and without the conversation, so
// nothing in the turn runs again (cancelled reminders aren't cancelled twice)
// and it costs a few thousand tokens.
export function reescritaNoIdioma(language) {
  const nome = idiomaPorExtenso(language);
  return {
    system: `You rewrite messages from a personal assistant. Your only task is to return the SAME message written entirely in ${nome}. Translate line by line without skipping any (bold headings and list items too), so the rewritten message has exactly the same lines as the original. Keep numbers, dates, names, links, emojis and formatting. Do not add or remove information, do not answer the person's request and do not comment on the task. Return only the rewritten message.`,
    entrada: (pedido, mensagem) => `${pedido ? `Context, do NOT answer this. The person's request:\n<<<\n${pedido}\n>>>\n\n` : ''}Message to rewrite in ${nome}:\n<<<\n${mensagem}\n>>>`,
  };
}

// If even the rewrite doesn't come out in the right language, the person receives this instead of a text
// they can't read. Action receipts still go right below.
const SEM_IDIOMA = {
  'pt-BR': 'Tive um problema ao escrever esta resposta no seu idioma. Pode me pedir de novo?',
  en: 'I had a problem writing this reply in your language. Could you ask me again?',
  es: 'Tuve un problema al escribir esta respuesta en tu idioma. ¿Me lo pides de nuevo?',
};
// Same number of lines with text: a rewrite that skips a line (the title
// "Lembretes cancelados", in the 2026-10-05 test) loses information without anyone seeing it.
export function mesmasLinhas(original, reescrito) {
  const n = (t) => String(t || '').split('\n').filter((l) => l.trim()).length;
  return n(original) === n(reescrito);
}
export function avisoSemIdioma(language) {
  return SEM_IDIOMA[normalizaIdioma(language) || defaultLanguage()];
}
