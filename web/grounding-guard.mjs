import { tagIdioma } from './locale.mjs';
import { marca } from './marca.mjs';

// FREIO DE FUNDAMENTAÇÃO
//
// O recibo de ação (action-evidence.mjs) responde "a ação aconteceu?". Este
// módulo responde a outra pergunta, que era a que ficava sem dono: "o fato
// afirmado foi CONSULTADO em algum lugar?".
//
// Origem (18/09/2026, achados de frustração do grupo 1): em cinco casos reais o
// assistente afirmou saldo/plano, preço, cupom, link e fonte sem que nenhuma
// ferramenta capaz de verificar aquilo tivesse rodado no turno. Não havia nada
// no código que percebesse; o único freio era um pedido em prosa no prompt.
//
// A regra aqui é deliberadamente burra e determinística: se a resposta contém um
// dado que só pode vir de fora (URL, cupom, nome de fonte, valor em dinheiro
// apresentado como pesquisado, saldo do próprio dono), esse dado precisa
// aparecer em alguma saída de ferramenta DESTE turno, ou no que o próprio dono
// escreveu. Não aparece em lugar nenhum = a plataforma não tem base pra entregar
// aquilo como fato. Não é classificador semântico e não julga se o conteúdo é
// verdadeiro: julga se existe origem.

// Ferramentas que provam consulta de saldo/plano do próprio dono.
const CREDIT_TOOLS = new Set(['consultar_creditos', 'consultar_gasto', 'status_conta']);
// Ferramentas que provam leitura do conteúdo de um arquivo/anexo.
const READ_TOOLS = new Set([
  'ler_arquivo', 'ler_documento', 'baixar_corpo', 'analisar_planilha',
  'ler_arquivo_do_app', 'google_drive', 'gmail_get_message',
  // ver_midia ABRE a imagem e olha de verdade pra ela. Desde que PDF sem camada
  // de texto passou a virar página-imagem na biblioteca, é por ela que esse anexo
  // é lido; fora desta lista, o freio acusaria 'arquivo não lido' numa resposta
  // que consultou o anexo de verdade.
  'ver_midia',
]);

const fold = value => String(value || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
// Pool de origem: tudo vira um texto só, sem pontuação, pra o teste de presença
// não depender de formatação (JSON, markdown, aspas).
const flatten = value => fold(value).replace(/[^a-z0-9]+/g, ' ');

// Domínios da própria plataforma (marca().hostsCitaveis): o assistente pode
// citá-los de cabeça porque eles vêm do system prompt, não de uma busca.

function hostOf(url) {
  const m = /^https?:\/\/([^/?#\s]+)/i.exec(String(url || ''));
  if (!m) return '';
  return m[1].toLowerCase().replace(/^www\./, '').replace(/[.,;:)\]}>"']+$/, '');
}

const trecho = value => String(value || '').replace(/\s+/g, ' ').trim().slice(0, 200);

// ——— verificadores ———————————————————————————————————————————————
// Cada um devolve zero ou mais achados. Todos recebem o mesmo contexto e
// nenhum deles faz I/O.

// Link cujo domínio não apareceu em nenhuma saída de ferramenta nem na fala do
// dono. A conferência HTTP de links (fontesEConferencia) pega o endereço morto;
// esta pega o endereço que nunca foi consultado, inclusive quando ele responde
// 200 por acaso.
function checkLinks(text, ctx) {
  const out = [];
  const vistos = new Set();
  for (const raw of String(text).match(/https?:\/\/[^\s<>()[\]{}"']+/gi) || []) {
    const host = hostOf(raw);
    if (!host || vistos.has(host)) continue;
    vistos.add(host);
    if (ctx.allowHosts.includes(host)) continue;
    if (ctx.pool.includes(flatten(host).trim())) continue;
    out.push({ kind: 'link_nao_consultado', trecho: trecho(raw), dado: host });
  }
  return out;
}

// Código de cupom/promoção. O contexto é de BLOCO, não de linha: o texto
// costuma anunciar "achei estes cupons:" e listar os códigos nas linhas
// seguintes. A janela abre na linha que fala de cupom e segue enquanto as linhas
// forem itens de lista, fechando na primeira linha em branco ou fora da lista.
const NAO_CUPOM = new Set(["CNPJ","CPF","RG","CEP","OAB","PDF","DOC","DOCX","XLSX","CSV","HTML","JSON","URL","LGPD","API","SKU","NFE","IPTU","PIX","IOF","CDB","ICMS"]);
function checkCupons(text, ctx) {
  const out = [];
  const vistos = new Set();
  let janela = false;
  for (const line of String(text).split("\n")) {
    const falaDeCupom = /\b(?:cupom|cupons|coupon|promocode|promo|c[óo]digos? de desconto)\b/i.test(line);
    const itemDeLista = /^\s*(?:[-*+•]|\d+[.)])\s+/.test(line);
    if (falaDeCupom) janela = true;
    else if (!itemDeLista || !line.trim()) janela = falaDeCupom;
    if (!janela) continue;
    for (const code of line.match(/\b[A-Z][A-Z0-9]{3,19}\b/g) || []) {
      if (vistos.has(code) || NAO_CUPOM.has(code)) continue;
      vistos.add(code);
      if (ctx.allowTokens.includes(code)) continue;
      if (ctx.pool.includes(flatten(code).trim())) continue;
      out.push({ kind: "cupom_nao_consultado", trecho: trecho(line), dado: code });
    }
  }
  return out;
}

// Assinatura de fonte ("Fonte: X" / "Fontes: X"). É uma afirmação explícita de
// leitura: o nome precisa ter aparecido em alguma saída real deste turno.
// LIMITE DELIBERADO: só o bloco explícito. Atribuição solta em prosa ("de acordo
// com a LGPD") também pode vir do conhecimento do modelo, e acusá-la dispararia
// repasse em resposta legítima. Ampliar isso exige dado, não palpite.
function checkFontes(text, ctx) {
  const out = [];
  const vistos = new Set();
  for (const line of String(text).split("\n")) {
    // A linha quase nunca vem crua: chega como "*Fonte: X*", "**Fonte:** X",
    // "- Fonte: X" ou "> Fonte: X". Ignorar a decoração de markdown era o
    // suficiente pra assinatura inventada passar batido (caso de uma rotina real).
    const m = /^[\s>*_#-]*fontes?[\s*_]*:\s*(.+)$/i.exec(line);
    if (!m) continue;
    for (const nome of String(m[1]).split(/[;,|]|\s+e\s+/)) {
      const limpo = nome.replace(/^[-–\s*_]+|[.;,\s*_]+$/g, "").slice(0, 80);
      if (/^https?:/i.test(limpo)) continue; // URL já é tratada em checkLinks
      const chave = flatten(limpo).trim();
      // Nome curto demais vira substring de qualquer coisa e acusaria à toa.
      if (chave.length < 4 || vistos.has(chave)) continue;
      vistos.add(chave);
      if (ctx.pool.includes(chave)) continue;
      out.push({ kind: "fonte_nao_lida", trecho: trecho(line), dado: limpo });
    }
  }
  return out;
}

// Valor em dinheiro apresentado como resultado de pesquisa. O gatilho é a
// AFIRMAÇÃO de ter pesquisado: conta do dono, orçamento hipotético e preço do
// próprio plano continuam livres.
const PESQUISA_CLAIM = /\b(?:pre[çc]os? reais|valores reais|com base (?:em|nos?) (?:pre[çc]os?|valores|uma? )?(?:reais|pesquisa|levantamento)|fiz (?:um|uma) (?:levantamento|pesquisa|cota[çc][ãa]o)|pesquisei|cotei|consultei os sites?|verifiquei (?:os )?pre[çc]os?)\b/i;
function checkPrecos(text, ctx) {
  const value = String(text);
  if (!PESQUISA_CLAIM.test(value)) return [];
  const out = [];
  const vistos = new Set();
  for (const raw of value.match(/R\$\s?\d[\d.,]*/gi) || []) {
    // Compara só os dígitos: a formatação do valor na saída da tool raramente é
    // a mesma que o modelo escreve.
    const digits = raw.replace(/\D/g, '').replace(/0+$/, '') || raw.replace(/\D/g, '');
    if (!digits || digits.length < 3 || vistos.has(digits)) continue;
    vistos.add(digits);
    if (ctx.poolDigits.includes(digits)) continue;
    out.push({ kind: 'preco_sem_consulta', trecho: trecho(raw), dado: raw.trim() });
  }
  return out;
}

// Saldo/plano do próprio dono afirmado sem nenhuma consulta de crédito no turno.
const SALDO_CLAIM = /\b(?:seu|teu|sua|tua)\s+(?:saldo|plano|franquia|cr[ée]ditos?)\b|\bvoc[êe]\s+(?:tem|est[áa] no|possui|assinou)\b[^\n.!?]{0,60}\b(?:cr[ée]ditos?|plano|b[áa]sico|pro|ultra|super|free)\b/i;
function checkSaldo(text, ctx) {
  if (ctx.creditToolRan) return [];
  const value = String(text);
  const out = [];
  for (const line of value.split(/\n|(?<=[.!?])\s+/)) {
    if (!SALDO_CLAIM.test(line)) continue;
    if (!/\d/.test(line) && !/\b(?:b[áa]sico|pro|ultra|super|free|gratuito)\b/i.test(line)) continue;
    out.push({ kind: 'saldo_sem_consulta', trecho: trecho(line), dado: '' });
    break; // um achado por turno basta: a causa e o remédio são os mesmos
  }
  return out;
}

// Conteúdo de anexo descrito sem que nenhuma ferramenta de leitura tenha rodado.
const CONTEUDO_CLAIM = /\b(?:o (?:arquivo|documento|pdf|anexo)|a (?:planilha|apresenta[çc][ãa]o)|no (?:arquivo|documento|anexo)|segue o? ?(?:fichamento|resumo)|fichamento|resumo do (?:arquivo|documento|anexo|pdf))\b/i;
function checkArquivo(text, ctx) {
  if (!ctx.hadAttachment || ctx.readToolRan) return [];
  const value = String(text);
  if (!CONTEUDO_CLAIM.test(value)) return [];
  const line = value.split('\n').find(l => CONTEUDO_CLAIM.test(l)) || value;
  return [{ kind: 'arquivo_nao_lido', trecho: trecho(line), dado: '' }];
}

const CHECKERS = [checkLinks, checkCupons, checkFontes, checkPrecos, checkSaldo, checkArquivo];

/**
 * Confere se os fatos externos afirmados no texto têm origem neste turno.
 * Puro: não faz I/O, não depende de relógio, não olha histórico.
 */
export function checkGrounding(text, {
  toolOutputs = [],
  ownerText = '',
  toolCounts = {},
  allowHosts = [],
  allowTokens = [],
  hadAttachment = false,
  creditDelivered = false,
} = {}) {
  const value = String(text || '');
  if (!value.trim()) return { findings: [] };
  // O que o dono escreveu é origem legítima: repetir o link/código que ELE
  // mandou não é invenção nossa.
  const bruto = [...toolOutputs.map(o => (typeof o === 'string' ? o : safeJson(o))), String(ownerText || '')].join(' \n ');
  const ctx = {
    pool: ` ${flatten(bruto)} `,
    poolDigits: ` ${String(bruto).replace(/\D+/g, ' ')} `,
    allowHosts: [...marca().hostsCitaveis, ...allowHosts.map(h => String(h).toLowerCase())],
    allowTokens: allowTokens.map(t => String(t).toUpperCase()),
    // O saldo/plano é dado NOSSO: quando a plataforma já entrega o número real
    // no contexto do turno, não há o que inventar e exigir a tool seria acusar
    // o assistente por usar a informação certa.
    creditToolRan: creditDelivered || Object.keys(toolCounts).some(n => CREDIT_TOOLS.has(n)),
    readToolRan: Object.keys(toolCounts).some(n => READ_TOOLS.has(n)),
    hadAttachment: !!hadAttachment,
  };
  const findings = [];
  for (const check of CHECKERS) {
    try { findings.push(...check(value, ctx)); } catch { /* verificador nunca derruba o turno */ }
  }
  return { findings };
}

function safeJson(v) {
  try { return JSON.stringify(v); } catch { return ''; }
}

const ORIENTACAO = {
  link_nao_consultado: 'o endereço não apareceu em nenhuma consulta deste turno',
  cupom_nao_consultado: 'o código não apareceu em nenhuma consulta deste turno',
  fonte_nao_lida: 'essa fonte não foi lida neste turno',
  preco_sem_consulta: 'esse valor não veio de nenhuma consulta deste turno',
  saldo_sem_consulta: 'o saldo/plano não foi consultado neste turno',
  arquivo_nao_lido: 'o conteúdo do arquivo não foi lido neste turno',
};

const FERRAMENTA = {
  link_nao_consultado: 'buscar_web ou a leitura de página',
  cupom_nao_consultado: 'buscar_web',
  fonte_nao_lida: 'buscar_web ou a leitura da página da fonte',
  preco_sem_consulta: 'buscar_web',
  saldo_sem_consulta: 'consultar_creditos',
  arquivo_nao_lido: 'a leitura do arquivo',
};

/**
 * Instrução do repasse: manda o modelo refazer a resposta CHAMANDO a ferramenta
 * que faltou. É a opção (a) escolhida pelo Marcos em 18/09: resolver pro
 * usuário, em vez de só apagar o trecho e deixá-lo sem resposta.
 */
export function groundingRetryPrompt(findings, language = 'pt-BR') {
  const itens = [...new Map(findings.map(f => [f.kind, f])).values()]
    .map(f => `- ${ORIENTACAO[f.kind] || 'sem origem verificada'}${f.dado ? ` (${trecho(f.dado)})` : ''}; use ${FERRAMENTA[f.kind] || 'a ferramenta adequada'}`)
    .join('\n');
  const head = {
    en: 'Your previous reply stated facts with no source in this turn:',
    es: 'Tu respuesta anterior afirmó datos sin origen en este turno:',
  }[tagIdioma(language)] || 'Sua resposta anterior afirmou dados sem nenhuma origem neste turno:';
  const tail = {
    en: 'Call the tool now and rewrite the reply using only what the tool returns. If the tool returns nothing, say plainly that you could not check, and do not invent a substitute.',
    es: 'Llama la herramienta ahora y reescribe la respuesta usando solo lo que devuelva. Si no devuelve nada, di claramente que no pudiste comprobarlo y no inventes un sustituto.',
  }[tagIdioma(language)] || 'Chame a ferramenta agora e reescreva a resposta usando somente o que ela devolver. Se a ferramenta não devolver nada, diga com todas as letras que não conseguiu verificar e não invente um substituto.';
  return `${head}\n${itens}\n\n${tail}`;
}

const AVISO = {
  'pt-BR': 'Não consegui verificar parte do que ia responder aqui, então preferi não afirmar. Se quiser, eu busco de novo.',
  en: 'I could not verify part of what I was about to state here, so I preferred not to assert it. I can look it up again if you want.',
  es: 'No pude verificar parte de lo que iba a afirmar aquí, así que preferí no afirmarlo. Si quieres, lo busco de nuevo.',
};

/**
 * Rede de baixo: quando nem o repasse produziu origem, a afirmação sem base não
 * é entregue como fato. Remove as LINHAS não fundamentadas e avisa uma vez.
 * Nunca deixa a resposta virar silêncio.
 */
export function applyGroundingFallback(text, findings, language = 'pt-BR') {
  const value = String(text || '');
  if (!findings.length) return value;
  const alvos = new Set(findings.map(f => f.trecho).filter(Boolean));
  const kept = value.split('\n').filter(line => {
    const norm = trecho(line);
    if (!norm) return true;
    return ![...alvos].some(a => norm.includes(a) || a.includes(norm));
  }).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  const aviso = AVISO[tagIdioma(language)] || AVISO['pt-BR'];
  return [kept, aviso].filter(Boolean).join('\n\n');
}
