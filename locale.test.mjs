// Offline test of the language/country rule. Nothing goes out to the network, nothing touches the database.
// Run with: node locale.test.mjs
import {
  IDIOMAS_OK, IDIOMA_PADRAO, normalizaIdioma, normalizaPais, localeDoAcceptLanguage,
  tagIdioma, instrucaoDeIdioma, comIdioma, derivaDeIdioma, lembreteDeIdioma,
  ideogramaAcidental, avisoSemIdioma, idiomaEscrito, idiomaDoTurno,
} from './web/locale.mjs';

let ok = 0, fail = 0;
const t = (nome, cond) => { if (cond) { ok++; console.log('  ok  ', nome); } else { fail++; console.log('  FALHA', nome); } };
const idioma = (entrada, esperado) => t(`idioma ${JSON.stringify(entrada)} -> ${esperado}`, normalizaIdioma(entrada) === esperado);
const pais = (entrada, esperado) => t(`país ${JSON.stringify(entrada)} -> ${esperado}`, normalizaPais(entrada) === esperado);
const header = (raw, lang, country) => {
  const r = localeDoAcceptLanguage(raw);
  t(`header ${JSON.stringify(raw)} -> ${lang}/${country}`, r.language === lang && r.country === country);
};

// 0) The supported set. If someone changes this without translating, the test warns.
t('idiomas atendidos = pt-BR, en, es', JSON.stringify(IDIOMAS_OK) === JSON.stringify(['pt-BR', 'en', 'es']));
t('padrão é pt-BR', IDIOMA_PADRAO === 'pt-BR');

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
  t(`header inválido ${JSON.stringify(raw)} não explode`, r && typeof r === 'object' && 'language' in r && 'country' in r);
});
header('*', null, null);
header('pt;q=abc', 'pt-BR', null);   // unreadable q becomes 0, but the language still counts

// 8) tagIdioma: always returns one of the three, with fallback to the default.
t('tag pt-BR', tagIdioma('pt-BR') === 'pt-BR');
t('tag pt-PT cai em pt-BR', tagIdioma('pt-PT') === 'pt-BR');
t('tag en-US -> en', tagIdioma('en-US') === 'en');
t('tag es-MX -> es', tagIdioma('es-MX') === 'es');
['ja', 'fr', '', null, undefined, 'xx'].forEach((v) => {
  t(`tag ${JSON.stringify(v)} cai no padrão`, tagIdioma(v) === IDIOMA_PADRAO);
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
  t(`idioma não atendido ${JSON.stringify(v)} não gera diretriz`, instrucaoDeIdioma(v) === null);
});
t('comIdioma sem idioma devolve o prompt IDÊNTICO', comIdioma(PROMPT, null) === PROMPT);
t('comIdioma em língua não atendida devolve o prompt IDÊNTICO', comIdioma(PROMPT, 'ja') === PROMPT);

// 9b) pt-BR has a directive, and it's the SAME one as 'pt' and 'pt-PT': a regional variant
//     cannot generate a different prefix, otherwise the cache breaks because of each
//     person's browser header.
t('pt-BR tem diretriz', typeof instrucaoDeIdioma('pt-BR') === 'string');
t('pt e pt-PT usam a mesma diretriz de pt-BR',
  instrucaoDeIdioma('pt') === instrucaoDeIdioma('pt-BR') && instrucaoDeIdioma('pt-PT') === instrucaoDeIdioma('pt-BR'));
t('diretriz de pt-BR está em português', instrucaoDeIdioma('pt-BR').startsWith('IDIOMA ('));
// The rule that motivated the change: mirror the language of WHOEVER IS WRITING.
t('pt-BR manda espelhar a língua do usuário', /responda na língua que ele usou/i.test(instrucaoDeIdioma('pt-BR')));
// And the counterweight: pasted text (email, document) is not a language switch, otherwise
// asking to read an email in English would turn the whole conversation into English.
t('pt-BR ressalva o texto colado', /NÃO conta como troca de língua/.test(instrucaoDeIdioma('pt-BR')));
t('pt-BR sem ${} solto', !instrucaoDeIdioma('pt-BR').includes('${'));
t('pt-BR anexa no fim, preservando o prompt',
  comIdioma(PROMPT, 'pt-BR') === `${PROMPT}\n\n${instrucaoDeIdioma('pt-BR')}`);

// 10) en and es have a directive, and it's APPENDED at the end without touching the original prompt.
for (const l of ['en', 'es']) {
  const d = instrucaoDeIdioma(l);
  t(`${l} tem diretriz`, typeof d === 'string' && d.length > 100);
  t(`${l} anexa no fim, preservando o prompt`, comIdioma(PROMPT, l) === `${PROMPT}\n\n${d}`);
  // Unresolved interpolation becomes literal text in the model's prompt: slash.
  t(`${l} sem \${} solto`, !d.includes('${'));
}
// The prompt and tool descriptions are in English, so EVERY served language
// needs the override clause and has to cover text inside tool arguments.
for (const l of IDIOMAS_OK) {
  const d = instrucaoDeIdioma(l);
  t(`${l} diz que sobrepõe as outras instruções`, /overrid|prioridad|vale mais/i.test(d));
  t(`${l} cobre texto dentro de argumento de tool`, /tool|herramienta|ferramenta/i.test(d));
}
t('pt-BR diz que o prompt em inglês não muda o idioma', /estão em inglês/.test(instrucaoDeIdioma('pt-BR')));
// Regional variants receive the SAME directive as the base language.
t('en-GB usa a diretriz de en', instrucaoDeIdioma('en-GB') === instrucaoDeIdioma('en'));
t('es-419 usa a diretriz de es', instrucaoDeIdioma('es-419') === instrucaoDeIdioma('es'));
t('en e es têm diretrizes diferentes', instrucaoDeIdioma('en') !== instrucaoDeIdioma('es'));
// Writing in the actual target language: an instruction in English pulls English output
// much better than "answer in English" written in Portuguese.
t('diretriz de en está em inglês', instrucaoDeIdioma('en').startsWith('LANGUAGE'));
t('diretriz de es está em espanhol', instrucaoDeIdioma('es').startsWith('IDIOMA'));
// Every supported language beyond the default needs a directive. If someone puts a
// new language in IDIOMAS_OK and forgets the text, the test warns here.
IDIOMAS_OK.filter((l) => l !== IDIOMA_PADRAO).forEach((l) => {
  t(`${l} (de IDIOMAS_OK) tem diretriz escrita`, !!instrucaoDeIdioma(l));
});

// 11) Language-drift detector. It's a heuristic and only observes, but the edges
//     need to be locked down: it can never run in pt-BR (Portuguese is
//     expected there) and it can never blow up on garbage input, because it runs
//     on the turn's response path.
const PT_LONGO = 'Pronto, já anotei aqui na sua memória que você não gosta de reunião antes das dez da manhã, e também que a sua irmã faz aniversário em março.';
const EN_LONGO = "Done, I noted in your memory that you don't like meetings before ten in the morning, and also that your sister has a birthday in March.";
const ES_LONGO = 'Listo, ya anoté en tu memoria que no te gustan las reuniones antes de las diez de la mañana, y también que tu hermana cumple años en marzo.';

// In pt-BR the detector has to stay SILENT, always.
t('pt-BR nunca gera medição', derivaDeIdioma(PT_LONGO, 'pt-BR') === null);
t('pt-PT também não', derivaDeIdioma(PT_LONGO, 'pt-PT') === null);
t('idioma não atendido não gera medição', derivaDeIdioma(PT_LONGO, 'ja') === null);
t('sem idioma não gera medição', derivaDeIdioma(PT_LONGO, null) === null);

// Useless input doesn't turn into a made-up score.
[null, undefined, '', '   ', 'ok', 'sim', 0, {}, []].forEach((v) => {
  t(`entrada ${JSON.stringify(v)} não gera score`, derivaDeIdioma(v, 'en') === null);
});

// What it exists to catch: Portuguese coming out for someone who asked for en/es.
for (const l of ['en', 'es']) {
  const d = derivaDeIdioma(PT_LONGO, l);
  t(`${l}: português é flagrado`, d !== null && d.suspeita === true);
  t(`${l}: devolve contagem coerente`, d.palavras > 8 && d.marcas > 0 && d.score > 0);
  t(`${l}: reporta o idioma esperado`, d.idioma === l);
}

// And what it must NOT flag: the right answer in the right language.
const dEn = derivaDeIdioma(EN_LONGO, 'en');
t('en limpo não é acusado', dEn !== null && dEn.suspeita === false);
// pt vs es is the hard case (almost all vocabulary shared): if the
// detector flags correct Spanish, the log would turn into noise and nobody would look at it.
const dEs = derivaDeIdioma(ES_LONGO, 'es');
t('es limpo não é acusado', dEs !== null && dEs.suspeita === false);
t('português pontua MAIS que espanhol', derivaDeIdioma(PT_LONGO, 'es').score > dEs.score);

// 12) Per-turn reminder (2026-09-30, DeepSeek replied in Chinese to a pt-BR
//     account on a long thread): every supported language has its own, written in the
//     language itself, short (goes in every message), and an unsupported language doesn't
//     get any reminder.
t('lembrete pt-BR em português', lembreteDeIdioma('pt-BR').includes('português do Brasil'));
t('lembrete en em inglês', lembreteDeIdioma('en').includes('reply in English'));
t('lembrete es em espanhol', lembreteDeIdioma('es').includes('responde en español'));
t('variante regional usa o mesmo lembrete', lembreteDeIdioma('pt') === lembreteDeIdioma('pt-BR') && lembreteDeIdioma('en-GB') === lembreteDeIdioma('en'));
for (const l of IDIOMAS_OK) t(`lembrete ${l} é curto`, lembreteDeIdioma(l).length > 0 && lembreteDeIdioma(l).length < 250);
for (const v of ['ja', 'zh', '', null, undefined]) t(`sem lembrete para ${JSON.stringify(v)}`, lembreteDeIdioma(v) === '');

// 13) Ideogram guard: the real prod drifts are caught, and the Japanese the
//     owner asks for on purpose (always with kana) or an explicit request for Chinese
//     pass through. Whoever touches the cutoff sees here if it started translating a legitimate response.
const DERIVA_0510 = '两件事：\n\n**Pepecarteira — 现在没打通。** 我尝试访问并返回了“未找到”（404）：网站在线，但我的代理用来记录/查询的接口此刻没有响应。所以现在，我**无法**从那里记录或核实任何内容。';
const DERIVA_3009 = '调整已安排好——今天的两个区块都不会丢，下午的区块避开了 Solar 会议（14:00–16:00）：\n\n- **区块 1**：15:30–17:00 → **16:15–17:45** *（在会议结束后，留出 15 分钟缓冲）*';
const JAPONES_PEDIDO = '**Tarefas diárias**\n- [x] 靴を買いに行く（くつをかいにいく）\n- 言語を勉強して\n- トフの砂を買って\n- オベンの修理を頼む\n- 鶏肉を解凍する';
t('deriva 05/10 é pega', ideogramaAcidental(DERIVA_0510, 'pt-BR', 'pode cancelar esses lembretes')?.idioma === 'pt-BR');
t('deriva 30/09 é pega', !!ideogramaAcidental(DERIVA_3009, 'pt-BR', 'Pode ajustar os blocos das aulas gravadas na agenda'));
t('deriva em conta en é pega', ideogramaAcidental(DERIVA_0510, 'en', 'cancel those reminders')?.idioma === 'en');
t('japonês pedido passa', ideogramaAcidental(JAPONES_PEDIDO, 'pt-BR', 'adiciona na lista') === null);
t('pedido de chinês passa', ideogramaAcidental(DERIVA_0510, 'pt-BR', 'traduz isso pra chinês') === null);
t('dono escrevendo em chinês passa', ideogramaAcidental(DERIVA_0510, 'pt-BR', '你好，请帮我') === null);
t('palavra solta em chinês passa', ideogramaAcidental('O caractere 你好 quer dizer olá; 谢谢 é obrigado.', 'pt-BR', 'como diz olá') === null);
for (const l of IDIOMAS_OK) t(`aviso sem idioma ${l} não tem ideograma`, !!avisoSemIdioma(l) && !/\p{Script=Han}/u.test(avisoSemIdioma(l)));

// 14) Written language (real prod messages, 2026-10-06 calibration): the person's
//     own short sentence is detected; pasted logs/CLI output and a Portuguese
//     request around an English quote are not, so they keep the configured language.
const escrito = (txt, esperado) => t(`escrito ${JSON.stringify(txt.slice(0, 40))} -> ${esperado}`, idiomaEscrito(txt) === esperado);
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
t('lembrete muda para o idioma escrito', lembreteDeIdioma('pt-BR', 'Search the web for the latest news about the James Webb Space Telescope.').includes('written in English'));
t('lembrete fica no configurado quando escreveu nele', lembreteDeIdioma('pt-BR', 'Quais são meus compromissos de amanhã?') === lembreteDeIdioma('pt-BR'));
t('conta en escrevendo em português', lembreteDeIdioma('en', 'inclui um outro evento para amanhã').includes('escrita em português'));
t('idioma do turno', idiomaDoTurno('pt-BR', 'Busca en la web las noticias más recientes sobre el clima') === 'es' && idiomaDoTurno('pt-BR', '') === 'pt-BR');
for (const l of IDIOMAS_OK) t(`lembrete escrito ${l} é curto`, ['Search the web for the latest news about the telescope.', 'Busca en la web las noticias más recientes sobre el clima', 'inclui um outro evento para amanhã'].every((m) => lembreteDeIdioma(l, m).length < 250));

console.log(`\n${ok} ok, ${fail} falha(s)`);
process.exit(fail ? 1 : 0);
