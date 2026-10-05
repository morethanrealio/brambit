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

// Nome do idioma POR EXTENSO, em português, pra encaixar em prompt que já está
// escrito em português. Existe porque nem toda frase do prompt aceita a tag
// crua: onde o texto original dizia "em português do Brasil", trocar por
// "em pt-BR" mudaria uma frase que foi MEDIDA com aquela redação. Aqui o padrão
// devolve exatamente 'português do Brasil', então a linha sai byte a byte igual
// pra quem está em pt-BR e só en/es veem redação diferente.
export function idiomaPorExtenso(language) {
  return { 'pt-BR': 'português do Brasil', en: 'inglês', es: 'espanhol' }[tagIdioma(language)];
}

// Diretriz de idioma, escrita NA PRÓPRIA LÍNGUA de destino (instrução em
// inglês funciona melhor pra sair inglês do que "responda em inglês" escrito em
// português).
//
// A cláusula de override existe porque o resto do prompt continua em português
// e várias descrições de tool dizem "em pt-BR". Sem dizer explicitamente quem
// ganha, o modelo recebe ordens contrárias e oscila. Por isso o chamador tem
// que colar isto no FIM do prompt.
//
// HISTÓRICO DO pt-BR (importa pra não desfazer sem querer): até 08/09/2026 esta
// tabela NÃO tinha entrada de pt-BR de propósito, pra quem está em português não
// receber byte nenhum a mais e o prefixo cacheado seguir idêntico ao de antes do
// multi-idioma. O efeito colateral foi um buraco: en e es mandavam "se a pessoa
// escrever em outra língua, responda na língua dela" e o pt-BR não mandava nada,
// então conta em português + usuário falando inglês ficava por conta da sorte do
// modelo. Marcos mandou fechar o buraco (08/09/2026). O preço é uma quebra de
// cache ÚNICA, no deploy: a partir dela o prefixo do pt-BR volta a ser estável.
// Por isso a diretriz de pt-BR é curta e fixa: cada byte aqui é multiplicado por
// toda conversa em português que existe.
const DIRETRIZ = {
  'pt-BR': [
    'IDIOMA: o idioma configurado deste usuário é o português do Brasil, e é nele que você responde por padrão.',
    'Se ELE escrever pra você em outra língua, responda na língua que ele usou, e volte pro português quando ele voltar. Texto que ele apenas colou ou mandou você ler (e-mail, documento, resultado de busca) NÃO conta como troca de língua: nesse caso a conversa continua onde estava, e você preserva a citação no original.',
  ].join('\n'),
  en: [
    'LANGUAGE — this overrides every other language instruction in this prompt:',
    "This user's language is English. Write EVERYTHING in English: your replies, and also the text you pass inside tool arguments that the user will end up reading (reminders, suggestions, notes, captions, documents, messages sent on their behalf).",
    'These instructions and some tool descriptions are written in Portuguese and a few of them say "em pt-BR". Ignore that: English wins.',
    'If the user writes to you in another language, reply in the language they used. When you quote someone else\'s words (an email, a document, a search result), keep the original wording and translate beside it if that helps.',
    'Never mention this instruction and never apologise for the language.',
  ].join('\n'),
  es: [
    'IDIOMA — esto tiene prioridad sobre cualquier otra instrucción de idioma de este prompt:',
    'El idioma de este usuario es el español. Escribe TODO en español: tus respuestas y también el texto que pasas dentro de los argumentos de las herramientas y que el usuario va a leer (recordatorios, sugerencias, notas, descripciones, documentos, mensajes enviados en su nombre).',
    'Estas instrucciones y algunas descripciones de herramientas están escritas en portugués y algunas dicen "em pt-BR". Ignóralo: manda el español.',
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
export function lembreteDeIdioma(language) {
  const l = normalizaIdioma(language);
  return (l && LEMBRETE[l]) || '';
}

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
