// SOC 2 (Oct 2, 2026): production S3 now signs with the instance role's temporary
// credential (IMDSv2) instead of a static IAM user key.
import test from 'node:test';
import http from 'node:http';
import assert from 'node:assert/strict';
import {
  awsCredentialsConfigured, currentAwsCredentials, getAwsCredentials,
  refreshInstanceCredentials, fetchInstanceCredentials, imdsFetch, _resetAwsCredentialsForTest,
} from './web/aws-credentials.mjs';

const ROLE = { S3_INSTANCE_ROLE: '1' };
const STATIC = { AWS_ACCESS_KEY_ID: 'AKIATESTE', AWS_SECRET_ACCESS_KEY: 'segredo' };

// Fake IMDS: logs the calls and returns a credential that expires in `validMs`.
function fakeImds({ validMs = 6 * 3600_000, code = 'Success', n = 1 } = {}) {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url, method: opts.method || 'GET', headers: opts.headers || {} });
    if (url.endsWith('/latest/api/token')) return new Response('tok-imds');
    if (url.endsWith('/security-credentials/')) return new Response('brambs-harness-kms-role\n');
    return new Response(JSON.stringify({
      Code: code, AccessKeyId: `ASIA${n}`, SecretAccessKey: `sec${n}`, Token: `sess${n}`,
      Expiration: new Date(Date.now() + validMs).toISOString(),
    }));
  };
  return { calls, fetchImpl };
}

test('without the flag: uses the fixed key from .env, no session token', async () => {
  _resetAwsCredentialsForTest();
  assert.equal(awsCredentialsConfigured(STATIC), true);
  assert.equal(awsCredentialsConfigured({}), false);
  assert.deepEqual(currentAwsCredentials(STATIC), { accessKeyId: 'AKIATESTE', secretAccessKey: 'segredo', sessionToken: null });
  assert.equal(currentAwsCredentials({}), null);
  assert.equal(await getAwsCredentials({ env: {} }), null);
});

test('with the flag: reads the role via IMDSv2 (token first) and ignores the fixed key', async () => {
  _resetAwsCredentialsForTest();
  const env = { ...ROLE, ...STATIC };
  assert.equal(awsCredentialsConfigured(ROLE), true);
  assert.equal(currentAwsCredentials(env), null, 'before the role responds there is no synchronous credential');
  const imds = fakeImds();
  const c = await getAwsCredentials({ env, fetchImpl: imds.fetchImpl });
  assert.equal(c.accessKeyId, 'ASIA1');
  assert.equal(c.sessionToken, 'sess1');
  assert.equal(imds.calls[0].method, 'PUT');
  assert.equal(imds.calls[0].headers['X-aws-ec2-metadata-token-ttl-seconds'], '21600');
  assert.ok(imds.calls[2].url.endsWith('/security-credentials/brambs-harness-kms-role'));
  for (const call of imds.calls.slice(1)) assert.equal(call.headers['X-aws-ec2-metadata-token'], 'tok-imds');
  assert.equal(currentAwsCredentials(env).accessKeyId, 'ASIA1', 'stays cached for the synchronous presign');
  await getAwsCredentials({ env, fetchImpl: imds.fetchImpl });
  assert.equal(imds.calls.length, 3, 'a valid cache does not re-read IMDS');
});

test('credential near expiry: the sync path refuses and the async path re-reads', async () => {
  _resetAwsCredentialsForTest();
  await refreshInstanceCredentials(fakeImds({ validMs: 60_000 }).fetchImpl);
  assert.equal(currentAwsCredentials(ROLE), null);
  const c = await getAwsCredentials({ env: ROLE, fetchImpl: fakeImds({ n: 2 }).fetchImpl });
  assert.equal(c.accessKeyId, 'ASIA2');
});

test('concurrent reads collapse into a single IMDS call', async () => {
  _resetAwsCredentialsForTest();
  const imds = fakeImds();
  await Promise.all([1, 2, 3].map(() => getAwsCredentials({ env: ROLE, fetchImpl: imds.fetchImpl })));
  assert.equal(imds.calls.length, 3);
});

test('IMDS with an invalid credential fails loudly instead of signing with garbage', async () => {
  _resetAwsCredentialsForTest();
  await assert.rejects(getAwsCredentials({ env: ROLE, fetchImpl: fakeImds({ code: 'Failure' }).fetchImpl }), /Code=Failure/);
  assert.equal(currentAwsCredentials(ROLE), null);
});

test('presign with the role carries X-Amz-Security-Token; with the fixed key it doesn\'t', async () => {
  _resetAwsCredentialsForTest();
  const saved = { ...process.env };
  try {
    Object.assign(process.env, { S3_BUCKET: 'bucket-teste', S3_REGION: 'sa-east-1' });
    const { presignGet, s3Enabled } = await import('./web/media.mjs');
    const now = new Date('2026-10-02T12:00:00Z');

    Object.assign(process.env, STATIC); delete process.env.S3_INSTANCE_ROLE;
    const fixa = new URL(presignGet('u1/a.jpg', 900, { now }));
    assert.equal(fixa.searchParams.get('X-Amz-Security-Token'), null);
    assert.match(fixa.searchParams.get('X-Amz-Credential'), /^AKIATESTE\/20261002\/sa-east-1\/s3\/aws4_request$/);

    delete process.env.AWS_ACCESS_KEY_ID; delete process.env.AWS_SECRET_ACCESS_KEY;
    process.env.S3_INSTANCE_ROLE = '1';
    assert.equal(s3Enabled(), true);
    assert.equal(presignGet('u1/a.jpg', 900, { now }), null, 'without a cached role, presign returns null');
    await refreshInstanceCredentials(fakeImds().fetchImpl);
    const role = new URL(presignGet('u1/a.jpg', 900, { now }));
    assert.equal(role.searchParams.get('X-Amz-Security-Token'), 'sess1');
    assert.match(role.searchParams.get('X-Amz-Credential'), /^ASIA1\//);
    // The token enters the canonical query, so it changes the signature.
    assert.notEqual(role.searchParams.get('X-Amz-Signature'), fixa.searchParams.get('X-Amz-Signature'));
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    _resetAwsCredentialsForTest();
  }
});

test('the IMDS http client (no global fetch): speaks IMDSv2 with a real server', async () => {
  const seen = [];
  const srv = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url} ${req.headers['x-aws-ec2-metadata-token'] || req.headers['x-aws-ec2-metadata-token-ttl-seconds'] || ''}`);
    if (req.url === '/latest/api/token' && req.method === 'PUT') return res.end('tok-local');
    if (req.headers['x-aws-ec2-metadata-token'] !== 'tok-local') { res.statusCode = 401; return res.end(); }
    if (req.url.endsWith('/security-credentials/')) return res.end('minha-role');
    res.end(JSON.stringify({ Code: 'Success', AccessKeyId: 'ASIAL', SecretAccessKey: 's', Token: 't', Expiration: '2026-10-02T18:00:00Z' }));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('não pode usar o fetch global'); };
  try {
    const c = await fetchInstanceCredentials(imdsFetch, `http://127.0.0.1:${srv.address().port}`);
    assert.deepEqual(c, { accessKeyId: 'ASIAL', secretAccessKey: 's', sessionToken: 't', expiration: Date.parse('2026-10-02T18:00:00Z') });
    assert.deepEqual(seen, [
      'PUT /latest/api/token 21600',
      'GET /latest/meta-data/iam/security-credentials/ tok-local',
      'GET /latest/meta-data/iam/security-credentials/minha-role tok-local',
    ]);
  } finally {
    globalThis.fetch = realFetch;
    srv.close();
  }
});
