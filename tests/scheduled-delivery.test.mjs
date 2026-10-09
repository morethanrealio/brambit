// Pure delivery factory and real curation orchestration, with synthetic senders.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createScheduledDelivery } from '../web/scheduled-delivery.mjs';
import { deliverCurationEdition } from '../web/curation-store.mjs';
import { sendCurationChannel } from '../web/curation-delivery.mjs';
import { createRoutineExecutor, routineExecutionText } from '../web/routine-execution.mjs';

const row = { id: 'routine-fixture', user_id: 'owner-fixture', agent_id: 'agent-fixture',
  title: 'Synthetic report', message: 'Synthetic reminder', email: 'fixture@example.invalid' };
const longText = 'Synthetic report. '.repeat(220);
function harness(overrides = {}) {
  const calls = [];
  const deps = {
    sendEmail: async (...args) => { calls.push(['email', ...args]); return { ok: true, id: 'email-receipt' }; },
    getTelegramBotForDelivery: async () => ({ token: 'synthetic', chat_id: 'synthetic' }),
    sendTelegramMessage: async (...args) => { calls.push(['telegram', ...args]); return { message_id: 42 }; },
    waEnabled: () => true,
    getWhatsAppLinkForUser: async () => ({ wa_phone: 'synthetic', enabled: true }),
    sendWhatsAppProactive: async (...args) => { calls.push(['whatsapp', ...args]); return { wamid: 'wa-receipt' }; },
    whatsappProse: async () => assert.fail('rewriting must not run in the test'),
    persistProactiveToThread: async (...args) => calls.push(['persist', ...args]),
    deliverCurationEdition, sendCurationChannel,
    curationStore: {
      reserve: async () => calls.push(['reserve']), confirm: async () => calls.push(['confirm']),
      uncertain: async () => calls.push(['uncertain']),
      appReceipt: async () => ({ ok: true, id: 'app-receipt' }),
    },
    ...overrides,
  };
  return { calls, deps, ...createScheduledDelivery(deps) };
}

test('all three channels require real receipts for reminders and routines', async () => {
  for (const channel of ['email', 'telegram', 'whatsapp']) {
    const h = harness();
    const reminder = await h.deliverReminder({ ...row, channel });
    assert.equal(reminder.status, 'accepted');
    assert.equal(reminder.channel, channel);
    assert.ok(reminder.id);
    assert.equal(h.calls.some(call => call[0] === 'persist'), false);
    const routine = await h.deliverRoutine({ ...row, channel }, 'Synthetic report');
    assert.equal(routine.status, 'accepted');
    assert.equal(routine.channel, channel);
    assert.equal(h.calls.at(-1)[0], 'persist');
    assert.equal(h.calls.filter(call => call[0] === channel).length, 2);
  }
});

test('skipped email is a definitive failure and does not persist a sent message', async () => {
  const h = harness({ sendEmail: async () => ({ skipped: true }) });
  for (const action of [() => h.deliverReminder({ ...row, channel: 'email' }),
    () => h.deliverRoutine({ ...row, channel: 'email' }, 'Synthetic report')]) {
    await assert.rejects(action, { definitive: true, code: 'DELIVERY_REJECTED' });
  }
  assert.deepEqual(h.calls, []);
});

test('missing provider ids remain uncertain and never persist as sent', async () => {
  const h = harness({ sendEmail: async () => ({ ok: true }),
    sendTelegramMessage: async () => ({}), sendWhatsAppProactive: async () => ({}) });
  for (const channel of ['email', 'telegram', 'whatsapp']) {
    await assert.rejects(h.deliverReminder({ ...row, channel }), { definitive: false });
    await assert.rejects(h.deliverRoutine({ ...row, channel }, 'Synthetic report'), { definitive: false });
  }
  assert.deepEqual(h.calls, []);
});

test('missing connections, disabled links and unsupported channels fail before sending', async () => {
  for (const [channel, override, fields] of [
    ['email', {}, { email: null }],
    ['telegram', { getTelegramBotForDelivery: async () => null }, {}],
    ['whatsapp', { waEnabled: () => false }, {}],
    ['whatsapp', { getWhatsAppLinkForUser: async () => null }, {}],
    ['whatsapp', { getWhatsAppLinkForUser: async () => ({ wa_phone: 'synthetic', enabled: false }) }, {}],
    ['unsupported', {}, {}],
  ]) {
    const h = harness(override);
    await assert.rejects(h.deliverReminder({ ...row, channel, ...fields }), { definitive: true });
    await assert.rejects(h.deliverRoutine({ ...row, channel, ...fields }, 'Synthetic report'), { definitive: true });
    assert.deepEqual(h.calls, []);
  }
});

test('scheduled WhatsApp never retries ambiguous requests automatically', async () => {
  const h = harness();
  await h.deliverReminder({ ...row, channel: 'whatsapp' });
  await h.deliverRoutine({ ...row, channel: 'whatsapp' }, 'Synthetic report');
  await h.deliverRoutine({ ...row, channel: 'whatsapp' }, {
    type: 'flight-monitor-v1', text: 'Synthetic report', templateText: 'Synthetic template',
  });
  for (const call of h.calls.filter(call => call[0] === 'whatsapp')) assert.equal(call[3].retryUnknown, false);
  assert.equal(h.calls.filter(call => call[0] === 'whatsapp').at(-1)[3].proseFallback, null);
});

test('curation checks scope, receipt and actual dispatch before accepting', async () => {
  const edition = { type: 'curation-v1', userId: row.user_id, routineId: row.id,
    editionId: 'edition-fixture', channel: 'email', text: 'Synthetic report', urls: ['https://example.invalid/article'] };
  const h = harness();
  await assert.rejects(h.deliverRoutine({ ...row, channel: 'email' }, { ...edition, userId: 'other' }), { definitive: true });
  assert.deepEqual(h.calls, []);
  assert.equal((await h.deliverRoutine({ ...row, channel: 'email' }, edition)).status, 'accepted');
  assert.deepEqual(h.calls.map(call => call[0]), ['reserve', 'email', 'confirm', 'persist']);
  const missing = harness({ sendEmail: async () => ({ ok: true }) });
  await assert.rejects(missing.deliverRoutine({ ...row, channel: 'email' }, edition), { definitive: false });
  assert.deepEqual(missing.calls.map(call => call[0]), ['reserve', 'uncertain']);
  const noDispatch = harness({ deliverCurationEdition: async () => {} });
  await assert.rejects(noDispatch.deliverRoutine({ ...row, channel: 'email' }, edition), { definitive: false });
  const app = harness();
  const saved = await app.deliverRoutine({ ...row, channel: 'app' }, { ...edition, channel: 'app' });
  assert.equal(saved.status, 'saved');
  assert.equal(saved.id, 'app-receipt');
});

test('long report never sends a successful-email notice when email was skipped', async () => {
  const h = harness({ sendEmail: async () => ({ skipped: true }) });
  await assert.rejects(h.deliverRoutine({ ...row, channel: 'whatsapp' }, longText), { definitive: true });
  assert.deepEqual(h.calls, []);
});

test('accepted first curation packet makes a later definitive refusal uncertain', async () => {
  let calls = 0;
  const h = harness({ sendWhatsAppProactive: async () => {
    if (++calls === 1) return { wamid: 'accepted-first-packet' };
    throw Object.assign(Error('Synthetic second packet refusal'), { definitive: true });
  } });
  const edition = { type: 'curation-v1', userId: row.user_id, routineId: row.id,
    editionId: 'edition-fixture', channel: 'whatsapp', text: 'Synthetic curation. '.repeat(100),
    urls: ['https://example.invalid/article'] };
  await assert.rejects(h.deliverRoutine({ ...row, channel: 'whatsapp' }, edition), { definitive: false });
  assert.equal(calls, 2);
  assert.deepEqual(h.calls.map(call => call[0]), ['reserve', 'uncertain']);
});

test('accepted long email survives a failed chat notice with explicit limitation', async () => {
  for (const definitive of [true, false]) {
    const h = harness({ sendWhatsAppProactive: async () => {
      throw Object.assign(Error('synthetic notice error'), { definitive });
    } });
    const receipt = await h.deliverRoutine({ ...row, channel: 'whatsapp' }, longText);
    assert.equal(receipt.status, 'accepted');
    assert.equal(receipt.channel, 'email');
    assert.equal(receipt.id, 'email-receipt');
    assert.deepEqual(receipt.notification, { channel: 'whatsapp', status: definitive ? 'failed' : 'uncertain' });
    assert.equal(h.calls.filter(call => call[0] === 'email').length, 1);
    assert.equal(h.calls.filter(call => call[0] === 'persist').length, 1);
  }
});

test('notification limitation survives executor outcome and its user-facing summary', async () => {
  let saved;
  const executor = createRoutineExecutor({ claim: async () => true, phase: async () => true,
    finish: async (_row, _token, status, outcome) => { saved = { status, ...outcome }; return true; } });
  const h = harness({ sendWhatsAppProactive: async () => { throw Error('synthetic timeout'); } });
  await executor.execute({ ...row, channel: 'whatsapp' }, { slot: 'synthetic', run: async () => longText, deliver: h.deliverRoutine });
  assert.equal(saved.delivery.channel, 'email');
  assert.equal(saved.delivery.status, 'accepted');
  assert.deepEqual(saved.delivery.notification, { status: 'uncertain', channel: 'whatsapp' });
  const summary = routineExecutionText({ config: { execution: saved } });
  assert.match(summary, /email/);
  assert.match(summary, /whatsapp/);
  assert.match(summary, /incert|não confirmad/);
});

test('reminder and routine wrappers follow the owner language; pt-BR stays byte-identical', async () => {
  const casos = [
    [null, '⏰ Lembrete: Synthetic reminder', 'Oi, Ana!', 'O "Synthetic report" de hoje ficou pronto. Como ficou grande demais para mandar por aqui'],
    ['pt-BR', '⏰ Lembrete: Synthetic reminder', 'Oi, Ana!', 'O "Synthetic report" de hoje ficou pronto. Como ficou grande demais para mandar por aqui'],
    ['en', '⏰ Reminder: Synthetic reminder', 'Hi, Ana!', 'Today\'s "Synthetic report" is ready. Since it was too long to send here'],
    ['es', '⏰ Recordatorio: Synthetic reminder', '¡Hola, Ana!', 'El "Synthetic report" de hoy está listo. Como quedó demasiado largo para enviarlo por aquí'],
  ];
  for (const [user_language, lembrete, oi, longo] of casos) {
    const base = { ...row, user_name: 'Ana Souza', user_language };
    const h = harness();
    await h.deliverReminder({ ...base, channel: 'telegram' });
    assert.equal(h.calls.at(-1)[3], lembrete);
    await h.deliverReminder({ ...base, channel: 'email' });
    assert.equal(h.calls.at(-1)[1].subject, lembrete.replace(': ', ': '));
    assert.ok(h.calls.at(-1)[1].text.startsWith(oi + '\n\n'));
    await h.deliverRoutine({ ...base, channel: 'email' }, 'Synthetic report');
    assert.ok(h.calls.at(-2)[1].text.startsWith(oi + '\n\n'));
    const hl = harness();
    await hl.deliverRoutine({ ...base, channel: 'telegram' }, longText);
    const aviso = hl.calls.find(c => c[0] === 'telegram')[3];
    assert.ok(aviso.includes(longo), `${user_language}: ${aviso}`);
  }
});

test('a list reminder outside the WhatsApp window is held behind a notice', async () => {
  const held = [];
  const heldWhatsApp = {
    hold: async (args) => { held.push(args); return 7; },
    attachNotice: async (...args) => held.push(['notice', ...args]),
    cancel: async () => assert.fail('a delivered notice must keep the hold'),
  };
  const list = 'Shopping:\n• bread\n• milk\n• eggs';
  for (const open of [false, true]) {
    const h = harness({ heldWhatsApp, whatsappWindowOpen: async () => open });
    const res = await h.deliverReminder({ ...row, message: list, channel: 'whatsapp', user_language: 'en' });
    assert.equal(res.status, 'accepted');
    const sent = h.calls.find(c => c[0] === 'whatsapp')[2];
    if (open) { assert.ok(sent.includes('• milk')); continue; }
    assert.ok(held[0].body.includes('• bread\n• milk'));
    assert.ok(!sent.includes('• milk') && sent.includes('Shopping:'), sent);
    assert.deepEqual(held[1], ['notice', 7, 'wa-receipt']);
  }
  assert.equal(held.length, 2);
});
