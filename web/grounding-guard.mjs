import { tagIdioma } from './locale.mjs';
import { marca } from './marca.mjs';

// GROUNDING GUARD
//
// The action receipt (action-evidence.mjs) answers "did the action happen?".
// This module answers another question, one that had no owner: "was the
// stated fact CONSULTED anywhere?".
//
// Origin (2026-09-18, frustration findings from group 1): in five real cases
// the assistant stated a balance/plan, price, coupon, link or source without
// any tool capable of verifying it having run in the turn. There was nothing
// in the code that noticed; the only guard was a prose request in the
// prompt.
//
// The rule here is deliberately dumb and deterministic: if the response
// contains data that can only come from outside (URL, coupon, source name, a
// money value presented as researched, the owner's own balance), that data
// needs to show up in some tool output from THIS turn, or in what the owner
// themself wrote. Not showing up anywhere = the platform has no basis to
// deliver it as fact. It isn't a semantic classifier and doesn't judge
// whether the content is true: it judges whether there's an origin.

// Tools that prove a query of the owner's own balance/plan.
const CREDIT_TOOLS = new Set(['consultar_creditos', 'consultar_gasto', 'status_conta']);
// Tools that prove reading of a file/attachment's content.
const READ_TOOLS = new Set([
  'ler_arquivo', 'ler_documento', 'baixar_corpo', 'analisar_planilha',
  'ler_arquivo_do_app', 'google_drive', 'gmail_get_message',
  // ver_midia OPENS the image and actually looks at it. Since a PDF with no
  // text layer started turning into an image page in the library, that's how
  // this attachment gets read; outside this list, the guard would flag
  // 'file not read' on a response that did consult the attachment for real.
  'ver_midia',
]);

const fold = value => String(value || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
// Origin pool: everything becomes a single text, with no punctuation, so the
// presence test doesn't depend on formatting (JSON, markdown, quotes).
const flatten = value => fold(value).replace(/[^a-z0-9]+/g, ' ');

// The platform's own domains (marca().hostsCitaveis): the assistant can cite
// them from memory because they come from the system prompt, not from a
// search.

function hostOf(url) {
  const m = /^https?:\/\/([^/?#\s]+)/i.exec(String(url || ''));
  if (!m) return '';
  return m[1].toLowerCase().replace(/^www\./, '').replace(/[.,;:)\]}>"']+$/, '');
}

// A local or private-network address isn't something you "look up" on the
// internet: it shows up when the owner is building a system (callback, test
// port).
const HOST_LOCAL = /^(?:localhost|127\.|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|\[?::1\]?)/;
const permitido = (host, hosts) => hosts.some(h => host === h || host.endsWith(`.${h}`));
// The last path segment that's an identifier (e-mail id, long slug): if it's
// in the turn's material, the address was built from something that was
// read.
function idDoCaminho(url) {
  const partes = String(url).replace(/^https?:\/\/[^/]+/i, '').split(/[/?#&=]+/).filter(Boolean);
  const ultimo = flatten(partes.at(-1) || '').trim();
  return ultimo.length >= 10 ? ultimo : '';
}

const trecho = value => String(value || '').replace(/\s+/g, ' ').trim().slice(0, 200);

// ——— verifiers ———————————————————————————————————————————————
// Each one returns zero or more findings. All receive the same context and
// none of them does I/O.

// A link whose domain never showed up in any tool output or in the owner's
// own words. The HTTP link check (fontesEConferencia) catches the dead
// address; this one catches the address that was never looked up, even when
// it happens to respond 200.
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

// Coupon/promo code. The context is at the BLOCK level, not the line level:
// the text usually announces "found these coupons:" and lists the codes on
// the following lines. The window opens at the line that mentions a coupon
// and continues while the lines are list items, closing at the first blank
// line or the first one outside the list.
const NAO_CUPOM = new Set(["CNPJ","CPF","RG","CEP","OAB","PDF","DOC","DOCX","XLSX","CSV","HTML","JSON","URL","LGPD","API","SKU","NFE","IPTU","PIX","IOF","CDB","ICMS"]);
// A word boundary that understands accents: with JS's \\b, "DESCARTÁVEIS"
// turned into the code "DESCART" and "promoções" counted as "promo".
const FALA_DE_CUPOM = /(?<![\p{L}\p{N}])(?:cupom|cupons|cup[oó]n|cupones|coupons?|promocode|promo|c[óo]digos? de desconto|discount codes?)(?![\p{L}\p{N}])/iu;
const CODIGO = /(?<![\p{L}\p{N}])[A-Z][A-Z0-9]{3,19}(?![\p{L}\p{N}])/gu;
// "não achei cupom", "no coupon": the line denies, it doesn't offer a code.
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
    // A piece of an address (utm, slug) isn't a code: the link has its own
    // verifier.
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

// Source signature ("Fonte: X" / "Fontes: X"). It's an explicit claim of
// reading: the name needs to have shown up in some real output from this
// turn. DELIBERATE LIMIT: only the explicit block. Loose attribution in
// prose ("according to the LGPD") can also come from the model's own
// knowledge, and flagging it would trigger a false positive on a legitimate
// response. Widening this needs data, not a guess.
// Only applies to a turn with NO tool at all: when there was a query, the
// response's source list is assembled by the platform from what the tools
// returned (citacoes.mjs), and the model's surrounding prose ("just
// checked", "the video is on Facebook") isn't a source name. One finding per
// line.
function checkFontes(text, ctx) {
  if (ctx.algumaFerramenta) return [];
  const out = [];
  const vistos = new Set();
  for (const line of String(text).split("\n")) {
    // The line almost never comes raw: it arrives as "*Fonte: X*",
    // "**Fonte:** X", "- Fonte: X" or "> Fonte: X". Ignoring the markdown
    // decoration was enough for a made-up signature to slip through (a real
    // routine's case).
    const m = /^[\s>*_#-]*fontes?[\s*_]*:\s*(.+)$/i.exec(line);
    if (!m) continue;
    for (const nome of String(m[1]).split(/[;,|]|\s+e\s+/)) {
      const limpo = nome.replace(/^[-–\s*_]+|[.;,\s*_]+$/g, "").slice(0, 80);
      if (/^https?:/i.test(limpo)) continue; // URL is already handled in checkLinks
      const chave = flatten(limpo).trim();
      // A name that's too short becomes a substring of anything and would
      // flag for nothing.
      if (chave.length < 4 || vistos.has(chave)) continue;
      vistos.add(chave);
      if (ctx.pool.includes(chave)) continue;
      out.push({ kind: "fonte_nao_lida", trecho: trecho(line), dado: limpo });
      break;
    }
  }
  return out;
}

// A money value presented as a search result. The trigger is the CLAIM of
// having searched: the owner's own account, a hypothetical budget and the
// price of their own plan all stay unrestricted.
const PESQUISA_CLAIM = /\b(?:pre[çc]os? reais|valores reais|com base (?:em|nos?) (?:pre[çc]os?|valores|uma? )?(?:reais|pesquisa|levantamento)|fiz (?:um|uma) (?:levantamento|pesquisa|cota[çc][ãa]o)|pesquisei|cotei|consultei os sites?|verifiquei (?:os )?pre[çc]os?)\b/i;
function checkPrecos(text, ctx) {
  const value = String(text);
  if (!PESQUISA_CLAIM.test(value)) return [];
  const out = [];
  const vistos = new Set();
  for (const raw of value.match(/R\$\s?\d[\d.,]*/gi) || []) {
    // Compares only the digits: the value's formatting in the tool output is
    // rarely the same as what the model writes.
    const digits = raw.replace(/\D/g, '').replace(/0+$/, '') || raw.replace(/\D/g, '');
    if (!digits || digits.length < 3 || vistos.has(digits)) continue;
    vistos.add(digits);
    if (ctx.poolDigits.includes(digits)) continue;
    // A calculation made on top of a queried value (2 people, round trip)
    // also has an origin: accepts k × value or k × (a + b), k up to 6, with
    // R$ 1 slack.
    if (derivado(centavos(raw.replace(/^R\$\s?/i, '')), ctx)) continue;
    out.push({ kind: 'preco_sem_consulta', trecho: trecho(raw), dado: raw.trim() });
  }
  return out;
}

// A value written in reais ("2.530", "998,93") or coming from JSON ("998.93")
// in cents. A dot followed by 3 digits is a thousands separator; another dot
// is decimal.
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

// The owner's own balance/plan stated without any credit query in the turn.
const SALDO_CLAIM = /\b(?:seu|teu|sua|tua)\s+(?:saldo|plano|franquia|cr[ée]ditos?)\b|\bvoc[êe]\s+(?:tem|est[áa] no|possui|assinou)\b[^\n.!?]{0,60}\b(?:cr[ée]ditos?|plano|b[áa]sico|pro|ultra|super|free)\b/i;
function checkSaldo(text, ctx) {
  if (ctx.creditToolRan) return [];
  const value = String(text);
  const out = [];
  for (const line of value.split(/\n|(?<=[.!?])\s+/)) {
    if (!SALDO_CLAIM.test(line)) continue;
    if (!/\d/.test(line) && !/\b(?:b[áa]sico|pro|ultra|super|free|gratuito)\b/i.test(line)) continue;
    out.push({ kind: 'saldo_sem_consulta', trecho: trecho(line), dado: '' });
    break; // one finding per turn is enough: the cause and the fix are the same
  }
  return out;
}

// Attachment content described without any reading tool having run.
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
 * Checks whether the external facts stated in the text have an origin in
 * this turn.
 * Pure: no I/O, no clock dependency, no looking at history.
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
  // What the owner wrote is a legitimate origin: repeating the link/code THEY
  // sent isn't our invention.
  const bruto = [...toolOutputs.map(o => (typeof o === 'string' ? o : safeJson(o))), String(ownerText || '')].join(' \n ');
  const ctx = {
    pool: ` ${flatten(bruto)} `,
    poolDigits: ` ${String(bruto).replace(/\D+/g, ' ')} `,
    valores: (() => { let v; return () => (v ??= valoresDoPool(bruto)); })(),
    algumaFerramenta: Object.keys(toolCounts).length > 0,
    allowHosts: [...marca().hostsCitaveis, ...allowHosts.map(h => String(h).toLowerCase())],
    allowTokens: allowTokens.map(t => String(t).toUpperCase()),
    // The balance/plan is OUR data: when the platform already delivers the
    // real number in the turn's context, there's nothing to invent, and
    // requiring the tool would mean flagging the assistant for using the
    // correct information.
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
 * Bottom-level safety net: when not even the hand-off produced an origin, the
 * baseless claim isn't delivered as fact. Removes the ungrounded LINES and
 * warns once. Never lets the response turn into silence.
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
