import test from 'node:test';
import assert from 'node:assert/strict';
import { buildEmailResearchEvidence } from './web/email-research-evidence.mjs';

const account = 'owner@example.invalid';
const message = (id, overrides = {}) => ({ account, id, subject: 'Seu pedido foi enviado',
  from: 'loja@example.invalid', date: '2026-09-11',
  snippet: 'Entrega prevista para 17 de setembro.',
  body: 'Pedido 123 foi enviado.\nEntrega prevista para 17 de setembro.',
  link: `https://mail.google.com/mail/?authuser=${account}#all/${id}`,
  ...overrides,
});
const extract = (...refs) => ({ achados: [{ fact: 'MODELO inventou algo', entity: 'MODELO entidade', refs }],
  gaps: ['MODELO lacuna'], ambiguities: ['MODELO ambiguidade'] });
const build = (sources, extraction, extra = {}) => buildEmailResearchEvidence({ account, sources, extraction, ...extra });

test('one contaminated citation cannot erase valid findings, source metadata or body fallback', () => {
  const sources = [message('order'), message('other', { body: 'Seu pagamento foi recebido.' })];
  const result = build(sources, extract(
    { id: 'order', field: 'body', quote: 'Pedido 123 foi enviado.' },
    { id: 'order', field: 'body', quote: 'Seu pagamento foi recebido.' },
  ));
  assert.equal(result.extraction.status, 'partial');
  assert.equal(result.trechos_verificados.length, 1);
  assert.equal(result.trechos_verificados[0].id, 'order');
  assert.equal(result.sources.length, 2);
  assert.equal(result.extraction.refs_rejected, 1);
  assert.equal(result.extraction.rejected[0].reason, 'quote_not_in_source');
  assert.equal(result.fallback_sources.find(s => s.id === 'order').fields[0].text, sources[0].body);
  assert.doesNotMatch(JSON.stringify(result), /MODELO/);
  assert.equal(result.extraction.search_absence_established, false);
});

test('all-invalid findings still return observed messages, links and raw evidence', () => {
  const result = build([message('order', { links: [{ label: 'Acompanhar', url: 'https://example.invalid/tracking/123' }] })],
    extract({ id: 'order', field: 'body', quote: 'Pedido 123 foi entregue ontem.' }));
  assert.deepEqual(result.trechos_verificados, []);
  assert.equal(result.extraction.sources_observed, 1);
  assert.equal(result.extraction.refs_rejected, 1);
  assert.equal(result.available_links[0].source, 'order');
  assert.equal(result.fallback_sources[0].fields[0].text, message('order').body);
  assert.equal(result.extraction.search_absence_established, false);
});

test('malformed JSON, malformed shape and empty findings preserve tools and never imply absence', () => {
  for (const [input, status] of [['{bad JSON', 'invalid_json'], [{ achados: 'not an array' }, 'invalid_shape'],
    [{ achados: [] }, 'no_verified_references'], [null, 'invalid_shape']]) {
    const result = build([message('order')], input);
    assert.equal(result.extraction.status, status);
    assert.equal(result.sources[0].id, 'order');
    assert.equal(result.fallback_sources[0].fields[0].text, message('order').body);
    assert.equal(result.extraction.search_absence_established, false);
  }
});

test('normalization accepts diacritics, case and whitespace but emits the exact contiguous source span', () => {
  const body = 'Detalhe: PREVISÃO\n  de entrega: amanhã.\nFim.';
  const result = build([message('order', { body })], extract(
    { id: 'order', field: 'body', quote: 'previsao de entrega: amanha.' },
    { id: 'order', field: 'body', quote: 'previsão amanhã' },
  ));
  assert.equal(result.trechos_verificados[0].quote, 'PREVISÃO\n  de entrega: amanhã.');
  assert.equal(result.extraction.refs_verified, 1);
  assert.equal(result.extraction.refs_rejected, 1);
  // Unicode combining marks and supplementary code points retain their offsets.
  const unicode = build([message('u', { body: '🚚 Entrega: amanha\u0303 com você.' })], extract(
    { id: 'u', field: 'body', quote: '🚚 entrega: amanha' },
  ));
  assert.equal(unicode.trechos_verificados[0].quote, '🚚 Entrega: amanha\u0303');
});

test('attachment evidence stays attached to its own message; body success does not hide an unread extraction', () => {
  const result = build([
    message('a', { attachmentText: 'Fatura A: total R$ 487,90. Vence em 28/09.' }),
    message('b', { attachmentText: 'Fatura B: total R$ 900,00.' }),
  ], extract(
    { id: 'a', field: 'body', quote: 'Pedido 123 foi enviado.' },
    { id: 'b', field: 'attachmentText', quote: 'Fatura A: total R$ 487,90.' },
  ));
  const a = result.fallback_sources.find(s => s.id === 'a');
  assert.deepEqual(a.fields.map(f => f.field), ['body','attachmentText','snippet']);
  assert.match(a.fields.find(f=>f.field==='attachmentText').text, /487,90/);
  assert.equal(a.account, account);
  const b = result.fallback_sources.find(s => s.id === 'b');
  assert.match(b.fields.find(f => f.field === 'attachmentText').text, /900,00/);
  assert.equal(result.extraction.rejected[0].reason, 'quote_not_in_source');
});

test('account isolation rejects foreign, missing-account and explicit foreign references, even with equal ids', () => {
  const result = build([
    message('same'), message('same', { account: 'someone@example.invalid', body: 'FOREIGN SECRET 1', subject: 'FOREIGN SUBJECT' }),
    message('foreign', { account: 'someone@example.invalid', body: 'FOREIGN SECRET 2' }),
    message('missing', { account: undefined, body: 'UNSCOPED SECRET' }),
  ], extract(
    { id: 'same', field: 'body', quote: 'Pedido 123 foi enviado.' },
    { id: 'same', account: 'someone@example.invalid', field: 'body', quote: 'Pedido 123 foi enviado.' },
    { id: 'foreign', field: 'body', quote: 'FOREIGN SECRET 2' },
  ));
  assert.equal(result.sources.length, 1);
  assert.equal(result.trechos_verificados.length, 1);
  assert.equal(result.extraction.ignored_sources, 3);
  assert.equal(result.extraction.refs_rejected, 2);
  assert.doesNotMatch(JSON.stringify(result), /FOREIGN|UNSCOPED|someone@example/);
  assert.throws(() => buildEmailResearchEvidence({ account: '' }), /explicit account/);
});

test('only known own fields validate, and short references cannot pass', () => {
  const source = message('order', { internal: 'Do not use this field.' });
  const result = build([source], extract(
    { id: 'order', field: 'internal', quote: source.internal },
    { id: 'order', field: 'toString', quote: '[object Object]' },
    { id: 'order', field: 'body', quote: '123' }, null,
  ));
  assert.equal(result.extraction.refs_rejected, 4);
  assert.deepEqual(result.trechos_verificados, []);
  assert.equal(result.fallback_sources.length, 1);
});

test('fallback limits and source incompleteness are explicit, including omitted messages and fields', () => {
  const result = build([
    message('a', { body: 'A'.repeat(30), attachmentText: 'C'.repeat(30), truncated: true }),
    message('b', { body: 'B'.repeat(30) }), message('c'),
  ], '{bad JSON', { limits: { maxSources: 2, maxFallbackCharsPerField: 10, maxFallbackTotalChars: 15 } });
  assert.equal(result.extraction.sources_observed, 3);
  assert.equal(result.extraction.sources_omitted, 1);
  assert.equal(result.extraction.fallback_chars_returned, 15);
  assert.equal(result.extraction.fallback_fields_omitted, 3);
  assert.equal(result.extraction.output_truncated, true);
  assert.equal(result.fallback_sources[0].fields[0].text, 'A'.repeat(10));
  assert.equal(result.fallback_sources[0].fields[1].text, 'C'.repeat(5));
  assert.equal(result.fallback_sources[0].fields[0].truncated, true);
  assert.equal(result.sources[0].truncated, true);
  const capped = build([message('a'), message('b')], { achados: [] }, { limits: { maxFallbackSources: 1 } });
  assert.equal(capped.fallback_sources.length, 1);
  assert.equal(capped.extraction.fallback_fields_omitted, 2);
});

test('quote limits cannot silently make a message look fully extracted', () => {
  const result = build([message('a')], extract(
    { id: 'a', field: 'body', quote: 'Pedido 123 foi enviado.' },
    { id: 'a', field: 'body', quote: 'Entrega prevista para 17 de setembro.' },
  ), { limits: { maxVerifiedRefs: 1, maxQuoteChars: 8 } });
  assert.equal(result.extraction.refs_verified, 2);
  assert.equal(result.extraction.refs_omitted, 1);
  assert.equal(result.trechos_verificados[0].quote_truncated, true);
  assert.equal(result.fallback_sources[0].fields[0].text, message('a').body);
  assert.equal(result.extraction.output_truncated, true);
  const omitted = build([message('a')], extract(
    { id: 'a', field: 'body', quote: 'Pedido 123 foi enviado.' },
    { id: 'a', field: 'body', quote: 'Entrega prevista para 17 de setembro.' },
  ), { limits: { maxVerifiedRefs: 1 } });
  assert.equal(omitted.trechos_verificados[0].quote_truncated, false);
  assert.equal(omitted.fallback_sources[0].fields[0].text, message('a').body);
});

test('read messages keep priority over earlier search previews when fallback caps apply', () => {
  const result = build([
    { account, id: 'preview1', snippet: 'Search preview one.' },
    { account, id: 'preview2', snippet: 'Search preview two.' }, message('read'),
  ], { achados: [] }, { limits: { maxFallbackSources: 1 } });
  assert.equal(result.fallback_sources[0].id, 'read');
  assert.equal(result.fallback_sources[0].fields[0].field, 'body');
  assert.equal(result.extraction.fallback_fields_omitted, 2);
});

test('preview fallback remains a preview and duplicate tool observations do not erase a read body', () => {
  const result = build([
    message('read', { truncated: true }), { account, id: 'read', snippet: 'New preview' },
    { account, id: 'listed', subject: 'List only', snippet: 'Only a preview was observed.' },
  ], { achados: [] });
  assert.equal(result.sources.length, 2);
  assert.equal(result.sources[0].truncated, true);
  assert.equal(result.fallback_sources[0].fields[0].field, 'body');
  assert.equal(result.fallback_sources[1].fields[0].field, 'snippet');
  assert.equal(result.sources[1].body_observed, false);
});

test('links are tool-derived, message-scoped, bounded and cannot carry executable URLs', () => {
  const links = [{ url: 'https://example.invalid/same', label: 'Tracking' },
    { url: 'javascript:alert(1)', label: 'Bad' }, { url: 'https://user:pass@example.invalid/', label: 'Bad' },
    { url: 'https://example.invalid/other', label: 'Second' }];
  const result = build([message('a', { links }), message('b', { links })], { achados: [] },
    { limits: { maxLinksPerSource: 1 } });
  assert.deepEqual(result.available_links.map(l => l.source), ['a', 'b']);
  assert.equal(result.sources.every(s => s.links_truncated), true);
  assert.doesNotMatch(JSON.stringify(result), /javascript:|user:pass/);
});

test('attachment and body truncation are independent in verified quotes and raw fallbacks', () => {
  for (const [bodyTruncated, attachmentTruncated] of [[false,true],[true,false]]) {
    const source = message('a', { truncated:bodyTruncated, attachment_truncated:attachmentTruncated,
      attachmentText:'Fatura total: R$ 487,90.' });
    const verified = build([source], extract(
      {id:'a',field:'body',quote:'Pedido 123 foi enviado.'},
      {id:'a',field:'attachmentText',quote:'Fatura total: R$ 487,90.'},
      {id:'a',field:'subject',quote:'Seu pedido foi enviado'},
    ));
    assert.equal(verified.trechos_verificados[0].source_truncated,bodyTruncated);
    assert.equal(verified.trechos_verificados[1].source_truncated,attachmentTruncated);
    assert.equal(verified.trechos_verificados[2].source_truncated,false);
    assert.equal(verified.sources[0].truncated,bodyTruncated);
    assert.equal(verified.sources[0].attachment_truncated,attachmentTruncated);
    const raw = build([source], '{invalid');
    assert.equal(raw.fallback_sources[0].fields.find(f=>f.field==='body').truncated,bodyTruncated);
    assert.equal(raw.fallback_sources[0].fields.find(f=>f.field==='attachmentText').truncated,attachmentTruncated);
  }
});

test('verified excerpts never remove other requested facts or candidates from the same observed field', () => {
  const source=message('all',{
    body:'Fatura 101: R$ 100. Fatura 102: R$ 200.',
    snippet:'Duas faturas foram emitidas.',
  });
  const result=build([source],extract({id:'all',field:'body',quote:'Fatura 101: R$ 100.'}));
  assert.equal(result.extraction.status,'verified');
  assert.equal(result.extraction.output_truncated,false);
  assert.equal(result.fallback_sources[0].fields.find(field=>field.field==='body').text,source.body);
  assert.equal(result.fallback_sources[0].fields.find(field=>field.field==='snippet').text,source.snippet);
  assert.match(JSON.stringify(result),/Fatura 102/);
});

test('structured attachment quotations require identity for multiple files and keep every raw attachment', () => {
  const source=message('two',{attachments:[
    {attachmentId:'alpha',filename:'Alpha.pdf',text:'Valor: R$ 100.',read:true,truncated:false},
    {attachmentId:'beta',filename:'Beta.pdf',text:'Valor: R$ 200.',read:true,truncated:true},
  ],attachment_truncated:true});
  const result=build([source],extract(
    {id:'two',field:'attachmentText',quote:'Valor: R$ 100.'},
    {id:'two',field:'attachmentText',attachmentId:'alpha',quote:'Valor: R$ 100.'},
    {id:'two',field:'attachmentText',attachmentId:'beta',quote:'Valor: R$ 100.'},
    {id:'two',field:'attachmentText',attachmentId:'missing',quote:'Valor: R$ 100.'},
  ));
  assert.equal(result.trechos_verificados.length,1);
  assert.equal(result.trechos_verificados[0].attachmentId,'alpha');
  assert.equal(result.trechos_verificados[0].source_truncated,false);
  assert.deepEqual(result.extraction.rejected.map(ref=>ref.reason),['ambiguous_attachment','quote_not_in_source','unknown_attachment']);
  const fields=result.fallback_sources[0].fields.filter(field=>field.field==='attachmentText');
  assert.deepEqual(fields.map(field=>[field.attachmentId,field.filename,field.text,field.truncated]),[
    ['alpha','Alpha.pdf','Valor: R$ 100.',false],['beta','Beta.pdf','Valor: R$ 200.',true],
  ]);
});

test('recipient and attachment caps explicitly report omitted data', () => {
  const result=build([message('caps',{para:['a@example.invalid','b@example.invalid'],cc:['c@example.invalid','d@example.invalid'],
    attachments:[{attachmentId:'one',text:'First attachment.'},{attachmentId:'two',text:'Second attachment.'}],
  })],{achados:[]},{limits:{maxRecipientsPerField:1,maxAttachmentsPerSource:1}});
  assert.deepEqual(result.sources[0].to,['a@example.invalid']);
  assert.deepEqual(result.sources[0].cc,['c@example.invalid']);
  assert.equal(result.sources[0].recipients_truncated,true);
  assert.equal(result.sources[0].attachments_truncated,true);
  assert.equal(result.extraction.recipients_omitted,2);
  assert.equal(result.extraction.attachments_omitted,1);
  assert.equal(result.extraction.output_truncated,true);
});

test('unlabeled legacy concatenation of multiple attachments is rejected and explicitly incomplete', () => {
  const result=build([message('legacy',{attachmentText:'Valor: R$ 200.\nValor: R$ 100.',
    attachments:[{attachmentId:'alpha',filename:'Alpha.pdf'},{attachmentId:'beta',filename:'Beta.pdf'}],
  })],extract({id:'legacy',field:'attachmentText',quote:'Valor: R$ 200.'}));
  assert.equal(result.extraction.refs_rejected,1);
  assert.equal(result.sources[0].attachment_content_ambiguous,true);
  assert.equal(result.extraction.output_truncated,true);
  assert.equal(result.fallback_sources[0].fields.some(field=>field.field==='attachmentText'),false);
});
