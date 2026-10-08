import { randomUUID, createHash } from 'node:crypto';

export const SEARCH_PAGINATION_RULE = 'In searches of files, Slack messages and GitHub, items contains only one page. has_more indicates continuation; partial also covers limits or an incomplete search by the provider, even without next_cursor. Continue with next_cursor on the SAME tool/query when needed or declare the limitation. Do not go through all pages automatically. reported_total is reported by the provider, not a complete inventory of the account. Preserve partial-search notices when synthesizing.';
export const searchCursorSchema = { type: 'string', description: 'Copy next_cursor to continue the same search in this run. Temporary cursor, exclusive to this tool/account; do not invent one or pass a URL.' };
const invalid = () => { throw new Error('Resposta de busca/paginação inválida; não conclua ausência nem busca completa.'); };
const nat = n => Number.isSafeInteger(n) && n >= 0;

// Same continuation contract as emails, kept separate so as not to change the
// legacy format. Cache local to the authenticated tool, 15 min/100 cursors, no DB/timers.
export function searchPagination({ defaultMax, cap, now = Date.now }) {
  const cursors = new Map();
  const prune = () => { for (const [k,v] of cursors) if (now()-v.at >= 900000) cursors.delete(k); };
  return {
    request(query, max, cursor) {
      if (typeof query !== 'string' || query.length > 2048) throw new Error('Consulta inválida (máximo 2048 caracteres).');
      if (max !== undefined && (!Number.isSafeInteger(max) || max < 1)) throw new Error('max deve ser inteiro positivo.');
      prune();
      if (cursor !== undefined) {
        const prev = typeof cursor === 'string' && cursors.get(cursor);
        if (!prev) throw new Error('Cursor inválido ou expirado. Reinicie a busca; não conclua ausência.');
        if (query !== prev.query || (max !== undefined && Math.min(max,cap) !== prev.pageSize)) throw new Error('Cursor pertence a outra consulta/tamanho de página.');
        return { ...prev, page: prev.page+1 };
      }
      return { query, pageSize: Math.min(max ?? defaultMax,cap), page: 1, searchId: randomUUID(), seen: [], incomplete: false };
    },
    result(req, items, { next = null, incomplete = false, limitReached = false, total } = {}) {
      if (next !== null && (typeof next !== 'string' || !next || next.length > 16384)) invalid();
      const fingerprint = next && createHash('sha256').update(next).digest('hex');
      const cycle = next !== null && (next === req.position || req.seen.includes(fingerprint));
      const localLimit = !!next && req.page >= 200;
      const limited = limitReached || cycle || localLimit;
      const incompleteSearch = req.incomplete || incomplete || limited;
      let cursor = null;
      if (next && !cycle && !localLimit) {
        prune();
        while (cursors.size >= 100) cursors.delete(cursors.keys().next().value);
        cursor = randomUUID();
        cursors.set(cursor, { ...req, position: next, seen: [...req.seen, fingerprint], incomplete: incompleteSearch, at: now() });
      }
      const partial = !!next || incompleteSearch;
      return JSON.stringify({ items, query: req.query, search_id: req.searchId, page: req.page,
        returned: items.length, page_size: req.pageSize, has_more: !!next,
        next_cursor: cursor, partial, incomplete_search: incompleteSearch,
        ...(nat(total) ? { reported_total: total } : {}),
        note: partial
          ? 'BUSCA PARCIAL: ' + (cycle ? 'o provedor repetiu a continuação; interrompa e refine. ' : (limitReached || localLimit) ? 'limite de resultados/páginas atingido; refine. ' : '')
            + (incompleteSearch ? 'A consulta teve cobertura incompleta; terminar a paginação não garante completude. ' : '')
            + (cursor ? 'Há mais páginas; continue com next_cursor se necessário. ' : '')
            + 'Não conclua ausência nem total exaustivo. Preserve este aviso.'
          : 'Última página desta consulta, não inventário de toda a conta. items contém só esta página; não repete anteriores. Resultados dependem dos escopos, filtros e índice do provedor e podem mudar durante a busca.',
      });
    },
  };
}

export function searchItems(value, page, key) {
  if (!Array.isArray(value) || value.length > page.pageSize || value.some(v => !v || typeof v !== 'object' || Array.isArray(v) || !(typeof v[key] === 'string' && v[key] || typeof v[key] === 'number' && Number.isSafeInteger(v[key])))) invalid();
  return value;
}
export function driveSearchMeta(j) {
  if (!j || typeof j !== 'object' || Array.isArray(j) || (j.incompleteSearch !== undefined && typeof j.incompleteSearch !== 'boolean')) invalid();
  return { next: j.nextPageToken ?? null, incomplete: j.incompleteSearch === true };
}
export function githubSearchMeta(j, page) {
  if (!j || !nat(j.total_count) || typeof j.incomplete_results !== 'boolean') invalid();
  const more = page.page * page.pageSize < Math.min(j.total_count,1000);
  return { next: more ? String(page.page+1) : null, total: j.total_count,
    incomplete: j.incomplete_results, limitReached: !more && j.total_count > 1000 };
}
export function slackSearchMeta(j, page) {
  const m = j?.messages, p = m?.paging;
  const raw = p ? { page: p.page, pages: p.pages, total: p.total } : { page: m?.pagination?.page, pages: m?.pagination?.page_count, total: m?.pagination?.total_count };
  if (!nat(raw.page) || raw.page !== page.page || !nat(raw.pages) || !nat(raw.total) || (raw.pages < raw.page && !(raw.pages === 0 && raw.total === 0 && page.page === 1))) invalid();
  // Slack limits page to 100; don't emit an impossible cursor nor call this complete end.
  const remaining = raw.page < raw.pages || raw.total > raw.page * page.pageSize;
  return { next: remaining && raw.page < 100 ? String(raw.page+1) : null, total: raw.total, limitReached: remaining && raw.page >= 100 };
}
export function graphSearchNextPath(link, expectedPath) {
  if (typeof link !== 'string' || !link.startsWith('https://graph.microsoft.com/') || link.length > 16384 || /[\s\\]/.test(link)) invalid();
  const url = new URL(link), expected = new URL('https://graph.microsoft.com/v1.0'+expectedPath);
  if (url.origin !== expected.origin || url.username || url.password || url.hash || url.pathname !== expected.pathname) invalid();
  return url.pathname.slice('/v1.0'.length)+url.search;
}

const SEARCH_TOOLS = new Set(['drive_search','onedrive_search','slack_search','github_search_repos','github_search_issues']);
// Continuation and limitations also reach the main one, even if the worker's
// synthesis omits them. Independent chains don't erase each other's notice.
export function trackSearchPagination(readTools, {account=''} = {}) {
  const rows = new Map(), failures = new Map();
  const requestKey=(tool,args)=>JSON.stringify([tool,args.query??args.q??'',args.terms??null,args.search_in??null,args.file_type??null,args.shared_with_me??null,args.folder_id??null]);
  return {
    tools: readTools.map(tool => !SEARCH_TOOLS.has(tool.name) ? tool : { ...tool, async run(args) {
      try {
        const raw = await tool.run(args);
        let result;
        try { result = JSON.parse(raw); } catch { /* reconnection/error as text is not an empty search */ }
        if (!result?.search_id || typeof result.partial !== 'boolean') failures.set(requestKey(tool.name,args), {tool:tool.name,account,status:'failed',reason:'query_failed'});
        else {
          failures.delete(requestKey(tool.name,args));
          const key=tool.name+':'+result.search_id, previous=rows.get(key);
          // A cached old page must not make a completed chain partial again.
          if(!previous || (result.page??0)>=(previous.page??0)) rows.set(key, {
            tool:tool.name,account,search_id:result.search_id,query:result.query??'',page:result.page,
            status:result.partial?'partial':'complete',returned:result.returned,
            reason:result.partial?(result.completion_reason||(result.incomplete_search?'provider_incomplete':result.has_more?'more_pages':'search_incomplete')):'',
          });
        }
        return raw;
      } catch (e) { failures.set(requestKey(tool.name,args),{tool:tool.name,account,status:'failed',reason:'query_failed'}); throw e; }
    } }),
    coverage() { return [...rows.values(),...failures.values()]; },
    hasPartial() { return this.coverage().some(row=>row.status!=='complete'); },
    finish(text) {
      return this.hasPartial()
        ? text+'\n\nAVISO DE BUSCA PARCIAL (estado interno): '+JSON.stringify(this.coverage().filter(row=>row.status!=='complete'))+'\nNão afirme ausência nem inventário completo. Entregue os achados úteis; explique somente a limitação comprovada que afeta o pedido, em linguagem comum. Páginas restantes não são erro de acesso. Não invente falha de compartilhamento. Não use alerta genérico nem jargão.'
        : text;
    },
  };
}
