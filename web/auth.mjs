// ── Helpers de autenticação ──
// Hash de senha com scrypt (nativo, sem dependências) e parsing de cookie.

import crypto from 'crypto';

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password, stored) {
  const [salt, hash] = (stored || '').split(':');
  if (!salt || !hash) return false;
  const test = crypto.scryptSync(password, salt, 64);
  const known = Buffer.from(hash, 'hex');
  return test.length === known.length && crypto.timingSafeEqual(test, known);
}

export function newToken() {
  return crypto.randomBytes(32).toString('hex');
}

// Lê um cookie qualquer do header.
export function readCookie(req, name) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) {
      // Cookie com percent-encoding inválido (%%, %zz) faz decodeURIComponent
      // lançar URIError. Como quem lê cookie está dentro do handler async do
      // servidor, esse throw virava rejeição não tratada e derrubava o processo
      // inteiro (achado #21). Valor estragado vale menos que o serviço no ar:
      // devolve o texto cru e quem valida o formato recusa depois.
      const bruto = v.join('=');
      try { return decodeURIComponent(bruto); } catch { return bruto; }
    }
  }
  return null;
}
// O site continua autenticando pelo cookie HttpOnly. O app mobile, por outro
// lado, recebe a sessão no corpo do login e a guarda no SecureStore: tentar
// remontar `Cookie: sid=...` manualmente no fetch do React Native/iOS não é
// confiável. Para o cliente que se identifica explicitamente como mobile,
// aceitamos o mesmo token em Authorization: Bearer.
//
// O Bearer tem precedência sobre um cookie antigo. Assim uma sessão que ficou no
// cookie jar nativo não consegue sobrepor a sessão recém-obtida pelo app. Fora do
// mobile o comportamento permanece byte a byte igual: somente o cookie vale.
const SESSION_TOKEN_RE = /^[0-9a-f]{64}$/;
export function readSid(req) {
  const cookie = readCookie(req, 'sid');
  if (String(req?.headers?.['x-brambs-mobile'] || '') !== '1') return cookie;
  const authorization = String(req?.headers?.authorization || '');
  if (!authorization.startsWith('Bearer ')) return cookie;
  const bearer = authorization.slice(7).trim();
  return SESSION_TOKEN_RE.test(bearer) ? bearer : cookie;
}

// Cookie de sessão: HttpOnly + Secure (https) + SameSite=Lax, válido 30 dias.
export function sessionCookie(token) {
  const days = 30;
  return `sid=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${days * 86400}`;
}

export function clearCookie() {
  return 'sid=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0';
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
export const validEmail = (e) => typeof e === 'string' && EMAIL_RE.test(e);

// ── Login com Google (OAuth 2.0, fluxo authorization code) ──
const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO = 'https://www.googleapis.com/oauth2/v3/userinfo';

export const googleEnabled = () =>
  !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_REDIRECT_URI);

// Escopos dos conectores, por serviço: leitura (read) + escrita (write).
// Pedimos os dois juntos no "Conectar Google"; tokens antigos (só leitura)
// continuam válidos e seguem só lendo até a pessoa reconectar.
// Obs Gmail: o escopo de "write" é gmail.compose (criar/gerir RASCUNHOS). O
// ENVIO não é um escopo separado pedido na conexão; é uma permissão que o
// usuário ativa explicitamente no app (coluna users.email_send_enabled). Sem
// isso, o agente só monta rascunho e não dispara e-mail.
// gmail: read (readonly) + write (compose = rascunho/envio).
// REMOVIDOS 12/08 (OK Marcos): `manage` (gmail.labels) e `settings`
// (gmail.settings.basic). Eles estavam FORA do conjunto verificado (LoV) e faziam
// a tela de consentimento aparecer como "app não verificado" pra todo mundo que
// conectava. Tirar do console do Google não bastava enquanto o código ainda pedia
// (o gatilho é a lista que o NOSSO código envia). Só reintroduzir depois de
// ressubmeter a tela de consentimento pra verificação já incluindo o escopo
// (ver https://support.google.com/cloud/answer/13464018). Custo de tirar: perde
// gerir marcadores (labels) e filtros do Gmail; ler/rascunho/envio seguem.
export const GOOGLE_SCOPES = {
  gmail:    { read: 'https://www.googleapis.com/auth/gmail.readonly',     write: 'https://www.googleapis.com/auth/gmail.compose' },
  drive:    { read: 'https://www.googleapis.com/auth/drive.readonly',     write: 'https://www.googleapis.com/auth/drive.file' },
  docs:     { read: 'https://www.googleapis.com/auth/documents.readonly' },
  calendar: { read: 'https://www.googleapis.com/auth/calendar.readonly',  write: 'https://www.googleapis.com/auth/calendar.events' },
};
const BASE_SCOPE = 'openid email profile';

// URL pra onde mandamos o usuário se autenticar no Google.
//  - login simples: só BASE_SCOPE, online, select_account.
//  - conectar serviços (incremental): BASE + escopos pedidos, offline + consent
//    (pra vir o refresh_token) e include_granted_scopes (mantém o que já tinha).
export function googleAuthUrl(state, { scopes = [], loginHint = '' } = {}) {
  const connect = scopes.length > 0;
  const scope = connect ? [BASE_SCOPE, ...scopes].join(' ') : BASE_SCOPE;
  const p = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: process.env.GOOGLE_REDIRECT_URI,
    response_type: 'code',
    scope,
    state,
    access_type: connect ? 'offline' : 'online',
    // No connect forçamos o seletor de conta + consentimento pra o usuário poder
    // ADICIONAR uma conta Google diferente (multi-conta), não só reusar a ativa.
    prompt: connect ? 'select_account consent' : 'select_account',
  });
  if (connect) p.set('include_granted_scopes', 'true');
  // RECONECTAR uma conta já existente: pré-seleciona o e-mail no Google.
  if (loginHint) p.set('login_hint', loginHint);
  return `${GOOGLE_AUTH}?${p.toString()}`;
}

// Resolve a lista de serviços pedidos (ex: ['gmail','drive']) em escopos
// (leitura + escrita de cada um).
export const scopesFor = (services) =>
  services.flatMap((s) => {
    const def = GOOGLE_SCOPES[s];
    if (!def) return [];
    return Object.values(def).filter(Boolean);
  });

// Quais serviços (gmail/drive/docs/calendar) um conjunto de escopos concedidos
// cobre (presente se tiver pelo menos o escopo de leitura OU o de escrita).
export function servicesFromScope(scope = '') {
  const granted = new Set(scope.split(/\s+/));
  return Object.entries(GOOGLE_SCOPES)
    .filter(([, def]) => (def.read && granted.has(def.read)) || (def.write && granted.has(def.write)))
    .map(([k]) => k);
}

// Capacidades read/write por serviço a partir dos escopos concedidos.
// Ex: { gmail: { read: true, write: true }, calendar: { read: true, write: false } }.
export function serviceCaps(scope = '') {
  const granted = new Set(scope.split(/\s+/));
  const caps = {};
  for (const [k, def] of Object.entries(GOOGLE_SCOPES)) {
    const c = {};
    for (const [op, sc] of Object.entries(def)) c[op] = !!(sc && granted.has(sc));
    if (Object.values(c).some(Boolean)) caps[k] = c;
  }
  return caps;
}

// Renova o access_token a partir do refresh_token.
export async function googleRefresh(refreshToken) {
  const body = new URLSearchParams({
    refresh_token: refreshToken,
    client_id: process.env.GOOGLE_CLIENT_ID,
    client_secret: process.env.GOOGLE_CLIENT_SECRET,
    grant_type: 'refresh_token',
  });
  const r = await fetch(GOOGLE_TOKEN, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body,
  });
  if (!r.ok) {
    const raw = await r.text();
    // invalid_grant = o refresh_token foi revogado/expirou (troca de senha, revogação
    // manual, 6 meses sem uso). É irreversível: só reconectando. Sinaliza pro caller
    // via .code em vez de vazar o JSON cru do Google no chat do usuário.
    const err = new Error(`google refresh ${r.status}`);
    if (/invalid_grant/i.test(raw)) err.code = 'invalid_grant';
    throw err;
  }
  return r.json(); // { access_token, expires_in, scope, ... } (sem refresh_token novo)
}

// Troca o code por tokens.
export async function googleExchange(code) {
  const body = new URLSearchParams({
    code,
    client_id: process.env.GOOGLE_CLIENT_ID,
    client_secret: process.env.GOOGLE_CLIENT_SECRET,
    redirect_uri: process.env.GOOGLE_REDIRECT_URI,
    grant_type: 'authorization_code',
  });
  const r = await fetch(GOOGLE_TOKEN, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body,
  });
  if (!r.ok) throw new Error(`token ${r.status}: ${await r.text()}`);
  return r.json(); // { access_token, id_token, ... }
}

// Busca nome + e-mail do usuário a partir do access_token.
export async function googleUserInfo(accessToken) {
  const r = await fetch(GOOGLE_USERINFO, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!r.ok) throw new Error(`userinfo ${r.status}: ${await r.text()}`);
  return r.json(); // { sub, email, email_verified, name, ... }
}

// Cookie curto pra guardar o state (proteção CSRF) entre start e callback.
// 30 min (era 10): 10 não cobria o tempo real de quem cria/confirma conta no
// meio do consentimento. Caso observado no Hotmail: 19min29s entre start e
// callback, a Microsoft devolvia um code válido e a gente descartava calado.
// O oflow acompanha o mesmo prazo: ele decide se o retorno vai pro deep link
// do app ou pra home web, e vencer antes do ostate jogaria o usuário mobile
// pro lugar errado.
export const stateCookie = (state) => `ostate=${state}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=1800`;
export const clearStateCookie = () => 'ostate=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0';

// Guarda o code_verifier do PKCE entre o /start e o /callback (providers OAuth
// 2.1, tipo Canva). Só o desafio (SHA-256) viaja na URL de autorização; o
// segredo fica aqui, no mesmo prazo e nas mesmas condições do ostate.
export const verifierCookie = (v) => `overif=${v}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=1800`;
export const clearVerifierCookie = () => 'overif=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0';

// Marca se o fluxo OAuth em andamento é 'login' ou 'connect' (mesmo callback).
export const flowCookie = (flow) => `oflow=${flow}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=1800`;
export const clearFlowCookie = () => 'oflow=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0';
