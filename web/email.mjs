// ── Email channel (IMAP ingest + SMTP reply, as the assistant) ──
// The user sends an email from ANY @example.com address. Google Workspace's
// catch-all rewrites the envelope to EMAIL_ADDRESS (assistant@example.com), so
// everything lands in a single mailbox. We read that mailbox over IMAP,
// identify the user by the SENDER (= their registered email), pick the
// assistant by the name written in the subject/body ("attn: <name>") and reply
// over SMTP as the assistant ("Bento <assistant@example.com>").
//
// Security / anti-abuse:
//  • only replies to REGISTERED senders (From = registered email) — prevents a
//    stranger from triggering someone else's assistant;
//  • checks the sender's AUTHENTICATION (DKIM/DMARC) before trusting the From:
//    From (RFC5322) is trivially forgeable over SMTP, so a stranger could write
//    "From: registered-person@domain" and trigger their assistant. We read the
//    Authentication-Results STAMPED BY OUR OWN MX (mx.google.com) — the one the
//    attacker cannot forge, because Google strips pre-existing A-R headers with
//    its own authserv-id — and require DMARC=pass (or DKIM=pass when the domain
//    doesn't publish DMARC). See passesEmailAuth();
//  • ignores auto-replies / no-reply / mailer-daemon / mailing lists and its own
//    address (anti-loop);
//  • dedup by Message-ID (email_seen table) + persistent queue (email_queue):
//    the downloaded raw message lives in Postgres until the reply GOES OUT;
//    a crash/SMTP failure doesn't lose a message (retry with an attempt ceiling);
//  • rate-limit per user (a lesson from a real flood);
//  • the credit gate already exists inside runConversationInThread.
//
// Env:
//   EMAIL_ADDRESS=assistant@example.com
//   EMAIL_APP_PASSWORD=<Google app password (2FA)>
//   EMAIL_IMAP_HOST=imap.gmail.com   EMAIL_IMAP_PORT=993
//   EMAIL_SMTP_HOST=smtp.gmail.com   EMAIL_SMTP_PORT=465
//   EMAIL_POLL_MS=30000
// Without EMAIL_ADDRESS/EMAIL_APP_PASSWORD the channel stays inert (doesn't connect).

export function emailEnabled() {
  return !!(process.env.EMAIL_ADDRESS && process.env.EMAIL_APP_PASSWORD);
}

const SELF = () => (process.env.EMAIL_ADDRESS || '').toLowerCase().trim();

// Strips repeated "Re:/Fwd:/Enc:/Res:" from the start of the subject (so
// replies thread into the same topic).
export function normalizeSubject(s) {
  let out = (s || '').trim();
  let prev;
  do { prev = out; out = out.replace(/^\s*(re|fwd?|enc|res|encaminhada?|in)\s*:\s*/i, ''); } while (out !== prev);
  return out.trim();
}

// Cuts the quoted history (previous replies) to send only the new text.
export function stripQuoted(text) {
  if (!text) return '';
  const lines = String(text).split(/\r?\n/);
  const out = [];
  for (const line of lines) {
    if (/^\s*>/.test(line)) break;                                          // ">" quote
    if (/^\s*(Em|On)\s+.+\b(escreveu|wrote)\s*:?\s*$/i.test(line)) break;    // "Em <data>, X escreveu:"
    if (/^\s*-{2,}\s*(Mensagem original|Original Message|Forwarded message|Início da mensagem)/i.test(line)) break;
    if (/^_{5,}\s*$/.test(line)) break;
    if (/^\s*De:\s.+\bPara:/i.test(line)) break;                            // forwarding header
    out.push(line);
  }
  return out.join('\n').trim();
}

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Picks the assistant by the name written in the email. Looks for "attn: X" /
// "a/c X" first; otherwise any assistant name mentioned in the text.
export function pickAgent(text, agents) {
  const t = (text || '').toLowerCase();
  if (!agents || !agents.length) return null;
  const m = t.match(/aos cuidados de\s+([a-zà-ú0-9 ._-]{2,40})/i)
    || t.match(/\ba\/c[:\s]+([a-zà-ú0-9 ._-]{2,40})/i)
    || t.match(/\bpara (?:o|a) (?:assistente )?([a-zà-ú0-9 ._-]{2,40})/i);
  const hint = m ? m[1].trim() : null;
  if (hint) {
    const byHint = agents.find((a) => new RegExp('\\b' + escapeRegex(a.name.toLowerCase()) + '\\b').test(hint));
    if (byHint) return byHint;
  }
  const cited = agents.find((a) => new RegExp('\\b' + escapeRegex(a.name.toLowerCase()) + '\\b').test(t));
  return cited || null;
}

// Detects senders that should NOT be replied to (anti-loop / automated).
export function isAutoOrLoop(parsed, fromAddr) {
  if (!fromAddr || fromAddr === SELF()) return true;
  if (/(^|[.@+_-])(no-?reply|noreply|mailer-daemon|postmaster|daemon|bounce|notifications?)([.@+_-]|$)/i.test(fromAddr)) return true;
  const h = parsed.headers; // Map (mailparser), lowercase keys
  const get = (k) => {
    const v = h?.get ? h.get(k) : undefined;
    return typeof v === 'string' ? v : (v?.value ?? (Array.isArray(v) ? v.join(' ') : ''));
  };
  const has = (k) => (h?.has ? h.has(k) : false);
  const autoSub = String(get('auto-submitted') || '').toLowerCase();
  if (autoSub && autoSub !== 'no') return true;
  const prec = String(get('precedence') || '').toLowerCase();
  if (['bulk', 'list', 'junk', 'auto_reply'].includes(prec)) return true;
  if (has('list-id') || has('list-unsubscribe')) return true;
  if (has('x-autoreply') || has('x-autorespond') || has('x-auto-response-suppress')) return true;
  return false;
}

// Reads the authentication verdicts (dkim/spf/dmarc) from Authentication-Results.
// ONLY trusts the line stamped by OUR MX: the authserv-id (the token BEFORE the
// first ';') has to be EXACTLY mx.google.com. Just checking whether the string
// appears in the line isn't enough: the attacker writes "Authentication-Results:
// evil.example; dkim=pass header.d=mx.google.com" in their own email and Google
// doesn't discard that header (it only removes ones that use its own authserv-id).
// With no trustworthy line (the email didn't go through Google's MX), trusted=false.
const MX_CONFIAVEL = String(process.env.EMAIL_TRUSTED_AUTHSERV || 'mx.google.com').toLowerCase();

// Extracts the domain from an A-R property value: "@x.com", "u@x.com" and
// "x.com" all become "x.com".
function dominioDe(valor) {
  const v = String(valor || '').toLowerCase().trim().replace(/[.;,]+$/, '');
  if (!v) return null;
  const at = v.lastIndexOf('@');
  const d = (at >= 0 ? v.slice(at + 1) : v).replace(/^\.+|\.+$/g, '');
  return d || null;
}

// Domain alignment in DMARC's "relaxed" sense, with no public suffix list:
// equal, or one is a subdomain of the other (mail.x.com ~ x.com). Doesn't cover
// two sibling subdomains of the same organizational domain, which is rare and
// falls into the inconclusive path, never into "strong".
function alinhado(dominio, fromDominio) {
  const d = dominioDe(dominio); const f = dominioDe(fromDominio);
  if (!d || !f) return false;
  return d === f || f.endsWith('.' + d) || d.endsWith('.' + f);
}

// An Authentication-Results is "authserv-id ; method=result prop=value ; ...".
// Returns null when the stamp isn't from our MX.
function lerAuthResults(linha) {
  const valor = String(linha || '').replace(/\s+/g, ' ').replace(/^[^:]*:/, '').trim();
  const partes = valor.split(';').map((p) => p.trim()).filter(Boolean);
  if (!partes.length) return null;
  const authserv = partes[0].split(/\s+/)[0].toLowerCase().replace(/\.$/, '');
  if (authserv !== MX_CONFIAVEL) return null;
  const metodos = [];
  for (const seg of partes.slice(1)) {
    const m = seg.match(/^([a-z][a-z0-9-]*)\s*=\s*([a-z]+)/i);
    if (!m) continue;
    const props = {};
    for (const p of seg.matchAll(/([a-z]+\.[a-z]+)\s*=\s*([^\s;]+)/gi)) props[p[1].toLowerCase()] = p[2];
    metodos.push({ metodo: m[1].toLowerCase(), resultado: m[2].toLowerCase(), props });
  }
  return { authserv, metodos };
}

export function emailAuth(parsed) {
  const lidas = (parsed.headerLines || [])
    .filter((h) => h.key === 'authentication-results')
    .map((h) => lerAuthResults(h.line))
    .filter(Boolean);
  if (!lidas.length) return { trusted: false, dmarc: null, dkim: null, spf: null, dkimDomains: [], spfDomains: [] };
  const metodos = lidas.flatMap((l) => l.metodos);
  const daqui = (nome) => metodos.filter((m) => m.metodo === nome);
  // dkim can appear several times (multiple signatures): pass if ANY one passes.
  const pick = (arr) => (arr.includes('pass') ? 'pass' : arr.includes('fail') ? 'fail' : arr[0] || null);
  const dkim = daqui('dkim'); const spf = daqui('spf'); const dmarc = daqui('dmarc');
  return {
    trusted: true,
    dmarc: pick(dmarc.map((m) => m.resultado)),
    dkim: pick(dkim.map((m) => m.resultado)),
    spf: pick(spf.map((m) => m.resultado)),
    // Who actually SIGNED (header.d, or header.i's domain). DKIM proves this
    // domain's key, not the From: without this there's no way to check alignment.
    dkimDomains: dkim.filter((m) => m.resultado === 'pass')
      .map((m) => dominioDe(m.props['header.d'] || m.props['header.i'])).filter(Boolean),
    spfDomains: spf.filter((m) => m.resultado === 'pass')
      .map((m) => dominioDe(m.props['smtp.mailfrom'] || m.props['smtp.helo'])).filter(Boolean),
  };
}

// Decides whether the sender is authenticated enough to be treated as the
// owner of the address. Policy:
//  • DMARC=pass  -> OK (DMARC itself already requires alignment, a strong anchor).
//  • DMARC=fail  -> REJECTS (domain spoof against a domain that publishes a policy).
//  • no DMARC, DKIM=pass ALIGNED with From -> strong OK.
//  • no DMARC, SPF=pass ALIGNED with From -> strong OK.
//  • DKIM=pass from a NON-aligned domain, and nothing aligned -> REJECTS. This
//    isn't absence of proof, it's proof to the contrary: someone who isn't the
//    From's domain signed the message. This was exactly the hole: "dkim=pass
//    header.i=@attacker; dmarc=none header.from=victim" was coming in as the
//    victim's strong identity.
//  • DKIM=fail AND SPF=fail -> REJECTS.
//  • inconclusive / no trustworthy A-R -> fail-OPEN with a log (doesn't drop a
//    legitimate email from a domain with no policy), unless EMAIL_STRICT_AUTH=1.
// fromAddr is the RFC5322 From (the same one the handler uses to find the
// account): alignment has to be measured AGAINST IT.
export function passesEmailAuth(parsed, fromAddr) {
  const a = emailAuth(parsed);
  const strict = process.env.EMAIL_STRICT_AUTH === '1';
  const fromDom = dominioDe(fromAddr);
  const dkimAlinhado = a.dkimDomains.some((d) => alinhado(d, fromDom));
  const spfAlinhado = a.spfDomains.some((d) => alinhado(d, fromDom));
  if (!a.trusted) return { ok: !strict, strong: false, reason: 'sem authentication-results confiável', a };
  if (a.dmarc === 'pass') return { ok: true, strong: true, reason: 'dmarc=pass', a };
  if (a.dmarc === 'fail') return { ok: false, strong: false, reason: 'dmarc=fail', a };
  if (a.dkim === 'pass' && dkimAlinhado) return { ok: true, strong: true, reason: 'dkim=pass alinhado', a };
  if (a.spf === 'pass' && spfAlinhado) return { ok: true, strong: true, reason: 'spf=pass alinhado', a };
  if (a.dkim === 'pass') return { ok: false, strong: false, reason: `dkim=pass de domínio não alinhado (${a.dkimDomains.join(',') || '?'} x ${fromDom || '?'})`, a };
  if (a.dkim === 'fail' && a.spf === 'fail') return { ok: false, strong: false, reason: 'dkim=fail+spf=fail', a };
  return { ok: !strict, strong: false, reason: `inconclusivo (dmarc=${a.dmarc} dkim=${a.dkim} spf=${a.spf})`, a };
}

// In-memory rate-limit: at most 20 emails processed per user / hour.
const rl = new Map(); // userId -> timestamps[]
function allow(userId) {
  const now = Date.now();
  const arr = (rl.get(userId) || []).filter((t) => now - t < 3600_000);
  if (arr.length >= 20) return false;
  arr.push(now); rl.set(userId, arr);
  return true;
}

// Plain text -> lightweight HTML (same approach as the mailer).
function textToHtml(text) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const body = esc(text || '')
    .replace(/\*([^*\n]+)\*/g, '<strong>$1</strong>')
    .replace(/^[•\-] (.+)$/gm, '<li>$1</li>')
    .replace(/(<li>[\s\S]*?<\/li>)/g, '<ul>$1</ul>')
    .replace(/\n{2,}/g, '</p><p>')
    .replace(/\n/g, '<br>');
  return `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.55;color:#1a1a1a;max-width:600px;margin:0 auto"><p>${body}</p></div>`;
}

// Replies over SMTP as the assistant (From = "Name <assistant@example.com>").
// Keeps the threading (In-Reply-To / References) so it lands in the same
// subject in the user's email client.
async function sendReply({ to, subject, agentName, text, inReplyTo, references }) {
  const { default: nodemailer } = await import('nodemailer');
  const port = Number(process.env.EMAIL_SMTP_PORT || 465);
  const transporter = nodemailer.createTransport({
    host: process.env.EMAIL_SMTP_HOST || 'smtp.gmail.com',
    port,
    secure: port === 465,
    auth: { user: process.env.EMAIL_ADDRESS, pass: process.env.EMAIL_APP_PASSWORD },
  });
  const name = (agentName || 'Assistente').replace(/[<>"]/g, '').trim();
  const subj = /^\s*re\s*:/i.test(subject || '') ? subject : `Re: ${subject || '(sem assunto)'}`;
  const refs = Array.isArray(references) ? references.join(' ') : (references || '');
  const headers = {};
  if (inReplyTo) headers['In-Reply-To'] = inReplyTo;
  const ref = [refs, inReplyTo].filter(Boolean).join(' ').trim();
  if (ref) headers.References = ref;
  const info = await transporter.sendMail({
    from: `${name} <${process.env.EMAIL_ADDRESS}>`,
    to, subject: subj, text: text || '', html: textToHtml(text || ''), headers,
  });
  return info.messageId;
}

// Handles an already-parsed email (mailparser). deps = { runConversation,
// getUserByEmail, listAgents, emailSeen, markEmailSeen }. Returns the outcome
// for the queue:
//   'skipped' = discarded on purpose (don't retry)
//   'defer'   = deferred without spending an attempt (rate-limit)
//   'done'    = reply sent
// Errors (conversation/SMTP) BUBBLE UP to the caller, which returns the row to
// the queue (retry). email_seen is only marked once the case is RESOLVED
// (replied to or discarded): marking it earlier was what silently lost a
// message when sending failed.
async function handleEmail(parsed, deps) {
  const fromAddr = (parsed.from?.value?.[0]?.address || '').toLowerCase().trim();
  const messageId = parsed.messageId || '';
  if (!fromAddr) return 'skipped';

  if (isAutoOrLoop(parsed, fromAddr)) { console.log('[email] ignored (auto/loop):', fromAddr); return 'skipped'; }
  if (messageId && await deps.emailSeen(messageId)) return 'skipped'; // dedup

  const user = await deps.getUserByEmail(fromAddr);
  if (!user) {
    console.log('[email] sender not registered, ignored:', fromAddr);
    if (messageId) await deps.markEmailSeen(messageId, null);
    return 'skipped';
  }
  // Account that asked for deletion (04/09): e-mail is the ONLY inbound channel
  // closeUserAccount can't switch off by deleting a row. WhatsApp/Telegram/
  // Slack resolve via a link table (deleted there); here the key is
  // `users.email` itself, which must keep existing for the 30-day grace
  // window. Without this check the assistant would keep answering by e-mail
  // after deletion.
  if (user.deleted_at) {
    console.log('[email] account deleted, ignored:', fromAddr);
    if (messageId) await deps.markEmailSeen(messageId, user.id);
    return 'skipped';
  }
  // Anti-spoofing: the From is forgeable, so only trust it if DKIM/DMARC
  // authenticate the sender. An email pretending to be from a registered user,
  // but that fails authentication, is discarded (doesn't trigger their assistant).
  const auth = passesEmailAuth(parsed, fromAddr);
  if (!auth.ok) {
    console.warn('[email] REJECTED due to authentication (possible From spoofing):', fromAddr, '—', auth.reason);
    if (messageId) await deps.markEmailSeen(messageId, user.id);
    return 'skipped';
  }
  if (!auth.strong) console.log('[email] weak authentication, accepted with caveat:', fromAddr, '—', auth.reason);
  if (!allow(user.id)) { console.log('[email] rate-limit, deferred:', fromAddr); return 'defer'; }

  const agents = await deps.listAgents(user.id);
  if (!agents.length) {
    console.log('[email] user has no assistant:', fromAddr);
    if (messageId) await deps.markEmailSeen(messageId, user.id);
    return 'skipped';
  }

  const subject = (parsed.subject || '(sem assunto)').trim();
  const bodyText = (parsed.text || '').trim();
  const agent = pickAgent(subject + '\n' + bodyText, agents) || agents[0]; // fallback = principal
  // In a FORWARD the useful content goes in the "quoted" part (stripQuoted
  // would eat it and only the signature would be left). So: if it's a forward,
  // or if after removing the quote almost nothing is left, uses the WHOLE body.
  const stripped = stripQuoted(bodyText);
  const isForward = /^\s*(fwd|fw|enc|encaminh)/i.test(subject)
    || /-{2,}\s*(forwarded message|mensagem encaminhada)/i.test(bodyText)
    || /^\s*De:\s.+\bPara:/im.test(bodyText);
  const clean = ((isForward || stripped.trim().length < 20) ? bodyText : stripped || subject).slice(0, 8000);
  const threadTitle = `📧 ${(normalizeSubject(subject) || 'E-mail').slice(0, 80)}`;

  const res = await deps.runConversation(agent, user.id, clean, threadTitle);
  const reply = typeof res === 'string' ? res : res?.text;
  if (!reply) {
    if (messageId) await deps.markEmailSeen(messageId, user.id);
    return 'skipped';
  }
  // If SMTP fails here, the retry re-runs the conversation (duplicate turn in
  // the thread). Accepted trade-off: better to reply late than to disappear.
  await sendReply({ to: fromAddr, subject, agentName: agent.name, text: reply, inReplyTo: messageId, references: parsed.references });
  console.log(`[email] replied to ${fromAddr} as "${agent.name}" (subject: ${subject.slice(0, 50)})`);
  if (messageId) await deps.markEmailSeen(messageId, user.id);
  return 'done';
}

// A SINGLE IMAP pass (quick): downloads the unread ones, ENQUEUES them in
// Postgres, marks \Seen and closes. The processing (which can call the model
// and take minutes) happens afterward, outside the IMAP socket, reading from
// the queue — see drainQueue.
// Order per item: enqueue BEFORE \Seen. If the process crashes between the
// two, the email stays unread and re-enters on the next poll (the duplicate
// row in the queue is neutralized by the Message-ID dedup at processing time).
async function pollOnce(deps) {
  const { ImapFlow } = await import('imapflow');
  const dbg = process.env.EMAIL_DEBUG === '1';
  const t0 = process.hrtime.bigint();
  const el = () => `+${(Number(process.hrtime.bigint() - t0) / 1e6).toFixed(0)}ms`;
  const dlog = dbg ? (...a) => console.log('[email dbg]', el(), ...a) : () => {};
  const dbgLogger = dbg ? {
    debug: (o) => { if (o?.msg) console.log('[email trace]', el(), o.src || '', String(o.msg).slice(0, 120)); },
    info: (o) => { if (o?.msg) console.log('[email trace]', el(), 'info', String(o.msg).slice(0, 120)); },
    warn: (o) => { if (o?.msg) console.log('[email trace]', el(), 'warn', String(o.msg).slice(0, 120)); },
    error: (o) => { if (o?.msg) console.log('[email trace]', el(), 'error', String(o.msg).slice(0, 120)); },
  } : false;
  const client = new ImapFlow({
    host: process.env.EMAIL_IMAP_HOST || 'imap.gmail.com',
    port: Number(process.env.EMAIL_IMAP_PORT || 993),
    secure: true,
    auth: { user: process.env.EMAIL_ADDRESS, pass: process.env.EMAIL_APP_PASSWORD },
    logger: dbgLogger,
    // Without this, ImapFlow's default is ~5min: a stuck socket/teardown would
    // leave the poller "busy" stuck for 5min (no email read in the meantime).
    // Short = fails fast and the next tick reopens. disableAutoIdle: we poll,
    // we don't IDLE.
    greetingTimeout: 15000,
    socketTimeout: 60000,
    disableAutoIdle: true,
  });
  if (dbg) { dlog('new client'); client.on('close', () => dlog('socket close')); }
  // ImapFlow is an EventEmitter: on a socket timeout it emits 'error'
  // ASYNCHRONOUSLY (outside the connect/fetch await), so the tick's try/catch
  // does NOT catch it. Without a listener, Node brings down the WHOLE PROCESS
  // (server crash). This listener neutralizes that; we just log and let the
  // next tick reopen.
  client.on('error', (e) => { console.error('[email] imap error:', e?.code || e?.message || e); });

  dlog('connect start');
  await client.connect();
  dlog('connect done');
  const lock = await client.getMailboxLock('INBOX');
  dlog('lock acquired');
  try {
    // Drains the WHOLE FETCH first (no STORE in the middle of streaming:
    // issuing a command during an in-progress fetch locks the connection until
    // socketTimeout — that was why the poller stalled with accumulated email).
    // Ceiling per tick so it doesn't pull hundreds at once.
    const MAX_PER_TICK = 10;
    const items = [];
    for await (const msg of client.fetch({ seen: false }, { source: true, uid: true })) {
      items.push({ uid: msg.uid, source: msg.source });
      if (items.length >= MAX_PER_TICK) break;
    }
    dlog(`fetch drained: ${items.length}`);
    // Now, with no fetch in progress, it's safe to enqueue and mark \Seen.
    // \Seen only after the INSERT: if the enqueue fails (DB down), the email
    // stays unread and comes back on the next poll.
    for (const it of items) {
      try {
        await deps.enqueueEmail(it.source);
        await client.messageFlagsAdd(it.uid, ['\\Seen'], { uid: true });
      } catch (e) { console.error('[email] enqueue:', e?.message ?? e); }
    }
  } finally {
    lock.release();
    // logout()/close() can HANG; we don't let the teardown hold up the tick.
    await Promise.race([client.logout().catch(() => {}), new Promise((r) => setTimeout(r, 5000))]);
    try { client.close(); } catch { /* ok */ }
  }
}

// Processes the queue (including leftovers from a crash/restart and send retries).
// Runs OUTSIDE the IMAP connection; an LLM turn can take minutes without a problem.
async function drainQueue(deps) {
  const { simpleParser } = await import('mailparser');
  const rows = await deps.claimPendingEmails(10);
  for (const row of rows) {
    try {
      const parsed = await simpleParser(row.source);
      const outcome = await handleEmail(parsed, deps);
      if (outcome === 'defer') { await deps.unclaimEmail(row.id); continue; }
      await deps.settleEmail(row.id, outcome === 'done' ? 'done' : 'skipped');
    } catch (e) {
      const msg = String(e?.message ?? e).slice(0, 500);
      console.error(`[email] queue #${row.id} (attempt ${row.attempts}):`, msg);
      // Goes back to 'pending' keeping the attempts already spent; the next
      // claim buries it in 'failed' once the ceiling is hit.
      await deps.settleEmail(row.id, 'pending', msg).catch(() => {});
    }
  }
}

// Creates the poller. Connects on every tick (robust against a stale
// connection); reentrancy protected by `busy`. deps injected by the server
// (avoids a circular import).
export function createEmailPoller(deps) {
  let stopped = false, busy = false, timer = null;
  const intervalMs = Number(process.env.EMAIL_POLL_MS || 30000);
  function schedule() { if (!stopped) timer = setTimeout(tick, intervalMs); }
  async function tick() {
    if (stopped || busy) return schedule();
    busy = true;
    try {
      // Backstop: if pollOnce hangs despite IMAP's timeouts, the guard releases
      // `busy` (otherwise the poller stops for good until the next restart). Now
      // pollOnce is IMAP-ONLY (fast); 120s is generous.
      await Promise.race([
        pollOnce(deps),
        new Promise((_, rej) => setTimeout(() => rej(new Error('poll timeout (guard)')), 120000)),
      ]);
    } catch (e) { console.error('[email] poll:', e?.message ?? e); }
    try {
      // The queue runs even with IMAP down (retries/leftovers). It can take
      // minutes (LLM turns); the wide guard only releases busy on a real hang —
      // duplicate reprocessing is blocked by the claim ('working' + attempts).
      await Promise.race([
        drainQueue(deps),
        new Promise((_, rej) => setTimeout(() => rej(new Error('drain timeout (guard)')), 900000)),
      ]);
    } catch (e) { console.error('[email] queue:', e?.message ?? e); }
    finally { busy = false; schedule(); }
  }
  return {
    start() {
      if (!emailEnabled()) { console.log('[email] inactive (missing EMAIL_ADDRESS/EMAIL_APP_PASSWORD)'); return; }
      console.log(`[email] poller active (${process.env.EMAIL_ADDRESS}, every ${intervalMs}ms)`);
      tick();
    },
    stop() { stopped = true; if (timer) clearTimeout(timer); },
  };
}
