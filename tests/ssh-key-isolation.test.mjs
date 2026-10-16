// The user's SSH private key must never enter the sandbox the model runs code in
// (audit item 8): any process there (same container, same uid) could read it. SSH
// goes through runnerd's /ssh, which runs it in a separate per-user container.
// Here the sandbox, db and vault are fakes; nothing leaves the process.
import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

const KEY = '-----BEGIN OPENSSH PRIVATE KEY-----\nAAAAfakekeymaterial\n-----END OPENSSH PRIVATE KEY-----\n';
const fakes = {
  './sandbox.mjs': `const S=()=>globalThis.__sb;
export const sandboxEnabled=()=>true;
export const sandboxShell=(...a)=>S().call('shell',a);
export const sandboxWrite=(...a)=>S().call('write',a);
export const sandboxRead=(...a)=>S().call('read',a);
export const sandboxSsh=(...a)=>S().call('ssh',a);
export const sandboxSshKeygen=(...a)=>S().call('keygen',a);`,
  './db.mjs': `export const listConnections=async()=>[{id:'c1',kind:'ssh_key',label:'srv',meta:{host:null}}];
export const getConnection=async()=>({id:'c1',secret_enc:'ENC',meta:{}});
export const addConnection=async(u,c)=>{globalThis.__saved=c;};`,
  './vault.mjs': `export const vaultEnabled=()=>true;
export const decryptSecret=()=>${JSON.stringify(KEY)};
export const encryptSecret=(s)=>'enc:'+s;`,
};
registerHooks({ resolve(specifier, context, next) {
  if (fakes[specifier] && context.parentURL?.endsWith('/web/ssh.mjs')) return { url: 'data:text/javascript,' + encodeURIComponent(fakes[specifier]), shortCircuit: true };
  return next(specifier, context);
} });

const { sshTools, livreExec } = await import('../web/ssh.mjs');
const { sshArgs } = await import('../ops/sandbox-host/runner.mjs');

function fakeSandbox() {
  const calls = [];
  return { calls, async call(kind, args) {
    calls.push({ kind, args });
    if (kind === 'shell') return { exitCode: 0, stdout: '/usr/bin/ssh\n', stderr: '' };
    if (kind === 'write') return { ok: true };
    if (kind === 'read') return { ok: true, content: KEY };
    if (kind === 'keygen') return { ok: true, publicKey: 'ssh-ed25519 AAAApub brambs-srv', privateKey: KEY };
    return { exitCode: 0, stdout: 'ok', stderr: '' };
  } };
}
const tool = (name) => sshTools('u1').find((t) => t.name === name);
const keyLeakedToSandbox = (calls) => calls.some((c) => c.kind !== 'ssh' && c.kind !== 'keygen' && JSON.stringify(c.args).includes('fakekeymaterial'))
  || calls.some((c) => c.kind === 'read');

test('rodar_no_servidor sends the key only to the SSH container, never into the sandbox', async () => {
  globalThis.__sb = fakeSandbox();
  const out = JSON.parse(await tool('rodar_no_servidor').run({ comando: 'uptime', host: '1.2.3.4', usuario: 'ubuntu' }));
  assert.equal(out.ok, true);
  const ssh = globalThis.__sb.calls.filter((c) => c.kind === 'ssh');
  assert.equal(ssh.length, 1);
  assert.equal(ssh[0].args[1].key, KEY);
  assert.equal(ssh[0].args[1].host, '1.2.3.4');
  assert.ok(!keyLeakedToSandbox(globalThis.__sb.calls));
});

test('free-mode terminal also keeps the key out of the sandbox and keeps one session per target', async () => {
  globalThis.__sb = fakeSandbox();
  await livreExec('u1', 'ls', { threadId: 't1', host: 'a.example.com', usuario: 'ubuntu' });
  await livreExec('u1', 'ls', { threadId: 't1', host: 'b.example.com', usuario: 'ubuntu' });
  const ssh = globalThis.__sb.calls.filter((c) => c.kind === 'ssh');
  assert.equal(ssh.length, 2);
  assert.notEqual(ssh[0].args[1].session, ssh[1].args[1].session);
  assert.ok(!keyLeakedToSandbox(globalThis.__sb.calls));
});

test('host or user that would become an ssh option is refused before reaching the sandbox host', async () => {
  for (const bad of [{ host: '-oProxyCommand=sh', usuario: 'ubuntu' }, { host: '1.2.3.4', usuario: '-oProxyCommand=sh' }, { host: 'a b', usuario: 'ubuntu' }]) {
    globalThis.__sb = fakeSandbox();
    const out = JSON.parse(await tool('rodar_no_servidor').run({ comando: 'id', ...bad }));
    assert.equal(out.ok, false);
    assert.equal(globalThis.__sb.calls.filter((c) => c.kind === 'ssh').length, 0);
  }
});

test('gerar_chave_ssh stores the key from the SSH container without passing it through the sandbox', async () => {
  globalThis.__sb = fakeSandbox();
  const out = JSON.parse(await tool('gerar_chave_ssh').run({ host: '1.2.3.4' }));
  assert.equal(out.ok, true);
  assert.equal(globalThis.__saved.secretEnc, 'enc:' + KEY);
  assert.ok(out.saida.includes('ssh-ed25519 AAAApub'));
  assert.ok(!out.saida.includes('fakekeymaterial'));
  assert.ok(!keyLeakedToSandbox(globalThis.__sb.calls));
});

test('runnerd ssh argv: target after "--", and option-shaped user/host/session refused', () => {
  const a = sshArgs({ user: 'ubuntu', host: 'srv.example.com', remote: 'echo x | base64 -d | bash', session: 'c1_ab12' });
  assert.deepEqual(a.slice(-4), ['ubuntu', '--', 'srv.example.com', 'echo x | base64 -d | bash']);
  assert.ok(a.includes('ControlPath=/tmp/cm_c1_ab12.sock'));
  assert.ok(!sshArgs({ user: 'u', host: 'h', remote: 'r' }).some((x) => x.startsWith('ControlPath')));
  assert.throws(() => sshArgs({ user: 'u', host: '-oProxyCommand=sh', remote: 'r' }));
  assert.throws(() => sshArgs({ user: '-oProxyCommand=sh', host: 'h', remote: 'r' }));
  assert.throws(() => sshArgs({ user: 'u', host: 'h', remote: 'r', session: '../../workspace/x' }));
});
