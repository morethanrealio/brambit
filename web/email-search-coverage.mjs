// Factual coverage of the queries, independent of the model synthesis.
export const EMAIL_COVERAGE_RULE = 'When answering about emails, distinguish: a query that finished with no result = "I did not find it in that search"; an incomplete/failed query = "I could not finish", never "it does not exist", "it did not arrive" or "there is nothing". Finishing the pagination does not prove the whole mailbox was scanned. Accounts, filters, counts and technical states are for steering the research internally; do not publish a coverage report or repeat filters in the answer. Give the requested result with its sources. Mention the account when needed to tell findings apart and briefly explain any concrete limitation that affects the answer. An account that was not queried does not allow ruling out that the email is in it. A partial search notice does not authorize absolute statements in the body of the answer.';

export function emailQueryCoverage() {
  const rows = new Map();
  return {
    observe(tool, args, result, account = '', failed = false) {
      const query = String(args?.query ?? args?.q ?? result?.query ?? '');
      const attachment = tool.endsWith('_read_attachment');
      const read = tool.endsWith('_read') || attachment;
      const key = JSON.stringify([account,tool,read ? args?.id : result?.search_id || query,...(attachment ? [args?.attachmentId] : [])]);
      const old = rows.get(key);
      const bad = failed || !result || result.error || result.erro || (!read && typeof result.has_more !== 'boolean')
        || (attachment && (typeof result.text !== 'string' || !result.text.trim()));
      const incomplete = !read && (result?.incomplete_search === true || !!result?.completion_reason || result?.truncated === true || result?.partial === true);
      const partial = !bad && (result.has_more === true || result.truncated === true || result.partial === true || incomplete);
      const ids = new Set([...(old?.ids || []), ...(read ? [] : (result?.messages || []).map(m=>m.id))]);
      rows.set(key, { account, tool, query:read ? '' : query, id:read ? args?.id : undefined,
        ...(attachment ? {attachmentId:args?.attachmentId} : {}),
        status:bad ? 'failed' : partial ? 'partial' : 'complete',
        reason:bad ? (attachment ? 'attachment_failed' : 'query_failed') : incomplete ? 'search_incomplete'
          : result.truncated === true || result.partial === true ? (attachment ? 'attachment_truncated' : 'body_truncated') : result.has_more ? 'more_pages' : '',
        returned:read || bad ? undefined : ids.size, ids:[...ids],
      });
    },
    rows() { return [...rows.values()].map(({ids,...row})=>row); },
    promptBlock() {
      if (!rows.size) return '';
      return '\n\nCOBERTURA REAL DAS CONSULTAS (complete refere-se só aos filtros desta consulta):\n'
        + JSON.stringify(this.rows()) + '\n' + EMAIL_COVERAGE_RULE;
    },
  };
}

// Backstop estreito para as alegações observadas no incidente. Não tenta
// verificar semanticamente fatos positivos nem modificar fontes/citações.
export function guardEmailCoverageClaims(text, { partial = false, active = false, language = 'pt-BR' } = {}) {
  if (!active) return String(text ?? '');
  const lang=String(language).slice(0,2);
  const replacement = lang==='en' ? 'I could not establish that from the emails consulted.'
    : lang==='es' ? 'No pude confirmar eso con los correos consultados.' : 'Não consegui confirmar isso nos e-mails consultados.';
  const exhaustive = /(?:\b(?:caixa|gmail|outlook|inbox|mailbox)\b.{0,55}\b(?:por inteiro|inteir[ao]|inteir[ao]s|complet[ao]|entire|whole)|\b(?:busca|consulta|varredura|search)\b.{0,30}\b(?:exaustiv[ao]|completa|exhaustive)|\b(?:entire|whole|toda a)\s+(?:inbox|mailbox|caixa)\b)/i;
  const absent = /(?:\bn[aã]o (?:h[aá]|existe[m]?|tem|chegou|chegaram)(?=\s|[.,;:!?]|$)|\bnenhum[a]?\b.{0,100}\b(?:chegou|chegaram|existe|existem|recebid[oa]|encontrad[oa])\b|\bn[aã]o apareceu em nenhum|\bno (?:emails?|messages?).{0,60}(?:arrived|exist)|\bthere (?:is|are) no\b|\bno (?:hay|existe|lleg[oó]))/i;
  return String(text ?? '').split('\n').map(line => {
    if (/^\s*(?:>|```)/.test(line)) return line;
    return line.split(/(?<=[.!?])\s+(?=[A-ZÀ-Ú])/).map(sentence => {
      // O assunto/link da fonte pode conter uma negativa legítima; proteja
      // apenas esse trecho, sem liberar afirmações ao lado de qualquer link.
      const prose = sentence.replace(/\[[^\]]*\]\(https?:\/\/[^\s)]+\)/g,'FONTE');
      if (exhaustive.test(prose) || (partial && absent.test(prose))) return replacement;
      return sentence;
    }).filter((v,i,a)=>!i || v!==a[i-1]).join(' ');
  }).join('\n');
}

export function renderEmailCoverage(rows, accounts, language = 'pt-BR') {
  if (!rows.length && !accounts.length) return '';
  const lang=String(language).slice(0,2);
  const labels=lang==='en' ? {title:'Search coverage',complete:'query completed',partial:'incomplete',failed:'failed',not_consulted:'not consulted',needs_reconnect:'needs reconnecting',consulted:'accessed',more_pages:'pages remaining',body_truncated:'body read only in part',query_failed:'query failed',search_incomplete:'search not completed',attachment_truncated:'attachment read only in part',attachment_failed:'attachment could not be read',evidence_limited:'part of the content was excluded from the analysis'}
    : lang==='es' ? {title:'Alcance de la búsqueda',complete:'consulta completada',partial:'incompleta',failed:'falló',not_consulted:'sin consultar',needs_reconnect:'hay que reconectar',consulted:'consultada',more_pages:'quedan páginas',body_truncated:'cuerpo leído parcialmente',query_failed:'falló la consulta',search_incomplete:'búsqueda sin completar',attachment_truncated:'adjunto leído parcialmente',attachment_failed:'no se pudo leer el adjunto',evidence_limited:'parte del contenido quedó fuera del análisis'}
    : {title:'Cobertura da busca',complete:'consulta concluída',partial:'incompleta',failed:'falhou',not_consulted:'não consultada',needs_reconnect:'precisa reconectar',consulted:'acessada',more_pages:'há páginas restantes',body_truncated:'corpo lido parcialmente',query_failed:'falha na consulta',search_incomplete:'busca não concluída',attachment_truncated:'anexo lido parcialmente',attachment_failed:'anexo não pôde ser lido',evidence_limited:'parte do conteúdo ficou fora da análise'};
  const safe=s=>String(s||'').replace(/[\r\n`<>*_\[\]]/g,' ').slice(0,180);
  const filters=q=>safe(q).replace(/\bin:anywhere\b/gi,lang==='en'?'all folders':lang==='es'?'todas las carpetas':'todas as pastas')
    .replace(/\bafter:/gi,lang==='en'?'since ':lang==='es'?'desde ':'desde ')
    .replace(/\bbefore:/gi,lang==='en'?'before ':lang==='es'?'antes de ':'antes de ')
    .replace(/\bfrom:/gi,lang==='en'?'sender ':lang==='es'?'remitente ':'remetente ')
    .replace(/\bto:/gi,lang==='en'?'recipient ':lang==='es'?'destinatario ':'destinatário ');
  const displayRows=rows.filter(r=>r.query || r.status!=='complete').sort((a,b)=>Number(a.status==='complete')-Number(b.status==='complete'));
  const lines=displayRows.slice(0,8).map(r=>
    `- ${safe(r.account) || (r.tool.startsWith('gmail')?'Gmail':'Outlook')}: ${r.query ? `“${filters(r.query)}” — ` : ''}${labels[r.status]}${r.returned!==undefined ? ` (${r.returned} ${lang==='es'?'correos':'e-mails'})` : ''}${r.reason ? `; ${labels[r.reason] || labels.query_failed}` : ''}.`);
  for (const a of accounts) if (a.status!=='consulted') lines.push(`- ${safe(a.account)}: ${labels[a.status] || labels.failed}.`);
  if(displayRows.length>8) lines.push(`- +${displayRows.length-8} ${lang==='en'?'queries':lang==='es'?'consultas':'consultas'}.`);
  if (!lines.length) return '';
  return `${labels.title}:\n${lines.join('\n')}`;
}

const LIMITATIONS = {
  pt: { prefix:'Na conta ', suffix:'A resposta pode estar incompleta.',
    query_failed:'uma consulta falhou', more_pages:'a busca ainda tem páginas de resultados por consultar',
    search_incomplete:'não consegui concluir a busca',
    body_truncated:'parte do conteúdo dos e-mails não pôde ser lida',
    evidence_limited:'parte do conteúdo das mensagens ficou fora da análise',
    attachment_truncated:'um anexo não pôde ser lido por inteiro', attachment_failed:'não consegui ler um anexo',
    not_consulted:'a conta não foi consultada', account_failed:'não consegui concluir o acesso',
    needs_reconnect:'a conexão com o Google expirou e precisa ser refeita em Conexões' },
  en: { prefix:'For the account ', suffix:'The answer may be incomplete.',
    query_failed:'a query failed', more_pages:'the search still has pages of results to check',
    search_incomplete:'I could not complete the search',
    body_truncated:'part of the email content could not be read',
    evidence_limited:'part of the message content was excluded from the analysis',
    attachment_truncated:'an attachment could not be read in full', attachment_failed:'I could not read an attachment',
    not_consulted:'the account was not checked', account_failed:'I could not complete access',
    needs_reconnect:'the Google connection expired and needs to be reconnected in Connections' },
  es: { prefix:'En la cuenta ', suffix:'La respuesta puede estar incompleta.',
    query_failed:'falló una consulta', more_pages:'quedan páginas de resultados por consultar',
    search_incomplete:'no pude completar la búsqueda',
    body_truncated:'no se pudo leer parte del contenido de los correos',
    evidence_limited:'parte del contenido de los mensajes quedó fuera del análisis',
    attachment_truncated:'no se pudo leer un adjunto completo', attachment_failed:'no pude leer un adjunto',
    not_consulted:'no se consultó la cuenta', account_failed:'no pude completar el acceso',
    needs_reconnect:'la conexión con Google caducó y hay que volver a conectarla en Conexiones' },
};
const limitationKeys = ['query_failed','more_pages','search_incomplete','body_truncated','attachment_truncated','attachment_failed','evidence_limited','not_consulted','account_failed','needs_reconnect'];
const safeAccount = s => String(s || '').replace(/[\r\n`<>*_\[\],;]/g,' ').replace(/\s+/g,' ').trim().slice(0,180);

// Só limitações materiais chegam ao usuário. O relatório com filtros acima
// continua disponível para diagnóstico; completar consultas não gera rodapé.
export function renderEmailCoverageLimitations(rows = [], accounts = [], language = 'pt-BR') {
  const labels = LIMITATIONS[String(language).slice(0,2)] || LIMITATIONS.pt;
  const grouped = new Map();
  const add = (account, reason, tool = '') => {
    const name = safeAccount(account) || (tool.startsWith('hotmail') ? 'Outlook' : tool.startsWith('gmail') ? 'Gmail' : 'e-mail');
    if (!grouped.has(name)) grouped.set(name,new Set());
    grouped.get(name).add(reason);
  };
  for (const row of rows) {
    if (row.status === 'complete') continue;
    const reason = row.status === 'failed' ? (row.reason === 'attachment_failed' ? 'attachment_failed' : 'query_failed')
      : ['more_pages','search_incomplete','body_truncated','attachment_truncated','evidence_limited'].includes(row.reason) ? row.reason : 'query_failed';
    add(row.account,reason,row.tool);
  }
  for (const row of accounts) {
    if (row.status === 'consulted') continue;
    add(row.account,['not_consulted','needs_reconnect'].includes(row.status) ? row.status : 'account_failed');
  }
  return [...grouped].map(([account,reasons]) => {
    const clauses = limitationKeys.filter(key=>reasons.has(key)).map(key=>labels[key]);
    return `⚠️ ${labels.prefix}${account}, ${clauses.join('; ')}. ${labels.suffix}`;
  });
}

const escapeRegExp = s => s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
// WhatsApp faz uma segunda síntese sem acesso ao objeto do turno. Reconhece
// apenas frases exatas do formato emitido acima, nunca ressalvas livres do LLM.
export function findEmailCoverageWarnings(text) {
  const found = [];
  for (const labels of Object.values(LIMITATIONS)) {
    const reason = `(?:${limitationKeys.map(key=>escapeRegExp(labels[key])).join('|')})`;
    const pattern = new RegExp(`⚠️ ${escapeRegExp(labels.prefix)}[^\\r\\n,;]{1,180}, ${reason}(?:; ${reason})*\\. ${escapeRegExp(labels.suffix)}`,'g');
    for (const match of String(text ?? '').matchAll(pattern)) found.push(match[0]);
  }
  return [...new Set(found)];
}
