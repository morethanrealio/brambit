// ── Sign-up with a password (HTTP side) ──
// /api/signup, /api/signup/confirm and /api/signup/resend, plus the piece of
// /api/login that answers a sign-up still waiting for its link. The request
// itself (table, link, confirmation) lives in signup-confirmation.mjs; this is
// the server's half, kept out of server.mjs.
//
// Sign-up asks for the e-mail first: the account is only created when the link
// sent to that e-mail is opened. An installation that can't send e-mail (no
// SMTP/Resend) creates the account on the spot, as before: there would be no
// way to confirm.
//
// deps: the server's send/fail/readBody/tooManyRequests/rateLimit, the pool, the
// message catalog (i18n), the account functions (getUserByEmail, purgeUser,
// criarConta, createUser, createReferredUserByCode, referralCodeExists,
// setUserLocaleIfEmpty, createSession), permissoes, empresaStore and
// language(req) = the language a new account starts with.
import { createPendingSignupStore, confirmRequest, matchingRequest } from './signup-confirmation.mjs';
import { hashPassword, verifyPassword, newToken, sessionCookie, validEmail } from './auth.mjs';
import { sendEmail, mailEnabled } from './mailer.mjs';
import { marca, siteDaMarca, hostDaMarca } from './brand.mjs';

export function registerSignupRoutes(rotas, d) {
  const { send, fail, readBody, tooManyRequests, rateLimit } = d;
  const pendingSignups = createPendingSignupStore(d.pool);
  const mailLimit = (em) => rateLimit(`confirm-mail:${em}`, 5, 60 * 60_000);

  // The confirmation link, in the language of the screen the person is on
  // (emails.confirm_signup in web/locales). Returns whether it went out.
  async function sendConfirmation(email, language, token) {
    const base = (process.env.PUBLIC_BASE_URL || siteDaMarca()).replace(/\/$/, '');
    const vars = {
      brand: marca().nome,
      support: marca().suporte || process.env.ADMIN_EMAIL || hostDaMarca(),
      link: `${base}/confirm-email?token=${token}`,
    };
    const t = (k) => d.i18n.t(`emails.confirm_signup.${k}`, language, vars);
    try {
      await sendEmail({ to: email, subject: t('subject'), text: t('body'), fromName: marca().nome });
      return true;
    } catch (e) {
      console.error('[signup] confirmation e-mail not sent:', e?.message ?? e);
      return false;
    }
  }

  // Creates the account of a sign-up (on the spot, or when the link is
  // confirmed). A code that ran out of invites in between doesn't stop the
  // account: the person was let in when they signed up.
  async function createAccount({ name, email, passwordHash, referralCode, language }) {
    const dados = { name, email, passwordHash };
    const user = (referralCode && await d.criarConta(d.createReferredUserByCode, { ...dados, code: referralCode }, 'convite'))
      || await d.criarConta(d.createUser, dados, 'email');
    // Failing here can't break a sign-up that succeeded: worst case the person
    // has no stored language and gets the default.
    try { await d.setUserLocaleIfEmpty(user.id, { language }); }
    catch (e) { console.warn('[signup] browser language not saved:', e?.message || e); }
    return user;
  }

  rotas.registrar('POST', '/api/signup', async (req, res) => {
    if (tooManyRequests(req, res, 'signup', 5, 60 * 60_000)) return;
    // The app has no cookie jar: it gets the session token in the body (see /api/login).
    const mobileClient = String(req.headers['x-brambs-mobile'] || '') === '1';
    const { name, email, password, referralCode, confirmEmailScreen } = await readBody(req);
    if (!name || !validEmail(email) || !password || password.length < 12)
      return send(res, 400, { error: 'server.signup_fields_invalid' });
    const em = email.toLowerCase();
    try {
      const existente = await d.getUserByEmail(em);
      if (existente && !existente.deleted_at) return send(res, 409, { error: 'server.email_already_has_account' });

      const code = /^\d{4}$/.test(String(referralCode || '').trim()) ? String(referralCode).trim() : '';
      const fila = await d.permissoes.filaDeEspera();
      // The way in. A code only counts while it has invites left.
      // No code (or a bad code) and the beta still has room: get in anyway.
      // Rule of 2026-08-28: sign-up is open up to the cap; the code isn't the
      // door. Since the free-first-month switch, EVERY new sign-up starts on
      // Básico for one cycle (conta_criada event), so what the code adds is
      // the 500-credit bonus for both sides when the referred user
      // subscribes, and entry once the beta cap is hit.
      // Someone invited to a company skips the queue: the invite is their seat.
      let via = null;
      if (await d.permissoes.liberadoNoCadastro(em)) via = 'email';
      else if (code && await pendingSignups.codeHasRoom(code)) via = 'convite';
      if (!via && (!fila || await d.empresaStore.temConvitePendente(em))) via = 'email';
      if (!via) {
        const codeExists = code ? await d.referralCodeExists(code) : false;
        const reason = !code ? 'sem_codigo' : (codeExists ? 'sem_convite' : 'codigo_invalido');
        const naFila = await d.permissoes.entrarNaFila({ email: em, name, referrerCode: code, reason });
        if (!naFila) return send(res, 403, { error: 'server.signups_closed' });
        return send(res, 200, { queued: true, message: naFila.mensagem });
      }
      // New account language: first what the person CHOSE in the site
      // selector, only then the browser's guess. Whoever read the site in
      // English and clicked sign up does the whole onboarding in English,
      // with the account already in English. Country NOT: stays NULL until
      // there's evidence (CEP/CPF).
      const dados = { name, email: em, passwordHash: hashPassword(password), referralCode: via === 'convite' ? code : null, language: d.language(req) };

      if (mailEnabled()) {
        if (!mailLimit(em)) return send(res, 429, { error: 'server.too_many_attempts' });
        const token = newToken();
        await pendingSignups.add(dados, token);
        const sent = await sendConfirmation(em, res.idiomaResposta, token);
        // Older app builds show an error's text in an alert and do nothing with a 200
        // without a session, so they get the instructions as an "error". Newer builds
        // have their own check-your-e-mail screen and say so in the body.
        if (mobileClient && confirmEmailScreen !== true) return send(res, 403, { error: sent ? 'server.confirm_email_sent' : 'server.confirm_email_not_sent' });
        return send(res, 200, { confirmEmail: true, email: em, sent });
      }

      // Sign-up with the SAME e-mail as an account that requested deletion and is
      // still within the 30-day window: `users.email` is UNIQUE, so either we
      // destroy the old one now or the person is stuck 30 days unable to come back.
      // We destroy it. Asking them to sign up again would give up the regret window,
      // and the data they asked to erase can't reappear inside a new account.
      if (existente) await d.purgeUser(existente);
      const user = await createAccount(dados);
      // Account created: we DON'T send e-mail here. The daily onboarding job
      // detects the new account and sends the first-access e-mail the next day.
      const token = newToken();
      await d.createSession(token, user.id);
      return send(res, 200, { name: user.name, agents: [], ...(mobileClient ? { token } : {}) }, { 'set-cookie': sessionCookie(token) });
    } catch (e) {
      return fail(res, 500, 'server.failed_create_account', e);
    }
  });

  // The button on the page the confirmation link opens. Only this POST creates
  // the account: e-mail scanners open links by themselves, and a GET that
  // confirmed would confirm for whoever never read the e-mail. No session comes
  // back: the person logs in with e-mail and password, which proves they are the
  // one who signed up (a link can be forwarded, a password isn't in the e-mail).
  rotas.registrar('POST', '/api/signup/confirm', async (req, res) => {
    if (tooManyRequests(req, res, 'signup-confirm', 20, 15 * 60_000)) return;
    const { token } = await readBody(req);
    try {
      const r = await confirmRequest(pendingSignups, String(token || ''), {
        getUserByEmail: d.getUserByEmail, purgeUser: d.purgeUser,
        createAccount: (p) => createAccount({ name: p.name, email: p.email, passwordHash: p.password_hash, referralCode: p.referral_code, language: p.language }),
      });
      if (!r) return send(res, 400, { error: 'server.confirm_link_invalid' });
      return send(res, 200, { ok: true, email: r.email });
    } catch (e) {
      return fail(res, 500, 'server.failed_create_account', e);
    }
  });

  // "Send it again" on the confirm-your-e-mail screen. Asks for the password of
  // the sign-up (the screen still has it): without it, anyone could make us mail
  // any address.
  rotas.registrar('POST', '/api/signup/resend', async (req, res) => {
    if (tooManyRequests(req, res, 'signup-resend', 10, 60 * 60_000)) return;
    const { email, password } = await readBody(req);
    if (!validEmail(email) || !password) return send(res, 400, { error: 'server.enter_email_and_password' });
    const em = email.toLowerCase();
    try {
      const pedido = mailEnabled() ? matchingRequest(await pendingSignups.forEmail(em), password, verifyPassword) : null;
      if (!pedido) return send(res, 400, { error: 'server.confirm_request_not_found' });
      if (!mailLimit(em)) return send(res, 429, { error: 'server.too_many_attempts' });
      const token = newToken();
      if (!await pendingSignups.reissue(pedido.id, token)) return send(res, 400, { error: 'server.confirm_request_not_found' });
      const sent = await sendConfirmation(em, res.idiomaResposta, token);
      return send(res, 200, { ok: true, sent });
    } catch (e) {
      return fail(res, 500, 'server.failed_create_account', e);
    }
  });

  return {
    // For initDb (runs with the other schemas at boot).
    esquema: () => pendingSignups.ensureSchema(),
    // Google/Apple vouched for the e-mail: sign-ups waiting for confirmation
    // with it (maybe someone else's, with a password they know) are discarded.
    clear: (email) => pendingSignups.clear(email),
    // /api/login with no live account for the e-mail. Signed up but never
    // opened the link: say so (only to whoever typed that sign-up's password)
    // and, if the link already expired, send a new one. true = answered.
    async loginPending(res, em, password) {
      if (!mailEnabled()) return false;
      const pedido = matchingRequest(await pendingSignups.forEmail(em), password, verifyPassword);
      if (!pedido) return false;
      let sent;
      if (!pedido.link_valid && mailLimit(em)) {
        const token = newToken();
        if (await pendingSignups.reissue(pedido.id, token)) sent = await sendConfirmation(em, res.idiomaResposta, token);
      }
      send(res, 403, { error: 'server.confirm_email_first', confirmEmail: true, email: em, ...(sent === undefined ? {} : { sent }) });
      return true;
    },
  };
}
