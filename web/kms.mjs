// Minimal, dependency-free AWS KMS client (only node:crypto/http/https). Does
// Encrypt and Decrypt by signing by hand (SigV4) with the EC2 IAM role's
// credentials, obtained via IMDSv2. Used at boot to unwrap the vault's
// master key (envelope encryption): VAULT_KEY_ENC (a blob encrypted by the
// KMS CMK) turns back into the raw 32-byte key, which is never persisted in
// plaintext.
//
// Runs ON the harness HOST (which has the instance role), not in the
// gateway's container. The connection to KMS is direct (doesn't go through a
// proxy) — the regional endpoint is reachable from the instance's network.
import crypto from 'crypto';
import http from 'http';
import https from 'https';

const REGION = process.env.KMS_REGION || 'sa-east-1';
const SERVICE = 'kms';
const HOST = `kms.${REGION}.amazonaws.com`;
const IMDS = '169.254.169.254';

const sha256hex = (d) => crypto.createHash('sha256').update(d).digest('hex');
const hmac = (k, d) => crypto.createHmac('sha256', k).update(d).digest();

// Reads an entire HTTP response body. The 'error' listener here is NOT
// decoration: if the socket drops AFTER the headers (network reset, server
// giving up mid-way), the response stream emits 'error'; an EventEmitter
// with no 'error' listener THROWS the exception, and since this happens
// outside any try/catch, it used to become an uncaughtException and kill
// the whole process (finding #22). With the listener, the network failure
// becomes an ordinary rejection, which the caller handles.
export function lerCorpo(res) {
  return new Promise((resolve, reject) => {
    let body = '';
    res.on('data', (d) => (body += d));
    res.on('end', () => resolve(body));
    res.on('error', reject);
  });
}

// GET/PUT to the metadata service (IMDSv2). Plain HTTP, short timeout.
function imds(method, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: IMDS, method, path, headers, timeout: 3000 }, (res) => {
      lerCorpo(res).then((body) => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(body);
        else reject(new Error(`IMDS ${method} ${path} -> ${res.statusCode}`));
      }, reject);
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('IMDS timeout')));
    req.end();
  });
}

let _creds = null; // { accessKeyId, secretAccessKey, token, expiration }
async function getCreds() {
  // reusa enquanto faltar > 5 min pra expirar
  if (_creds && new Date(_creds.expiration).getTime() - Date.now() > 300000) return _creds;
  const token = await imds('PUT', '/latest/api/token', { 'X-aws-ec2-metadata-token-ttl-seconds': '21600' });
  const h = { 'X-aws-ec2-metadata-token': token };
  const role = (await imds('GET', '/latest/meta-data/iam/security-credentials/', h)).trim();
  const j = JSON.parse(await imds('GET', `/latest/meta-data/iam/security-credentials/${role}`, h));
  _creds = { accessKeyId: j.AccessKeyId, secretAccessKey: j.SecretAccessKey, token: j.Token, expiration: j.Expiration };
  return _creds;
}

async function kmsCall(target, payloadObj) {
  const creds = await getCreds();
  const body = JSON.stringify(payloadObj);
  const amzdate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, ''); // YYYYMMDDTHHMMSSZ
  const datestamp = amzdate.slice(0, 8);

  const canonicalHeaders =
    `content-type:application/x-amz-json-1.1\n` +
    `host:${HOST}\n` +
    `x-amz-date:${amzdate}\n` +
    `x-amz-security-token:${creds.token}\n` +
    `x-amz-target:${target}\n`;
  const signedHeaders = 'content-type;host;x-amz-date;x-amz-security-token;x-amz-target';
  const canonicalRequest = ['POST', '/', '', canonicalHeaders, signedHeaders, sha256hex(body)].join('\n');
  const scope = `${datestamp}/${REGION}/${SERVICE}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzdate, scope, sha256hex(canonicalRequest)].join('\n');
  const kSigning = hmac(hmac(hmac(hmac('AWS4' + creds.secretAccessKey, datestamp), REGION), SERVICE), 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');
  const authorization = `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return new Promise((resolve, reject) => {
    const req = https.request({
      host: HOST, method: 'POST', path: '/', timeout: 10000,
      headers: {
        'Content-Type': 'application/x-amz-json-1.1',
        'X-Amz-Target': target,
        'X-Amz-Date': amzdate,
        'X-Amz-Security-Token': creds.token,
        'Authorization': authorization,
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      lerCorpo(res).then((out) => {
        if (res.statusCode === 200) { try { resolve(JSON.parse(out)); } catch (e) { reject(e); } }
        else reject(new Error(`KMS ${target} -> ${res.statusCode}: ${out}`));
      }, reject);
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('KMS timeout')));
    req.end(body);
  });
}

// Cifra um Buffer com a CMK. Retorna o CiphertextBlob em base64.
export async function kmsEncrypt(plaintextBuf, keyId = process.env.KMS_KEY_ID) {
  if (!keyId) throw new Error('KMS_KEY_ID não configurada');
  const r = await kmsCall('TrentService.Encrypt', { KeyId: keyId, Plaintext: Buffer.from(plaintextBuf).toString('base64') });
  return r.CiphertextBlob;
}

// Decifra um CiphertextBlob (base64) produzido pela CMK. Retorna Buffer.
export async function kmsDecrypt(ciphertextB64) {
  const r = await kmsCall('TrentService.Decrypt', { CiphertextBlob: String(ciphertextB64) });
  return Buffer.from(r.Plaintext, 'base64');
}
