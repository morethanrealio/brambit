import test from 'node:test';
import assert from 'node:assert/strict';
import { withEmailSearchCompletion } from '../web/email-search-completion.mjs';
import { emailPagination, trackEmailPagination } from '../web/email-pagination.mjs';

// Only in-memory functions; no providers, credentials, database, or network.
const page = (ids, number = 1, next = null, extra = {}) => JSON.stringify({
  search_id: 'search-1', query: 'fatura setembro', page: number, page_size: 2,
  messages: ids.map(id => ({ id, account: 'work@example.invalid', subject: `Fatura ${id}` })),
  has_more: !!next, next_cursor: next, returned: ids.length, ...extra,
});
function fixture(responses, config, name = 'gmail_search') {
  const calls = [];
  const tool = { name, parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    async run(args) { calls.push(args); assert.ok(responses.length, 'no unexpected call'); const response = responses.shift(); if (response instanceof Error) throw response; return response; } };
  return { calls, original: tool, wrapped: withEmailSearchCompletion([tool], config)[0] };
}

for (const name of ['gmail_search', 'hotmail_search']) test(`${name}: three pages, deduplicated IDs, and the same filters/account`, async () => {
  const f = fixture([page(['1', '2'], 1, 'cursor-2'), page(['2', '3'], 2, 'cursor-3'), page(['4'], 3)], undefined, name);
  const args = { [name === 'gmail_search' ? 'query' : 'q']: 'fatura setembro', max: 2, complete: true };
  const result = JSON.parse(await f.wrapped.run(args));
  assert.deepEqual(result.messages.map(m => m.id), ['1', '2', '3', '4']);
  assert.equal(result.returned, 4); assert.equal(result.pages_completed, 3);
  assert.equal(result.has_more, false); assert.equal(result.partial, false); assert.equal(result.incomplete_search, false);
  assert.equal(result.account, 'work@example.invalid');
  assert.deepEqual(f.calls.map(c => c.cursor), [undefined, 'cursor-2', 'cursor-3']);
  for (const call of f.calls) { assert.equal(call.complete, undefined); assert.equal(call.max, 2); assert.equal(call[name === 'gmail_search' ? 'query' : 'q'], 'fatura setembro'); }
  assert.equal(args.complete, true); assert.equal(args.cursor, undefined);
  assert.deepEqual(f.wrapped.parameters.required, ['query']); assert.equal(f.original.parameters.properties.complete, undefined);
  assert.equal(f.wrapped.parameters.properties.complete.type, 'boolean');
});

test('legacy mode does not paginate or alter the result; unrelated tools are preserved', async () => {
  const raw = page(['1'], 1, 'cursor-2');
  for (const complete of [undefined, false]) {
    const f = fixture([raw]); const args = { query: 'fatura setembro', ...(complete === undefined ? {} : { complete }) };
    assert.equal(await f.wrapped.run(args), raw); assert.equal(f.calls.length, 1);
    assert.deepEqual(f.calls[0], { query: 'fatura setembro' });
    if (complete === undefined) assert.equal(f.calls[0], args);
  }
  const other = { name: 'drive_search', run: async () => 'original' };
  assert.equal(withEmailSearchCompletion([other])[0], other);
});

test('a late error preserves messages and cursor; sensitive error body does not leak', async () => {
  const f = fixture([page(['1'], 1, 'cursor-2'), new Error('401 TOKEN-SECRET customer@example.invalid')]);
  const raw = await f.wrapped.run({ query: 'fatura setembro', complete: true }), result = JSON.parse(raw);
  assert.deepEqual(result.messages.map(m => m.id), ['1']); assert.equal(result.completion_reason, 'page_failed');
  assert.equal(result.has_more, true); assert.equal(result.next_cursor, 'cursor-2');
  assert.equal(result.incomplete_search, true); assert.equal(result.partial, true); assert.equal(result.truncated, true);
  assert.ok(!raw.includes('TOKEN-SECRET')); assert.ok(!raw.includes('customer@example.invalid'));
});

test('initial failure propagates; a malformed initial response does not become empty', async () => {
  const error = new Error('initial');
  await assert.rejects(() => fixture([error]).wrapped.run({ query: 'fatura setembro', complete: true }), e => e === error);
  for (const bad of ['garbage', '{}', 'null', page([], 1, null, { messages: [{}] }), page([], 1, null, { has_more: 'false' }), page([], 1, 'bad', { has_more: false })]) {
    await assert.rejects(() => fixture([bad]).wrapped.run({ query: 'fatura setembro', complete: true }), /inicial.*inválida/);
  }
});

test('a repeated cursor stops the search without losing the valid pages', async () => {
  const f = fixture([page(['1'], 1, 'cycle'), page(['2'], 2, 'cycle')]);
  const result = JSON.parse(await f.wrapped.run({ query: 'fatura setembro', complete: true }));
  assert.equal(f.calls.length, 2); assert.deepEqual(result.messages.map(m => m.id), ['1', '2']);
  assert.equal(result.completion_reason, 'cursor_repeated'); assert.equal(result.has_more, true);
  assert.equal(result.next_cursor, null); assert.equal(result.truncated, true);
});

test('continuation without a cursor and a malformed later body preserve partial state', async () => {
  for (const [second, expected] of [
    [page(['2'], 2, null, { has_more: true }), 'cursor_missing'],
    ['malformed SECRET-BODY', 'invalid_page'],
    [page([], 2, null, { error: 'SECRET-BODY' }), 'invalid_page'],
  ]) {
    const result = JSON.parse(await fixture([page(['1'], 1, 'next'), second]).wrapped.run({ query: 'fatura setembro', complete: true }));
    assert.equal(result.completion_reason, expected); assert.equal(result.has_more, true); assert.equal(result.truncated, true);
    assert.equal(result.messages[0].id, '1'); assert.ok(!JSON.stringify(result).includes('SECRET-BODY'));
  }
});

test('a chain that diverges by identity, filter, account or page is discarded entirely', async () => {
  for (const extra of [
    { search_id: 'another-search' }, { query: 'outro filtro' }, { account: 'personal@example.invalid' },
    { messages: [{ id: 'other', account: 'personal@example.invalid' }] }, { page: 1 },
  ]) {
    const f = fixture([page(['1'], 1, 'next'), page(['foreign'], 2, null, extra)]);
    const result = JSON.parse(await f.wrapped.run({ query: 'fatura setembro', complete: true }));
    assert.equal(result.completion_reason, 'different_chain'); assert.deepEqual(result.messages.map(m => m.id), ['1']);
    assert.equal(result.query, 'fatura setembro'); assert.equal(result.search_id, 'search-1'); assert.equal(result.has_more, true);
    assert.equal(result.account, 'work@example.invalid');
  }
});

test("code limits win over the model's arguments and do not hide pages or messages", async () => {
  const f = fixture([page(['1'], 1, 'next')], { maxPages: 1 });
  const result = JSON.parse(await f.wrapped.run({ query: 'fatura setembro', complete: true, maxPages: 10000, maxMessages: 10000 }));
  assert.equal(f.calls.length, 1); assert.equal(result.completion_reason, 'page_limit'); assert.equal(result.has_more, true);
  const capped = JSON.parse(await fixture([page(['1', '2', '3'])], { maxMessages: 2 }).wrapped.run({ query: 'fatura setembro', complete: true }));
  assert.deepEqual(capped.messages.map(m => m.id), ['1', '2']); assert.equal(capped.completion_reason, 'message_limit');
  assert.equal(capped.has_more, false); assert.equal(capped.truncated, true); assert.equal(capped.partial, true);
  const exact = JSON.parse(await fixture([page(['1', '2'])], { maxMessages: 2 }).wrapped.run({ query: 'fatura setembro', complete: true }));
  assert.equal(exact.partial, false);
});

test('provider limitation is not erased by the last page', async () => {
  const f = fixture([page(['1'], 1, 'next', { incomplete_search: true }), page(['2'], 2)]);
  const result = JSON.parse(await f.wrapped.run({ query: 'fatura setembro', complete: true }));
  assert.equal(result.completion_reason, 'provider_incomplete'); assert.equal(result.has_more, false); assert.equal(result.truncated, true);
  assert.deepEqual(result.messages.map(m => m.id), ['1', '2']);
});

test('Outlook with no explicit account and an empty first page preserve continuation', async () => {
  const f = fixture([
    page([], 1, 'next', { query: '' }),
    page([], 2, null, { query: '', messages: [{ id: 'outlook-1' }] }),
  ], undefined, 'hotmail_search');
  const result = JSON.parse(await f.wrapped.run({ complete: true }));
  assert.equal(result.messages[0].id, 'outlook-1'); assert.equal(result.has_more, false); assert.equal(result.partial, false);
  assert.deepEqual(f.calls, [{}, { cursor: 'next' }]);
});

test('invalid config and a non-boolean complete fail before calling any tools', async () => {
  for (const value of [0, -1, 1.5, '3', Infinity, NaN]) {
    assert.throws(() => withEmailSearchCompletion([], { maxPages: value }));
    assert.throws(() => withEmailSearchCompletion([], { maxMessages: value }));
  }
  const f = fixture([]);
  await assert.rejects(() => f.wrapped.run({ query: 'fatura setembro', complete: 'true' }), /booleano/);
  assert.equal(f.calls.length, 0);
});

test('real pager and tracker observe full aggregation and partial failure', async () => {
  for (const failLater of [false, true]) {
    const pager = emailPagination({ defaultMax: 1, cap: 1 }); let calls = 0;
    const tracked = trackEmailPagination(withEmailSearchCompletion([{
      name: 'gmail_search',
      async run(args) {
        calls++; const request = pager.request(args.query, args.max, args.cursor);
        if (request.page === 2 && failLater) throw Error('PRIVATE_PROVIDER_RESPONSE');
        return pager.result(request, [{ id: `mail-${request.page}`, account: 'work@example.invalid' }], request.page < 3 ? `native-${request.page + 1}` : null);
      },
    }]));
    const result = JSON.parse(await tracked.tools[0].run({ query: 'fatura setembro', complete: true }));
    assert.equal(calls, failLater ? 2 : 3);
    assert.equal(tracked.hasPartial(), failLater);
    assert.equal(tracked.coverage()[0].status, failLater ? 'partial' : 'complete');
    assert.equal(tracked.coverage()[0].reason, failLater ? 'search_incomplete' : '');
    assert.equal(tracked.coverage()[0].returned, failLater ? 1 : 3);
    assert.equal(tracked.evidence().length, failLater ? 1 : 3);
    assert.equal(result.has_more, failLater);
  }
});
