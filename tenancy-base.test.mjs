// Cross-account isolation probes do not hit production by default
// (phase B item 5 of the open source plan). Before, with no BASE they went
// to the hosted production URL, including the probe that WRITES to account A.
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { resolveBase, DEFAULT_BASE } from './ops/tenancy-base.mjs';

test('no BASE: local server', () => {
  assert.deepEqual(resolveBase({}), { base: DEFAULT_BASE, remote: false });
  assert.match(DEFAULT_BASE, /^http:\/\/127\.0\.0\.1:/);
});

test('explicit local passes without ALLOW_REMOTE', () => {
  for (const b of ['http://localhost:8090/', 'http://127.0.0.1:3000', 'http://[::1]:8080']) {
    assert.equal(resolveBase({ BASE: b }).remote, false, b);
  }
});

test('production and any remote target require ALLOW_REMOTE=1', () => {
  for (const b of ['https://brambs.com.br', 'https://www.brambs.com.br/', 'https://dev.brambs.com.br', 'http://10.0.0.5:8080', 'http://localhost.evil.com']) {
    assert.throws(() => resolveBase({ BASE: b }), /ALLOW_REMOTE=1/, b);
    assert.throws(() => resolveBase({ BASE: b, ALLOW_REMOTE: 'true' }), /ALLOW_REMOTE=1/, `${b} with a value other than 1`);
    assert.deepEqual(resolveBase({ BASE: b, ALLOW_REMOTE: '1' }), { base: b.replace(/\/+$/, ''), remote: true });
  }
});

test('a BASE that isn\'t http(s) is rejected', () => {
  assert.throws(() => resolveBase({ BASE: 'brambs.com.br' }), /Invalid|http/);
  assert.throws(() => resolveBase({ BASE: 'file:///etc/passwd' }), /http/);
});

// End-to-end: each probe, with a session and production BASE but without ALLOW_REMOTE,
// exits with 2 before any request. The network guard guarantees that no
// call would go out: if the script tried, fetch would break with a different message.
const SONDAS = ['ops/tenancy-test.mjs', 'ops/tenancy-write-test.mjs', 'ops/tenancy-runner-test.mjs'];
for (const f of SONDAS) {
  test(`${f} refuses production without ALLOW_REMOTE=1`, () => {
    const env = { PATH: process.env.PATH, HOME: process.env.HOME, SID_A: 'sessao-falsa-a', SID_B: 'sessao-falsa-b', BASE: 'https://brambs.com.br' };
    const r = spawnSync(process.execPath, ['--import', 'data:text/javascript,globalThis.fetch=()=>{throw new Error("REDE_PROIBIDA_NO_TESTE")}', f], { env, encoding: 'utf8', timeout: 30000 });
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /ALLOW_REMOTE=1/);
    assert.doesNotMatch(r.stdout + r.stderr, /REDE_PROIBIDA_NO_TESTE/);
  });
}
