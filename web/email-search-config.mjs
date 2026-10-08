// "busca_email" type routine: the structured search is recorded in
// routines.config.email_search and it's the PLATFORM that runs the exact
// query on Gmail/Outlook (paging to the end) before calling the model. The
// model receives the ready-made list and only summarizes. Mirrors the
// curation design (curation-config.mjs): schema for the tool + strict
// normalization + a prepare that returns the new config or throws an Error in
// pt-BR for the assistant to fix.

export const EMAIL_SEARCH_VERSION = 1;
export const EMAIL_SEARCH_MAX_DAYS = 30;
export const EMAIL_SEARCH_DEFAULT_DAYS = 2;
export const EMAIL_SEARCH_PROVIDERS = ['gmail', 'outlook'];
const CHANNELS = ['email', 'whatsapp', 'telegram', 'none', 'app'];
const MAX_LIST = 10;
const MAX_TERM = 80;

export const emailSearchToolSchema = {
  type: 'object',
  description: 'Structured email search. Only with tipo="busca_email". The platform runs the exact query and hands the list to the assistant; o_que_fazer describes only what to do with the emails found.',
  properties: {
    provider: { type: 'string', enum: EMAIL_SEARCH_PROVIDERS, description: 'gmail (default) or outlook.' },
    account: { type: 'string', description: 'Email address of the account to query (only if the user has more than one connected; otherwise omit).' },
    terms: { type: 'array', items: { type: 'string' }, description: 'Terms/phrases to search for (any of them). E.g.: ["quintoandar","quinto andar"]. Empty = all emails in the period.' },
    senders: { type: 'array', items: { type: 'string' }, description: 'Senders (email address or domain), any of them. E.g.: ["quintoandar.com.br"].' },
    days: { type: 'integer', minimum: 1, maximum: EMAIL_SEARCH_MAX_DAYS, description: `Window in days counting from now (1-${EMAIL_SEARCH_MAX_DAYS}). Default ${EMAIL_SEARCH_DEFAULT_DAYS}. Daily routine = 1 or 2.` },
    unreadOnly: { type: 'boolean', description: 'Unread only.' },
    withAttachment: { type: 'boolean', description: 'With attachment only.' },
  },
};

export const emailSearchToolHelp = 'A request to follow/search/triage EMAILS (Gmail/Outlook) by subject, sender or period = tipo "busca_email" + busca_email (terms/senders/days). The platform runs the exact query and paginates to the end; the assistant only summarizes. Do not use tipo "geral" for this.';

const clean = (s) => String(s ?? '').replace(/[\u0000-\u001f"()]/g, ' ').replace(/\s+/g, ' ').trim();

function normList(raw, field, validate) {
  if (raw === undefined || raw === null) return [];
  if (typeof raw === 'string') raw = raw.split(/[,;\n]/);
  if (!Array.isArray(raw)) throw new Error(`busca_email.${field} deve ser uma lista.`);
  const out = [];
  for (const x of raw) {
    const v = clean(x).slice(0, MAX_TERM);
    if (!v) continue;
    if (validate && !validate(v)) throw new Error(`busca_email.${field}: "${v}" inválido.`);
    if (!out.includes(v)) out.push(v);
  }
  if (out.length > MAX_LIST) throw new Error(`busca_email.${field}: no máximo ${MAX_LIST} itens.`);
  return out;
}

const SENDER_RE = /^(?:[\w.+'-]+@)?[\w-]+(?:\.[\w-]+)+$/i;
const EMAIL_RE = /^[\w.+'-]+@[\w-]+(?:\.[\w-]+)+$/i;

// Strict normalization: an unknown key or a value outside the contract = Error.
// Everything that comes out of here is safe to become a query (no loose quotes/parens).
export function normalizeEmailSearchConfig(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('busca_email deve ser um objeto.');
  const known = new Set(['version', 'provider', 'account', 'terms', 'senders', 'days', 'unreadOnly', 'withAttachment']);
  for (const k of Object.keys(raw)) if (!known.has(k)) throw new Error(`busca_email: campo desconhecido "${k}".`);
  if (raw.version !== undefined && raw.version !== EMAIL_SEARCH_VERSION) throw new Error('busca_email: versão não suportada.');
  const provider = raw.provider === undefined || raw.provider === null || raw.provider === '' ? 'gmail' : String(raw.provider).toLowerCase();
  if (!EMAIL_SEARCH_PROVIDERS.includes(provider)) throw new Error('busca_email.provider deve ser "gmail" ou "outlook".');
  let account = null;
  if (raw.account !== undefined && raw.account !== null && raw.account !== '') {
    account = String(raw.account).trim().toLowerCase();
    if (!EMAIL_RE.test(account)) throw new Error('busca_email.account deve ser um e-mail.');
  }
  const terms = normList(raw.terms, 'terms');
  const senders = normList(raw.senders, 'senders', (v) => SENDER_RE.test(v)).map((s) => s.toLowerCase());
  let days = raw.days === undefined || raw.days === null ? EMAIL_SEARCH_DEFAULT_DAYS : Number(raw.days);
  if (!Number.isInteger(days) || days < 1 || days > EMAIL_SEARCH_MAX_DAYS) throw new Error(`busca_email.days deve ser inteiro entre 1 e ${EMAIL_SEARCH_MAX_DAYS}.`);
  const flag = (v, f) => { if (v === undefined || v === null) return false; if (typeof v !== 'boolean') throw new Error(`busca_email.${f} deve ser true/false.`); return v; };
  return {
    version: EMAIL_SEARCH_VERSION, provider, account, terms, senders, days,
    unreadOnly: flag(raw.unreadOnly, 'unreadOnly'), withAttachment: flag(raw.withAttachment, 'withAttachment'),
  };
}

// Prompt of a "general" routine that in practice is an email search. Just a
// heuristic to push the assistant toward the right type; a mixed monitor
// (calendar + email) passes.
export function looksLikeEmailSearch(prompt) {
  const p = String(prompt || '').toLowerCase();
  if (!p) return false;
  const mail = /\b(gmail|outlook|hotmail|e-?mails?|caixa de entrada|inbox|mensagens? d[eo] e-?mail)\b/.test(p);
  const act = /\b(busc|busq|procur|verific|consult|chec|cheq|le[ir]|varr|monitor|acompanh|triag|resum|filtr)/.test(p);
  const mixed = /\b(agenda|calend[aá]rio|drive|planilha|reuni[õo]es)\b/.test(p);
  return mail && act && !mixed;
}

// Same as prepareCurationChange: returns the new config (the routine's entire
// config, with email_search replaced), undefined if nothing changes, or throws.
export function prepareEmailSearchChange(current, { tipo, busca_email, prompt, channel } = {}) {
  const old = current?.config || {};
  const typed = Object.hasOwn(old, 'email_search');
  if (tipo !== undefined && !['geral', 'curadoria', 'busca_email'].includes(tipo)) throw new Error('Tipo de rotina inválido.');
  if (tipo === 'geral' && typed) throw new Error('Esta rotina é uma busca de e-mail. Ajuste termos/remetentes/período em busca_email; não a transforme em rotina geral.');
  if (tipo === 'curadoria' && typed) throw new Error('Esta rotina é uma busca de e-mail; não vira curadoria nesta edição.');
  if (busca_email !== undefined && tipo !== undefined && tipo !== 'busca_email') throw new Error('busca_email só vale com tipo "busca_email".');
  if ((old.curation || old.flight_monitor) && (busca_email !== undefined || tipo === 'busca_email')) throw new Error('Curadoria/monitor de voos não vira busca de e-mail nesta edição.');
  if (busca_email === undefined) {
    if (tipo === 'busca_email') throw new Error('Faltam os parâmetros da busca em busca_email: terms e/ou senders, days (janela em dias) e, se houver mais de uma conta, account.');
    if (!typed && tipo === 'geral' && looksLikeEmailSearch(prompt)) throw new Error('Este pedido é uma busca de e-mail: use tipo "busca_email" e preencha busca_email (terms/senders/days). Assim a plataforma executa a consulta e o assistente só resume.');
    if (typed && !CHANNELS.includes(channel ?? current.channel)) throw new Error('Canal inválido para a busca de e-mail.');
    return undefined;
  }
  if (!CHANNELS.includes(channel ?? current?.channel ?? 'email')) throw new Error('Canal inválido para a busca de e-mail.');
  const c = normalizeEmailSearchConfig({ ...busca_email, version: EMAIL_SEARCH_VERSION });
  return { ...old, email_search: c };
}

// Text for the assistant/user to confirm what was recorded.
export function describeEmailSearch(c) {
  if (!c) return '';
  const quoted = (xs) => xs.map((x) => `"${x}"`).join(' ou ');
  const parts = [];
  parts.push(c.provider === 'outlook' ? 'Busca no Outlook' : 'Busca no Gmail');
  if (c.account) parts[0] += ` (conta ${c.account})`;
  const crit = [];
  if (c.terms.length) crit.push(`termos ${quoted(c.terms)}`);
  if (c.senders.length) crit.push(`remetentes ${quoted(c.senders)}`);
  if (!crit.length) crit.push('todos os e-mails');
  crit.push(`últimos ${c.days} dia${c.days === 1 ? '' : 's'}`);
  if (c.unreadOnly) crit.push('só não lidos');
  if (c.withAttachment) crit.push('só com anexo');
  return `${parts[0]}: ${crit.join('; ')}. A plataforma roda essa consulta exata e pagina até o fim a cada execução; o assistente só resume o que voltou.`;
}

// Only what the assistant can edit (no version).
export function editableEmailSearch(c) {
  if (!c) return null;
  const { version, ...rest } = c;
  return rest;
}

// When the search routine runs, the model only needs to summarize: removes
// every email- and web-search/reading tool. What's left is memory (the owner's context).
export function pruneEmailSearchTools(registry) {
  const allowed = new Set(['memoria_ler']);
  for (const name of registry.map.keys()) if (!allowed.has(name)) registry.map.delete(name);
}
