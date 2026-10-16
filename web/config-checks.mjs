// ── Settings checks (admin screen) ──
// Each check tells whether a group of settings works, without doing anything
// with it: a model key lists the models, a mail server logs in and out, a
// WhatsApp number is looked up. Nothing is sent, created or charged.
//
// A check gets the values to try (what the admin typed, falling back to what
// is in use) and answers { ok, reason }. The reason is a short code, never the
// service's answer: an error body can echo the key or other private data.
const TIMEOUT_MS = 8000;

const chatToModels = (url) => String(url).replace(/\/chat\/completions\/?$/, '/models');

// Turns an HTTP status into a result. `good` lists the statuses that mean the
// credential was accepted.
function byStatus(status, good = [200]) {
  if (good.includes(status)) return { ok: true };
  if (status === 401 || status === 403) return { ok: false, reason: 'rejected' };
  return { ok: false, reason: `status_${status}` };
}

const bearer = (key) => ({ authorization: `Bearer ${key}` });

// Models list of an OpenAI-compatible API.
const modelsCheck = (keyName, urlName, defaultUrl) => ({
  keys: [keyName],
  run: async (v, { get }) => byStatus(await get(chatToModels(v[urlName] || defaultUrl), bearer(v[keyName]))),
});

export const CHECKS = {
  together: modelsCheck('TOGETHER_API_KEY', 'TOGETHER_URL', 'https://api.together.xyz/v1/chat/completions'),
  openai: modelsCheck('OPENAI_API_KEY', 'OPENAI_URL', 'https://api.openai.com/v1/chat/completions'),
  deepinfra: modelsCheck('DEEPINFRA_API_KEY', 'DEEPINFRA_URL', 'https://api.deepinfra.com/v1/openai/chat/completions'),
  deepseek: {
    keys: ['DEEPSEEK_API_KEY'],
    run: async (v, { get }) => byStatus(await get('https://api.deepseek.com/models', bearer(v.DEEPSEEK_API_KEY))),
  },
  gemini: {
    keys: ['GEMINI_API_KEY'],
    // Gemini answers 400 (not 401) to an invalid key.
    run: async (v, { get }) => {
      const s = await get('https://generativelanguage.googleapis.com/v1beta/models', { 'x-goog-api-key': v.GEMINI_API_KEY });
      return s === 400 ? { ok: false, reason: 'rejected' } : byStatus(s);
    },
  },
  typesafe: {
    keys: ['TYPESAFE_API_KEY'],
    run: async (v, { get }) => byStatus(await get('https://api.typesafe.ai/v1/models', bearer(v.TYPESAFE_API_KEY))),
  },
  resend: {
    keys: ['RESEND_API_KEY'],
    // A sending-only key cannot list domains: 401 restricted_api_key still
    // proves the key exists.
    run: async (v, { get }) => {
      const s = await get('https://api.resend.com/domains', bearer(v.RESEND_API_KEY), { readName: true });
      if (s.status === 401 && s.name === 'restricted_api_key') return { ok: true };
      return byStatus(s.status);
    },
  },
  smtp: {
    keys: ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS'],
    run: (v, { smtp }) => smtp({ host: v.SMTP_HOST, port: Number(v.SMTP_PORT || 465), user: v.SMTP_USER, pass: v.SMTP_PASS }),
  },
  // The assistant's own inbox: reads with IMAP, replies with SMTP.
  email_inbox: {
    keys: ['EMAIL_ADDRESS', 'EMAIL_APP_PASSWORD'],
    run: async (v, { imap, smtp }) => {
      const auth = { user: v.EMAIL_ADDRESS, pass: v.EMAIL_APP_PASSWORD };
      const read = await imap({ host: v.EMAIL_IMAP_HOST || 'imap.gmail.com', port: Number(v.EMAIL_IMAP_PORT || 993), ...auth });
      if (!read.ok) return { ok: false, reason: `imap_${read.reason}` };
      const send = await smtp({ host: v.EMAIL_SMTP_HOST || 'smtp.gmail.com', port: Number(v.EMAIL_SMTP_PORT || 465), ...auth });
      return send.ok ? send : { ok: false, reason: `smtp_${send.reason}` };
    },
  },
  whatsapp: {
    keys: ['WA_TOKEN', 'WA_PHONE_NUMBER_ID'],
    run: async (v, { get }) => {
      if (!/^\d+$/.test(v.WA_PHONE_NUMBER_ID)) return { ok: false, reason: 'bad_number_id' };
      return byStatus(await get(`https://graph.facebook.com/v21.0/${v.WA_PHONE_NUMBER_ID}?fields=id`, bearer(v.WA_TOKEN)));
    },
  },
  slack: {
    keys: ['SLACK_BOT_TOKEN'],
    // Slack answers 200 with { ok:false } to a bad token.
    run: async (v, { post }) => {
      const r = await post('https://slack.com/api/auth.test', bearer(v.SLACK_BOT_TOKEN));
      if (r.status !== 200) return byStatus(r.status);
      return r.json?.ok ? { ok: true } : { ok: false, reason: 'rejected' };
    },
  },
  serpapi: {
    keys: ['SERPAPI_KEY'],
    run: async (v, { get }) => byStatus(await get(`https://serpapi.com/account.json?api_key=${encodeURIComponent(v.SERPAPI_KEY)}`, {})),
  },
  // Code sandbox (runnerd): a request with the token and no person in it is
  // refused with 400 when the token is right, 401 when it is wrong.
  sandbox: {
    keys: ['SANDBOX_URL', 'SANDBOX_TOKEN'],
    run: async (v, { post }) => {
      const r = await post(new URL('/stop', v.SANDBOX_URL).href, bearer(v.SANDBOX_TOKEN));
      return byStatus(r.status, [400]);
    },
  },
};

// The checks a group of settings can run: those whose keys are all in it.
export const checksFor = (keys) => Object.entries(CHECKS)
  .filter(([, c]) => c.keys.every((k) => keys.includes(k)))
  .map(([name]) => name);

function networkReason(e) {
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return 'timeout';
  // The mail libraries wrap the socket error (code ESOCKET, cause in the message).
  const code = `${e?.code ?? ''} ${e?.cause?.code ?? ''} ${e?.message ?? ''}`;
  if (/ENOTFOUND|EAI_AGAIN/.test(code)) return 'host_not_found';
  if (/ECONNREFUSED/.test(code)) return 'connection_refused';
  if (e instanceof TypeError && /URL/i.test(e.message)) return 'bad_url';
  return 'unreachable';
}

// Network helpers the checks use. Tests pass fakes.
export function defaultTools({ fetchFn = fetch, timeoutMs = TIMEOUT_MS } = {}) {
  const call = async (url, method, headers, { readName } = {}) => {
    const r = await fetchFn(url, { method, headers, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    let json = null;
    if (readName || method === 'POST') { try { json = await r.json(); } catch { /* not JSON */ } }
    else await r.body?.cancel?.();
    return { status: r.status, json, name: json?.name };
  };
  return {
    get: async (url, headers, opts) => {
      const r = await call(url, 'GET', headers, opts);
      return opts?.readName ? r : r.status;
    },
    post: (url, headers) => call(url, 'POST', { ...headers, 'content-type': 'application/json' }),
    smtp: async ({ host, port, user, pass }) => {
      const { default: nodemailer } = await import('nodemailer');
      const t = nodemailer.createTransport({
        host, port, secure: port === 465, auth: { user, pass },
        connectionTimeout: timeoutMs, greetingTimeout: timeoutMs, socketTimeout: timeoutMs,
      });
      try { await t.verify(); return { ok: true }; }
      catch (e) { return { ok: false, reason: e?.code === 'EAUTH' ? 'rejected' : networkReason(e) }; }
      finally { t.close(); }
    },
    imap: async ({ host, port, user, pass }) => {
      const { ImapFlow } = await import('imapflow');
      const c = new ImapFlow({ host, port, secure: true, auth: { user, pass }, logger: false, greetingTimeout: timeoutMs, socketTimeout: timeoutMs });
      c.on('error', () => {});
      try { await c.connect(); await c.logout(); return { ok: true }; }
      catch (e) { return { ok: false, reason: e?.authenticationFailed ? 'rejected' : networkReason(e) }; }
      finally { c.close(); }
    },
  };
}

// Runs one check. A missing setting is reported before anything is called.
export async function runCheck(name, values, tools = defaultTools()) {
  const check = CHECKS[name];
  if (!check) return { ok: false, reason: 'unknown_check' };
  const missing = check.keys.filter((k) => !String(values[k] ?? '').trim());
  if (missing.length) return { ok: false, reason: 'missing', missing };
  try { return await check.run(values, tools); }
  catch (e) { return { ok: false, reason: networkReason(e) }; }
}
