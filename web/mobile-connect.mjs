// ── Connecting Google and the other providers FROM THE APP ──
// The site's /api/connect/<prov>/start needs a browser session, and the app has
// none: it keeps its session token in SecureStore and sends it as a Bearer. The
// browser the app opens for the provider's consent doesn't carry that token, and
// the site's callback sends the person to the web home, never back to the app.
// So the app goes through here:
//  1. POST /api/mobile/connect (Bearer) {provider, services?, hint?} -> {code}:
//     a single-use start code bound to the person.
//  2. It opens /api/mobile/connect/start?c=CODE in an auth session that waits
//     for brambs://connect. The start keeps the OAuth state on the server (whose
//     flow, which provider, the PKCE verifier) and goes on to the provider.
//  3. The provider comes back to the usual callback, where handleCallback() below
//     recognizes the state, saves NOTHING and hands the auth session
//     brambs://connect?provider=P&f=FINISH (or &outcome=cancelled|failed).
//  4. The app sends POST /api/mobile/connect/finish (Bearer) {f}. Only the session
//     that started the flow can finish it; only then the code is exchanged and
//     the connection saved, with the same rules as the site (connect-save.mjs).
// Step 4 is what stops a start link sent to someone else from attaching their
// account to the sender's: whoever authorizes gets the finish code on their own
// device, and their app (another person's session) is refused.
// Same scopes and same redirect URIs as the site: nothing changes at the providers.
import { newToken, googleEnabled, googleAuthUrl, scopesFor, googleAccountFromCode, stateCookie, clearStateCookie, oauthStateOk } from './auth.mjs';
import { PROVIDER_NAMES, providerEnabled, providerAuthUrl, providerExchange, providerUsesPkce, newPkceVerifier } from './providers.mjs';
import { microsoftOnboardingScope } from './microsoft-scopes.mjs';

const START_TTL_MS = 2 * 60_000; // from the tap to the browser opening
const STATE_TTL_MS = 30 * 60_000; // same as the ostate cookie (consent can take a while)
const FINISH_TTL_MS = 5 * 60_000; // from the deep link to the app's finish call
const APP_LINK = 'brambs://connect';
const GOOGLE_SERVICES = 'gmail,drive,docs,calendar'; // same default as /api/connect/google/start

const CALLBACK_RE = new RegExp(`^/api/(?:connect|auth)/(google|${PROVIDER_NAMES.join('|')})/callback$`);

export function createCodeStore(ttlMs) {
  const codes = new Map();
  return {
    put(entry) {
      const code = newToken();
      codes.set(code, { ...entry, exp: Date.now() + ttlMs });
      return code;
    },
    // Single use: the entry goes away on the first read, expired or not.
    take(code) {
      const e = typeof code === 'string' && codes.get(code);
      if (!e) return null;
      codes.delete(code);
      return Date.now() > e.exp ? null : e;
    },
    sweep(now = Date.now()) { for (const [k, e] of codes) if (now > e.exp) codes.delete(k); },
  };
}

// deps: the server's send/fail/readBody and save = createConnectSave(...).
// exchange is only swapped in tests ({ google(code), provider(prov, code, opts) }).
export function registerMobileConnect(rotas, deps) {
  const { send, fail, readBody, save } = deps;
  const exchange = deps.exchange || { google: googleAccountFromCode, provider: providerExchange };
  const starts = createCodeStore(START_TTL_MS);
  const states = createCodeStore(STATE_TTL_MS);
  const finishes = createCodeStore(FINISH_TTL_MS);
  setInterval(() => { starts.sweep(); states.sweep(); finishes.sweep(); }, 5 * 60_000).unref();

  rotas.registrar('POST', '/api/mobile/connect', async (req, res, url, ctx) => {
    const user = await ctx.currentUser();
    if (!user) return send(res, 401, { error: 'server.log_in_first' });
    const body = await readBody(req);
    const provider = String(body?.provider || '');
    const hint = String(body?.hint || '').toLowerCase().trim();
    let services = body?.services == null ? undefined : String(body.services);
    if (provider === 'google') {
      if (!googleEnabled()) return send(res, 503, { error: 'server.google_not_set_up' });
      services = services ?? GOOGLE_SERVICES;
      if (!scopesFor(services.split(',').map((s) => s.trim())).length) return send(res, 400, { error: 'server.no_valid_service' });
    } else if (PROVIDER_NAMES.includes(provider)) {
      if (!providerEnabled(provider)) return send(res, 503, { error: 'server.provider_not_set_up' });
      if (provider !== 'microsoft') services = undefined;
      if (services !== undefined) {
        try { microsoftOnboardingScope(services); } catch { return send(res, 400, { error: 'server.invalid_calendar_services' }); }
      }
    } else {
      return send(res, 400, { error: 'server.invalid_provider' });
    }
    return send(res, 200, { code: starts.put({ userId: String(user.id), provider, services, hint }) });
  });

  rotas.registrar('GET', '/api/mobile/connect/start', async (req, res, url) => {
    const s = starts.take(url.searchParams.get('c'));
    if (!s) return backToApp(res, '', 'outcome=failed', 'start code invalid or expired');
    const verifier = s.provider !== 'google' && providerUsesPkce(s.provider) ? newPkceVerifier() : null;
    const state = states.put({ userId: s.userId, provider: s.provider, verifier }); // the OAuth state itself
    const location = s.provider === 'google'
      ? googleAuthUrl(state, { scopes: scopesFor(s.services.split(',').map((x) => x.trim())), loginHint: s.hint })
      : providerAuthUrl(s.provider, state, { codeVerifier: verifier, services: s.services });
    // Same cookie as the site's flow: the callback must come back to the browser
    // that started it.
    res.writeHead(302, { Location: location, 'set-cookie': stateCookie(state, s.userId) });
    return res.end();
  });

  rotas.registrar('POST', '/api/mobile/connect/finish', async (req, res, url, ctx) => {
    const user = await ctx.currentUser();
    if (!user) return send(res, 401, { error: 'server.log_in_first' });
    const f = finishes.take((await readBody(req))?.f);
    if (!f) return send(res, 400, { error: 'server.invalid_or_expired_code' });
    if (f.userId !== String(user.id)) {
      console.warn(`[oauth] mobile ${f.provider} finish refused: flow started by another user (user ${user.id})`);
      return send(res, 400, { error: 'server.invalid_or_expired_code' });
    }
    try {
      let outcome;
      if (f.provider === 'google') {
        const g = await exchange.google(f.code);
        if (!g) return send(res, 400, { error: 'server.failed_connect' });
        outcome = await save.google(user.id, g.email, g.acct);
      } else {
        const tok = await exchange.provider(f.provider, f.code, { codeVerifier: f.verifier });
        if (!tok?.access_token) return send(res, 400, { error: 'server.failed_connect' });
        outcome = await save.provider(user.id, f.provider, tok);
      }
      if (outcome === 'empresa_dominio') return send(res, 403, { error: 'server.connection_domain_refused', outcome });
      return send(res, 200, { ok: true, provider: f.provider });
    } catch (e) {
      return fail(res, 502, 'server.failed_connect', e);
    }
  });

  // The provider's callback for a flow the app started. Runs before the site's
  // callbacks in server.mjs; true = answered (the state was one of ours).
  async function handleCallback(req, res, url) {
    if (req.method !== 'GET') return false;
    const m = url.pathname.match(CALLBACK_RE);
    const state = m && url.searchParams.get('state');
    const s = state && states.take(state);
    if (!s) return false;
    const provider = s.provider;
    if (m[1] !== provider) return backToApp(res, provider, 'outcome=failed', `callback of ${m[1]}`);
    if (!oauthStateOk(req, state, s.userId)) return backToApp(res, provider, 'outcome=failed', 'state does not match the cookie');
    const err = url.searchParams.get('error');
    if (err) return backToApp(res, provider, `outcome=${err === 'access_denied' ? 'cancelled' : 'failed'}`, `provider returned error=${err}`);
    const code = url.searchParams.get('code');
    if (!code) return backToApp(res, provider, 'outcome=failed', 'no code');
    return backToApp(res, provider, `f=${finishes.put({ userId: s.userId, provider, code, verifier: s.verifier })}`);
  }

  return { handleCallback };
}

// Closes the app's auth session: it is waiting for exactly this scheme.
function backToApp(res, provider, query, refusal) {
  if (refusal) console.error(`[oauth] mobile ${provider || '?'} connection refused: ${refusal}`);
  const p = provider ? `provider=${provider}&` : '';
  res.writeHead(302, { Location: `${APP_LINK}?${p}${query}`, 'set-cookie': clearStateCookie() });
  res.end();
  return true;
}
