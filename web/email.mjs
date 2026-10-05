// ── Canal E-mail (ingest por IMAP + resposta por SMTP, como o assistente) ──
// O usuário manda um e-mail de QUALQUER endereço @exemplo.com. O catch-all do
// Google Workspace reescreve o envelope pra EMAIL_ADDRESS (assistente@exemplo.com),
// então tudo cai numa caixa só. A gente lê essa caixa por IMAP, identifica o
// usuário pelo REMETENTE (= e-mail de cadastro), escolhe o assistente pelo nome
// escrito no assunto/corpo ("aos cuidados de <nome>") e responde por SMTP como o
// assistente ("Bento <assistente@exemplo.com>").
//
// Segurança / anti-abuso:
//  • só responde a remetentes REGISTRADOS (From = e-mail de cadastro) — impede
//    que um estranho acione o assistente de outra pessoa;
//  • verifica a AUTENTICAÇÃO do remetente (DKIM/DMARC) antes de confiar no From:
//    o From (RFC5322) é trivialmente forjável no SMTP, então um estranho poderia
//    escrever "From: fulano-registrado@dominio" e acionar o assistente dele. A
//    gente lê o Authentication-Results CARIMBADO PELO NOSSO MX (mx.google.com) —
//    o único que o atacante não consegue forjar, porque o Google remove os A-R
//    pré-existentes com o próprio authserv-id — e exige DMARC=pass (ou DKIM=pass
//    quando o domínio não publica DMARC). Ver passesEmailAuth();
//  • ignora auto-respostas / no-reply / mailer-daemon / listas e o próprio
//    endereço (anti-loop);
//  • dedup por Message-ID (tabela email_seen) + fila persistente (email_queue):
//    o raw baixado vive no Postgres até a resposta SAIR; crash/SMTP-fail não
//    perde mensagem (retry com teto de tentativas);
//  • rate-limit por usuário (lição de um flood real);
//  • o gate de crédito já existe dentro de runConversationInThread.
//
// Env:
//   EMAIL_ADDRESS=assistente@exemplo.com
//   EMAIL_APP_PASSWORD=<senha de app do Google (2FA)>
//   EMAIL_IMAP_HOST=imap.gmail.com   EMAIL_IMAP_PORT=993
//   EMAIL_SMTP_HOST=smtp.gmail.com   EMAIL_SMTP_PORT=465
//   EMAIL_POLL_MS=30000
// Sem EMAIL_ADDRESS/EMAIL_APP_PASSWORD o canal fica inerte (não conecta).

export function emailEnabled() {
  return !!(process.env.EMAIL_ADDRESS && process.env.EMAIL_APP_PASSWORD);
}

const SELF = () => (process.env.EMAIL_ADDRESS || '').toLowerCase().trim();

// Tira "Re:/Fwd:/Enc:/Res:" repetidos do começo do assunto (pra threadear
// respostas no mesmo tópico).
export function normalizeSubject(s) {
  let out = (s || '').trim();
  let prev;
  do { prev = out; out = out.replace(/^\s*(re|fwd?|enc|res|encaminhada?|in)\s*:\s*/i, ''); } while (out !== prev);
  return out.trim();
}

// Corta o histórico citado (respostas anteriores) pra mandar só o texto novo.
export function stripQuoted(text) {
  if (!text) return '';
  const lines = String(text).split(/\r?\n/);
  const out = [];
  for (const line of lines) {
    if (/^\s*>/.test(line)) break;                                          // citação ">"
    if (/^\s*(Em|On)\s+.+\b(escreveu|wrote)\s*:?\s*$/i.test(line)) break;    // "Em <data>, X escreveu:"
    if (/^\s*-{2,}\s*(Mensagem original|Original Message|Forwarded message|Início da mensagem)/i.test(line)) break;
    if (/^_{5,}\s*$/.test(line)) break;
    if (/^\s*De:\s.+\bPara:/i.test(line)) break;                            // cabeçalho de encaminhamento
    out.push(line);
  }
  return out.join('\n').trim();
}

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Escolhe o assistente pelo nome escrito no e-mail. Procura "aos cuidados de X"
// / "a/c X" primeiro; senão qualquer nome de assistente citado no texto.
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

// Detecta remetentes que NÃO devem ser respondidos (anti-loop / automáticos).
export function isAutoOrLoop(parsed, fromAddr) {
  if (!fromAddr || fromAddr === SELF()) return true;
  if (/(^|[.@+_-])(no-?reply|noreply|mailer-daemon|postmaster|daemon|bounce|notifications?)([.@+_-]|$)/i.test(fromAddr)) return true;
  const h = parsed.headers; // Map (mailparser), chaves minúsculas
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

// Lê os vereditos de autenticação (dkim/spf/dmarc) do Authentication-Results.
// SÓ confia na linha carimbada pelo NOSSO MX: o authserv-id (o token ANTES do
// primeiro ';') tem que ser EXATAMENTE mx.google.com. Testar só se a string
// aparece na linha não serve: o atacante escreve "Authentication-Results:
// evil.example; dkim=pass header.d=mx.google.com" no próprio e-mail e o Google
// não descarta esse cabeçalho (ele só remove os que usam o authserv-id dele).
// Sem nenhuma linha confiável (e-mail não passou pelo MX Google), trusted=false.
const MX_CONFIAVEL = String(process.env.EMAIL_TRUSTED_AUTHSERV || 'mx.google.com').toLowerCase();

// Extrai o domínio de um valor de propriedade do A-R: "@x.com", "u@x.com" e
// "x.com" viram todos "x.com".
function dominioDe(valor) {
  const v = String(valor || '').toLowerCase().trim().replace(/[.;,]+$/, '');
  if (!v) return null;
  const at = v.lastIndexOf('@');
  const d = (at >= 0 ? v.slice(at + 1) : v).replace(/^\.+|\.+$/g, '');
  return d || null;
}

// Alinhamento de domínio no sentido do DMARC "relaxado", sem lista pública de
// sufixos: igual, ou um é subdomínio do outro (mail.x.com ~ x.com). Não cobre
// dois subdomínios irmãos de um mesmo domínio organizacional, o que é raro e
// cai no caminho inconclusivo, nunca em "forte".
function alinhado(dominio, fromDominio) {
  const d = dominioDe(dominio); const f = dominioDe(fromDominio);
  if (!d || !f) return false;
  return d === f || f.endsWith('.' + d) || d.endsWith('.' + f);
}

// Um Authentication-Results é "authserv-id ; metodo=resultado prop=valor ; ...".
// Devolve null quando o carimbo não é do nosso MX.
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
  // dkim pode aparecer várias vezes (múltiplas assinaturas): pass se QUALQUER uma passa.
  const pick = (arr) => (arr.includes('pass') ? 'pass' : arr.includes('fail') ? 'fail' : arr[0] || null);
  const dkim = daqui('dkim'); const spf = daqui('spf'); const dmarc = daqui('dmarc');
  return {
    trusted: true,
    dmarc: pick(dmarc.map((m) => m.resultado)),
    dkim: pick(dkim.map((m) => m.resultado)),
    spf: pick(spf.map((m) => m.resultado)),
    // Quem ASSINOU de fato (header.d, ou o domínio de header.i). DKIM prova a chave
    // deste domínio, não o From: sem isso não dá pra checar alinhamento.
    dkimDomains: dkim.filter((m) => m.resultado === 'pass')
      .map((m) => dominioDe(m.props['header.d'] || m.props['header.i'])).filter(Boolean),
    spfDomains: spf.filter((m) => m.resultado === 'pass')
      .map((m) => dominioDe(m.props['smtp.mailfrom'] || m.props['smtp.helo'])).filter(Boolean),
  };
}

// Decide se o remetente está autenticado o suficiente pra ser tratado como o dono
// do endereço. Política:
//  • DMARC=pass  -> OK (o próprio DMARC já exige alinhamento, âncora forte).
//  • DMARC=fail  -> REJEITA (spoof de domínio que publica política).
//  • sem DMARC, DKIM=pass ALINHADO com o From -> OK forte.
//  • sem DMARC, SPF=pass ALINHADO com o From -> OK forte.
//  • DKIM=pass de domínio NÃO alinhado, e nada alinhado -> REJEITA. Isso não é
//    ausência de prova, é prova ao contrário: alguém que não é o domínio do From
//    assinou a mensagem. Era exatamente o furo: "dkim=pass header.i=@atacante;
//    dmarc=none header.from=vitima" entrava como identidade forte da vítima.
//  • DKIM=fail E SPF=fail -> REJEITA.
//  • inconclusivo / sem A-R confiável -> fail-OPEN com log (não derruba e-mail
//    legítimo de domínio sem política), a menos que EMAIL_STRICT_AUTH=1.
// fromAddr é o From do RFC5322 (o mesmo que o handler usa pra achar a conta): é
// contra ELE que o alinhamento tem que ser medido.
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

// Rate-limit em memória: no máx 20 e-mails processados por usuário / hora.
const rl = new Map(); // userId -> timestamps[]
function allow(userId) {
  const now = Date.now();
  const arr = (rl.get(userId) || []).filter((t) => now - t < 3600_000);
  if (arr.length >= 20) return false;
  arr.push(now); rl.set(userId, arr);
  return true;
}

// Texto simples -> HTML leve (mesma pegada do mailer).
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

// Responde por SMTP como o assistente (From = "Nome <assistente@exemplo.com>").
// Mantém o threading (In-Reply-To / References) pra cair no mesmo assunto no
// cliente de e-mail do usuário.
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

// Trata um e-mail já parseado (mailparser). deps = { runConversation, getUserByEmail,
// listAgents, emailSeen, markEmailSeen }. Devolve o desfecho pra fila:
//   'skipped' = descartado de propósito (não tentar de novo)
//   'defer'   = adiar sem gastar tentativa (rate-limit)
//   'done'    = resposta enviada
// Erros (conversa/SMTP) SOBEM pro caller, que devolve a linha pra fila (retry).
// email_seen só é marcado quando o caso está RESOLVIDO (respondido ou descartado):
// marcar antes era o que perdia mensagem em silêncio quando o envio falhava.
async function handleEmail(parsed, deps) {
  const fromAddr = (parsed.from?.value?.[0]?.address || '').toLowerCase().trim();
  const messageId = parsed.messageId || '';
  if (!fromAddr) return 'skipped';

  if (isAutoOrLoop(parsed, fromAddr)) { console.log('[email] ignorado (auto/loop):', fromAddr); return 'skipped'; }
  if (messageId && await deps.emailSeen(messageId)) return 'skipped'; // dedup

  const user = await deps.getUserByEmail(fromAddr);
  if (!user) {
    console.log('[email] remetente não registrado, ignorado:', fromAddr);
    if (messageId) await deps.markEmailSeen(messageId, null);
    return 'skipped';
  }
  // Conta que pediu exclusão (Marcos 04/09): o e-mail é o ÚNICO canal de entrada
  // que closeUserAccount não consegue desligar apagando linha — WhatsApp/Telegram/
  // Slack resolvem por link em tabela (apagada lá), aqui a chave é o próprio
  // `users.email`, que tem que continuar existindo pelos 30 dias da janela de
  // arrependimento. Sem esta trava o assistente seguiria respondendo por e-mail
  // depois da exclusão.
  if (user.deleted_at) {
    console.log('[email] conta excluída, ignorado:', fromAddr);
    if (messageId) await deps.markEmailSeen(messageId, user.id);
    return 'skipped';
  }
  // Anti-spoofing: o From é forjável, então só confia se DKIM/DMARC autenticam o
  // remetente. Um e-mail que finge ser de um usuário registrado, mas falha na
  // autenticação, é descartado (não aciona o assistente dele).
  const auth = passesEmailAuth(parsed, fromAddr);
  if (!auth.ok) {
    console.warn('[email] REJEITADO por autenticação (possível spoofing de From):', fromAddr, '—', auth.reason);
    if (messageId) await deps.markEmailSeen(messageId, user.id);
    return 'skipped';
  }
  if (!auth.strong) console.log('[email] autenticação fraca, aceito com ressalva:', fromAddr, '—', auth.reason);
  if (!allow(user.id)) { console.log('[email] rate-limit, adiado:', fromAddr); return 'defer'; }

  const agents = await deps.listAgents(user.id);
  if (!agents.length) {
    console.log('[email] usuário sem assistente:', fromAddr);
    if (messageId) await deps.markEmailSeen(messageId, user.id);
    return 'skipped';
  }

  const subject = (parsed.subject || '(sem assunto)').trim();
  const bodyText = (parsed.text || '').trim();
  const agent = pickAgent(subject + '\n' + bodyText, agents) || agents[0]; // fallback = principal
  // Num ENCAMINHAMENTO o conteúdo útil vai na parte "citada" (o stripQuoted comeria
  // ela e sobraria só a assinatura). Então: se é forward, ou se depois de tirar a
  // citação sobrou quase nada, usa o corpo INTEIRO.
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
  // Se o SMTP falhar aqui, o retry re-roda a conversa (turno duplicado na
  // thread). Trade-off aceito: melhor responder com atraso que sumir.
  await sendReply({ to: fromAddr, subject, agentName: agent.name, text: reply, inReplyTo: messageId, references: parsed.references });
  console.log(`[email] respondido ${fromAddr} como "${agent.name}" (assunto: ${subject.slice(0, 50)})`);
  if (messageId) await deps.markEmailSeen(messageId, user.id);
  return 'done';
}

// Uma passada SÓ de IMAP (rápida): baixa os não-lidos, ENFILEIRA no Postgres,
// marca \Seen e fecha. O processamento (que pode chamar o modelo e levar
// minutos) acontece depois, fora do socket IMAP, lendo da fila — ver drainQueue.
// Ordem por item: enqueue ANTES do \Seen. Se o processo cair entre os dois, o
// e-mail continua não-lido e re-entra no próximo poll (a linha duplicada na
// fila é neutralizada pelo dedup de Message-ID na hora de processar).
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
    // Sem isto o default do ImapFlow é ~5min: um socket/teardown travado deixaria
    // o poller "busy" preso por 5min (nenhum e-mail lido no meio). Curto = falha
    // rápido e o próximo tick reabre. disableAutoIdle: a gente faz polling, não IDLE.
    greetingTimeout: 15000,
    socketTimeout: 60000,
    disableAutoIdle: true,
  });
  if (dbg) { dlog('new client'); client.on('close', () => dlog('socket close')); }
  // ImapFlow é EventEmitter: num timeout de socket ele emite 'error' de forma
  // ASSÍNCRONA (fora do await do connect/fetch), então o try/catch do tick NÃO
  // pega. Sem um listener, o Node derruba o PROCESSO INTEIRO (crash do servidor).
  // Este listener neutraliza isso; só logamos e deixamos o tick seguinte reabrir.
  client.on('error', (e) => { console.error('[email] imap error:', e?.code || e?.message || e); });

  dlog('connect start');
  await client.connect();
  dlog('connect done');
  const lock = await client.getMailboxLock('INBOX');
  dlog('lock acquired');
  try {
    // Drena o FETCH INTEIRO primeiro (nada de STORE no meio do streaming: emitir
    // comando durante um fetch em curso trava a conexão até o socketTimeout —
    // era o motivo do poller estolar com e-mail acumulado). Teto por tick pra não
    // puxar centenas de uma vez.
    const MAX_PER_TICK = 10;
    const items = [];
    for await (const msg of client.fetch({ seen: false }, { source: true, uid: true })) {
      items.push({ uid: msg.uid, source: msg.source });
      if (items.length >= MAX_PER_TICK) break;
    }
    dlog(`fetch drained: ${items.length}`);
    // Agora, sem fetch em curso, é seguro enfileirar e marcar \Seen. O \Seen só
    // depois do INSERT: se o enqueue falhar (DB fora), o e-mail fica não-lido e
    // volta no próximo poll.
    for (const it of items) {
      try {
        await deps.enqueueEmail(it.source);
        await client.messageFlagsAdd(it.uid, ['\\Seen'], { uid: true });
      } catch (e) { console.error('[email] enqueue:', e?.message ?? e); }
    }
  } finally {
    lock.release();
    // logout()/close() podem TRAVAR; não deixamos o teardown segurar o tick.
    await Promise.race([client.logout().catch(() => {}), new Promise((r) => setTimeout(r, 5000))]);
    try { client.close(); } catch { /* ok */ }
  }
}

// Processa a fila (inclusive sobras de crash/restart e retries de envio).
// Roda FORA da conexão IMAP; um turno de LLM pode levar minutos sem problema.
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
      console.error(`[email] fila #${row.id} (tentativa ${row.attempts}):`, msg);
      // Volta pra 'pending' mantendo o attempts já gasto; o claim seguinte
      // enterra em 'failed' quando estourar o teto.
      await deps.settleEmail(row.id, 'pending', msg).catch(() => {});
    }
  }
}

// Cria o poller. Conecta a cada tick (robusto contra conexão velha); reentrância
// protegida por `busy`. deps injetadas pelo server (evita import circular).
export function createEmailPoller(deps) {
  let stopped = false, busy = false, timer = null;
  const intervalMs = Number(process.env.EMAIL_POLL_MS || 30000);
  function schedule() { if (!stopped) timer = setTimeout(tick, intervalMs); }
  async function tick() {
    if (stopped || busy) return schedule();
    busy = true;
    try {
      // Backstop: se pollOnce travar apesar dos timeouts do IMAP, o guard destrava
      // o `busy` (senão o poller para de vez até o próximo restart). Agora o
      // pollOnce é SÓ IMAP (rápido); 120s é folgado.
      await Promise.race([
        pollOnce(deps),
        new Promise((_, rej) => setTimeout(() => rej(new Error('poll timeout (guard)')), 120000)),
      ]);
    } catch (e) { console.error('[email] poll:', e?.message ?? e); }
    try {
      // Fila roda mesmo com o IMAP fora (retries/sobras). Pode levar minutos
      // (turnos de LLM); o guard largo só destrava o busy num travamento real —
      // reprocesso duplicado é bloqueado pelo claim ('working' + attempts).
      await Promise.race([
        drainQueue(deps),
        new Promise((_, rej) => setTimeout(() => rej(new Error('drain timeout (guard)')), 900000)),
      ]);
    } catch (e) { console.error('[email] fila:', e?.message ?? e); }
    finally { busy = false; schedule(); }
  }
  return {
    start() {
      if (!emailEnabled()) { console.log('[email] inerte (faltam EMAIL_ADDRESS/EMAIL_APP_PASSWORD)'); return; }
      console.log(`[email] poller ativo (${process.env.EMAIL_ADDRESS}, cada ${intervalMs}ms)`);
      tick();
    },
    stop() { stopped = true; if (timer) clearTimeout(timer); },
  };
}
