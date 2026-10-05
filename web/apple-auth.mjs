// Sign in with Apple — verificação do identity token e revogação.
//
// Por que à mão: o repo não tem biblioteca de JWT, e puxar uma dependência nova
// pra verificar UM tipo de token (RS256 com chave pública publicada) não paga o
// custo de auditoria. São ~60 linhas de `crypto` nativo.
//
// O identity token é um JWT assinado pela Apple. Verificar significa, nesta
// ordem: achar a chave pública pelo `kid` do cabeçalho, conferir a assinatura
// sobre `header.payload`, e SÓ DEPOIS acreditar no conteúdo. Conferir claim de
// token não verificado é o erro clássico — aqui o parse do payload só acontece
// depois que a assinatura passou.
import { createPublicKey, createVerify, createSign, createHash, timingSafeEqual } from 'node:crypto';

const APPLE_ISS = 'https://appleid.apple.com';
const JWKS_URL = `${APPLE_ISS}/auth/keys`;
const TOKEN_URL = `${APPLE_ISS}/auth/token`;
const REVOKE_URL = `${APPLE_ISS}/auth/revoke`;

// Login da Apple é o mínimo pra funcionar: só o client_id (bundle do app).
// Revogação exige a chave .p8 e é checada em separado (ver appleRevokeReady),
// porque a ausência dela NÃO pode impedir alguém de entrar — só muda o que
// conseguimos fazer no momento da exclusão da conta.
export function appleEnabled() {
  return !!process.env.APPLE_CLIENT_ID;
}

export function appleRevokeReady() {
  return !!(process.env.APPLE_CLIENT_ID && process.env.APPLE_TEAM_ID
    && process.env.APPLE_KEY_ID && process.env.APPLE_PRIVATE_KEY);
}

// Aceita mais de um audience (bundle do app iOS + Services ID do site, se um dia
// existir login pela web). Separado por vírgula.
function allowedAudiences() {
  return String(process.env.APPLE_CLIENT_ID || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
}

function b64urlToBuf(s) {
  return Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function jsonFromB64url(s) {
  return JSON.parse(b64urlToBuf(s).toString('utf8'));
}

// Cache das chaves públicas. A Apple roda rotação, então o cache tem prazo e,
// diante de um `kid` desconhecido, refaz o fetch na hora (uma vez) em vez de
// recusar o login de quem pegou a chave nova.
let jwksCache = { keys: [], at: 0 };
const JWKS_TTL_MS = 60 * 60 * 1000;

async function fetchJwks() {
  const r = await fetch(JWKS_URL);
  if (!r.ok) throw new Error(`JWKS da Apple respondeu ${r.status}`);
  const body = await r.json();
  if (!Array.isArray(body?.keys) || !body.keys.length) throw new Error('JWKS da Apple veio vazio');
  jwksCache = { keys: body.keys, at: Date.now() };
  return jwksCache.keys;
}

async function appleKeyFor(kid, { refetch = true } = {}) {
  let keys = jwksCache.keys;
  if (!keys.length || Date.now() - jwksCache.at > JWKS_TTL_MS) keys = await fetchJwks();
  let jwk = keys.find((k) => k.kid === kid);
  if (!jwk && refetch) {
    keys = await fetchJwks(); // rotação de chave: tenta uma vez com a lista fresca
    jwk = keys.find((k) => k.kid === kid);
  }
  if (!jwk) throw new Error('chave da Apple não encontrada para este token');
  return createPublicKey({ key: jwk, format: 'jwk' });
}

function sameString(a, b) {
  const ba = Buffer.from(String(a), 'utf8'), bb = Buffer.from(String(b), 'utf8');
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export function sha256Hex(s) {
  return createHash('sha256').update(String(s), 'utf8').digest('hex');
}

// Verifica o identity token e devolve a identidade. Lança em qualquer desvio —
// quem chama trata como "não entrou". Nunca devolve dado de token inválido.
//
// `expectedNonce` é o nonce CRU que o app recebeu de nós; o token carrega o
// SHA-256 dele (é o app que hasheia antes de mandar pra Apple). Sem esse
// amarração, um identity token capturado em outro lugar viraria sessão aqui.
export async function verifyAppleIdentityToken(idToken, { expectedNonce } = {}) {
  const parts = String(idToken || '').split('.');
  if (parts.length !== 3) throw new Error('identity token malformado');
  const [h, p, s] = parts;

  const header = jsonFromB64url(h);
  if (header.alg !== 'RS256') throw new Error(`algoritmo inesperado: ${header.alg}`);
  const key = await appleKeyFor(header.kid);

  const ok = createVerify('RSA-SHA256').update(`${h}.${p}`).verify(key, b64urlToBuf(s));
  if (!ok) throw new Error('assinatura do identity token não confere');

  // Daqui pra baixo o conteúdo é confiável.
  const claims = jsonFromB64url(p);
  if (claims.iss !== APPLE_ISS) throw new Error('emissor inesperado');
  const auds = allowedAudiences();
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.some((a) => auds.includes(a))) throw new Error('audience inesperada');
  const agora = Math.floor(Date.now() / 1000);
  if (!claims.exp || claims.exp <= agora) throw new Error('identity token expirado');
  if (claims.iat && claims.iat > agora + 300) throw new Error('identity token do futuro');
  if (!claims.sub) throw new Error('identity token sem sub');

  if (expectedNonce) {
    if (!claims.nonce || !sameString(claims.nonce, sha256Hex(expectedNonce)))
      throw new Error('nonce não confere');
  }

  const email = claims.email ? String(claims.email).toLowerCase() : null;
  return {
    sub: String(claims.sub),
    email,
    // `email_verified` e `is_private_email` vêm como boolean OU string ("true").
    emailVerified: claims.email_verified === true || claims.email_verified === 'true',
    isPrivateEmail: claims.is_private_email === true || claims.is_private_email === 'true',
  };
}

// A .p8 é um PEM de várias linhas e o EnvironmentFile do systemd não é um shell:
// o tratamento de `\n` dentro de aspas varia com a versão e um erro aqui só
// aparece na hora de excluir uma conta. Então aceitamos três formas e
// normalizamos: PEM cru (se o arquivo .env tiver quebras de linha reais), PEM com
// `\n` literal, ou base64 do PEM inteiro — esta última é a que não tem como sair
// errado, porque é uma linha só sem aspas nem escape.
function applePrivateKeyPem() {
  const raw = String(process.env.APPLE_PRIVATE_KEY || '').trim();
  if (raw.includes('BEGIN')) return raw.replace(/\\n/g, '\n');
  const pem = Buffer.from(raw, 'base64').toString('utf8');
  if (!pem.includes('BEGIN')) throw new Error('APPLE_PRIVATE_KEY não é um PEM nem base64 de um PEM');
  return pem;
}

// client_secret da Apple: um JWT ES256 assinado com a chave .p8 do portal,
// válido por poucos minutos. Gerado a cada chamada porque o custo é desprezível
// e guardar um secret vivo em memória não compra nada.
function appleClientSecret() {
  if (!appleRevokeReady()) throw new Error('chave privada da Apple não configurada');
  const teamId = process.env.APPLE_TEAM_ID;
  const keyId = process.env.APPLE_KEY_ID;
  const pem = applePrivateKeyPem();
  const clientId = allowedAudiences()[0];

  const iat = Math.floor(Date.now() / 1000);
  const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = b64url({ alg: 'ES256', kid: keyId });
  const body = b64url({ iss: teamId, iat, exp: iat + 300, aud: APPLE_ISS, sub: clientId });
  // ieee-p1363 = r||s cru, que é o formato do JWS. O padrão do Node é DER, e
  // DER aqui produz um token que a Apple recusa sem explicar por quê.
  const sig = createSign('SHA256')
    .update(`${head}.${body}`)
    .sign({ key: pem, dsaEncoding: 'ieee-p1363' })
    .toString('base64url');
  return `${head}.${body}.${sig}`;
}

async function applePostForm(url, params) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
  const txt = await r.text();
  let json = null;
  try { json = txt ? JSON.parse(txt) : null; } catch { /* a Apple às vezes devolve vazio */ }
  if (!r.ok) throw new Error(`Apple ${url} respondeu ${r.status}: ${txt.slice(0, 200)}`);
  return json;
}

// Troca o authorization code (do login nativo) pelo refresh_token. É o único
// momento em que esse token existe: sem guardar agora, não há como revogar
// depois, e a exclusão de conta deixa de cumprir a 5.1.1(v).
export async function appleExchangeCode(code) {
  const out = await applePostForm(TOKEN_URL, {
    client_id: allowedAudiences()[0],
    client_secret: appleClientSecret(),
    code,
    grant_type: 'authorization_code',
  });
  return { refreshToken: out?.refresh_token || null };
}

// Revoga o acesso na Apple quando a pessoa exclui a conta. Exigência da
// 5.1.1(v): apagar só do nosso lado não basta — enquanto o token vive, a conta
// segue listada em Ajustes > ID Apple > Usar ID Apple.
export async function appleRevoke(refreshToken) {
  if (!refreshToken) throw new Error('sem refresh token da Apple');
  await applePostForm(REVOKE_URL, {
    client_id: allowedAudiences()[0],
    client_secret: appleClientSecret(),
    token: refreshToken,
    token_type_hint: 'refresh_token',
  });
  return true;
}
