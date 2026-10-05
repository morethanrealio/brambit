// Real senders with synthetic HTTP responses; sockets and subprocesses denied.
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const denied = () => { throw Error('REAL I/O FORBIDDEN'); };
net.Socket.prototype.connect = denied; tls.connect = denied;
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) cp[name] = denied;
syncBuiltinESMExports();
process.env.WA_TOKEN = 'synthetic-token'; process.env.WA_PHONE_NUMBER_ID = 'synthetic-phone';
const { sendTelegramMessage } = await import('./web/telegram.mjs');
const { sendWhatsAppProactive, setWaHooks, retryProactiveAsTemplate } = await import('./web/whatsapp.mjs');

function http(parts) {
  const calls = [];
  globalThis.fetch = async (_url, opts) => {
    calls.push(JSON.parse(opts.body));
    const part = parts.shift();
    assert.ok(part, 'unexpected extra HTTP request');
    return { ok: part.status === 200, status: part.status, json: async () => part.body };
  };
  return calls;
}
const tgAccepted = id => ({ status: 200, body: { ok: true, result: { message_id: id } } });
const tgRejected = { status: 400, body: { ok: false, description: 'synthetic rejection' } };
const waAccepted = id => ({ status: 200, body: { messages: [{ id }] } });

test('Telegram rejects missing receipts for any part without resending', async () => {
  for (const first of [true, false]) {
    const calls = http(first ? [tgAccepted(undefined)] : [tgAccepted(1), tgAccepted(undefined)]);
    await assert.rejects(sendTelegramMessage('synthetic', '123', 'x'.repeat(5000)), error => error.definitive === false);
    assert.equal(calls.length, first ? 1 : 2);
  }
});
test('blank or malformed second-part IDs cannot turn a partial send into full acceptance', async () => {
  for (const id of ['', ' ', 0, -1, '23', {}]) {
    const calls = http([tgAccepted(1), tgAccepted(id)]);
    await assert.rejects(sendTelegramMessage('synthetic', '123', 'x'.repeat(5000)), error => error.definitive === false);
    assert.equal(calls.length, 2);
  }
  setWaHooks({ lastInboundAt: async () => new Date() });
  for (const id of ['', ' ', 23, {}]) {
    const calls = http([waAccepted('valid-wamid'), waAccepted(id)]);
    await assert.rejects(sendWhatsAppProactive('5511000000000', 'x'.repeat(1800), { retryUnknown: false }),
      error => error.definitive === false && error.partial === true);
    assert.equal(calls.length, 2);
  }
});
test('Telegram partial acceptance followed by a definitive rejection is uncertain', async () => {
  let calls = http([tgAccepted(1), tgRejected]);
  await assert.rejects(sendTelegramMessage('synthetic', '123', 'x'.repeat(5000)), error => error.definitive === false);
  assert.equal(calls.length, 2);
  calls = http([tgRejected]);
  await assert.rejects(sendTelegramMessage('synthetic', '123', 'short'), error => error.definitive === true);
  assert.equal(calls.length, 1);
});
test('Telegram complete multi-part sends preserve all receipts', async () => {
  http([tgAccepted(1), tgAccepted(2)]);
  assert.deepEqual(await sendTelegramMessage('synthetic', '123', 'x'.repeat(5000)), { message_id: 1, message_ids: [1, 2] });
});
test('WhatsApp missing part receipts never authorize full-body fallback', async () => {
  setWaHooks({ lastInboundAt: async () => new Date() });
  for (const first of [true, false]) {
    const calls = http(first ? [waAccepted(undefined)] : [waAccepted('wamid-1'), waAccepted(undefined)]);
    await assert.rejects(sendWhatsAppProactive('5511000000000', 'x'.repeat(1800), { retryUnknown: false }),
      error => error.definitive === false && error.partial === true);
    assert.equal(calls.length, first ? 1 : 2);
    assert.ok(calls.every(call => call.type === 'text'));
  }
});
test('WhatsApp 131047 after accepted first part cannot resend the full body as a template', async () => {
  setWaHooks({ lastInboundAt: async () => new Date() });
  const calls = http([waAccepted('wamid-1'), { status: 400, body: { error: { message: '131047: outside allowed window' } } }]);
  await assert.rejects(sendWhatsAppProactive('5511000000000', 'x'.repeat(1800), { retryUnknown: false }),
    error => error.definitive === false && error.partial === true);
  assert.equal(calls.length, 2);
  assert.ok(calls.every(call => call.type === 'text'));
});
test('WhatsApp first-part closed-window rejection still permits known safe template fallback', async () => {
  setWaHooks({ lastInboundAt: async () => new Date() });
  const calls = http([{ status: 400, body: { error: { message: '131047: outside allowed window' } } }, waAccepted('wamid-template')]);
  const result = await sendWhatsAppProactive('5511000000000', 'short', { retryUnknown: false });
  assert.equal(result.wamid, 'wamid-template');
  assert.deepEqual(calls.map(call => call.type), ['text', 'template']);
});
test('WhatsApp asynchronous failure of one part cannot replay the accepted multi-part body', async () => {
  setWaHooks({ lastInboundAt: async () => new Date() });
  const calls = http([waAccepted('async-part-1'), waAccepted('async-part-2')]);
  await sendWhatsAppProactive('5511000000000', 'x'.repeat(1800), { retryUnknown: false });
  assert.equal(await retryProactiveAsTemplate('async-part-2', '5511000000000'), false);
  assert.equal(calls.length, 2);
});
test('WhatsApp preserves the uncertain result of a template attempt after a known session rejection', async () => {
  setWaHooks({ lastInboundAt: async () => new Date() });
  const calls = http([
    { status: 400, body: { error: { message: '131047: outside allowed window' } } },
    { status: 503, body: { error: { message: 'synthetic unavailable' } } },
  ]);
  await assert.rejects(sendWhatsAppProactive('5511000000000', 'short', { retryUnknown: false }), error => error.definitive === false);
  assert.equal(calls.length, 2);
});
