import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createScheduledDelivery } from '../web/scheduled-delivery.mjs';
import { createDiscoveryReportDelivery } from '../web/discovery-delivery.mjs';
import { generateMessageDraft } from '../web/message-draft.mjs';
import { HEALTH_GUARDRAIL } from '../web/health-guardrail.mjs';

const source = readFileSync('web/server.mjs', 'utf8');
function fixture(overrides = {}) {
  const calls = [];
  const deps = {
    sendEmail: async () => assert.fail('discovery must not switch channel'),
    getTelegramBotForDelivery: async () => ({ token: 'synthetic', chat_id: 'synthetic' }),
    sendTelegramMessage: async (...args) => { calls.push(['telegram', ...args]); return { message_id: 123 }; },
    waEnabled: () => true,
    getWhatsAppLinkForUser: async () => ({ wa_phone: 'synthetic', enabled: true }),
    sendWhatsAppProactive: async (...args) => { calls.push(['whatsapp', ...args]); return { wamid: 'synthetic-wa-id' }; },
    whatsappProse: async () => assert.fail('report must not be rewritten to fit template'),
    persistProactiveToThread: async () => assert.fail('transport must not double-persist'),
    deliverCurationEdition: null, sendCurationChannel: null, curationStore: null,
    ...overrides,
  };
  return { calls, deps, ...createScheduledDelivery(deps) };
}
test('actual server composition exposes the receipt-checked transport used by discovery', async () => {
  const f = fixture();
  const wiring = source.match(/const \{ deliverRoutine, deliverReminder, deliverToChannel \} = createScheduledDelivery\([\s\S]*?\n\}\);/)?.[0];
  assert.ok(wiring, 'the server must bind the transport, not merely export it');
  const scope = { ...f.deps, createScheduledDelivery, waWindowOpen: async () => null, WA_TEMPLATE_MAX: 900, runAgentMessageDraft: null,
    createRoutineConfirmationHandoff: () => null, confirmationStore: null, getOrCreateThreadByTitle: null };
  vm.runInNewContext(wiring + '\nthis.probe = deliverToChannel;', scope);
  for (const channel of ['telegram', 'whatsapp']) {
    const r = await scope.probe({ user_id: 'owner', agent_id: 'agent', title: 'Jornada', channel }, 'Como foi sua manhã?', 'Como foi sua manhã?');
    assert.equal(r.ok, true); assert.ok(r.id);
  }
  assert.equal(f.calls.length, 2);
});
test('full artifact is persisted once by key; notifications contain only a short private-conversation link', async () => {
  for (const channel of ['telegram', 'whatsapp', 'app']) {
    const f = fixture(); const saves = [], pushes = [];
    const send = createDiscoveryReportDelivery({ ...f,
      publish: async (...args) => { saves.push(args); return 'synthetic-thread'; },
      push: async (...args) => { pushes.push(args); return { ok: true, ids: ['synthetic-expo'] }; },
      baseUrl: () => 'https://example.invalid',
    });
    const receipt = await send({ channel, user_id: 'owner', agent_id: 'agent', report_id: 'report-id' }, 'PRIVATE_SYNTHETIC_REPORT'.repeat(150));
    assert.equal(receipt.ok, true); assert.equal(saves.length, 1);
    assert.match(saves[0][2], /^discovery-report:report-id:[a-f0-9]{64}$/);
    const notice = JSON.stringify([...f.calls, ...pushes]);
    assert.doesNotMatch(notice, /PRIVATE_SYNTHETIC_REPORT/);
    if (channel !== 'app') assert.match(notice, /\/inicio\?c=synthetic-thread/);
    if (channel === 'whatsapp') {
      assert.ok(f.calls[0][3].templateText.length < 900);
      assert.equal(f.calls[0][3].retryUnknown, false);
    }
  }
});
test('unconfirmed push, missing receipts, persistence errors and definitive refusals stay distinct', async () => {
  const base = { publish: async () => 'thread', baseUrl: () => 'https://example.invalid',
    push: async () => ({ ok: true, sent: 1 }), deliverToChannel: async () => ({ ok: true }) };
  let r = await createDiscoveryReportDelivery(base)({ channel: 'app', report_id: 'r' }, 'Body');
  assert.equal(r.ok, false); assert.equal(r.definitive, false);
  r = await createDiscoveryReportDelivery({ ...base, push: async () => ({ skipped: true, reason: 'sem_token' }) })({ channel: 'app' }, 'Body');
  assert.equal(r.definitive, true);
  r = await createDiscoveryReportDelivery({ ...base, publish: async () => { throw Error('synthetic'); }, deliverToChannel: async () => assert.fail('no report') })({ channel: 'telegram' }, 'Body');
  assert.equal(r.reason, 'report_not_saved'); assert.equal(r.definitive, true);
  r = await createDiscoveryReportDelivery({ ...base, deliverToChannel: async () => { throw Object.assign(Error('synthetic'), { definitive: true }); } })({ channel: 'whatsapp' }, 'Body');
  assert.equal(r.ok, false); assert.equal(r.definitive, true); assert.equal(r.threadId, 'thread');
});
test('real push function only counts actual Expo acceptance tickets', async () => {
  const fn = source.slice(source.indexOf('async function sendPush('), source.indexOf('\nasync function agentInboxDigest', source.indexOf('async function sendPush(')));
  for (const [response, expected] of [
    [{ ok: true, data: [{ status: 'ok', id: 'ticket-id' }] }, true],
    [{ ok: true, data: [{ status: 'error', details: { error: 'DeviceNotRegistered' } }] }, false],
    [{ ok: false, data: [] }, false],
    [{ ok: true, data: [{ status: 'ok' }] }, false],
  ]) {
    const scope = {
      listPushTokensForUserDb: async () => [{ token: 'ExponentPushToken[synthetic]' }],
      removePushTokensDb: async () => {}, console: { error() {} }, marca: () => ({ nome: 'Synthetic' }),
      fetch: async () => ({ ok: response.ok, json: async () => ({ data: response.data }) }),
    };
    vm.runInNewContext(fn + '\nthis.probe = sendPush;', scope);
    const r = await scope.probe('owner', { body: 'Synthetic notification' });
    assert.equal(r.ok, expected); assert.equal(r.sent, expected ? 1 : 0);
  }
});

test('explicit conversational completion delivers the full report to its chosen channel, with a safe WhatsApp fallback', async () => {
  for (const channel of ['telegram', 'whatsapp', 'app']) {
    const sent = [], published = [];
    const send = createDiscoveryReportDelivery({
      publish: async (...args) => { published.push(args); return 'requested-thread'; },
      deliverToChannel: async (...args) => { sent.push(args); return { ok: true, id: 'receipt' }; },
      push: async () => ({ skipped: true, reason: 'sem_token' }), baseUrl: () => 'https://example.invalid',
    });
    const p = { channel: 'app', delivery_thread_id: 'requested-thread', delivery_channel: channel, report_id: 'r', recovery_count: 1 };
    const r = await send(p, 'Uma solução concreta para sua lista de compras.');
    assert.equal(r.ok, true); assert.equal(published[0][0].delivery_thread_id, 'requested-thread');
    if (channel !== 'app') {
      assert.equal(sent[0][0].channel, channel); assert.match(sent[0][1], /solução concreta/);
      assert.doesNotMatch(sent[0][2], /solução concreta/); // private content never enters a WA template
    }
    if (channel === 'whatsapp') {
      await send(p, 'FULL_PRIVATE_REPORT'.repeat(300));
      assert.doesNotMatch(sent[1][1], /FULL_PRIVATE_REPORT/); assert.match(sent[1][1], /\/inicio\?c=requested-thread/);
      assert.match(published[1][1], /FULL_PRIVATE_REPORT/);
    }
  }
});

test('failure notice never claims the report is ready', async () => {
  const sent = [];
  const send = createDiscoveryReportDelivery({ publish: async () => 'thread', push: async () => assert.fail('Telegram'), baseUrl: () => 'https://example.invalid', deliverToChannel: async (...args) => { sent.push(args); return { ok: true, id: 'receipt' }; } });
  await send({ channel: 'telegram', report_id: 'r', delivery_thread_id: 'thread', delivery_channel: 'telegram', report_state: 'failed' }, 'Não consegui preparar sua devolutiva desta vez.');
  assert.match(sent[0][1], /Não consegui preparar/); assert.doesNotMatch(sent[0][2], /Preparei sua devolutiva/);
});

test('long v2 reports remain complete in the conversation while WhatsApp receives only the private notice', async () => {
  const body = 'Uma entrega específica e útil.\n'.repeat(400), published = [], sent = [];
  const send = createDiscoveryReportDelivery({
    publish: async (_p, text) => { published.push(text); return 'owner-thread'; },
    deliverToChannel: async (_p, text) => { sent.push(text); return { ok: true, id: 'receipt' }; },
    push: async () => assert.fail('WhatsApp only'), baseUrl: () => 'https://example.invalid',
  });
  assert.ok(body.length > 5500 && body.length < 18000);
  const receipt = await send({ channel: 'whatsapp', delivery_channel: 'whatsapp', delivery_thread_id: 'owner-thread', report_id: 'report' }, body);
  assert.equal(receipt.ok, true); assert.equal(published[0], body);
  assert.match(sent[0], /inicio\?c=owner-thread/); assert.doesNotMatch(sent[0], /Uma entrega específica/);
});
test('Telegram receives a private link instead of truncating the final sections above its transport limit', async () => {
  const published = [], sent = [];
  const send = createDiscoveryReportDelivery({ publish: async (_p,body) => { published.push(body); return 'owner-thread'; },
    deliverToChannel: async (_p,body) => { sent.push(body); return { ok: true, id: 'receipt' }; },
    push: async () => assert.fail('Telegram'), baseUrl: () => 'https://example.invalid' });
  for (const size of [12000,12001,17999]) {
    const ending = '\nÚltimo passo útil.', body = 'x'.repeat(size-ending.length)+ending;
    await send({ channel: 'telegram', delivery_channel: 'telegram', delivery_thread_id: 'owner-thread', report_id: 'report' }, body);
    assert.equal(published.at(-1), body);
    if (body.length <= 12000) assert.equal(sent.at(-1), body);
    else { assert.match(sent.at(-1), /inicio\?c=owner-thread/); assert.ok(sent.at(-1).length<1000); }
  }
});

test('actual internal repair wiring measures usage without billing or demanding more customer credits', async () => {
  const fn = source.slice(source.indexOf('async function isolatedAgentDraft('), source.indexOf('\nasync function runAgentMessageDraft('));
  for (const model of ['default', 'official']) {
    const calls = [], usage = [];
    const resultProvider = { complete: async () => ({ text: 'synthetic report', stop: 'end', usage: { model: 'synthetic', in: 10, out: 20 } }) };
    const scope = {
      generateMessageDraft, HEALTH_GUARDRAIL, getCreditStatus: async () => assert.fail('repair is internal'),
      getUserLocale: async () => ({ language: 'pt-BR' }), comIdioma: s => s,
      DEEPSEEK_AGENT_MODEL: 'official', isDeepSeekTurn: () => false, PRIMARY_MAX_OUT: 8192,
      makeOfficialDeepSeek: (_max, identity) => { calls.push(identity); return resultProvider; },
      forcedAgentProvider: () => resultProvider,
      gasto: { vincular: args => { calls.push(args); return resultProvider; } }, randomUUID: () => 'synthetic',
      recordUsages: async (...args) => { usage.push(args); },
    };
    vm.runInNewContext(fn + '\nthis.draft=isolatedAgentDraft;', scope);
    assert.equal(await scope.draft({ id: 'agent', model }, 'owner', 'synthetic', { discoveryDraft: true, repairDraft: true }), 'synthetic report');
    assert.equal(calls[0].noBill, true); assert.equal(usage[0][2].noBill, true);
    assert.equal(usage[0][0][0].in, 10); // physical cost observation is retained
  }
  const callback = source.slice(source.indexOf('const discoveryClosingRunner=')).match(/generate:(async\(p,prompt\)=>\{[^\n]+\}),\n/)?.[1];
  assert.ok(callback);
  const observed = [], scope = { getAgentOwned: async () => ({ id: 'agent' }), isolatedAgentDraft: async (_a, _u, _p, opts) => { observed.push(opts); return 'synthetic'; } };
  vm.runInNewContext('this.generate=' + callback, scope);
  for (const p of [{ generation_attempt: 1, recovery_count: 0 }, { generation_attempt: 2, recovery_count: 0 }, { generation_attempt: 1, recovery_count: 1 }]) await scope.generate(p, 'synthetic');
  assert.deepEqual(observed.map(x => x.repairDraft), [false, true, true]);
});

// ── Delivery with PDF (short text + file on any channel) ────────────────
function pdfFixture(overrides = {}) {
  const published = [], docs = [], mails = [];
  const doc = { buffer: Buffer.from('%PDF-synthetic'), mime: 'application/pdf', filename: 'Jornada de descoberta.pdf',
    attachment: { type: 'document', url: '/api/media?key=synthetic', mime: 'application/pdf', key: 'owner/synthetic.pdf', filename: 'Jornada de descoberta.pdf', name: 'Jornada de descoberta.pdf' } };
  const deps = {
    publish: async (...args) => { published.push(args); return 'owner-thread'; },
    push: async () => ({ ok: true, ids: ['synthetic-expo'] }),
    baseUrl: () => 'https://example.invalid',
    buildDocument: async () => doc,
    sendDocument: async (...args) => { docs.push(args); return { ok: true, id: 'doc-receipt' }; },
    emailDocument: async (...args) => { mails.push(args); return true; },
    ...overrides,
  };
  return { doc, published, docs, mails, deps };
}
const REPORT = 'PRIVATE_SYNTHETIC_REPORT'.repeat(150);
const participant = (channel, extra = {}) => ({ channel, user_id: 'owner', agent_id: 'agent', report_id: 'report-id', body_markdown: '# Sua jornada\n\nSíntese.', ...extra });

test('with a PDF available, every channel receives short text and the file, and the conversation keeps the attachment', async () => {
  for (const channel of ['telegram', 'whatsapp', 'app']) {
    const f = pdfFixture({ deliverToChannel: async () => assert.fail('the text notice only exists when the PDF fails') });
    const receipt = await createDiscoveryReportDelivery(f.deps)(participant(channel), REPORT);
    assert.equal(receipt.ok, true);
    // The conversation receives the short text with the PDF attached, never the raw report.
    assert.equal(f.published.length, 1);
    assert.doesNotMatch(f.published[0][1], /PRIVATE_SYNTHETIC_REPORT/);
    assert.match(f.published[0][1], /PDF em anexo/);
    assert.deepEqual(f.published[0][3], [f.doc.attachment]);
    if (channel === 'app') { assert.equal(f.docs.length, 0); assert.equal(receipt.id, 'expo:synthetic-expo'); continue; }
    assert.equal(f.docs.length, 1);
    assert.equal(f.docs[0][0].channel, channel);
    assert.equal(f.docs[0][1].filename, 'Jornada de descoberta.pdf');
    assert.doesNotMatch(f.docs[0][1].caption, /PRIVATE_SYNTHETIC_REPORT/);
    assert.match(f.docs[0][1].caption, /\/inicio\?c=owner-thread/);
    assert.equal(receipt.id, 'doc-receipt');
  }
});

test('WhatsApp outside the window: PDF by email and notice via utility message', async () => {
  const f = fixture(), p = pdfFixture({ deliverToChannel: f.deliverToChannel, whatsappWindowOpen: async () => false });
  const receipt = await createDiscoveryReportDelivery(p.deps)(participant('whatsapp'), REPORT);
  assert.equal(receipt.ok, true);
  assert.equal(p.docs.length, 0, 'approved template does not carry a file');
  assert.equal(p.mails.length, 1);
  assert.equal(p.mails[0][1].filename, 'Jornada de descoberta.pdf');
  assert.ok(p.mails[0][1].buffer.length);
  // The notice goes out through the same utility-template path used in routines.
  const [[, , text, options]] = f.calls;
  assert.match(text, /enviei o PDF para o seu e-mail/);
  assert.doesNotMatch(text, /PRIVATE_SYNTHETIC_REPORT/);
  assert.equal(options.templateText, text.replace(/^\*[^*]+\*\n\n/, ''));
  assert.ok(options.templateText.length < 900);
  assert.equal(options.retryUnknown, false);
});

test('without a delivered email, the outside-the-window notice promises no email at all', async () => {
  const sent = [], p = pdfFixture({ emailDocument: async () => false, whatsappWindowOpen: async () => false,
    deliverToChannel: async (...args) => { sent.push(args); return { ok: true, id: 'receipt' }; } });
  const receipt = await createDiscoveryReportDelivery(p.deps)(participant('whatsapp'), REPORT);
  assert.equal(receipt.ok, true);
  assert.doesNotMatch(sent[0][1], /e-mail/);
  assert.match(sent[0][1], /\/inicio\?c=owner-thread/);
  assert.deepEqual(p.published[0][3], [p.doc.attachment], 'the PDF stays in the conversation');
});

test('failure to generate the PDF preserves the text delivery', async () => {
  const sent = [], p = pdfFixture({ buildDocument: async () => { throw Error('synthetic'); },
    deliverToChannel: async (...args) => { sent.push(args); return { ok: true, id: 'receipt' }; } });
  const receipt = await createDiscoveryReportDelivery(p.deps)(participant('telegram'), REPORT);
  assert.equal(receipt.ok, true);
  assert.equal(p.published[0][1], REPORT, 'the full report is written back to the conversation');
  assert.equal(p.published[0][3], null);
  assert.match(sent[0][1], /\/inicio\?c=owner-thread/);
});

test('failure to send the PDF on the channel becomes a notice with a link, without losing the conversation attachment', async () => {
  const sent = [], p = pdfFixture({ sendDocument: async () => { throw Error('synthetic'); },
    deliverToChannel: async (...args) => { sent.push(args); return { ok: true, id: 'receipt' }; } });
  const receipt = await createDiscoveryReportDelivery(p.deps)(participant('telegram'), REPORT);
  assert.equal(receipt.ok, true); assert.equal(receipt.id, 'receipt');
  assert.deepEqual(p.published[0][3], [p.doc.attachment]);
  assert.match(sent[0][1], /\/inicio\?c=owner-thread/);
  assert.doesNotMatch(sent[0][1], /PRIVATE_SYNTHETIC_REPORT/);
});

test('preparation-failure notice does not try to generate a PDF', async () => {
  const sent = [], p = pdfFixture({ buildDocument: async () => assert.fail('there is no report to turn into a PDF'),
    deliverToChannel: async (...args) => { sent.push(args); return { ok: true, id: 'receipt' }; } });
  await createDiscoveryReportDelivery(p.deps)(participant('telegram', { report_state: 'failed' }), 'Não consegui preparar sua devolutiva desta vez.');
  assert.match(sent[0][1], /Não consegui preparar/);
  assert.equal(p.published[0][3], null);
});
