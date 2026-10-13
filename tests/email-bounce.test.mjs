import test from 'node:test';
import assert from 'node:assert/strict';
import { simpleParser } from 'mailparser';
import { readHardBounces, suppressHardBounces } from '../web/email-bounce.mjs';
import { passesEmailAuth } from '../web/email.mjs';

const OURS = 'assistant@example.com';
const GMAIL_AR = 'mx.google.com; dkim=pass header.i=@googlemail.com header.s=20230601; dmarc=pass (p=QUARANTINE) header.from=googlemail.com';

// The shape Gmail sends back when a relay address is gone: human-readable part,
// machine-readable delivery-status, and the headers of our original message.
function dsn({
  from = 'Mail Delivery Subsystem <mailer-daemon@googlemail.com>', ar = GMAIL_AR,
  status = '5.1.1', action = 'failed', recipient = 'gone@privaterelay.appleid.com',
  originalFrom = `Brambs <${OURS}>`, originalTo = recipient, human = 'Address not found.',
} = {}) {
  return [
    `Authentication-Results: ${ar}`,
    `From: ${from}`, `To: ${OURS}`, 'Auto-Submitted: auto-replied',
    'Subject: Delivery Status Notification (Failure)', 'MIME-Version: 1.0',
    'Content-Type: multipart/report; boundary="b1"; report-type=delivery-status', '',
    '--b1', 'Content-Type: text/plain; charset="UTF-8"', '', human, '',
    '--b1', 'Content-Type: message/delivery-status', '',
    'Reporting-MTA: dns; googlemail.com', 'X-Original-Message-ID: <orig-1@example.com>', '',
    `Final-Recipient: rfc822; ${recipient}`, `Action: ${action}`, `Status: ${status}`,
    `Diagnostic-Code: smtp; 550 ${status} <${recipient}>: user not found`, '',
    '--b1', 'Content-Type: text/rfc822-headers', '',
    `From: ${originalFrom}`, `To: ${originalTo}`, 'Subject: hi', 'Message-ID: <orig-1@example.com>', '',
    '--b1--', '',
  ].join('\r\n');
}

async function read(raw, opts = { keepDeliveryStatus: true }) {
  const parsed = await simpleParser(raw, opts);
  const fromAddr = parsed.from.value[0].address.toLowerCase();
  return { parsed, fromAddr, auth: passesEmailAuth(parsed, fromAddr) };
}

test.beforeEach(() => {
  process.env.MAIL_FROM = OURS;
  delete process.env.BRAMBIT_BOUNCE_REPORTERS;
});

test('a Gmail hard bounce of our mail names the dead recipient and suppresses it', async (t) => {
  const { parsed, fromAddr, auth } = await read(dsn());
  assert.deepEqual(readHardBounces(parsed, { fromAddr, auth }), [{ recipient: 'gone@privaterelay.appleid.com', status: '5.1.1' }]);
  const stored = [];
  const suppressions = { suppress: async (email, entry) => { stored.push([email, entry]); return true; } };
  t.mock.method(console, 'log', () => {});
  assert.equal(await suppressHardBounces(parsed, { fromAddr, auth, suppressions }), true);
  assert.deepEqual(stored, [['gone@privaterelay.appleid.com', { source: 'bounce', reason: '5.1.1' }]]);
});

test('only permanent "no such address" failures count', async () => {
  for (const [status, action] of [['5.7.1', 'failed'], ['5.2.2', 'failed'], ['4.1.1', 'delayed'], ['5.1.1', 'delayed']]) {
    const { parsed, fromAddr, auth } = await read(dsn({ status, action }));
    assert.equal(readHardBounces(parsed, { fromAddr, auth }), null, `${status} ${action}`);
  }
});

test('a notice that could be forged suppresses nothing', async () => {
  const cases = {
    'reporter not authenticated by our MX': dsn({ ar: 'evil.example; dmarc=pass header.from=googlemail.com' }),
    'reporter not on the list': dsn({ from: 'mailer-daemon@evil.example', ar: 'mx.google.com; dmarc=pass header.from=evil.example' }),
    'original not sent by us': dsn({ originalFrom: 'someone@else.example' }),
    // The remote server writes the diagnostic text; a recipient that wasn't in
    // our own headers is not ours to suppress.
    'recipient not in the original headers': dsn({ recipient: 'victim@example.org', originalTo: 'attacker@evil.example' }),
  };
  for (const [name, raw] of Object.entries(cases)) {
    const { parsed, fromAddr, auth } = await read(raw);
    assert.equal(readHardBounces(parsed, { fromAddr, auth }), null, name);
  }
});

test('the delivery-status part is only read when the parser keeps it apart', async () => {
  const { parsed, fromAddr, auth } = await read(dsn({ human: 'Final-Recipient: rfc822; victim@example.org' }), {});
  assert.equal(readHardBounces(parsed, { fromAddr, auth }), null);
});
