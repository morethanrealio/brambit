import { trackSearchPagination } from './search-pagination.mjs';
import { randomUUID } from 'node:crypto';
import { withEmailSearchCompletion } from './email-search-completion.mjs';
import { createEmailEvidence, emailSource } from './email-evidence.mjs';
import { emailQueryCoverage, guardEmailCoverageClaims } from './email-search-coverage.mjs';

export const EMAIL_PAGINATION_RULE = 'In email searches, messages contains only one page. If has_more=true, use next_cursor on the SAME tool/query to continue when needed, or declare the search partial. Do not claim absence or an exhaustive total from a single page; estimated_total is an estimate. Do not sweep the whole mailbox automatically in a broad search; a closed query (sender/subject/period) must be paginated to the end. When synthesizing, preserve any partial-search notice.';
export const emailCursorSchema = { type: 'string', description: 'Copy next_cursor from the previous result to continue the SAME query in this run. Temporary cursor; do not invent one or use a URL.' };

// Ephemeral state per authenticated tool instance: doesn't share cursors
// across accounts/users. No database. The reading worker has isolated history.
export function emailPagination({ defaultMax, cap, now = Date.now }) {
  const cursors = new Map();
  const ttl = 15 * 60 * 1000;
  function prune() {
    for (const [key, value] of cursors) if (now() - value.at >= ttl) cursors.delete(key);
  }
  return {
    request(query, max, cursor) {
      if (typeof query !== 'string' || query.length > 2048) throw new Error('Consulta de e-mail inválida (máximo 2048 caracteres).');
      if (max !== undefined && (!Number.isSafeInteger(max) || max < 1)) throw new Error('max deve ser um inteiro positivo.');
      prune();
      let previous;
      if (cursor !== undefined) {
        if (typeof cursor !== 'string' || !cursors.has(cursor)) throw new Error('Cursor de e-mail inválido ou expirado. Reinicie a busca sem cursor; não conclua que o e-mail não existe.');
        previous = cursors.get(cursor);
        if (previous.query !== query || (max !== undefined && Math.min(max, cap) !== previous.pageSize)) throw new Error('Cursor pertence a outra consulta ou tamanho de página. Repita os mesmos parâmetros ou reinicie sem cursor.');
      }
      return { searchId: previous?.searchId || randomUUID(), query, pageSize: previous?.pageSize ?? Math.min(max ?? defaultMax, cap), position: previous?.position, page: previous ? previous.page + 1 : 1 };
    },
    result(request, messages, position, estimatedTotal) {
      if (position != null && (typeof position !== 'string' || !position || position.length > 16384)) throw new Error('Paginação inválida na resposta do provedor; não considere a busca completa.');
      const hasMore = !!position;
      let nextCursor = null;
      if (hasMore && position !== request.position) {
        prune();
        while (cursors.size >= 100) cursors.delete(cursors.keys().next().value);
        nextCursor = randomUUID();
        cursors.set(nextCursor, { ...request, position, at: now() });
      }
      return JSON.stringify({
        messages, query: request.query, search_id: request.searchId, page: request.page, returned: messages.length,
        page_size: request.pageSize, has_more: hasMore, next_cursor: nextCursor,
        ...(Number.isSafeInteger(estimatedTotal) && estimatedTotal >= 0 ? { estimated_total: estimatedTotal } : {}),
        note: hasMore
          ? (nextCursor ? 'BUSCA PARCIAL: há mais páginas. Continue com next_cursor e a mesma consulta, ou informe a limitação. Não conclua ausência ou total exaustivo.' : 'BUSCA PARCIAL: o provedor repetiu o cursor. Interrompa a paginação e refine a consulta; não conclua ausência.')
          : 'Última página desta consulta, não de toda a caixa. messages contém apenas esta página; resultados anteriores não são repetidos. Nenhum resultado nesta página não significa ausência em páginas anteriores.',
      });
    },
  };
}

// Only uses a nextLink received from the API and stored in an opaque cursor.
// Extra defense: same origin/listing path, no credentials/fragments/redirect.
export function graphEmailNextPath(link, expectedPath) {
  if (typeof link !== 'string' || !link.startsWith('https://graph.microsoft.com/') || link.length > 16384 || /[\s\\]/.test(link)) throw new Error('Continuação Microsoft inválida.');
  const url = new URL(link);
  if (url.origin !== 'https://graph.microsoft.com' || url.username || url.password || url.hash || url.pathname !== '/v1.0' + expectedPath) throw new Error('Continuação Microsoft fora da listagem de e-mail autorizada.');
  return url.pathname.slice('/v1.0'.length) + url.search;
}

// Raw results stay in the worker; attaches a deterministic notice to the
// synthesis so the main assistant also gets the limitation, even if the
// worker omits it.
export function trackEmailPagination(readTools, { account = '', language = 'pt-BR' } = {}) {
  const coverage = emailQueryCoverage();
  const partial = new Map();
  const evidence = createEmailEvidence();
  const searches = trackSearchPagination(withEmailSearchCompletion(readTools),{account});
  const nonEmailPartial = new Map();
  const analysisLimits = new Map();
  return {
    tools: searches.tools.map(tool => !['gmail_search', 'hotmail_search', 'gmail_read', 'hotmail_read', 'gmail_read_attachment', 'hotmail_read_attachment', 'calendar_list', 'outlook_calendar_list'].includes(tool.name) ? tool : {
      ...tool,
      async run(args) {
        try {
          const raw = await tool.run(args);
          const result = JSON.parse(raw);
          if (['calendar_list','outlook_calendar_list'].includes(tool.name)) {
            nonEmailPartial.set(tool.name + ':' + JSON.stringify(args),result.partial === true || !!result.erro || !!result.error);
            return raw;
          }
          coverage.observe(tool.name, args, result, result?.account || account);
          const attachment = tool.name.endsWith('_read_attachment');
          const read = tool.name.endsWith('_read') || attachment;
          if (read) partial.set(tool.name + ':' + args.id + (attachment ? ':'+args.attachmentId : ''), result.truncated === true || result.partial === true || !!result.error || !!result.erro || (attachment && (typeof result.text !== 'string' || !result.text.trim())));
          else if (typeof result.has_more !== 'boolean') partial.set(tool.name + ':erro', true);
          else partial.set(JSON.stringify([tool.name, result.search_id || result.query]), result.has_more || result.partial === true || result.truncated === true || result.incomplete_search === true);
          if (!attachment) evidence.observe((read ? [result] : result.messages || []).map(m => emailSource(tool.name.startsWith('gmail') ? 'gmail' : 'outlook', m, {read,account})));
          return raw;
        } catch (e) {
          if (['gmail_search','hotmail_search','gmail_read','hotmail_read','gmail_read_attachment','hotmail_read_attachment'].includes(tool.name)) coverage.observe(tool.name,args,null,account,true);
          if (['calendar_list','outlook_calendar_list'].includes(tool.name)) nonEmailPartial.set(tool.name + ':' + JSON.stringify(args), true);
          else partial.set(tool.name + ':erro', true); throw e;
        }
      },
    }),
    coverage() { return coverage.rows(); },
    observeRetainedResults(messages=[]) {
      for(const message of messages)if(message.role==='tool'){
        let row;try{row=JSON.parse(message.content);}catch{continue;}
        if(row?.evidence_limited===true&&row.search_id&&['drive_search','onedrive_search','slack_search','github_search_repos','github_search_issues'].includes(message.name))analysisLimits.set(message.name+':'+row.search_id,{tool:message.name,account,search_id:row.search_id+':analysis',status:'partial',reason:'evidence_limited'});
      }
    },
    nonEmailCoverage() { return [...searches.coverage(),...analysisLimits.values(), ...[...nonEmailPartial].filter(([,partial])=>partial).map(([key])=>({tool:key.split(':')[0],account,status:'partial',reason:'calendar_incomplete'}))]; },
    evidence() { return evidence.rows(); },
    hasNonEmailPartial() { return searches.hasPartial() || analysisLimits.size>0 || [...nonEmailPartial.values()].some(Boolean); },
    hasPartial() { return this.hasNonEmailPartial() || [...partial.values()].some(Boolean); },
    finish(text) {
      text = guardEmailCoverageClaims(text, {partial:this.hasPartial(),active:coverage.rows().length>0,language});
      text = searches.finish(text) + evidence.promptBlock() + coverage.promptBlock();
      return [...partial.values()].some(Boolean)
        ? text + '\n\nAVISO DE BUSCA PARCIAL: ao menos uma consulta de e-mail/agenda ficou incompleta ou falhou (incluindo páginas não percorridas). Não é possível afirmar ausência ou total exaustivo com esses resultados. Preserve os achados úteis e informe somente a limitação concreta que afeta o pedido, sem filtros nem detalhes internos.'
        : text;
    },
  };
}
