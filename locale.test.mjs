// Offline test of the language/country rule. Nothing goes out to the network, nothing touches the database.
// Run with: node locale.test.mjs
import {
  IDIOMAS_OK, LEGACY_TEXT_LANGUAGE, defaultLanguage, defaultTimezone, normalizaIdioma, normalizaPais, localeDoAcceptLanguage,
  tagIdioma, instrucaoDeIdioma, comIdioma, derivaDeIdioma, lembreteDeIdioma,
  ideogramaAcidental, avisoSemIdioma, idiomaEscrito, idiomaDoTurno,
} from './web/locale.mjs';

let ok = 0, fail = 0;
const t = (nome, cond) => { if (cond) { ok++; console.log('  ok  ', nome); } else { fail++; console.log('  FALHA', nome); } };
const idioma = (entrada, esperado) => t(`language ${JSON.stringify(entrada)} -> ${esperado}`, normalizaIdioma(entrada) === esperado);
const pais = (entrada, esperado) => t(`country ${JSON.stringify(entrada)} -> ${esperado}`, normalizaPais(entrada) === esperado);
const header = (raw, lang, country) => {
  const r = localeDoAcceptLanguage(raw);
  t(`header ${JSON.stringify(raw)} -> ${lang}/${country}`, r.language === lang && r.country === country);
};

// 0) The supported set. If someone changes this without translating, the test warns.
t('supported languages = pt-BR, en, es', JSON.stringify(IDIOMAS_OK) === JSON.stringify(['pt-BR', 'en', 'es']));
t('legacy texts are pt-BR', LEGACY_TEXT_LANGUAGE === 'pt-BR');
{
  const saved = process.env.BRAMBIT_DEFAULT_LANGUAGE;
  delete process.env.BRAMBIT_DEFAULT_LANGUAGE;
  t('instance default is en', defaultLanguage() === 'en');
  process.env.BRAMBIT_DEFAULT_LANGUAGE = 'pt-br';
  t('BRAMBIT_DEFAULT_LANGUAGE sets the default', defaultLanguage() === 'pt-BR' && tagIdioma(null) === 'pt-BR');
  process.env.BRAMBIT_DEFAULT_LANGUAGE = 'fr';
  t('unsupported BRAMBIT_DEFAULT_LANGUAGE falls back to en', defaultLanguage() === 'en');
  if (saved === undefined) delete process.env.BRAMBIT_DEFAULT_LANGUAGE; else process.env.BRAMBIT_DEFAULT_LANGUAGE = saved;
}

// Instance time zone: BRAMBIT_DEFAULT_TIMEZONE when it is a valid IANA name; a typo
// falls back to the machine zone instead of making every Intl call throw.
{
  const saved = process.env.BRAMBIT_DEFAULT_TIMEZONE;
  process.env.BRAMBIT_DEFAULT_TIMEZONE = 'Asia/Tokyo';
  t('BRAMBIT_DEFAULT_TIMEZONE sets the time zone', defaultTimezone() === 'Asia/Tokyo');
  process.env.BRAMBIT_DEFAULT_TIMEZONE = 'Mars/Base';
  t('invalid BRAMBIT_DEFAULT_TIMEZONE falls back to a valid zone', defaultTimezone() !== 'Mars/Base' && !!new Intl.DateTimeFormat('en', { timeZone: defaultTimezone() }));
  if (saved === undefined) delete process.env.BRAMBIT_DEFAULT_TIMEZONE; else process.env.BRAMBIT_DEFAULT_TIMEZONE = saved;
}

// 1) normalizaIdioma: regional variants collapse into the language.
idioma('pt', 'pt-BR');
idioma('pt-BR', 'pt-BR');
idioma('pt-br', 'pt-BR');
idioma('PT-PT', 'pt-BR');   // European Portuguese falls into our pt-BR: it's the same translation
idioma('en', 'en');
idioma('en-US', 'en');
idioma('en-GB', 'en');
idioma('es', 'es');
idioma('es-AR', 'es');
idioma('es-419', 'es');     // Latin American Spanish
idioma('  ES-mx  ', 'es');  // whitespace and case must not get in the way

// 2) normalizaIdioma: "don't know" has to be null, NEVER turn into pt-BR here.
//    The caller decides the fallback; mixing the two things erases the
//    difference between "the person chose Portuguese" and "no idea".
['ja', 'fr', 'de', 'zh-CN', 'xx', '', '   ', null, undefined, 0, {}, 'portugues'].forEach((v) => idioma(v, null));

// 3) normalizaPais: only ISO-3166 alpha-2 format, uppercase.
pais('br', 'BR');
pais('BR', 'BR');
pais(' us ', 'US');
pais('ar', 'AR');
['BRA', 'B', '419', '', '1R', null, undefined, 'br1'].forEach((v) => pais(v, null));

// 4) Accept-Language: o caso comum.
header('pt-BR,pt;q=0.9,en-US;q=0.8', 'pt-BR', 'BR');
header('en-US,en;q=0.9', 'en', 'US');
header('es-AR,es;q=0.9,en;q=0.8', 'es', 'AR');
header('es', 'es', null);            // without a declared region: country stays unknown, not guessed
header('pt', 'pt-BR', null);

// 5) A language we don't support yet is SKIPPED, it doesn't become the default. Whoever has
//    the browser in Japanese with English in second place has to fall into English.
header('ja,en;q=0.9', 'en', null);
header('ja-JP,en-GB;q=0.9,pt-BR;q=0.8', 'en', 'GB');
header('fr-FR,de;q=0.9', null, null);   // nada que a gente atenda: chamador decide
header('ja', null, null);

// 6) Ordering by q, including ties. A tie preserves the declared order
//    (RFC 9110), so "en;q=0.9,es;q=0.9" is English.
header('en;q=0.5,es;q=0.9', 'es', null);
header('pt-BR;q=0.2,en-US;q=0.7', 'en', 'US');
header('en;q=0.9,es;q=0.9', 'en', null);
header('es-MX;q=1,en-US', 'es', 'MX');   // without explicit q it counts as 1, ties, es comes first

// 7) Missing, empty, or garbage header must not blow up or guess a language.
[null, undefined, '', '   ', '*', ',,,', ';q=0.9', 'pt;q=abc'].forEach((raw) => {
  const r = localeDoAcceptLanguage(raw);
  t(`invalid header ${JSON.stringify(raw)} does not blow up`, r && typeof r === 'object' && 'language' in r && 'country' in r);
});
header('*', null, null);
header('pt;q=abc', 'pt-BR', null);   // unreadable q becomes 0, but the language still counts

// 8) tagIdioma: always returns one of the three, with fallback to the default.
t('tag pt-BR', tagIdioma('pt-BR') === 'pt-BR');
t('tag pt-PT falls into pt-BR', tagIdioma('pt-PT') === 'pt-BR');
t('tag en-US -> en', tagIdioma('en-US') === 'en');
t('tag es-MX -> es', tagIdioma('es-MX') === 'es');
['ja', 'fr', '', null, undefined, 'xx'].forEach((v) => {
  t(`tag ${JSON.stringify(v)} falls back to default`, tagIdioma(v) === defaultLanguage());
});

// 9) An UNRECOGNIZED language still gets no directive, and comIdioma returns the
//    prompt byte for byte. Not a detail: "I don't know which" must not become
//    "it's Portuguese" by omission, or normalizaIdioma (which keeps the two
//    apart on purpose) loses its point.
//    CHANGE 08/09/2026: until then pt-BR ALSO returned null, for the cache. The
//    gap: en/es said "answer in the language the person wrote in" and pt-BR said
//    nothing, so a Portuguese account with a user writing English was left to
//    the model's luck. That gap was closed.
const PROMPT = 'Você é X.\nEstilo: pt-BR, direto.';
['ja', 'fr', 'de', 'xx', '', '   ', null, undefined, 0, {}].forEach((v) => {
  t(`unsupported language ${JSON.stringify(v)} does not generate a directive`, instrucaoDeIdioma(v) === null);
});
t('comIdioma without language returns the IDENTICAL prompt', comIdioma(PROMPT, null) === PROMPT);
t('comIdioma with an unsupported language returns the IDENTICAL prompt', comIdioma(PROMPT, 'ja') === PROMPT);

// 9b) pt-BR has a directive, and it's the SAME one as 'pt' and 'pt-PT': a regional variant
//     cannot generate a different prefix, otherwise the cache breaks because of each
//     person's browser header.
t('pt-BR has a directive', typeof instrucaoDeIdioma('pt-BR') === 'string');
t('pt and pt-PT use the same pt-BR directive',
  instrucaoDeIdioma('pt') === instrucaoDeIdioma('pt-BR') && instrucaoDeIdioma('pt-PT') === instrucaoDeIdioma('pt-BR'));
t('pt-BR directive is in Portuguese', instrucaoDeIdioma('pt-BR').startsWith('IDIOMA ('));
// The rule that motivated the change: mirror the language of WHOEVER IS WRITING.
t('pt-BR tells it to mirror the user\'s language', /responda na língua que ele usou/i.test(instrucaoDeIdioma('pt-BR')));
// And the counterweight: pasted text (email, document) is not a language switch, otherwise
// asking to read an email in English would turn the whole conversation into English.
t('pt-BR carves out pasted text', /NÃO conta como troca de língua/.test(instrucaoDeIdioma('pt-BR')));
t('pt-BR has no stray \${}', !instrucaoDeIdioma('pt-BR').includes('${'));
t('pt-BR appends at the end, preserving the prompt',
  comIdioma(PROMPT, 'pt-BR') === `${PROMPT}\n\n${instrucaoDeIdioma('pt-BR')}`);

// 10) en and es have a directive, and it's APPENDED at the end without touching the original prompt.
for (const l of ['en', 'es']) {
  const d = instrucaoDeIdioma(l);
  t(`${l} has a directive`, typeof d === 'string' && d.length > 100);
  t(`${l} appends at the end, preserving the prompt`, comIdioma(PROMPT, l) === `${PROMPT}\n\n${d}`);
  // Unresolved interpolation becomes literal text in the model's prompt: slash.
  t(`${l} has no stray \${}`, !d.includes('${'));
}
// The prompt and tool descriptions are in English, so EVERY served language
// needs the override clause and has to cover text inside tool arguments.
for (const l of IDIOMAS_OK) {
  const d = instrucaoDeIdioma(l);
  t(`${l} says it overrides the other instructions`, /overrid|prioridad|vale mais/i.test(d));
  t(`${l} covers text inside a tool argument`, /tool|herramienta|ferramenta/i.test(d));
}
t('pt-BR says the English prompt does not change the language', /estão em inglês/.test(instrucaoDeIdioma('pt-BR')));
// Regional variants receive the SAME directive as the base language.
t('en-GB uses the en directive', instrucaoDeIdioma('en-GB') === instrucaoDeIdioma('en'));
t('es-419 uses the es directive', instrucaoDeIdioma('es-419') === instrucaoDeIdioma('es'));
t('en and es have different directives', instrucaoDeIdioma('en') !== instrucaoDeIdioma('es'));
// Writing in the actual target language: an instruction in English pulls English output
// much better than "answer in English" written in Portuguese.
t('en directive is in English', instrucaoDeIdioma('en').startsWith('LANGUAGE'));
t('es directive is in Spanish', instrucaoDeIdioma('es').startsWith('IDIOMA'));
// Every supported language needs a directive. If someone puts a
// new language in IDIOMAS_OK and forgets the text, the test warns here.
IDIOMAS_OK.forEach((l) => {
  t(`${l} (from IDIOMAS_OK) has a written directive`, !!instrucaoDeIdioma(l));
});

// 11) Language-drift detector. It's a heuristic and only observes, but the edges
//     need to be locked down: it can never run in pt-BR (Portuguese is
//     expected there) and it can never blow up on garbage input, because it runs
//     on the turn's response path.
const PT_LONGO = 'Pronto, já anotei aqui na sua memória que você não gosta de reunião antes das dez da manhã, e também que a sua irmã faz aniversário em março.';
const EN_LONGO = "Done, I noted in your memory that you don't like meetings before ten in the morning, and also that your sister has a birthday in March.";
const ES_LONGO = 'Listo, ya anoté en tu memoria que no te gustan las reuniones antes de las diez de la mañana, y también que tu hermana cumple años en marzo.';

// In pt-BR the detector has to stay SILENT, always.
t('pt-BR never generates a measurement', derivaDeIdioma(PT_LONGO, 'pt-BR') === null);
t('pt-PT does not either', derivaDeIdioma(PT_LONGO, 'pt-PT') === null);
t('unsupported language does not generate a measurement', derivaDeIdioma(PT_LONGO, 'ja') === null);
t('no language does not generate a measurement', derivaDeIdioma(PT_LONGO, null) === null);

// Useless input doesn't turn into a made-up score.
[null, undefined, '', '   ', 'ok', 'sim', 0, {}, []].forEach((v) => {
  t(`input ${JSON.stringify(v)} does not generate a score`, derivaDeIdioma(v, 'en') === null);
});

// What it exists to catch: Portuguese coming out for someone who asked for en/es.
for (const l of ['en', 'es']) {
  const d = derivaDeIdioma(PT_LONGO, l);
  t(`${l}: Portuguese is flagged`, d !== null && d.suspeita === true);
  t(`${l}: returns a coherent count`, d.palavras > 8 && d.marcas > 0 && d.score > 0);
  t(`${l}: reports the expected language`, d.idioma === l);
}

// And what it must NOT flag: the right answer in the right language.
const dEn = derivaDeIdioma(EN_LONGO, 'en');
t('clean en is not flagged', dEn !== null && dEn.suspeita === false);
// pt vs es is the hard case (almost all vocabulary shared): if the
// detector flags correct Spanish, the log would turn into noise and nobody would look at it.
const dEs = derivaDeIdioma(ES_LONGO, 'es');
t('clean es is not flagged', dEs !== null && dEs.suspeita === false);
t('Portuguese scores MORE than Spanish', derivaDeIdioma(PT_LONGO, 'es').score > dEs.score);

// 12) Per-turn reminder (2026-09-30, DeepSeek replied in Chinese to a pt-BR
//     account on a long thread): every supported language has its own, written in the
//     language itself, short (goes in every message), and an unsupported language doesn't
//     get any reminder.
t('pt-BR reminder in Portuguese', lembreteDeIdioma('pt-BR').includes('português do Brasil'));
t('en reminder in English', lembreteDeIdioma('en').includes('reply in English'));
t('es reminder in Spanish', lembreteDeIdioma('es').includes('responde en español'));
t('regional variant uses the same reminder', lembreteDeIdioma('pt') === lembreteDeIdioma('pt-BR') && lembreteDeIdioma('en-GB') === lembreteDeIdioma('en'));
for (const l of IDIOMAS_OK) t(`${l} reminder is short`, lembreteDeIdioma(l).length > 0 && lembreteDeIdioma(l).length < 250);
for (const v of ['ja', 'zh', '', null, undefined]) t(`no reminder for ${JSON.stringify(v)}`, lembreteDeIdioma(v) === '');

// 13) Ideogram guard: the real prod drifts are caught, and the Japanese the
//     owner asks for on purpose (always with kana) or an explicit request for Chinese
//     pass through. Whoever touches the cutoff sees here if it started translating a legitimate response.
const DERIVA_0510 = '两件事：\n\n**Pepecarteira — 现在没打通。** 我尝试访问并返回了“未找到”（404）：网站在线，但我的代理用来记录/查询的接口此刻没有响应。所以现在，我**无法**从那里记录或核实任何内容。';
const DERIVA_3009 = '调整已安排好——今天的两个区块都不会丢，下午的区块避开了 Solar 会议（14:00–16:00）：\n\n- **区块 1**：15:30–17:00 → **16:15–17:45** *（在会议结束后，留出 15 分钟缓冲）*';
const JAPONES_PEDIDO = '**Tarefas diárias**\n- [x] 靴を買いに行く（くつをかいにいく）\n- 言語を勉強して\n- トフの砂を買って\n- オベンの修理を頼む\n- 鶏肉を解凍する';
t('drift 05/10 is caught', ideogramaAcidental(DERIVA_0510, 'pt-BR', 'pode cancelar esses lembretes')?.idioma === 'pt-BR');
t('drift 30/09 is caught', !!ideogramaAcidental(DERIVA_3009, 'pt-BR', 'Pode ajustar os blocos das aulas gravadas na agenda'));
t('drift on an en account is caught', ideogramaAcidental(DERIVA_0510, 'en', 'cancel those reminders')?.idioma === 'en');
t('requested Japanese passes', ideogramaAcidental(JAPONES_PEDIDO, 'pt-BR', 'adiciona na lista') === null);
t('request for Chinese passes', ideogramaAcidental(DERIVA_0510, 'pt-BR', 'traduz isso pra chinês') === null);
t('owner writing in Chinese passes', ideogramaAcidental(DERIVA_0510, 'pt-BR', '你好，请帮我') === null);
t('stray word in Chinese passes', ideogramaAcidental('O caractere 你好 quer dizer olá; 谢谢 é obrigado.', 'pt-BR', 'como diz olá') === null);
for (const l of IDIOMAS_OK) t(`no-language notice for ${l} has no ideogram`, !!avisoSemIdioma(l) && !/\p{Script=Han}/u.test(avisoSemIdioma(l)));

// 14) Written language (real prod messages, 2026-10-06 calibration): the person's
//     own short sentence is detected; pasted logs/CLI output and a Portuguese
//     request around an English quote are not, so they keep the configured language.
const escrito = (txt, esperado) => t(`written ${JSON.stringify(txt.slice(0, 40))} -> ${esperado}`, idiomaEscrito(txt) === esperado);
escrito('Search the web for the latest news about the James Webb Space Telescope and cite your sources.', 'en');
escrito('Busca en la web las noticias más recientes sobre el clima en Buenos Aires y dame las fuentes.', 'es');
escrito('Can you put a “cortar cabelo - ana” event on my agenda at 4:30 pm? It’ll go on for one hour', 'en');
escrito('Explain in three short sentences what inflation is.', 'en');
escrito('Remind me tomorrow at 9am to call the dentist to reschedule my appointment.', 'en');
escrito('Explícame en tres frases cortas qué es la inflación.', 'es');
escrito('inclui um outro evento para amanhã', 'pt-BR');
escrito('Quais são as regras de aposentadoria por idade do INSS em 2026? Me dá as fontes.', 'pt-BR');
escrito('(node:8195) [DEP0040] DeprecationWarning: The punycode module is deprecated. Please use a userland alternative', null);
escrito('✔ Generate a new App Store Connect API Key? … yes ? Select role for the generated API key: › - Use arrow-keys.', null);
escrito('git reset --hard HEAD HEAD is now at c00bc29 feat: use official brambs star SVG for app icons and splash', null);
escrito('INFO | Android emulator version 37.1.11.0 (build_id 15917651) (CL:N/A) INFO | Graphics backend', null);
escrito('traduz pra mim: "what is the best way to do this and why"', null);
escrito('ok', null);
t('reminder switches to the written language', lembreteDeIdioma('pt-BR', 'Search the web for the latest news about the James Webb Space Telescope.').includes('written in English'));
t('reminder stays on the configured language when written in it', lembreteDeIdioma('pt-BR', 'Quais são meus compromissos de amanhã?') === lembreteDeIdioma('pt-BR'));
t('en account writing in Portuguese', lembreteDeIdioma('en', 'inclui um outro evento para amanhã').includes('escrita em português'));
t('language of the turn', idiomaDoTurno('pt-BR', 'Busca en la web las noticias más recientes sobre el clima') === 'es' && idiomaDoTurno('pt-BR', '') === 'pt-BR');
for (const l of IDIOMAS_OK) t(`written ${l} reminder is short`, ['Search the web for the latest news about the telescope.', 'Busca en la web las noticias más recientes sobre el clima', 'inclui um outro evento para amanhã'].every((m) => lembreteDeIdioma(l, m).length < 250));

console.log(`\n${ok} ok, ${fail} falha(s)`);
process.exit(fail ? 1 : 0);
