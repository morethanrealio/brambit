const EMAIL_SEARCH_TOOLS = new Set(['gmail_search', 'hotmail_search']);
const positive = value => Number.isSafeInteger(value) && value > 0;
const REASONS = {
  page_limit: 'o limite de páginas desta execução foi atingido',
  message_limit: 'o limite de mensagens desta execução foi atingido',
  cursor_repeated: 'a continuação se repetiu',
  cursor_missing: 'o provedor indicou mais páginas sem uma continuação utilizável',
  page_failed: 'não foi possível obter uma página posterior',
  invalid_page: 'uma página posterior trouxe uma resposta inválida',
  different_chain: 'uma página posterior não correspondeu à consulta ou à conta original',
  provider_incomplete: 'o provedor informou cobertura incompleta',
};

function readPage(raw, query, chain) {
  let page;
  try { page = JSON.parse(raw); } catch { throw Error('invalid_page'); }
  if (!page || typeof page !== 'object' || Array.isArray(page) || page.error || page.erro
      || typeof page.search_id !== 'string' || !page.search_id || typeof page.query !== 'string'
      || typeof page.has_more !== 'boolean' || !Array.isArray(page.messages)
      || page.messages.some(m => !m || typeof m !== 'object' || Array.isArray(m) || typeof m.id !== 'string' || !m.id)
      || (page.page !== undefined && !positive(page.page))
      || ['partial', 'truncated', 'incomplete_search'].some(key => page[key] !== undefined && typeof page[key] !== 'boolean')
      || (!page.has_more && page.next_cursor != null)
      || (page.next_cursor != null && (typeof page.next_cursor !== 'string' || !page.next_cursor || page.next_cursor.length > 16384))) {
    throw Error('invalid_page');
  }
  const accounts = [page.account, ...page.messages.map(m => m.account)].filter(a => a != null && a !== '');
  if (accounts.some(a => typeof a !== 'string') || new Set(accounts).size > 1) throw Error('different_chain');
  const account = accounts[0];
  if (page.query !== query || (chain && (page.search_id !== chain.search_id
      || (chain.account && account && chain.account !== account)
      || (chain.page !== undefined && page.page !== chain.page + 1)))) throw Error('different_chain');
  return { page, account };
}

// Limits belong to the code, not to arguments produced by the model.
// The same authenticated instance runs every page; no token/account or
// continuation URL is chosen here. Only cursors received are followed.
export function withEmailSearchCompletion(readTools, { maxPages = 10, maxMessages = 200 } = {}) {
  if (!positive(maxPages) || !positive(maxMessages)) throw Error('Limites de conclusão de busca inválidos.');
  return readTools.map(tool => !EMAIL_SEARCH_TOOLS.has(tool.name) ? tool : {
    ...tool,
    parameters: {
      ...tool.parameters,
      properties: {
        ...tool.parameters?.properties,
        complete: { type: 'boolean', description: 'true to go through the pages of this bounded query, within the platform\'s limits. Use to list all relevant results. Does not broaden the filters nor search other accounts.' },
      },
    },
    async run(args = {}) {
      if (args.complete === undefined) return tool.run(args);
      if (typeof args.complete !== 'boolean') throw Error('complete deve ser booleano.');
      const { complete, ...originalArgs } = args;
      if (!complete) return tool.run(originalArgs);

      const query = tool.name === 'gmail_search' ? originalArgs.query : (originalArgs.q ?? '');
      // The first failure is still a tool failure, never an empty list.
      const firstRaw = await tool.run(originalArgs);
      let first;
      try { first = readPage(firstRaw, query); }
      catch { throw Error('Resposta inicial de busca inválida; não conclua ausência nem consulta completa.'); }
      let current = first.page, account = first.account, pages = 0, reason = '';
      let providerIncomplete = false, discardedMessages = false;
      const messages = new Map(), usedCursors = new Set(originalArgs.cursor ? [originalArgs.cursor] : []);

      for (;;) {
        pages++;
        providerIncomplete ||= current.truncated === true || current.incomplete_search === true
          || (current.partial === true && !current.has_more);
        for (const message of current.messages) {
          if (messages.has(message.id)) continue;
          if (messages.size >= maxMessages) { discardedMessages = true; continue; }
          messages.set(message.id, message);
        }
        if (discardedMessages) { reason = 'message_limit'; break; }
        if (!current.has_more) break;
        if (messages.size >= maxMessages) { reason = 'message_limit'; break; }
        if (pages >= maxPages) { reason = 'page_limit'; break; }
        if (!current.next_cursor) { reason = 'cursor_missing'; break; }
        if (usedCursors.has(current.next_cursor)) { reason = 'cursor_repeated'; break; }

        const cursor = current.next_cursor;
        usedCursors.add(cursor);
        let raw;
        try { raw = await tool.run({ ...originalArgs, cursor }); }
        catch { reason = 'page_failed'; break; }
        let next;
        try { next = readPage(raw, query, { search_id: first.page.search_id, account, page: current.page }); }
        catch (error) { reason = error.message === 'different_chain' ? 'different_chain' : 'invalid_page'; break; }
        current = next.page;
        account ||= next.account;
      }

      reason ||= providerIncomplete ? 'provider_incomplete' : '';
      const incomplete = !!reason;
      return JSON.stringify({
        ...current,
        messages: [...messages.values()], returned: messages.size,
        search_id: first.page.search_id, query, ...(account ? { account } : {}),
        pages_completed: pages, start_page: first.page.page ?? 1,
        has_more: current.has_more,
        next_cursor: reason === 'cursor_repeated' ? null : (current.next_cursor ?? null),
        partial: incomplete || current.has_more,
        truncated: incomplete,
        incomplete_search: incomplete,
        ...(reason ? { completion_reason: reason } : {}),
        note: incomplete
          ? `BUSCA PARCIAL: ${REASONS[reason]}. Os resultados já obtidos foram preservados. Não conclua ausência nem total completo; refine a consulta ou conclua a continuação quando disponível.`
          : 'Paginação desta consulta concluída. messages reúne as páginas desta execução, sem repetir IDs; não representa toda a caixa nem repete páginas de uma execução anterior.',
      });
    },
  });
}
