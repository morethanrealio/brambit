// Citação por referência: o modelo marca o fato com [n], a PLATAFORMA monta a
// lista de fontes.
//
// Por que existe (06/10/2026): o modelo escrevia a própria lista ("Fonte: X"),
// copiando, encurtando e às vezes trocando nomes e endereços. O freio de
// fundamentação (grounding-guard.mjs) então comparava texto com texto e errava
// dos dois lados: acusava fonte real que o modelo resumiu e não tinha como
// provar de onde vinha cada fato. Aqui a origem é garantida por construção:
//  1. cada fonte que uma ferramenta de busca/leitura mostra ao modelo ganha um
//     número fixo no turno (registroDeFontes), na própria saída da ferramenta;
//  2. o modelo só escreve o número junto do fato;
//  3. citarFontes troca número por fonte real: número que nenhuma ferramenta
//     mostrou some, e a lista que a pessoa lê sai do registro, nunca da memória
//     do modelo.
//
// Também moram aqui os outros consertos puros do texto final (marcador órfão,
// tool-call vazado, pontuação grudada em link), que antes ficavam no server.mjs.
// Módulo puro: sem I/O, sem banco.
import { tagIdioma, IDIOMA_PADRAO } from './locale.mjs';

const ROTULO = { 'pt-BR': 'Fontes:', en: 'Sources:', es: 'Fuentes:' };
const rotuloDe = language => ROTULO[tagIdioma(language)] || ROTULO[IDIOMA_PADRAO] || 'Fontes:';

/**
 * Registro das fontes que o modelo viu neste turno. A mesma URL recebe sempre o
 * mesmo número, então duas buscas que acham a mesma página não geram duas
 * fontes. Só entra endereço http(s): sem endereço, a fonte não serve de prova.
 */
export function registroDeFontes() {
  const lista = [];
  const porUri = new Map();
  return {
    add({ title, uri } = {}) {
      const u = String(uri || '').trim();
      if (!/^https?:\/\/\S+$/i.test(u)) return 0;
      if (porUri.has(u)) return porUri.get(u);
      lista.push({ title: String(title || '').replace(/\s+/g, ' ').trim() || u, uri: u });
      porUri.set(u, lista.length);
      return lista.length;
    },
    get: n => lista[n - 1] || null,
    get size() { return lista.length; },
  };
}

// ——— marcadores ———————————————————————————————————————————————
// Mexer no texto final acerta 100% das respostas de todo mundo, então a troca
// de marcador é cercada por portões, e fora deles o texto sai byte a byte:
//  - o marcador tem que estar DENTRO da frase, nunca abrindo linha (senão a
//    gente apagaria o menu que o próprio assistente ofereceu: "[1] Sim");
//  - tem que parecer citação: números a partir de 1 (intervalo "[0, 1]" fica) e
//    nada de dígito logo depois (DDD "[11] 98888-7777" fica);
//  - bloco de código (``` ou `) passa intacto: lá "[0]" é código.
const CITACAO = String.raw`\[\s*[1-9]\d*(?:\s*[,;]\s*[1-9]\d*)*\s*\]`;
const RE_CITACAO = new RegExp(
  String.raw`[ \t]*(?<![\w\]])(?:\(\s*${CITACAO}\s*\)|${CITACAO})(?!\()[ \t]*`,
  'g',
);
// Na citação por referência o grupo "[1][3]" é um marcador só.
const RE_GRUPO = new RegExp(
  String.raw`[ \t]*(?<![\w\]])(?:\(\s*${CITACAO}\s*\)|${CITACAO}(?:[ \t]*${CITACAO})*)(?!\()[ \t]*`,
  'g',
);
const RE_LISTA = /(^|\n)\s*(fontes|sources|fuentes)\s*:/i;
const RE_ITEM_LISTA = /^\s*\[\d+\]\s+\S.*https?:\/\//m;

// Lixo que não é conteúdo em nenhum caso: "[cite: 1]" e o identificador da
// própria chamada de tool que alguns modelos usam como citação.
function limparLixo(s) {
  return s.replace(/[ \t]*\[cite:\s*\d+(?:[.,;\s]+\d+)*\s*\][ \t]*/gi, (m, off, str) => {
    const next = str[off + m.length] || '';
    return !off || !next || /[\s.,;:!?)\]]/.test(next) ? '' : ' ';
  }).replace(/default_api[:.][A-Za-z0-9_.-]+(?:\s*:\s*\d+)?/g, '');
}

// Abrindo linha (com ou sem bullet/título markdown) é item de lista ou menu.
function abreLinha(str, off, m) {
  const linha = str.slice(str.lastIndexOf('\n', off - 1) + 1, off + m.length - m.trimStart().length);
  return /^\s*(?:[-*•>#]+\s*)*$/.test(linha);
}

// Espaço do marcador removido: só volta se ele separava duas palavras.
function semMarcador(m, off, str) {
  const antes = str[off - 1] || '';
  const depois = str[off + m.length] || '';
  if (!antes || !depois || antes === '\n' || /[\s.,;:!?)\]]/.test(depois)) return '';
  return ' ';
}

// Aplica fn só na prosa: fora de ``` (cerca sem fechamento conta como aberta até
// o fim, caso de resposta cortada no teto) e fora de `inline`.
function naProsa(texto, fn) {
  const partes = String(texto).split(/(```[\s\S]*?```)/g);
  const abertaEm = partes.findIndex((p, i) => i % 2 === 0 && p.includes('```'));
  return partes.map((parte, i) => (i % 2 || (abertaEm >= 0 && i >= abertaEm) ? parte
    : parte.split(/(`[^`\n]*`)/g).map((p, j) => (j % 2 ? p : fn(p))).join(''))).join('');
}
const prosaDe = texto => { const out = []; naProsa(texto, p => { out.push(p); return p; }); return out.join('\n'); };

/**
 * Turno SEM registro de fontes (nenhuma busca nossa rodou, ou só a busca nativa
 * do Gemini): tira marcador órfão. Com lista no texto, o [n] resolve e fica.
 */
export function stripCitationMarkers(s) {
  const temLista = (t) => RE_LISTA.test(t) || RE_ITEM_LISTA.test(t);
  const listaNoTexto = temLista(prosaDe(s));
  return naProsa(s, (p) => {
    const t = limparLixo(p);
    if (listaNoTexto || temLista(t)) return t;
    return t.replace(RE_CITACAO, (m, off, str) => {
      if (abreLinha(str, off, m)) return m;
      if (/\d/.test(str[off + m.length] || '')) return m;
      return semMarcador(m, off, str);
    });
  });
}

const numerosDe = m => (m.match(/\d+/g) || []).map(Number);

// Lista que o próprio modelo escreveu: a ÚLTIMA linha "Fontes:" fora de código e
// os itens logo abaixo dela (linhas com [n], bullet ou endereço; uma linha em
// branco só não fecha a lista se o próximo é item). Devolve as posições no texto.
const RE_CABECA = /^[ \t>*_#-]*(?:fontes|sources|fuentes)[\s*_]*:/i;
const RE_ITEM = /^\s*(?:[-*•+]|\d+[.)]|\[\d+\])\s+\S|https?:\/\//;
function blocoDoModelo(texto) {
  const linhas = texto.split('\n');
  let cerca = false, cab = -1;
  linhas.forEach((l, i) => {
    if (/^\s*```/.test(l)) cerca = !cerca;
    else if (!cerca && RE_CABECA.test(l)) cab = i;
  });
  if (cab < 0) return null;
  let fim = cab + 1;
  while (fim < linhas.length) {
    const l = linhas[fim];
    if (/^\s*```/.test(l)) break;
    if (RE_ITEM.test(l)) { fim++; continue; }
    if (!l.trim() && RE_ITEM.test(linhas[fim + 1] || '')) { fim++; continue; }
    break;
  }
  const ini = linhas.slice(0, cab).join('\n').length + (cab ? 1 : 0);
  const end = linhas.slice(0, fim).join('\n').length;
  return { ini, fim: end, texto: texto.slice(ini, end) };
}
const semPontaFinal = u => u.replace(/[.,;:!?)\]>*_]+$/, '');
// A lista do modelo só pode ser trocada pela nossa se ela fala das MESMAS
// fontes: todo endereço dela está no registro, e todo "[n] ... url" usa o
// mesmo número que o registro deu àquele endereço.
function trocavel(bloco, registro) {
  const conhecidas = new Map();
  for (let n = 1; n <= registro.size; n++) conhecidas.set(registro.get(n).uri, n);
  for (const u of bloco.match(/https?:\/\/[^\s<>()[\]"'`]+/g) || []) {
    if (!conhecidas.has(semPontaFinal(u))) return false;
  }
  for (const linha of bloco.split('\n')) {
    const item = /^\s*(?:[-*•+]\s*)?\[(\d+)\][^\n]*?(https?:\/\/[^\s<>()[\]"'`]+)/.exec(linha);
    if (item && conhecidas.get(semPontaFinal(item[2])) !== Number(item[1])) return false;
  }
  return true;
}

/**
 * Troca os [n] do texto pelas fontes reais do registro do turno.
 *  - número que alguma ferramenta mostrou fica, e a fonte entra na lista;
 *  - número que nenhuma ferramenta mostrou some (não existe fonte pra ele);
 *  - a lista "Fontes:" é montada AQUI, só com o que foi citado. Se o modelo
 *    escreveu a dele com as mesmas fontes, a nossa entra no lugar dela; se a
 *    dele traz outra coisa (numeração própria, endereço que o registro não
 *    conhece), o texto fica como ele escreveu, porque os números apontam pra
 *    lista dele;
 *  - sem nenhuma citação válida, nada é anexado e a linha "Fonte: X" que o
 *    modelo tenha escrito fica intacta.
 * Os números não são renumerados: cada [n] continua apontando exatamente para a
 * mesma linha da lista, inclusive um [n] que tenha escapado dos portões.
 * `comLista: false` só troca os marcadores (uso: resumo do subagente).
 * @returns {string}
 */
export function citarFontes(texto, registro, { language, comLista = true } = {}) {
  const base = String(texto ?? '');
  if (!registro?.size) return stripCitationMarkers(base);
  const bloco = blocoDoModelo(base);
  if (bloco && !trocavel(bloco.texto, registro)) return naProsa(base, limparLixo);
  const antes = bloco ? base.slice(0, bloco.ini) : base;
  const depois = bloco ? base.slice(bloco.fim) : '';
  const citados = new Set();
  const trocar = (p) => limparLixo(p).replace(RE_GRUPO, (m, off, str) => {
    if (abreLinha(str, off, m)) return m;
    if (/\d/.test(str[off + m.length] || '')) return m;
    const validos = [...new Set(numerosDe(m))].filter(n => registro.get(n));
    if (!validos.length) return semMarcador(m, off, str);
    validos.forEach(n => citados.add(n));
    const seguinte = str[off + m.length] || '';
    const fim = /[ \t]$/.test(m) && seguinte && !/[\s.,;:!?)\]]/.test(seguinte) ? ' ' : '';
    return `${/^[ \t]/.test(m) ? ' ' : ''}[${validos.join(', ')}]${fim}`;
  });
  const corpo = naProsa(antes, trocar).replace(/\s+$/, '');
  const resto = naProsa(depois, trocar).replace(/^\s+/, '');
  // Nenhuma citação válida: o texto volta como veio, só sem marcador órfão.
  if (!citados.size) return bloco ? naProsa(base, limparLixo) : corpo;
  if (!comLista) return [corpo, resto].filter(Boolean).join('\n\n');
  const linhas = [...citados].sort((a, b) => a - b).slice(0, 10)
    .map(n => `[${n}] ${registro.get(n).title} — ${registro.get(n).uri}`);
  return [corpo, `${rotuloDe(language)}\n${linhas.join('\n')}`, resto].filter(Boolean).join('\n\n');
}

// ——— outros consertos do texto final ———————————————————————————

// Bloco <tool_call>…</tool_call> (formato GLM: nome + pares <arg_key>/<arg_value>)
// sai inteiro. Sem fechamento, sai até o último </arg_value> do bloco ou, sem
// argumentos, até o fim da linha da tag. Espaço em volta do buraco vira um
// espaço (ou um parágrafo, se havia quebra de linha).
export function removerToolCallVazado(s) {
  if (!s.includes('<tool_call>')) return s;
  const BURACO = '\u0000';
  let out = s.replace(/<tool_call>(?:(?!<tool_call>)[\s\S])*?<\/tool_call>/g, BURACO);
  let i;
  while ((i = out.indexOf('<tool_call>')) >= 0) {
    const proxima = out.indexOf('<tool_call>', i + 1);
    const bloco = out.slice(i, proxima >= 0 ? proxima : out.length);
    const fimArg = bloco.lastIndexOf('</arg_value>');
    const nl = bloco.indexOf('\n');
    const fim = fimArg >= 0 ? fimArg + '</arg_value>'.length : nl >= 0 ? nl : bloco.length;
    out = out.slice(0, i) + BURACO + out.slice(i + fim);
  }
  return out.replace(/\s*\u0000(?:\s*\u0000)*\s*/g, (m, off, str) => {
    if (!off || off + m.length >= str.length) return '';
    return m.includes('\n') ? '\n\n' : ' ';
  });
}

// Ponto final colado numa URL vira 404: o linkificador do WhatsApp/Telegram (e o
// nosso, no web) engole o "." dentro do href. Não controlamos o cliente, então
// tiramos a pontuação da frase quando ela está grudada num link no fim da linha.
// Só mexe em URL COM caminho (tem "/"), pra não estragar frase que termina em
// nome de arquivo ("veja o config.yaml."), e ignora link markdown (fecha em ")").
export function desgrudarPontuacaoDeLink(s) {
  return String(s ?? '').replace(
    /((?:https?:\/\/|(?:[a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}\/)[^\s<>()[\]]*[^\s<>()[\].,;:!?])[.,;:!?]+(?=\s*$)/gm,
    '$1',
  );
}

/**
 * Rede de segurança do texto FINAL do assistente, independente de provider:
 *  1) tira marcação crua de tool-call que escapa quando o parser do modelo falha;
 *  2) citações: com registro de fontes do turno, troca [n] por fonte real
 *     (citarFontes); sem registro mas com busca no turno, tira marcador órfão.
 * O mascaramento de segredo e o desgrude de pontuação ficam com quem chama
 * (o mascarador mora num módulo com banco).
 */
export function limparTextoFinal(t, { comFontes = false, fontes = null, language } = {}) {
  // Tira só o pedaço técnico vazado; o texto pro usuário antes E depois dele
  // fica. Antes cortava tudo do primeiro <tool_call> em diante e perdia a
  // resposta que vinha depois (29/09/2026).
  let s = removerToolCallVazado(String(t ?? ''));
  // Limpa fragmentos soltos de arg (caso o modelo emita sem o <tool_call> de abertura).
  s = s.replace(/<\/?(?:tool_call|arg_key|arg_value)>/g, '');
  if (fontes?.size) return citarFontes(s, fontes, { language });
  if (comFontes) return stripCitationMarkers(s);
  return s;
}
