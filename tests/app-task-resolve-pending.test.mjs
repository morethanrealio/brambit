import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import crypto from 'node:crypto';
import net from 'node:net';import tls from 'node:tls';
import {createAppTaskStore} from '../web/app-task-store.mjs';
import {makeAppTaskControlTool} from '../web/app-task-runner.mjs';
import {gateTool,takePending} from '../web/confirm.mjs';
net.Socket.prototype.connect=()=>{throw Error('Network forbidden');};tls.connect=()=>{throw Error('Network forbidden');};globalThis.fetch=()=>{throw Error('Network forbidden');};

// Reproduces the stuck-forever case reported for real users (Carlos, Beto,
// Proggy): a mutating app-build step comes back with an "unknown" effect, the
// runner deliberately leaves `pending.mutating=true` as a safety net (it must
// never silently re-run an action whose real-world outcome is uncertain), and
// `cancelar`/`atualizar_escopo` both refuse to run while that flag is set.
// Before this fix there was NO action that could ever clear it: the task, and
// every future request about the same app, stayed blocked forever.
const session = 'synthetic-owner:agent:thread:app';
async function fixture(t, {status = 'paused', sig = 'sig-abc', signatures = []} = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-resolve-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const key = crypto.randomBytes(32);
  const seal = s => { const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', key, iv); const b = Buffer.concat([c.update(s), c.final()]); return Buffer.concat([iv, c.getAuthTag(), b]).toString('base64'); };
  const open = s => { const b = Buffer.from(s, 'base64'), c = crypto.createDecipheriv('aes-256-gcm', key, b.subarray(0, 12)); c.setAuthTag(b.subarray(12, 28)); return Buffer.concat([c.update(b.subarray(28)), c.final()]).toString(); };
  const store = createAppTaskStore({root, seal, open});
  const app = 'stuck-app', scope = JSON.stringify([session, app, '']);
  const initial = {id: crypto.randomUUID(), targetIdentity: 'owner:stuck-app', mode: 'edicao', objective: 'Editar e testar o rascunho',
    reviewFiles: null, status, phase: 'editing', nextPhase: null, calls: 3, tokens: 4000, history: [], journal: [],
    readCoverage: [], signatures, progress: [], evidence: [], pending: {name: 'escrever_arquivo_do_app', sig, mutating: true}};
  await store.withTask(scope, async ({save}) => save(initial));
  const read = () => store.withTask(scope, async ({record}) => record);
  const control = makeAppTaskControlTool({store, sessionKey: session, authorize: async () => true});
  const thread = crypto.randomUUID(); t.after(() => takePending(thread));
  const gated = gateTool(control, thread, {mode: 'aceitar_edicoes'});
  return {store, app, scope, initial, read, control, gated, thread};
}
async function confirm(f, args, thread = f.thread, gated = f.gated) {
  const text = await gated.run(args);
  assert.match(text, /PENDENTE/, `expected a confirmation card, got: ${text}`);
  const p = takePending(thread); assert.ok(p, 'no pending confirmation was registered');
  return p.run(p.args);
}

test('resolver_pendencia(concluida) clears a stuck pending mutation after human confirmation and journals the decision', async t => {
  const f = await fixture(t);
  const out = await confirm(f, {app: f.app, acao: 'resolver_pendencia', resultado: 'concluida'});
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.resultado, 'concluida');
  const saved = await f.read();
  assert.equal(saved.pending, null);
  const entry = saved.journal.at(-1);
  assert.equal(entry.event, 'user_resolved_pending');
  assert.equal(entry.result, 'concluida');
});

test('resolver_pendencia(nao_executada) clears pending AND drops the dedupe signature so the same call may be retried', async t => {
  const f = await fixture(t, {sig: 'sig-xyz', signatures: ['sig-xyz', 'sig-other']});
  const out = await confirm(f, {app: f.app, acao: 'resolver_pendencia', resultado: 'nao_executada'});
  assert.equal(out.ok, true, JSON.stringify(out));
  const saved = await f.read();
  assert.equal(saved.pending, null);
  assert.deepEqual(saved.signatures, ['sig-other']);
});

test('resolver_pendencia(concluida) keeps the dedupe signature (the action is treated as having happened, so it must not be repeated)', async t => {
  const f = await fixture(t, {sig: 'sig-xyz', signatures: ['sig-xyz']});
  await confirm(f, {app: f.app, acao: 'resolver_pendencia', resultado: 'concluida'});
  const saved = await f.read();
  assert.deepEqual(saved.signatures, ['sig-xyz']);
});

test('resolver_pendencia works even on an already-cancelled task (cancelTask deliberately preserves an uncertain pending mutation)', async t => {
  const f = await fixture(t, {status: 'cancelled'});
  const out = await confirm(f, {app: f.app, acao: 'resolver_pendencia', resultado: 'concluida'});
  assert.equal(out.ok, true, JSON.stringify(out));
  const saved = await f.read();
  assert.equal(saved.pending, null);
  assert.equal(saved.status, 'cancelled');
});

test('cancelar alone cannot clear a stuck pending mutation; resolver_pendencia is the only way out, and cancelar works again afterward', async t => {
  const f = await fixture(t);
  // Safety behaviour, unchanged by this fix: cancelar refuses to run while an
  // uncertain mutation is pending, so it can never bypass reconciliation.
  const blocked = await f.control.run({app: f.app, acao: 'cancelar'});
  assert.equal(blocked.ok, false);
  await confirm(f, {app: f.app, acao: 'resolver_pendencia', resultado: 'concluida'});
  const thread2 = crypto.randomUUID(); t.after(() => takePending(thread2));
  const gated2 = gateTool(f.control, thread2, {mode: 'aceitar_edicoes'});
  const out = await confirm(f, {app: f.app, acao: 'cancelar'}, thread2, gated2);
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal((await f.read()).status, 'cancelled');
});

test('resolver_pendencia rejects a missing/invalid resultado before touching any state', async t => {
  const f = await fixture(t);
  const before = await f.read();
  assert.equal((await f.control.run({app: f.app, acao: 'resolver_pendencia'})).ok, false);
  assert.equal((await f.control.run({app: f.app, acao: 'resolver_pendencia', resultado: 'talvez'})).ok, false);
  assert.deepEqual(await f.read(), before);
});

test('resolver_pendencia refuses to run when there is no pending action to resolve', async t => {
  const f = await fixture(t);
  await f.store.withTask(f.scope, async ({record, save}) => save({...record, pending: null}));
  const out = await f.control.run({app: f.app, acao: 'resolver_pendencia', resultado: 'concluida'});
  assert.equal(out.ok, false);
});

test('resolver_pendencia still requires explicit human confirmation; the raw tool never executes before "Sim"', async t => {
  const f = await fixture(t);
  const text = await f.gated.run({app: f.app, acao: 'resolver_pendencia', resultado: 'concluida'});
  assert.match(text, /PENDENTE/);
  const saved = await f.read();
  assert.ok(saved.pending?.mutating, 'pending must still be set before the human confirms');
});
