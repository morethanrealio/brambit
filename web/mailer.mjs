// ── Transactional email ──
// Two uses: the assistant emails the user (routine briefings) and system
// emails (e.g. password reset). Configured via env.
//
// SMTP (Gmail / Google Workspace, preferred):
//   SMTP_HOST=smtp.gmail.com
//   SMTP_PORT=465            (implicit TLS; 587 = STARTTLS)
//   SMTP_USER=oi@exemplo.com
//   SMTP_PASS=<App Password> (Gmail app password, made by the account owner)
//   MAIL_FROM=oi@exemplo.com
//   MAIL_FROM_NAME=Acme
//
// Resend (HTTP, fallback, no dependency):
//   RESEND_API_KEY=...
//   MAIL_FROM=oi@exemplo.com
//
// Without credentials it does NOT break: logs and returns { skipped:true }, so
// it runs in dev before credentials are ready.

const RESEND_API = 'https://api.resend.com/emails';

export function smtpEnabled() {
  return !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS && process.env.MAIL_FROM);
}
export function resendEnabled() {
  return !!(process.env.RESEND_API_KEY && process.env.MAIL_FROM);
}
export function mailEnabled() {
  return smtpEnabled() || resendEnabled();
}

// Builds the From header: "Assistant Name <oi@exemplo.com>".
// The address is fixed (a verified domain); the display name is the assistant's,
// so it arrives as "Mara", "Bento", etc. — not as the user themself.
function fromHeader(fromName, fromAddr) {
  const addr = fromAddr || process.env.MAIL_FROM;
  const name = (fromName || process.env.MAIL_FROM_NAME || 'Assistente').replace(/[<>"]/g, '').trim();
  return `${name} <${addr}>`;
}

// Converts plain text (the agent's reply) into light, readable HTML.
function textToHtml(text) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const body = esc(text || '')
    .replace(/\*([^*\n]+)\*/g, '<strong>$1</strong>')   // *negrito*
    .replace(/^[•\-] (.+)$/gm, '<li>$1</li>')            // bullets
    .replace(/(<li>[\s\S]*?<\/li>)/g, '<ul>$1</ul>')
    .replace(/\n{2,}/g, '</p><p>')
    .replace(/\n/g, '<br>');
  return `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.55;color:#1a1a1a;max-width:600px;margin:0 auto"><p>${body}</p></div>`;
}

// Sends via SMTP (nodemailer, dynamic import so it doesn't require the dep at boot
// when SMTP isn't configured). Used by Gmail/Workspace.
// `attachments`: [{ filename, content: Buffer, contentType }] — same format
// accepted by nodemailer, normalized in sendEmail before reaching here.
async function sendViaSmtp({ to, subject, text, html, fromName, fromAddr, headers, attachments }) {
  const { default: nodemailer } = await import('nodemailer');
  const port = Number(process.env.SMTP_PORT || 465);
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: port === 465, // 465 = implicit TLS; 587 = STARTTLS
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  const info = await transporter.sendMail({
    from: fromHeader(fromName, fromAddr),
    to,
    subject,
    text: text || '',
    html: html || textToHtml(text || ''),
    ...(headers ? { headers } : {}),
    ...(attachments?.length ? { attachments } : {}),
  });
  return { ok: true, id: info.messageId };
}

// Normalizes attachments to nodemailer's format, ignoring entries without bytes.
function mailAttachments(attachments) {
  return (Array.isArray(attachments) ? attachments : [])
    .filter((a) => a && Buffer.isBuffer(a.content) && a.content.length)
    .map((a) => ({ filename: a.filename || 'anexo', content: a.content, contentType: a.contentType || 'application/octet-stream' }));
}

// Sends an email. { to, subject, text, html, fromName, fromAddr, headers,
// attachments }. fromAddr overrides the address (institutional). headers =
// extra headers (e.g. List-Unsubscribe). `attachments` = [{ filename,
// content: Buffer, contentType }].
// Returns { ok:true, id } | { skipped:true } | throws.
export async function sendEmail({ to, subject, text, html, fromName, fromAddr, headers, attachments }) {
  const files = mailAttachments(attachments);
  if (smtpEnabled()) return sendViaSmtp({ to, subject, text, html, fromName, fromAddr, headers, attachments: files });
  if (!resendEnabled()) {
    console.log(`[mailer] (stub, no email credential) -> ${to}: ${subject}`);
    return { skipped: true };
  }
  const payload = {
    from: fromHeader(fromName, fromAddr),
    to: [to],
    subject,
    text: text || '',
    html: html || textToHtml(text || ''),
    ...(headers ? { headers } : {}),
    // Resend receives the content in base64 (the API doesn't accept Buffer).
    ...(files.length ? { attachments: files.map((a) => ({ filename: a.filename, content: a.content.toString('base64'), content_type: a.contentType })) } : {}),
  };
  const r = await fetch(RESEND_API, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!r.ok) throw new Error(`resend ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const data = await r.json().catch(() => ({}));
  return { ok: true, id: data.id };
}
