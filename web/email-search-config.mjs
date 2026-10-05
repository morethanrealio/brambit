// Rotina tipo "busca_email": a busca estruturada fica gravada em
// routines.config.email_search e é a PLATAFORMA que executa a consulta exata
// no Gmail/Outlook (paginando até o fim) antes de chamar o modelo. O modelo
// recebe a lista pronta e só resume. Espelha o desenho de curadoria
// (curation-config.mjs): schema pra tool + normalização estrita + prepare que
// devolve o novo config ou lança Error em pt-BR pro assistente corrigir.

export const EMAIL_SEARCH_VERSION = 1;
export const EMAIL_SEARCH_MAX_DAYS = 30;
export const EMAIL_SEARCH_DEFAULT_DAYS = 2;
export const EMAIL_SEARCH_PROVIDERS = ['gmail', 'outlook'];
const CHANNELS = ['email', 'whatsapp', 'telegram', 'none', 'app'];
const MAX_LIST = 10;
const MAX_TERM = 80;

export const emailSearchToolSchema = {
  type: 'object',
  description: 'Busca de e-mail estruturada. Só com tipo="busca_email". A plataforma roda a consulta exata e entrega a lista ao assistente; o_que_fazer descreve só o que fazer com os e-mails encontrados.',
  properties: {
    provider: { type: 'string', enum: EMAIL_SEARCH_PROVIDERS, description: 'gmail (padrão) ou outlook.' },
    account: { type: 'string', description: 'E-mail da conta a consultar (só se o usuário tiver mais de uma conectada; senão omita).' },
    terms: { type: 'array', items: { type: 'string' }, description: 'Termos/frases a procurar (qualquer um deles). Ex.: ["quintoandar","quinto andar"]. Vazio = todos os e-mails do período.' },
    senders: { type: 'array', items: { type: 'string' }, description: 'Remetentes (e-mail ou domínio), qualquer um deles. Ex.: ["quintoandar.com.br"].' },
    days: { type: 'integer', minimum: 1, maximum: EMAIL_SEARCH_MAX_DAYS, description: `Janela em dias contando de agora (1-${EMAIL_SEARCH_MAX_DAYS}). Padrão ${EMAIL_SEARCH_DEFAULT_DAYS}. Rotina diária = 1 ou 2.` },
    unreadOnly: { type: 'boolean', description: 'Só não lidos.' },
    withAttachment: { type: 'boolean', description: 'Só com anexo.' },
  },
};

export const emailSearchToolHelp = 'Pedido de acompanhar/buscar/triar E-MAILS (Gmail/Outlook) por assunto, remetente ou período = tipo "busca_email" + busca_email (terms/senders/days). A plataforma executa a consulta exata e pagina até o fim; o assistente só resume. Não use tipo "geral" pra isso.';

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

// Normalização estrita: chave desconhecida ou valor fora do contrato = Error.
// Tudo que sai daqui é seguro pra virar consulta (sem aspas/parênteses soltos).
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

// Prompt de rotina "geral" que na prática é busca de e-mail. Só heurística pra
// empurrar o assistente pro tipo certo; monitor misto (agenda + e-mail) passa.
export function looksLikeEmailSearch(prompt) {
  const p = String(prompt || '').toLowerCase();
  if (!p) return false;
  const mail = /\b(gmail|outlook|hotmail|e-?mails?|caixa de entrada|inbox|mensagens? d[eo] e-?mail)\b/.test(p);
  const act = /\b(busc|busq|procur|verific|consult|chec|cheq|le[ir]|varr|monitor|acompanh|triag|resum|filtr)/.test(p);
  const mixed = /\b(agenda|calend[aá]rio|drive|planilha|reuni[õo]es)\b/.test(p);
  return mail && act && !mixed;
}

// Igual ao prepareCurationChange: devolve o config novo (config inteiro da
// rotina, com email_search substituído), undefined se nada muda, ou lança.
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

// Texto pro assistente/usuário confirmar o que ficou gravado.
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

// Só o que o assistente pode editar (sem version).
export function editableEmailSearch(c) {
  if (!c) return null;
  const { version, ...rest } = c;
  return rest;
}

// Na execução da rotina de busca, o modelo só precisa resumir: tira todas as
// ferramentas de busca/leitura de e-mail e web. Fica memória (contexto do dono).
export function pruneEmailSearchTools(registry) {
  const allowed = new Set(['memoria_ler']);
  for (const name of registry.map.keys()) if (!allowed.has(name)) registry.map.delete(name);
}
