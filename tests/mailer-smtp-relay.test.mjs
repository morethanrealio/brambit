// SMTP with and without a login (web/mailer.mjs), against a mail server that
// lives only in this test and records what it was told.
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { sendEmail, smtpEnabled } from '../web/mailer.mjs';
import { runCheck } from '../web/config-checks.mjs';

const KEYS = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'MAIL_FROM', 'RESEND_API_KEY'];
const nobodySuppressed = { lookup: async () => null };

// Accepts one message per connection. `commands` gets every line the client
// sends outside the message body.
async function mailServer(t) {
  const commands = [];
  const server = net.createServer((socket) => {
    let inBody = false, pending = '';
    socket.write('220 test ESMTP\r\n');
    socket.on('error', () => {});
    socket.on('data', (chunk) => {
      pending += chunk;
      let end;
      while ((end = pending.indexOf('\r\n')) >= 0) {
        const line = pending.slice(0, end);
        pending = pending.slice(end + 2);
        if (inBody) { if (line === '.') { inBody = false; socket.write('250 queued\r\n'); } continue; }
        commands.push(line);
        if (/^EHLO /i.test(line)) socket.write('250-test\r\n250 AUTH PLAIN LOGIN\r\n');
        else if (/^AUTH PLAIN/i.test(line)) socket.write('235 ok\r\n');
        else if (/^DATA$/i.test(line)) { inBody = true; socket.write('354 go\r\n'); }
        else if (/^QUIT$/i.test(line)) socket.end('221 bye\r\n');
        else socket.write('250 ok\r\n');
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return { port: server.address().port, commands };
}

function withEnv(t, values) {
  const before = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  t.after(() => { for (const k of KEYS) { if (before[k] === undefined) delete process.env[k]; else process.env[k] = before[k]; } });
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, values);
}

const message = { to: 'someone@example.com', subject: 'Reset', text: 'link' };

test('with no login the message goes out with no AUTH, under the sender domain', async (t) => {
  const { port, commands } = await mailServer(t);
  withEnv(t, { SMTP_HOST: '127.0.0.1', SMTP_PORT: String(port), MAIL_FROM: 'no-reply@example.com' });
  const sent = await sendEmail(message, { suppressions: nobodySuppressed });
  assert.equal(sent.ok, true);
  assert.equal(commands[0], 'EHLO example.com');
  assert.equal(commands.some((c) => /^AUTH/i.test(c)), false);
  assert.ok(commands.includes('MAIL FROM:<no-reply@example.com>'));
  assert.ok(commands.includes('RCPT TO:<someone@example.com>'));
});

test('with a login the server is asked to accept it before the message', async (t) => {
  const { port, commands } = await mailServer(t);
  withEnv(t, { SMTP_HOST: '127.0.0.1', SMTP_PORT: String(port), SMTP_USER: 'user@example.com', SMTP_PASS: 'pass', MAIL_FROM: 'no-reply@example.com' });
  const sent = await sendEmail(message, { suppressions: nobodySuppressed });
  assert.equal(sent.ok, true);
  const auth = commands.findIndex((c) => /^AUTH PLAIN/i.test(c));
  assert.ok(auth > 0 && auth < commands.findIndex((c) => /^MAIL FROM/i.test(c)));
});

test('half a login sends nothing and the settings check names what is missing', async (t) => {
  const { port, commands } = await mailServer(t);
  withEnv(t, { SMTP_HOST: '127.0.0.1', SMTP_PORT: String(port), SMTP_USER: 'user@example.com', MAIL_FROM: 'no-reply@example.com' });
  t.mock.method(console, 'log', () => {});
  assert.equal(smtpEnabled(), false);
  assert.deepEqual(await sendEmail(message, { suppressions: nobodySuppressed }), { skipped: true });
  assert.deepEqual(await runCheck('smtp', { ...process.env }), { ok: false, reason: 'missing', missing: ['SMTP_PASS'] });
  assert.deepEqual(commands, []);
});

test('the settings check reaches a server that takes no login', async (t) => {
  const { port, commands } = await mailServer(t);
  const values = { SMTP_HOST: '127.0.0.1', SMTP_PORT: String(port), MAIL_FROM: 'no-reply@example.com' };
  assert.deepEqual(await runCheck('smtp', values), { ok: true });
  assert.equal(commands[0], 'EHLO example.com');
  assert.equal(commands.some((c) => /^(AUTH|MAIL FROM)/i.test(c)), false);
});
