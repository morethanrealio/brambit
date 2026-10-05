// i18n das páginas públicas: tradução em tempo de RESPOSTA, sem tocar no HTML.
//
// Por que não `data-i18n` em cada elemento (o plano original): marcar ~740
// strings à mão significa editar todas as páginas que hoje estão certas e no ar,
// e cada marcação esquecida vira um pedaço em português no meio da página
// traduzida, sem erro nenhum aparecendo. Aqui o HTML fica INTACTO e o catálogo é
// um arquivo à parte; o que falta tradução continua em português, que é o
// fallback honesto.
//
// A propriedade que sustenta tudo: em pt-BR `traduzPagina` devolve a MESMA
// string, por early return, e com catálogo vazio a caminhada devolve o arquivo
// BYTE A BYTE. Ou seja, os 99 usuários de hoje não têm como regredir por causa
// disto, e isso está provado em teste sobre as páginas reais, não afirmado.
//
// LIMITE DECLARADO: isto traduz o que está NO ARQUIVO. Texto que o JavaScript
// da página monta a partir de dado vindo da API (nome de plano, mensagem de erro
// do servidor) não passa por aqui — quem traduz aquilo é o backend.

import fs from 'node:fs';
import path from 'node:path';
import { tagIdioma, IDIOMA_PADRAO, IDIOMAS_OK } from './locale.mjs';

// Atributos cujo valor o usuário LÊ. `value` fica de fora de propósito: em
// <input type=hidden> e <option value=...> ele é dado, não texto, e traduzir
// quebraria o form. Botão com texto em `value` não existe nestas páginas
// (verificado por grep antes de decidir).
const ATRIBUTOS_DE_TEXTO = new Set(['placeholder', 'title', 'alt', 'aria-label', 'aria-placeholder']);

// <meta content="..."> só é texto em alguns nomes; nos outros é máquina
// (viewport, charset, theme-color) e traduzir seria estrago.
const META_DE_TEXTO = new Set(['description', 'og:description', 'og:title', 'og:site_name', 'twitter:title', 'twitter:description', 'apple-mobile-web-app-title']);

// Tem letra? Serve pra descartar candidato que é só número, pontuação ou emoji
// ("→", "•", "1", "R$"), que não tem o que traduzir e só sujaria o catálogo.
const TEM_LETRA = /\p{L}{2}/u;

function ehTraduzivel(s) {
  // `${...}` no meio: é texto MONTADO em tempo de execução. Traduzir o molde
  // inteiro exigiria mexer na ordem dos pedaços e resolver plural, e o que sai
  // do buraco continua vindo do backend em português. Fica fora, declarado.
  return TEM_LETRA.test(s) && !s.includes('${');
}

// Dentro de <script> a maioria das strings NÃO é texto de usuário: é seletor
// ('.aviso'), rota ('/api/creditos'), chave ('content-type'), constante de DOM
// ('Enter'). Traduzir qualquer uma dessas não deixa a página feia, deixa
// QUEBRADA, e em silêncio. Então aqui a regra é o contrário da do HTML: só
// passa o que tem cara de frase.
//
// Passa se tiver espaço (frase) ou acento (prova de que é português escrito
// pra gente ler). Palavra ASCII solta fica de fora mesmo sendo texto de
// verdade: perde-se um 'Salvar' que continua em português, e em troca não se
// arrisca traduzir o 'Enter' de `e.key === 'Enter'`. Fallback em português é
// defeito visível; tecla que parou de funcionar, não.
function ehFraseDeScript(s) {
  if (ehCss(s)) return false;
  return /\s/.test(s) || /[^\x00-\x7F]/.test(s);
}

// CSS posto no `style` de um elemento ('font-size:12px;margin:2px 0 4px;') tem
// espaço e por isso passaria como frase. É código: traduzido, quebra o layout.
// Reconhece pelo formato, todo pedaço separado por ';' sendo um
// `propriedade: valor` com nome de propriedade CSS (minúscula com hífen).
function ehCss(s) {
  // Seletor ('#routines .rcard', '.tabs .tab'): tem espaço, então passaria como
  // frase. Nenhuma frase de português começa com # ou ponto.
  if (/^[#.[]/.test(s)) return true;
  const partes = s.split(';').map((p) => p.trim()).filter(Boolean);
  return partes.length > 0 && partes.every((p) => /^[a-z-]+\s*:\s*\S/.test(p));
}

// Segundo filtro pro script: olha o que vem ANTES do literal. Tem string que
// parece frase de tela por todos os lados ('app-open lib', '1 1 auto',
// 'BEGIN PRIVATE KEY') e é valor de máquina; o que denuncia não é o conteúdo, é
// quem está recebendo. Traduzir uma dessas não deixa a tela feia, deixa
// QUEBRADA em silêncio, que é o defeito que este arquivo inteiro existe pra
// evitar.
//
// Cada linha abaixo saiu de uma ocorrência REAL medida no index.html, não de
// precaução genérica: nome de classe montado em `className =`, medida em
// `style.flex`/`style.padding`, e o `p8.includes('BEGIN PRIVATE KEY')` que
// detecta chave privada colada pelo usuário.
const CONTEXTO_DE_MAQUINA = new RegExp(`(?:${[
  '(?:===?|!==?|\\bcase)',                                     // comparação direta
  '\\.(?:includes|indexOf|lastIndexOf|startsWith|endsWith|split)\\s*\\(',
  '\\.(?:className|cssText)\\s*\\+?=',                         // classe / style inteiro
  '\\.style\\.[A-Za-z]+\\s*=',                                 // style.flex, style.padding
  'classList\\.(?:add|remove|toggle|contains|replace)\\s*\\(',
  '(?:querySelector|querySelectorAll|closest|matches|getElementById)\\s*\\(',
  '(?:get|set|has|remove)Attribute\\s*\\(',                    // 1º arg é NOME de atributo
  'setAttribute\\s*\\(\\s*[\'"]class[\'"]\\s*,',               // e o 2º arg de class também
  '(?:localStorage|sessionStorage)\\.\\w+\\s*\\(',
].join('|')})\\s*$`);

// ── Caminhada ───────────────────────────────────────────────────────────────
// Um único percurso serve pra EXTRAIR (montar o catálogo) e pra APLICAR
// (traduzir). É de propósito: se fossem dois percursos diferentes, a chave
// extraída poderia não ser a chave procurada, e o sintoma seria página em
// português sem erro nenhum. Aqui, se extraiu, acha.
//
// `troca(texto, tipo)` devolve a substituição ou null pra deixar como está.
function caminha(html, troca) {
  let out = '';
  let i = 0;
  const n = html.length;

  const emite = (bruto, tipo) => {
    // Preserva o espaço em volta: o trim é só pra casar a chave, o HTML volta
    // com a mesma indentação de antes.
    const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(bruto);
    const [, antes, miolo, depois] = m;
    if (!miolo || !ehTraduzivel(miolo)) return bruto;
    const novo = troca(miolo, tipo);
    return novo == null ? bruto : antes + novo + depois;
  };

  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt < 0) { out += emite(html.slice(i), 'texto'); break; }
    out += emite(html.slice(i, lt), 'texto');

    // Comentário: copiado cru. Comentário de código não é texto de usuário.
    if (html.startsWith('<!--', lt)) {
      const fim = html.indexOf('-->', lt + 4);
      const ate = fim < 0 ? n : fim + 3;
      out += html.slice(lt, ate);
      i = ate;
      continue;
    }

    // Fim da tag de abertura, ignorando '>' que esteja DENTRO de valor de
    // atributo (acontece em onclick e em SVG).
    let j = lt + 1, aspas = null;
    while (j < n) {
      const c = html[j];
      if (aspas) { if (c === aspas) aspas = null; }
      else if (c === '"' || c === "'") aspas = c;
      else if (c === '>') break;
      j++;
    }
    if (j >= n) { out += html.slice(lt); break; }

    const tag = html.slice(lt, j + 1);
    out += traduzTag(tag, troca);
    i = j + 1;

    // <script> e <style>: o conteúdo NÃO é HTML, então a caminhada não pode
    // entrar nele. Vai inteiro pro tratamento de literal de JS (script) ou é
    // copiado cru (style).
    const nome = /^<\s*([a-zA-Z][\w:-]*)/.exec(tag)?.[1]?.toLowerCase();
    if ((nome === 'script' || nome === 'style') && !/\/\s*>$/.test(tag)) {
      const fecha = new RegExp(`</\\s*${nome}\\s*>`, 'i');
      const resto = html.slice(i);
      const m = fecha.exec(resto);
      const corpo = m ? resto.slice(0, m.index) : resto;
      out += nome === 'script' ? traduzScript(corpo, troca) : corpo;
      i += corpo.length;
    }
  }
  return out;
}

// Atributos de texto dentro de uma tag de abertura.
function traduzTag(tag, troca) {
  const ehMeta = /^<\s*meta\b/i.test(tag);
  let metaNome = null;
  if (ehMeta) {
    const m = /\b(?:name|property)\s*=\s*("([^"]*)"|'([^']*)')/i.exec(tag);
    metaNome = (m?.[2] ?? m?.[3] ?? '').toLowerCase();
  }
  return tag.replace(/([a-zA-Z_:][\w:.-]*)\s*=\s*("([^"]*)"|'([^']*)')/g, (todo, nome, _q, dupla, simples) => {
    const attr = nome.toLowerCase();
    const valor = dupla !== undefined ? dupla : simples;
    const aspa = dupla !== undefined ? '"' : "'";
    const alvo = ATRIBUTOS_DE_TEXTO.has(attr) || (ehMeta && attr === 'content' && META_DE_TEXTO.has(metaNome));
    if (!alvo || !valor || !ehTraduzivel(valor)) return todo;
    const novo = troca(valor.trim(), 'atributo');
    // Aspas no meio do valor quebrariam o atributo. Não é hipótese remota: em
    // espanhol «"sí"» aparece. Na dúvida, mantém o português.
    if (novo == null || novo.includes(aspa)) return todo;
    return `${nome}=${aspa}${novo}${aspa}`;
  });
}

// ── Lexer de JavaScript ─────────────────────────────────────────────────────
// Achar string com regex NÃO funciona, e o jeito que não funciona é traiçoeiro.
// Nestas páginas existe `/[.,;:!?)\]}"]$/`: a aspa dentro do literal de regex
// abre uma "string" falsa que engole código até a próxima aspa, e o extrator
// cospe pedaços de função como se fossem frase. Foi exatamente o que aconteceu
// na primeira versão (medido, não suposto). Daí o lexer: ele precisa conhecer
// comentário, regex e template pra saber o que NÃO é string.
const PALAVRAS_ANTES_DE_REGEX = new Set(['return', 'typeof', 'case', 'in', 'of', 'new', 'delete', 'void', 'do', 'else', 'yield', 'await', 'instanceof', 'throw']);

// Fatia o código em pedaços rotulados, cobrindo o texto inteiro sem buraco nem
// sobreposição (o teste confirma que remontar os pedaços devolve a entrada).
export function fatiaJs(js) {
  const out = [];
  const n = js.length;
  let i = 0;
  let anterior = '';        // último caractere significativo
  let palavra = '';         // último identificador, pra `return /re/`
  // Contexto aninhado: {tipo:'tpl'} dentro de template, {tipo:'expr'} dentro do
  // ${} de um template. Precisa de pilha de verdade porque template dentro de
  // ${} de outro template acontece nestas páginas.
  const pilha = [];
  const topo = () => pilha[pilha.length - 1];

  const podeSerRegex = () => {
    if (!anterior) return true;
    if (/[A-Za-z0-9_$]/.test(anterior)) return PALAVRAS_ANTES_DE_REGEX.has(palavra);
    // depois de ) ou ] vem divisão (`(a+b)/2`); depois de operador, vírgula,
    // abre-chaves etc. vem regex.
    return anterior !== ')' && anterior !== ']';
  };

  const fimDeString = (ini, aspa) => {
    let j = ini + 1;
    while (j < n) {
      const c = js[j];
      if (c === '\\') { j += 2; continue; }
      if (c === aspa) return j + 1;
      if (c === '\n') return -1;   // string não fecha em outra linha: era outra coisa
      j++;
    }
    return -1;
  };

  while (i < n) {
    const c = js[i];

    // Dentro de template o conteúdo é TEXTO, não código: só ` e ${ têm
    // significado. Tem que vir antes de tudo, senão uma aspa ou uma barra no
    // meio do texto vira string/regex e os pedaços se sobrepõem.
    if (topo()?.tipo === 'tpl') {
      if (c === '\\') { i += 2; continue; }
      if (c === '`') {
        const ctx = pilha.pop();
        if (!pilha.length) out.push({ tipo: 'template', ini: ctx.ini, fim: i + 1, aspa: '`' });
        anterior = '`'; palavra = '';
        i++;
        continue;
      }
      if (c === '$' && js[i + 1] === '{') { pilha.push({ tipo: 'expr', chaves: 0 }); i += 2; continue; }
      i++;
      continue;
    }

    if (c === '/' && js[i + 1] === '/') {
      const j = js.indexOf('\n', i);
      if (!pilha.length) out.push({ tipo: 'comentario', ini: i, fim: j < 0 ? n : j });
      i = j < 0 ? n : j;
      continue;
    }
    if (c === '/' && js[i + 1] === '*') {
      const j = js.indexOf('*/', i + 2);
      if (!pilha.length) out.push({ tipo: 'comentario', ini: i, fim: j < 0 ? n : j + 2 });
      i = j < 0 ? n : j + 2;
      continue;
    }
    if (c === '/' && podeSerRegex()) {
      let j = i + 1, classe = false, ok = false;
      while (j < n) {
        const d = js[j];
        if (d === '\\') { j += 2; continue; }
        if (d === '\n') break;
        if (classe) { if (d === ']') classe = false; }
        else if (d === '[') classe = true;
        else if (d === '/') { ok = true; j++; break; }
        j++;
      }
      if (ok) {
        while (j < n && /[a-z]/.test(js[j])) j++;   // flags
        if (!pilha.length) out.push({ tipo: 'regex', ini: i, fim: j });
        anterior = '/'; palavra = '';
        i = j;
        continue;
      }
      // não fechou: era divisão mesmo, segue como código
    }
    if (c === '"' || c === "'") {
      const fim = fimDeString(i, c);
      if (fim > 0) {
        if (!pilha.length) out.push({ tipo: 'string', ini: i, fim, aspa: c });
        anterior = c; palavra = '';
        i = fim;
        continue;
      }
      // aspa solta (dentro de regex mal detectada, por ex.): trata como código
    }
    if (c === '`') {
      pilha.push({ tipo: 'tpl', ini: i });
      anterior = '`'; palavra = '';
      i++;
      continue;
    }
    // Fechamento do ${}: a chave que casa com a abertura devolve pro template.
    if (topo()?.tipo === 'expr') {
      if (c === '{') topo().chaves++;
      else if (c === '}') {
        if (topo().chaves === 0) { pilha.pop(); i++; continue; }
        topo().chaves--;
      }
    }
    if (!/\s/.test(c)) {
      anterior = c;
      palavra = /[A-Za-z0-9_$]/.test(c) ? palavra + c : '';
    }
    i++;
  }
  // Template que não fecha (script truncado): emite o que sobrou pra cobertura
  // continuar completa em vez de sumir com o resto do arquivo.
  const aberto = pilha.find((c) => c.tipo === 'tpl');
  if (aberto) out.push({ tipo: 'template', ini: aberto.ini, fim: n, aspa: '`' });
  return out;
}

// Tem tag HTML dentro? Aí a string é um pedaço de página montado em JS, e quem
// sabe achar texto nela é a própria caminhada de HTML, recursivamente. Assim
// 'Baixe o <b>__MARCA__ Runner.exe</b> (botão acima)' é traduzido pelos pedaços de
// texto, com as tags intactas, em vez de virar uma chave gigante de catálogo.
const TEM_TAG = /<[a-zA-Z][^>]*>/;

// Lista de palavras soltas, vizinhas, com pelo menos uma acentuada: é a forma
// de `['domingo','segunda','terça',...]`. Sem isto o filtro de frase pega só
// 'terça' e 'sábado' (as acentuadas) e a tela em inglês mostra "domingo,
// segunda, Tuesday" — pior do que tudo em português, porque parece defeito e
// não falta de tradução. Então ou o grupo inteiro entra, ou nenhum entra.
//
// Exige TODAS as palavras soltas pra não confundir com argumento de função, e
// pelo menos uma acentuada como prova de que a lista é português escrito pra
// ler. Lista sem acento nenhum ('jan','fev','mar') fica fora inteira, que é
// consistente.
const UMA_PALAVRA = /^\p{L}[\p{L}\p{M}]*$/u;

function irmaosDeLista(js, pedacos) {
  const ok = new Set();
  let grupo = [];
  const fecha = () => {
    const corpos = grupo.map((p) => js.slice(p.ini + 1, p.fim - 1));
    if (grupo.length >= 3 && corpos.every((c) => UMA_PALAVRA.test(c)) && corpos.some((c) => /[^\x00-\x7F]/.test(c))) {
      for (const p of grupo) ok.add(p.ini);
    }
    grupo = [];
  };
  for (const p of pedacos) {
    if (p.tipo !== 'string') { fecha(); continue; }
    if (grupo.length && /^\s*,\s*$/.test(js.slice(grupo[grupo.length - 1].fim, p.ini))) grupo.push(p);
    else { fecha(); grupo = [p]; }
  }
  fecha();
  return ok;
}

// Literais de string dentro de <script>.
function traduzScript(js, troca) {
  const pedacos = fatiaJs(js);
  const daLista = irmaosDeLista(js, pedacos);
  let out = '';
  let cursor = 0;
  for (const p of pedacos) {
    out += js.slice(cursor, p.ini);
    cursor = p.fim;
    const bruto = js.slice(p.ini, p.fim);
    if (p.tipo !== 'string' && p.tipo !== 'template') { out += bruto; continue; }
    const aspa = p.aspa;
    const corpo = js.slice(p.ini + 1, p.fim - 1);

    if (TEM_TAG.test(corpo)) {
      // Recursão: só os textos de dentro do fragmento são trocados. Qualquer
      // troca que traga a aspa de fechamento ou barra invertida é recusada lá
      // embaixo, então o literal continua válido.
      const novo = caminha(corpo, (t, tipo) => {
        const r = troca(t, tipo);
        return r == null || r.includes(aspa) || r.includes('\\') || r.includes('`') ? null : r;
      });
      out += aspa + novo + aspa;
      continue;
    }
    if (!corpo || !ehTraduzivel(corpo)) { out += bruto; continue; }
    if (!daLista.has(p.ini) && !ehFraseDeScript(corpo.trim())) { out += bruto; continue; }
    // 40 caracteres porque o gatilho mais longo ('setAttribute("class", ') não
    // cabe em menos; janela curta deixaria passar justamente o caso perigoso.
    if (CONTEXTO_DE_MAQUINA.test(js.slice(Math.max(0, p.ini - 40), p.ini))) { out += bruto; continue; }
    const novo = troca(corpo.trim(), 'script');
    // A string volta com a MESMA aspa, então a tradução não pode conter a aspa
    // nem barra invertida solta. Aspa simples em espanhol/inglês é comum
    // ("don't", "qué'"), e escapar aqui seria fácil de errar: melhor recusar.
    if (novo == null || novo.includes(aspa) || novo.includes('\\')) { out += bruto; continue; }
    // preserva o espaço em volta que o trim tirou
    const m = /^(\s*)[\s\S]*?(\s*)$/.exec(corpo);
    out += aspa + m[1] + novo + m[2] + aspa;
  }
  return out + js.slice(cursor);
}

// ── API ─────────────────────────────────────────────────────────────────────

// Todos os textos que a caminhada considera traduzíveis, na ordem em que
// aparecem, sem repetição. É a lista que alimenta o catálogo — e, por ser o
// MESMO percurso da tradução, é também a lista do que dá pra traduzir.
export function extraiTextos(html) {
  const vistos = new Set();
  const fora = [];
  caminha(html, (texto, tipo) => {
    if (!vistos.has(texto)) { vistos.add(texto); fora.push({ texto, tipo }); }
    return null;
  });
  return fora;
}

// Aplica um catálogo { 'texto em português': 'tradução' }. Chave ausente = fica
// em português, de propósito.
export function aplicaCatalogo(html, catalogo) {
  if (!catalogo) return html;
  return caminha(html, (texto) => {
    const t = catalogo[texto];
    return typeof t === 'string' && t ? t : null;
  });
}

// Troca o lang= da tag <html>, pra leitor de tela e corretor do navegador não
// continuarem achando que a página é portuguesa.
function trocaLangDoHtml(html, tag) {
  return html.replace(/<html\b[^>]*>/i, (m) => (
    /\blang\s*=\s*["'][^"']*["']/i.test(m)
      ? m.replace(/\blang\s*=\s*["'][^"']*["']/i, `lang="${tag}"`)
      : m.replace(/^<html\b/i, `<html lang="${tag}"`)
  ));
}

// Lê os catálogos do disco, um JSON por idioma. Arquivo faltando ou quebrado NÃO
// derruba o processo: sem catálogo o site inteiro sai em português, que é o
// mesmo comportamento de antes desta mudança existir. Um site em português é um
// site; um site que não sobe, não.
export function carregaCatalogos(dir) {
  const fora = {};
  // Várias pastas (a do núcleo e as da marca): as de depois completam as de antes.
  for (const tag of IDIOMAS_OK) for (const d of [].concat(dir)) {
    if (tag === IDIOMA_PADRAO) continue;
    const arq = path.join(d, `${tag}.json`);
    try {
      const j = JSON.parse(fs.readFileSync(arq, 'utf8'));
      // Só string não-vazia entra: chave com null/número no JSON viraria
      // substituição inesperada lá na frente.
      const limpo = {};
      for (const [k, v] of Object.entries(j)) if (typeof v === 'string' && v.trim()) limpo[k] = v;
      fora[tag] = { ...fora[tag], ...limpo };
    } catch (e) {
      if (e.code !== 'ENOENT') console.error(`[site-i18n] catálogo ${tag} ignorado: ${e.message}`);
    }
  }
  return fora;
}

// Ponto único chamado pelo servidor. Em pt-BR devolve a MESMA string, sem passar
// pela caminhada: é o que garante que a página de hoje não muda um byte.
export function traduzPagina(html, language, catalogos) {
  const tag = tagIdioma(language);
  if (tag === IDIOMA_PADRAO) return html;
  const cat = catalogos?.[tag];
  if (!cat) return html;
  return trocaLangDoHtml(aplicaCatalogo(html, cat), tag);
}
