// ── Hard bounces ──
// Over SMTP the only sign that an address is dead is the delivery status
// notification (DSN, RFC 3464) the provider mails back to the sender. With the
// usual setup (MAIL_FROM = EMAIL_ADDRESS) it lands in the inbox the email
// channel already reads, so handleEmail (email.mjs) hands every message here
// first, and a hard bounce suppresses the recipient (email-suppression.mjs).
//
// A forged bounce would let anyone silence a real user's mail, password reset
// included, so a notice only counts when ALL of these hold:
//  • the sender is a configured reporter (BRAMBIT_BOUNCE_REPORTERS, default
//    Gmail's mailer-daemon@googlemail.com) and our MX authenticates it strongly;
//  • its message/delivery-status part says Action: failed with a status that
//    means the address does not exist (PERMANENT). Policy refusals (5.7.x), a
//    full mailbox and anything temporary never suppress;
//  • the returned headers (text/rfc822-headers) are from a message we sent, and
//    the failed recipient is one of its To/Cc. The remote server writes the
//    diagnostic text, so a recipient missing from our own headers is ignored.
//
// drainQueue parses with keepDeliveryStatus: otherwise mailparser folds the
// delivery-status part into the body text, where it can't be told apart.
import { normalizeAddress, emailSuppressions } from './email-suppression.mjs';

// RFC 3463: bad mailbox, bad domain, bad address syntax, no mail domain (RFC
// 7505) and mailbox disabled.
const PERMANENT = new Set(['5.1.1', '5.1.2', '5.1.3', '5.1.10', '5.2.1']);

const addressList = (raw) => String(raw || '').split(',')
  .map((s) => normalizeAddress(s)).filter(Boolean);

export function bounceReporters() {
  return addressList(process.env.BRAMBIT_BOUNCE_REPORTERS || 'mailer-daemon@googlemail.com');
}

// The addresses our mail goes out from: mailer.mjs (MAIL_FROM) and the email
// channel replies (EMAIL_ADDRESS).
function ownAddresses() {
  return addressList([process.env.MAIL_FROM, process.env.EMAIL_ADDRESS].filter(Boolean).join(','));
}

// Header-style field blocks: blank lines separate blocks, indented lines
// continue the previous field, the first occurrence of a field wins. Field
// names come back lowercase.
export function fieldBlocks(text) {
  return String(text || '').replace(/\r\n?/g, '\n').split(/\n[ \t]*\n/).map((block) => {
    const fields = {};
    let last = null;
    for (const line of block.split('\n')) {
      if (/^[ \t]/.test(line)) { if (last) fields[last] += ' ' + line.trim(); continue; }
      const m = line.match(/^([A-Za-z0-9-]+):[ \t]*(.*)$/);
      last = m && !(m[1].toLowerCase() in fields) ? m[1].toLowerCase() : null;
      if (last) fields[last] = m[2].trim();
    }
    return fields;
  }).filter((fields) => Object.keys(fields).length);
}

// The permanently failed recipients of one of our messages, as
// [{ recipient, status }], or null when the message isn't such a notice.
// `auth` = passesEmailAuth(parsed, fromAddr).
export function readHardBounces(parsed, { fromAddr, auth } = {}) {
  if (!auth?.strong || !bounceReporters().includes(normalizeAddress(fromAddr))) return null;
  const type = parsed.headers?.get?.('content-type');
  if (type?.value !== 'multipart/report' || type.params?.['report-type'] !== 'delivery-status') return null;
  const parts = (contentType) => (parsed.attachments || []).filter((a) => a.contentType === contentType && Buffer.isBuffer(a.content));
  const status = parts('message/delivery-status');
  const original = parts('text/rfc822-headers');
  if (status.length !== 1 || original.length !== 1) return null;

  const [sent] = fieldBlocks(original[0].content.toString('utf8'));
  if (!sent || !ownAddresses().includes(normalizeAddress(sent.from))) return null;
  const sentTo = new Set([...addressList(sent.to), ...addressList(sent.cc)]);

  const failed = [];
  for (const r of fieldBlocks(status[0].content.toString('utf8'))) {
    const recipient = normalizeAddress(String(r['final-recipient'] || '').split(';').pop());
    const code = String(r.status || '').trim().split(/\s/)[0];
    if (recipient && sentTo.has(recipient) && /^failed$/i.test(r.action || '') && PERMANENT.has(code)) {
      failed.push({ recipient, status: code });
    }
  }
  return failed.length ? failed : null;
}

// true when the message was a hard bounce of ours (already handled: the caller
// stops there). `suppressions` replaces the shared store.
export async function suppressHardBounces(parsed, { fromAddr, auth, suppressions } = {}) {
  const failed = readHardBounces(parsed, { fromAddr, auth });
  if (!failed) return false;
  const store = suppressions || await emailSuppressions();
  for (const { recipient, status } of failed) {
    await store.suppress(recipient, { source: 'bounce', reason: status });
    console.log(`[email] hard bounce ${status}, recipient at ${recipient.split('@')[1]} suppressed`);
  }
  return true;
}
