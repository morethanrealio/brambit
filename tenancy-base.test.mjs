// Sondas de isolamento entre contas não batem em produção por padrão
// (fase B item 5 do plano open source). Antes, sem BASE elas iam pra
// https://brambs.com.br, inclusive a sonda que ESCREVE na conta A.
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { resolveBase, DEFAULT_BASE } from './ops/tenancy-base.mjs';

test('sem BASE: servidor local', () => {
  assert.deepEqual(resolveBase({}), { base: DEFAULT_BASE, remote: false });
  assert.match(DEFAULT_BASE, /^http:\/\/127\.0\.0\.1:/);
});

test('local explícito passa sem ALLOW_REMOTE', () => {
  for (const b of ['http://localhost:8090/', 'http://127.0.0.1:3000', 'http://[::1]:8080']) {
    assert.equal(resolveBase({ BASE: b }).remote, false, b);
  }
});

test('produção e qualquer alvo remoto exigem ALLOW_REMOTE=1', () => {
  for (const b of ['https://brambs.com.br', 'https://www.brambs.com.br/', 'https://dev.brambs.com.br', 'http://10.0.0.5:8080', 'http://localhost.evil.com']) {
    assert.throws(() => resolveBase({ BASE: b }), /ALLOW_REMOTE=1/, b);
    assert.throws(() => resolveBase({ BASE: b, ALLOW_REMOTE: 'true' }), /ALLOW_REMOTE=1/, `${b} com valor diferente de 1`);
    assert.deepEqual(resolveBase({ BASE: b, ALLOW_REMOTE: '1' }), { base: b.replace(/\/+$/, ''), remote: true });
  }
});

test('BASE que não é http(s) é recusada', () => {
  assert.throws(() => resolveBase({ BASE: 'brambs.com.br' }), /inválida|http/);
  assert.throws(() => resolveBase({ BASE: 'file:///etc/passwd' }), /http/);
});

// Ponta a ponta: cada sonda, com sessão e BASE de produção mas sem ALLOW_REMOTE,
// sai com 2 antes de qualquer requisição. A guarda de rede garante que nenhuma
// chamada sairia: se o script tentasse, o fetch quebraria com outra mensagem.
const SONDAS = ['ops/tenancy-test.mjs', 'ops/tenancy-write-test.mjs', 'ops/tenancy-runner-test.mjs'];
for (const f of SONDAS) {
  test(`${f} recusa produção sem ALLOW_REMOTE=1`, () => {
    const env = { PATH: process.env.PATH, HOME: process.env.HOME, SID_A: 'sessao-falsa-a', SID_B: 'sessao-falsa-b', BASE: 'https://brambs.com.br' };
    const r = spawnSync(process.execPath, ['--import', 'data:text/javascript,globalThis.fetch=()=>{throw new Error("REDE_PROIBIDA_NO_TESTE")}', f], { env, encoding: 'utf8', timeout: 30000 });
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /ALLOW_REMOTE=1/);
    assert.doesNotMatch(r.stdout + r.stderr, /REDE_PROIBIDA_NO_TESTE/);
  });
}
