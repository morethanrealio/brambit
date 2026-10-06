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

// Endereço local ou de rede privada não é algo que se "consulta" na internet:
// aparece quando o dono está montando um sistema (callback, porta de teste).
const HOST_LOCAL = /^(?:localhost|127\.|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|\[?::1\]?)/;
const permitido = (host, hosts) => hosts.some(h => host === h || host.endsWith(`.${h}`));
// Último pedaço do caminho que é um identificador (id de e-mail, slug longo):
// se ele está no material do turno, o endereço foi montado a partir de algo lido.
function idDoCaminho(url) {
  const partes = String(url).replace(/^https?:\/\/[^/]+/i, '').split(/[/?#&=]+/).filter(Boolean);
  const ultimo = flatten(partes.at(-1) || '').trim();
  return ultimo.length >= 10 ? ultimo : '';
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
    if (permitido(host, ctx.allowHosts) || HOST_LOCAL.test(host)) continue;
    if (ctx.pool.includes(` ${flatten(host).trim()} `)) continue;
    const id = idDoCaminho(raw);
    if (id && ctx.pool.includes(` ${id} `)) continue;
    out.push({ kind: 'link_nao_consultado', trecho: trecho(raw), dado: host });
  }
  return out;
}

// Código de cupom/promoção. O contexto é de BLOCO, não de linha: o texto
// costuma anunciar "achei estes cupons:" e listar os códigos nas linhas
// seguintes. A janela abre na linha que fala de cupom e segue enquanto as linhas
// forem itens de lista, fechando na primeira linha em branco ou fora da lista.
const NAO_CUPOM = new Set(["CNPJ","CPF","RG","CEP","OAB","PDF","DOC","DOCX","XLSX","CSV","HTML","JSON","URL","LGPD","API","SKU","NFE","IPTU","PIX","IOF","CDB","ICMS"]);
// Fronteira de palavra que entende acento: com \\b do JS, "DESCARTÁVEIS" virava
// o código "DESCART" e "promoções" contava como "promo".
const FALA_DE_CUPOM = /(?<![\p{L}\p{N}])(?:cupom|cupons|cup[oó]n|cupones|coupons?|promocode|promo|c[óo]digos? de desconto|discount codes?)(?![\p{L}\p{N}])/iu;
const CODIGO = /(?<![\p{L}\p{N}])[A-Z][A-Z0-9]{3,19}(?![\p{L}\p{N}])/gu;
// "não achei cupom", "no coupon": a linha nega, não oferece código.
const NEGA_CUPOM = /(?<![\p{L}])(?:n[ãa]o|nenhum|sem|no|not|none|ning[uú]n|sin)(?![\p{L}])[^\n]{0,40}(?:cupo|coupon|c[óo]digo|code)/iu;
function checkCupons(text, ctx) {
  const out = [];
  const vistos = new Set();
  let janela = false;
  for (const line of String(text).split("\n")) {
    const falaDeCupom = FALA_DE_CUPOM.test(line);
    const itemDeLista = /^\s*(?:[-*+•]|\d+[.)])\s+/.test(line);
    if (falaDeCupom) janela = true;
    else if (!itemDeLista || !line.trim()) janela = falaDeCupom;
    if (!janela || NEGA_CUPOM.test(line)) continue;
    // Pedaço de endereço (utm, slug) não é código: o link tem verificador próprio.
    for (const code of line.replace(/https?:\/\/\S+|\S+@\S+/gi, ' ').match(CODIGO) || []) {
      if (vistos.has(code) || NAO_CUPOM.has(code)) continue;
      vistos.add(code);
      if (ctx.allowTokens.includes(code)) continue;
      if (ctx.pool.includes(` ${flatten(code).trim()} `)) continue;
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
// Só vale em turno sem NENHUMA ferramenta: quando houve consulta, a lista de
// fontes da resposta é montada pela plataforma a partir do que as ferramentas
// devolveram (citacoes.mjs), e a prosa do modelo ao redor ("consultados agora",
// "o vídeo está no Facebook") não é nome de fonte. Um achado por linha.
function checkFontes(text, ctx) {
  if (ctx.algumaFerramenta) return [];
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
      break;
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
    // Conta feita em cima de valor consultado (2 pessoas, ida + volta) também
    // tem origem: aceita k × valor ou k × (a + b), k até 6, com folga de R$ 1.
    if (derivado(centavos(raw.replace(/^R\$\s?/i, '')), ctx)) continue;
    out.push({ kind: 'preco_sem_consulta', trecho: trecho(raw), dado: raw.trim() });
  }
  return out;
}

// Valor escrito em reais ("2.530", "998,93") ou vindo de JSON ("998.93") em
// centavos. Ponto seguido de 3 dígitos é milhar; outro ponto é decimal.
function centavos(v) {
  let t = String(v).replace(/[.,]+$/, '');
  if (t.includes(',')) t = t.replace(/\./g, '').replace(',', '.');
  else if (/\.\d{3}(?:\.|$)/.test(t)) t = t.replace(/\./g, '');
  const n = Number(t);
  return Number.isFinite(n) ? Math.round(n * 100) : NaN;
}
const RE_VALOR_POOL = /R\$\s?(\d[\d.,]*)|"(?:price|preco|preço|valor|total|amount|value|price_brl|preco_total|valor_total)"\s*:\s*"?(\d[\d.,]*)/gi;
function valoresDoPool(bruto) {
  const vals = new Set();
  for (const m of String(bruto).matchAll(RE_VALOR_POOL)) {
    const c = centavos(m[1] ?? m[2]);
    if (c > 0) vals.add(c);
    if (vals.size >= 400) break;
  }
  return [...vals];
}
function derivado(alvo, ctx) {
  if (!(alvo > 0)) return false;
  const vals = ctx.valores();
  const perto = (base) => { for (let k = 1; k <= 6; k++) if (Math.abs(k * base - alvo) <= 100) return true; return false; };
  for (let i = 0; i < vals.length; i++) {
    if (perto(vals[i])) return true;
    for (let j = i + 1; j < vals.length; j++) if (perto(vals[i] + vals[j])) return true;
  }
  return false;
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
    valores: (() => { let v; return () => (v ??= valoresDoPool(bruto)); })(),
    algumaFerramenta: Object.keys(toolCounts).length > 0,
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
 * Retry instruction: an INTERNAL REVIEW the person doesn't see. The model
 * rewrites the whole reply, confirming with the tool what it can and removing
 * (or saying naturally that it's unavailable) what it can't. The reader gets
 * only the final reply: no "I checked again", no tool name, no sign that a
 * review happened (06/10).
 */
export function groundingRetryPrompt(findings, language = 'pt-BR') {
  const itens = [...new Map(findings.map(f => [f.kind + f.dado, f])).values()].slice(0, 12)
    .map(f => `- ${ORIENTACAO[f.kind] || 'sem origem verificada'}${f.dado ? ` (${trecho(f.dado)})` : ''}; para confirmar: ${FERRAMENTA[f.kind] || 'a ferramenta adequada'}`)
    .join('\n');
  const head = {
    en: 'Internal review (the person does not see this message). In the reply you were about to send, these items do not appear in anything consulted in this conversation:',
    es: 'Revisión interna (la persona no ve este mensaje). En la respuesta que ibas a entregar, estos datos no aparecen en nada consultado en esta conversación:',
  }[tagIdioma(language)] || 'Revisão interna (a pessoa não vê esta mensagem). Na resposta que você ia entregar, estes dados não aparecem em nada que foi consultado nesta conversa:';
  const tail = {
    en: 'Rewrite the SAME full reply, as the person will read it. For each item: if a tool can confirm it, confirm it and use only what it returns; if not, drop it or say naturally that this information is not available. Do not mention review, lookups, tools, verification or that you redid the reply, and do not invent a substitute.',
    es: 'Reescribe la MISMA respuesta completa, como la persona la va a leer. Para cada dato: si una herramienta puede confirmarlo, confírmalo y usa solo lo que devuelva; si no, quítalo o di con naturalidad que esa información no está disponible. No menciones revisión, consultas, herramientas, verificación ni que rehiciste la respuesta, y no inventes un sustituto.',
  }[tagIdioma(language)] || 'Reescreva a MESMA resposta completa, do jeito que a pessoa vai ler. Para cada item: se uma ferramenta puder confirmar, confirme e use só o que ela devolver; se não puder, tire o dado ou diga com naturalidade que essa informação não está disponível. Não mencione revisão, consulta, ferramenta, verificação nem que refez a resposta, e não invente um substituto.';
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
