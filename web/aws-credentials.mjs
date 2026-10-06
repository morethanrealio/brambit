// ── Backend AWS credentials (S3) ──
// Two sources, picked by .env:
// - S3_INSTANCE_ROLE=1: TEMPORARY credential of the EC2 instance role, read from
//   IMDSv2 (169.254.169.254). No key on disk; AWS rotates the credential and we
//   just re-read it. SOC 2 decision (Oct 2, 2026): drop the static IAM user key
//   from the production .env.
// - Without the flag: static AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY (legacy, and
//   the way back if the role misbehaves: just remove the flag).
// URL presigning is synchronous, so the role credential is cached and a timer
// re-reads it every few minutes (startAwsCredentialRefresh, at boot).
//
// IMDS is read with plain http, as in kms.mjs, NOT with the global fetch: fetch
// goes through egress.mjs (which doesn't know 169.254.169.254 and would block it
// with EGRESS_MODE=block) and may inherit the environment's proxy.
import http from 'http';
import { lerCorpo } from './kms.mjs';

const IMDS = 'http://169.254.169.254';
const IMDS_TIMEOUT_MS = 2000;
const REFRESH_EVERY_MS = 5 * 60_000;
// Abaixo disso a credencial em cache não serve mais pra assinar.
const MIN_REMAINING_MS = 5 * 60_000;

// Fonte padrão: lida por process.env.X (e não env.X) pra trava do .env.example
// (test-support/env-example-guard.mjs) enxergar que essas variáveis são usadas.
const processEnv = () => ({
  S3_INSTANCE_ROLE: process.env.S3_INSTANCE_ROLE,
  AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID,
  AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
});

let cached = null; // { accessKeyId, secretAccessKey, sessionToken, expiration(ms) }
let inflight = null;
let timer = null;

export function instanceRoleMode(env = processEnv()) {
  return env.S3_INSTANCE_ROLE === '1';
}

// Tem de onde tirar credencial? (não garante que a role já respondeu)
export function awsCredentialsConfigured(env = processEnv()) {
  return instanceRoleMode(env) || !!(env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY);
}

function staticCredentials(env) {
  if (!env.AWS_ACCESS_KEY_ID || !env.AWS_SECRET_ACCESS_KEY) return null;
  return { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY, sessionToken: null };
}

// Síncrono: a credencial que dá pra usar AGORA, ou null (role ainda sem cache).
export function currentAwsCredentials(env = processEnv(), now = Date.now()) {
  if (!instanceRoleMode(env)) return staticCredentials(env);
  return cached && cached.expiration - now > MIN_REMAINING_MS ? cached : null;
}

// Mini-fetch em http puro só pro IMDS: devolve { ok, status, text() }. Agent
// próprio de propósito: com NODE_USE_ENV_PROXY o agent global do http manda tudo
// pro HTTP_PROXY, e o IMDS só responde direto da instância.
const imdsAgent = new http.Agent();
export function imdsFetch(url, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers, timeout: IMDS_TIMEOUT_MS, agent: imdsAgent }, (res) => {
      lerCorpo(res).then((body) => resolve({
        ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, text: async () => body,
      }), reject);
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('IMDS timeout')));
    req.end();
  });
}

// Lê a credencial da role pelo IMDSv2 (token de sessão primeiro, depois o nome
// da role, depois a credencial).
// `imds` só muda no teste (servidor local no lugar do 169.254.169.254).
export async function fetchInstanceCredentials(fetchImpl = imdsFetch, imds = IMDS) {
  const tokRes = await fetchImpl(`${imds}/latest/api/token`, {
    method: 'PUT', headers: { 'X-aws-ec2-metadata-token-ttl-seconds': '21600' },
  });
  if (!tokRes.ok) throw new Error(`imds token ${tokRes.status}`);
  const headers = { 'X-aws-ec2-metadata-token': (await tokRes.text()).trim() };
  const base = `${imds}/latest/meta-data/iam/security-credentials/`;
  const roleRes = await fetchImpl(base, { headers });
  if (!roleRes.ok) throw new Error(`imds role ${roleRes.status}`);
  const role = (await roleRes.text()).split('\n')[0].trim();
  if (!role) throw new Error('imds: instância sem role');
  const credRes = await fetchImpl(base + encodeURIComponent(role), { headers });
  if (!credRes.ok) throw new Error(`imds credencial ${credRes.status}`);
  const c = JSON.parse(await credRes.text());
  if (c.Code !== 'Success' || !c.AccessKeyId || !c.SecretAccessKey || !c.Token) {
    throw new Error(`imds credencial inválida (Code=${c.Code})`);
  }
  return {
    accessKeyId: c.AccessKeyId, secretAccessKey: c.SecretAccessKey, sessionToken: c.Token,
    expiration: Date.parse(c.Expiration),
  };
}

// Relê a credencial da role (uma leitura por vez) e guarda no cache.
export async function refreshInstanceCredentials(fetchImpl = imdsFetch) {
  if (!inflight) {
    inflight = fetchInstanceCredentials(fetchImpl)
      .then((c) => { cached = c; return c; })
      .finally(() => { inflight = null; });
  }
  return inflight;
}

// Assíncrono: usado por PUT/GET/DELETE. Na role, relê se o cache está vazio ou
// perto de vencer. Devolve null se não há fonte configurada.
export async function getAwsCredentials({ env = processEnv(), now = Date.now(), fetchImpl = imdsFetch } = {}) {
  if (!instanceRoleMode(env)) return staticCredentials(env);
  return currentAwsCredentials(env, now) || refreshInstanceCredentials(fetchImpl);
}

// Boot: aquece o cache e mantém a credencial da role fresca. Sem a flag, não faz nada.
export function startAwsCredentialRefresh({ env = processEnv(), fetchImpl = imdsFetch, log = console } = {}) {
  if (!instanceRoleMode(env) || timer) return;
  const tick = () => refreshInstanceCredentials(fetchImpl)
    .catch((e) => log.error('[aws-cred] falha ao ler a credencial da role:', e?.message ?? e));
  void tick().then((c) => { if (c) log.log('[aws-cred] S3 usando a role da instância'); });
  timer = setInterval(tick, REFRESH_EVERY_MS);
  timer.unref();
}

// Só pra teste.
export function _resetAwsCredentialsForTest() {
  cached = null; inflight = null;
  if (timer) clearInterval(timer);
  timer = null;
}
