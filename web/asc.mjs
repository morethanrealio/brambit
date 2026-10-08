// ── App Store Connect (TestFlight crashes) as vault tools ──
//
// Connector via Apple API key (issuer id + key id + .p8 private key), kept in
// the credentials Vault (provider 'appstoreconnect'): the .p8 stays ENCRYPTED
// in secret_enc; issuer id + key id live in `meta` (they're identifiers, not
// a secret). Each function receives an async `cred()` that returns {
// issuerId, keyId, p8, appId? } or null if the user hasn't connected yet.
// Scoped per user: each assistant only sees the crashes of the app from the
// account THE OWNER connected.
//
// READ-ONLY. ON-DEMAND flow (no push/automatic): the owner asks for the list,
// picks the crash(es), and only then does the assistant download that one's
// full log. Same shape as the other connector tools: { name, description,
// parameters, async run(args) } -> string.
import crypto from 'crypto';
import { marca } from './marca.mjs';

const ASC = 'https://api.appstoreconnect.apple.com';

const ASC_SETUP = () => [
  'Pra eu puxar os crashes do seu TestFlight, conecte sua conta do App Store Connect (o "caminho técnico", guardado com segurança no Cofre):',
  '',
  '1. Em appstoreconnect.apple.com › *Usuários e Acesso* › *Integrações* › *App Store Connect API*, gere uma chave (role *Developer* ou superior). Baixe o arquivo `.p8` (só dá pra baixar uma vez).',
  '2. Anote o *Issuer ID* (topo da página) e o *Key ID* (na linha da chave, é o mesmo do nome do arquivo `AuthKey_XXXX.p8`).',
  `3. Aqui no ${marca().nome}, vá em *Conexões › App Store Connect* e informe Issuer ID, Key ID e o arquivo \`.p8\`.`,
  '',
  'Depois me avisa que eu já listo e baixo os crashes do TestFlight. A chave fica cifrada no cofre; nunca aparece no chat.',
].join('\n');

const ASC_BAD = [
  'A chave do App Store Connect guardada no cofre não autentica mais (a Apple recusou o acesso: chave revogada, expirada ou Issuer/Key ID errados).',
  '',
  'Peça ao usuário pra gerar uma chave nova em App Store Connect › Usuários e Acesso › Integrações e reconectar em *Conexões › App Store Connect*. Não repita a chave no chat.',
].join('\n');

const b64url = (b) =>
  Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// Builds a short-lived (10min) ES256 JWT to authenticate to the App Store
// Connect API. The .p8 is an EC P-256 (PKCS#8) key. dsaEncoding ieee-p1363 =
// JOSE signature (r||s), which is the format Apple expects (not DER).
function ascJwt({ issuerId, keyId, p8 }) {
  const header = { alg: 'ES256', kid: keyId, typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const payload = { iss: issuerId, iat: now, exp: now + 600, aud: 'appstoreconnect-v1' };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const key = crypto.createPrivateKey(p8);
  const sig = crypto.sign('sha256', Buffer.from(signingInput), { key, dsaEncoding: 'ieee-p1363' });
  return `${signingInput}.${b64url(sig)}`;
}

// Authenticated GET. Never throws: returns markers (__notConnected /
// __badKey / __badCredential / __apiError) for the tools to translate into text.
async function aReq(cred, path) {
  const c = await cred();
  if (!c) return { __notConnected: true };
  let token;
  try { token = ascJwt(c); } catch (e) { return { __badKey: String(e?.message || e).slice(0, 200) }; }
  let r;
  try {
    r = await fetch(ASC + path, { headers: { Authorization: `Bearer ${token}` } });
  } catch (e) { return { __apiError: `falha de rede: ${String(e?.message || e).slice(0, 160)}` }; }
  if (r.status === 401 || r.status === 403) return { __badCredential: true, __status: r.status };
  const text = await r.text();
  let json = null;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { __raw: text }; }
  if (!r.ok) {
    const msg = Array.isArray(json?.errors)
      ? json.errors.map((e) => e.title + (e.detail ? `: ${e.detail}` : '')).filter(Boolean).join('; ')
      : (json?.__raw || `HTTP ${r.status}`);
    return { __apiError: String(msg).slice(0, 400), __status: r.status };
  }
  return json;
}

// Translates the error markers into a guidance text (or null if ok).
function errText(j) {
  if (!j) return null;
  if (j.__notConnected) return ASC_SETUP();
  if (j.__badKey) return `A chave .p8 guardada não é uma chave válida (${j.__badKey}). Peça ao usuário pra reconectar em Conexões › App Store Connect.`;
  if (j.__badCredential) return ASC_BAD;
  if (j.__apiError) return `A Apple recusou a consulta (HTTP ${j.__status || '?'}): ${j.__apiError}`;
  return null;
}

// Resolves which app to operate on. If the user pinned an appId in the
// connector, uses it. Otherwise lists the account's apps: 1 app -> uses it;
// several -> returns the list for the owner to choose (no guessing). Returns
// { app } | { pick: [...] } | { err }.
async function resolveApp(cred, hint) {
  const c = await cred();
  if (c?.appId && !hint) return { app: { id: c.appId } };
  const j = await aReq(cred, '/v1/apps?limit=200&fields[apps]=name,bundleId');
  const e = errText(j);
  if (e) return { err: e };
  const apps = (j.data || []).map((a) => ({ id: a.id, name: a.attributes?.name || '', bundleId: a.attributes?.bundleId || '' }));
  if (!apps.length) return { err: 'Nenhum app encontrado nessa conta do App Store Connect.' };
  const h = String(hint || '').trim().toLowerCase();
  if (h) {
    const m = apps.find((a) => a.id === hint || a.bundleId.toLowerCase() === h || a.name.toLowerCase() === h)
      || apps.find((a) => a.name.toLowerCase().includes(h) || a.bundleId.toLowerCase().includes(h));
    if (m) return { app: m };
    return { err: `Não achei o app "${hint}". Apps na conta: ${apps.map((a) => a.name || a.bundleId).join(', ')}.` };
  }
  if (apps.length === 1) return { app: apps[0] };
  return { pick: apps };
}

// Normalizes a crash submission (readable metadata).
function crashSummary(item) {
  const a = item?.attributes || {};
  return {
    id: item.id,
    data: a.createdDate,
    comentario_tester: a.comment || '',
    device: a.deviceModel || '',
    ios: a.osVersion || '',
    build: a.buildBundleId || '',
    tester: a.email || '',
  };
}

export function ascTools({ cred }) {
  return [
    {
      name: 'listar_crashes_testflight',
      description: 'Lists the TestFlight crashes (testers\' crash feedback) of the user\'s app in App Store Connect. Read-only. Use when the owner asks whether there are crashes. Returns each crash with an id, the date, the tester\'s comment, device, iOS version and build. Does NOT download the log yet — the owner chooses which ones to process and then you use baixar_crash_testflight. On-demand flow; never process a crash without the owner asking.',
      parameters: { type: 'object', properties: {
        app: { type: 'string', description: 'Optional. App name or bundle id, if the account has more than one app.' },
        limite: { type: 'number', description: 'How many crashes to list (default 20, max 100), from newest to oldest.' },
      } },
      async run({ app, limite } = {}) {
        const r = await resolveApp(cred, app);
        if (r.err) return r.err;
        if (r.pick) return JSON.stringify({ escolha_o_app: r.pick.map((a) => ({ nome: a.name, bundle: a.bundleId })) });
        const n = Math.min(Math.max(1, Number(limite) || 20), 100);
        // Pulls a batch and sorts client-side by date desc (the API does not guarantee order).
        const j = await aReq(cred, `/v1/apps/${r.app.id}/betaFeedbackCrashSubmissions?limit=200`);
        const e = errText(j);
        if (e) return e;
        const all = (j.data || []).map(crashSummary)
          .sort((x, y) => String(y.data || '').localeCompare(String(x.data || '')));
        if (!all.length) return JSON.stringify({ total: 0, nota: 'Nenhum crash no TestFlight por enquanto.' });
        return JSON.stringify({ total: all.length, mostrando: Math.min(n, all.length), crashes: all.slice(0, n) });
      },
    },
    {
      name: 'baixar_crash_testflight',
      description: 'Downloads the full log (symbolicated by Apple) of one or more TestFlight crashes, by the ids obtained from listar_crashes_testflight. Read-only. Use only on the crashes the owner chooses. Each log is large; download at most 3 at a time. Returns the entire crash log for you to investigate the cause.',
      parameters: { type: 'object', properties: {
        ids: { type: 'array', items: { type: 'string' }, description: 'The ids of the crashes to download (the ones the owner chose from the list).' },
      }, required: ['ids'] },
      async run({ ids } = {}) {
        const list = (Array.isArray(ids) ? ids : [ids]).map((s) => String(s || '').trim()).filter(Boolean);
        if (!list.length) return 'Diga quais crashes baixar (os ids da lista de listar_crashes_testflight).';
        if (list.length > 3) return `Você pediu ${list.length} crashes; baixe no máximo 3 por vez (cada log é grande). Escolha até 3 ids.`;
        const out = [];
        for (const id of list) {
          const meta = await aReq(cred, `/v1/betaFeedbackCrashSubmissions/${encodeURIComponent(id)}`);
          const em = errText(meta);
          if (em) return em; // credential/connection: general failure, stops everything
          const logJ = await aReq(cred, `/v1/betaFeedbackCrashSubmissions/${encodeURIComponent(id)}/crashLog`);
          const el = errText(logJ);
          const summary = crashSummary(meta.data || {});
          out.push({
            ...summary,
            log: el ? `(não consegui baixar o log: ${el})` : (logJ?.data?.attributes?.logText || '(log vazio)'),
          });
        }
        return JSON.stringify({ crashes: out });
      },
    },
  ];
}
