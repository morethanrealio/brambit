// ── Envio de e-mail transacional ──
// Dois usos: o assistente manda e-mail PRO usuário (briefing das rotinas) e
// e-mails de sistema (ex.: redefinição de senha). Configurável por env.
//
// SMTP (Gmail / Google Workspace — preferido):
//   SMTP_HOST=smtp.gmail.com
//   SMTP_PORT=465            (TLS implícito; 587 = STARTTLS)
//   SMTP_USER=oi@exemplo.com
//   SMTP_PASS=<App Password> (senha de app do Gmail, gerada pelo dono da conta)
//   MAIL_FROM=oi@exemplo.com
//   MAIL_FROM_NAME=Brambs
//
// Resend (HTTP, fallback, sem dependência):
//   RESEND_API_KEY=...
//   MAIL_FROM=oi@exemplo.com
//
// Sem credencial NÃO quebra: loga e devolve { skipped:true }, pra rodar/dev
// antes das credenciais estarem prontas.

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

// Monta o cabeçalho From: "Nome do Assistente <oi@exemplo.com>".
// O endereço é fixo (um domínio verificado); o display name é o do assistente,
// pra chegar como "Mara", "Bento", etc. — não como o próprio usuário.
function fromHeader(fromName, fromAddr) {
  const addr = fromAddr || process.env.MAIL_FROM;
  const name = (fromName || process.env.MAIL_FROM_NAME || 'Assistente').replace(/[<>"]/g, '').trim();
  return `${name} <${addr}>`;
}

// Converte texto simples (resposta do agente) num HTML leve e legível.
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

// Envia via SMTP (nodemailer, import dinâmico pra não exigir a dep no boot
// quando SMTP não está configurado). Usado pelo Gmail/Workspace.
// `attachments`: [{ filename, content: Buffer, contentType }] — mesmo formato
// aceito pelo nodemailer, normalizado em sendEmail antes de chegar aqui.
async function sendViaSmtp({ to, subject, text, html, fromName, fromAddr, headers, attachments }) {
  const { default: nodemailer } = await import('nodemailer');
  const port = Number(process.env.SMTP_PORT || 465);
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: port === 465, // 465 = TLS implícito; 587 = STARTTLS
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

// Normaliza anexos para o formato do nodemailer, ignorando entrada sem bytes.
function mailAttachments(attachments) {
  return (Array.isArray(attachments) ? attachments : [])
    .filter((a) => a && Buffer.isBuffer(a.content) && a.content.length)
    .map((a) => ({ filename: a.filename || 'anexo', content: a.content, contentType: a.contentType || 'application/octet-stream' }));
}

// Envia um e-mail. { to, subject, text, html, fromName, fromAddr, headers,
// attachments }. fromAddr sobrescreve o endereço (institucional). headers =
// cabeçalhos extras (ex.: List-Unsubscribe). `attachments` = [{ filename,
// content: Buffer, contentType }].
// Devolve { ok:true, id } | { skipped:true } | lança.
export async function sendEmail({ to, subject, text, html, fromName, fromAddr, headers, attachments }) {
  const files = mailAttachments(attachments);
  if (smtpEnabled()) return sendViaSmtp({ to, subject, text, html, fromName, fromAddr, headers, attachments: files });
  if (!resendEnabled()) {
    console.log(`[mailer] (stub, sem credencial de e-mail) -> ${to}: ${subject}`);
    return { skipped: true };
  }
  const payload = {
    from: fromHeader(fromName, fromAddr),
    to: [to],
    subject,
    text: text || '',
    html: html || textToHtml(text || ''),
    ...(headers ? { headers } : {}),
    // Resend recebe o conteúdo em base64 (a API não aceita Buffer).
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
