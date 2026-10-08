#!/usr/bin/env node
// ── Cross-account isolation: the WRITE surface (Phase 1, part 2) ──────────
//
// The sibling suite (ops/tenancy-test.mjs) only does reads. This one covers the endpoints
// that CHANGE state and accept an id, which are precisely the dangerous ones: if the owner
// check fails on one of them, account B doesn't read A's data — it deletes it.
//
// Rule that makes this safe to run in production: no probe points at the
// owner's real resource. The test FIRST CREATES, in account A, a disposable set
// (assistant, conversation, routine, page, tasks, sequence, edge, device,
// connection, file), account B tries to destroy/alter THESE, and at the end everything is
// deleted by account A itself. If isolation is broken, what gets lost is
// test junk.
//
// The verdict is NOT the HTTP status: several handlers respond 200 even without affecting
// anything (the UPDATE has `WHERE user_id = $x` and matches zero rows). What counts is the
// EFFECT: before each probe a snapshot of the resource is taken via A's session,
// the probe is run with B's session, and the snapshot is taken again. Changed = FAILED.
//
// Usage:
//   SID_A=<account A's sid> SID_B=<account B's sid> node ops/tenancy-write-test.mjs
//   BASE=http://127.0.0.1:8080  (default: local server)
//   BASE=https://your-domain ALLOW_REMOTE=1  (any target outside this machine,
//     production included, requires ALLOW_REMOTE=1; see ops/tenancy-base.mjs)
//   JSON=1  prints the report in JSON at the end (for CI)
//
// Cleanup runs in `finally`: if the process dies midway, leftover junk with the
// `zz-tenancy-` prefix stays on account A, safe to delete by hand.
//
// Output: exit 0 if none FAILED; 1 if any failed; 2 on setup error.

import { baseOrExit } from './tenancy-base.mjs';

const SID = { A: process.env.SID_A || '', B: process.env.SID_B || '' };

if (!SID.A || !SID.B) {
  console.error('Missing SID_A and/or SID_B (session cookie for each account).');
  process.exit(2);
}
const BASE = baseOrExit();

const MARCA = 'zz-tenancy-' + Date.now().toString(36);
const INVASOR = 'INVADIDO-POR-B';

async function call(who, method, path, body) {
  const headers = {};
  if (who !== 'anon') headers.cookie = `sid=${SID[who]}`;
  // csrfOk() allows GET/HEAD/OPTIONS and requires a known Origin for the rest. Without this
  // header every write probe would get a 403 CSRF and the test would "pass" without having
  // exercised anything — false green, the worst possible result here.
  if (method !== 'GET' && method !== 'HEAD') headers.origin = BASE;
  if (body !== undefined) headers['content-type'] = 'application/json';
  let r;
  try {
    r = await fetch(BASE + path, {
      method, headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      redirect: 'manual',
    });
  } catch (e) {
    return { status: 0, error: String(e?.message || e), data: null };
  }
  const t = await r.text();
  let data = null;
  try { data = JSON.parse(t); } catch { /* non-JSON */ }
  return { status: r.status, data, raw: t };
}

// ── Snapshots: what account A sees of its own resource, right now ──
// Each key returns a stable string. The string is compared before/after each
// probe; any difference is a side effect from the intruder.
const R = {};   // ids of the disposable resources created in account A
const SNAP = {
  thread: async () => {
    const l = await call('A', 'GET', '/api/threads');
    const t = (l.data?.threads || []).find((x) => x.id === R.threadId);
    return JSON.stringify(t || null);
  },
  agent: async () => {
    const g = await call('A', 'GET', `/api/agent/get?agentId=${R.agentId}`);
    return JSON.stringify({ status: g.status, data: g.data });
  },
  webhook: async () => {
    const g = await call('A', 'GET', `/api/agent/webhook/get?agentId=${R.agentId}`);
    // callCount/lastUsedAt change on their own if the webhook is used; what matters
    // here is existing, being on/off and the token hint.
    const d = g.data || {};
    return JSON.stringify({ status: g.status, exists: d.exists, enabled: d.enabled, hint: d.hint });
  },
  routine: async () => {
    const l = await call('A', 'GET', '/api/routines');
    const r = (l.data?.routines || []).find((x) => x.id === R.routineId);
    // last_run_at changes when the routine runs — and that's EXACTLY what the
    // /api/routine/run probe would try to trigger, so it stays within the comparison.
    return JSON.stringify(r || null);
  },
  page: async () => {
    const g = await call('A', 'GET', `/api/memory/page?slug=${encodeURIComponent(R.slug)}`);
    return JSON.stringify({ status: g.status, page: g.data?.page || null });
  },
  cockpit: async () => {
    const c = await call('A', 'GET', '/api/cockpit');
    const d = c.data || {};
    const meus = new Set([R.taskId, R.taskId2].filter(Boolean));
    return JSON.stringify({
      tasks: (d.tasks || []).filter((t) => meus.has(t.id)),
      groups: (d.groups || []).filter((g) => g.id === R.groupId),
      edges: (d.edges || []).filter((e) => meus.has(e.from_task) || meus.has(e.to_task)),
    });
  },
  device: async () => {
    const l = await call('A', 'GET', '/api/device/tokens');
    const d = (l.data?.devices || []).find((x) => x.id === R.deviceId);
    // last_seen_at is tied to the runner heartbeat; this test device never
    // polled, so the whole object works.
    return JSON.stringify(d || null);
  },
  connection: async () => {
    const l = await call('A', 'GET', '/api/connections');
    const c = (l.data?.connections || []).find((x) => x.id === R.connectionId);
    return JSON.stringify(c || null);
  },
  file: async () => {
    const l = await call('A', 'GET', '/api/files');
    const f = (l.data?.files || []).find((x) => x.id === R.fileId);
    return JSON.stringify(f || null);
  },
};

// An empty snapshot (resource doesn't exist) makes before === after === 'null' and the probe
// "passes" without having any target at all. That's a false green, the worst possible result here,
// so an empty snapshot becomes an explicit SKIP.
function retratoVazio(chave, s) {
  if (!s || s === 'null') return true;
  if (chave === 'cockpit') {
    const d = JSON.parse(s);
    return !d.tasks.length && !d.groups.length && !d.edges.length;
  }
  if (chave === 'agent' || chave === 'webhook' || chave === 'page') return JSON.parse(s).status !== 200;
  return false;
}

const results = [];
function record(nome, chave, r, mudou, obs) {
  const ok = mudou === null ? null : !mudou;
  results.push({ nome, recurso: chave, status: r.status, mudou, ok, obs: obs || null });
  const tag = ok === null ? 'SKIP' : ok ? 'PASSOU' : 'FALHOU';
  const efeito = mudou === null ? '' : mudou ? '  ·· O RECURSO DE A MUDOU ··' : '  · recurso de A intacto';
  console.log(`[${tag}] ${nome} → HTTP ${r.status}${efeito}${obs ? `  · ${obs}` : ''}`);
}

// ── Setup: creates the disposable in account A ──
async function setup() {
  const falta = [];

  const ag = await call('A', 'POST', '/api/agent', {
    name: `ZZ ${MARCA}`,
    goal: 'Disposable resource for the cross-account isolation test.',
    instructions: 'Do not use. Created by ops/tenancy-write-test.mjs.',
  });
  if (ag.status !== 200 || !ag.data?.id) return { erro: `failed to create the test assistant: HTTP ${ag.status} ${ag.raw?.slice(0, 200)}` };
  R.agentId = ag.data.id;

  const th = await call('A', 'POST', '/api/thread', { agentId: R.agentId, title: `ZZ ${MARCA} thread` });
  if (th.status === 200 && th.data?.id) R.threadId = th.data.id; else falta.push(`thread (HTTP ${th.status})`);

  // Test assistant's webhook: the /webhook/enabled probe is only meaningful
  // if a token already exists (the handler refuses to enable without a token), so it's generated here.
  const wh = await call('A', 'POST', '/api/agent/webhook/token', { agentId: R.agentId });
  if (wh.status !== 200) falta.push(`webhook do assistente (HTTP ${wh.status})`);

  const ro = await call('A', 'POST', '/api/routine', {
    agentId: R.agentId, title: `ZZ ${MARCA} rotina`,
    prompt: 'Disposable resource for the isolation test.',
    // `days` is a text column (default 'daily'), not an array. 3am and
    // a lifespan of minutes: the routine dies long before any trigger.
    hour: 3, days: 'daily', tz: 'America/Sao_Paulo',
  });
  if (ro.status === 200 && ro.data?.id) R.routineId = ro.data.id; else falta.push(`rotina (HTTP ${ro.status} ${ro.raw?.slice(0, 120)})`);

  const pg = await call('A', 'POST', '/api/memory/page', {
    slug: MARCA, title: `ZZ ${MARCA}`, body: 'CONTEUDO-ORIGINAL-DE-A',
  });
  if (pg.status === 200 && pg.data?.page?.slug) R.slug = pg.data.page.slug; else falta.push(`memory page (HTTP ${pg.status})`);

  for (const [k, titulo] of [['taskId', 'task 1'], ['taskId2', 'task 2']]) {
    const t = await call('A', 'POST', '/api/cockpit/task', {
      agentId: R.agentId, title: `ZZ ${MARCA} ${titulo}`,
      body: 'Disposable resource for the isolation test.', posX: 10, posY: 10, kind: 'task',
    });
    if (t.status === 200 && t.data?.task?.id) R[k] = t.data.task.id; else falta.push(`cockpit ${titulo} (HTTP ${t.status})`);
  }
  if (R.taskId && R.taskId2) {
    const ed = await call('A', 'POST', '/api/cockpit/edge', { fromTask: R.taskId, toTask: R.taskId2 });
    if (ed.status === 200 && ed.data?.edge?.id) R.edgeId = ed.data.edge.id; else falta.push(`cockpit edge (HTTP ${ed.status})`);
  }
  const gr = await call('A', 'POST', '/api/cockpit/group', { title: `ZZ ${MARCA} sequence`, posX: 200, posY: 200 });
  if (gr.status === 200 && gr.data?.group?.id) {
    R.groupId = gr.data.group.id;
    // Sequence needs an agent + queue for /group/run to reach execution; without
    // that the probe dies on a 400 validation error and doesn't test ownership at all.
    await call('A', 'POST', '/api/cockpit/group/update', { id: R.groupId, agentId: R.agentId, taskIds: [R.taskId].filter(Boolean) });
  } else falta.push(`cockpit sequence (HTTP ${gr.status})`);

  const dv = await call('A', 'POST', '/api/device/tokens', { label: `ZZ ${MARCA}` });
  if (dv.status === 200 && dv.data?.device?.id) { R.deviceId = dv.data.device.id; R.deviceToken = dv.data.token; }
  else falta.push(`device token (HTTP ${dv.status})`);

  const cn = await call('A', 'POST', '/api/connections', {
    provider: `zz-tenancy-test`, kind: 'apikey', label: `ZZ ${MARCA}`, secret: 'valor-descartavel-de-teste',
  });
  if (cn.status === 200 && cn.data?.connection?.id) R.connectionId = cn.data.connection.id;
  else falta.push(`vault connection (HTTP ${cn.status} ${cn.raw?.slice(0, 120)})`);

  const up = await call('A', 'POST', '/api/feed/upload', {
    data: Buffer.from(`disposable test file ${MARCA}`).toString('base64'),
    mimeType: 'text/plain', name: `${MARCA}.txt`,
  });
  if (up.status === 200 && up.data?.key) {
    R.fileKey = up.data.key;
    const fl = await call('A', 'GET', '/api/files');
    R.fileId = (fl.data?.files || []).find((f) => f.url?.includes(encodeURIComponent(R.fileKey)))?.id || null;
  }
  if (!R.fileId) falta.push(`file (HTTP ${up.status})`);

  return { falta };
}

// ── Probes: account B targets A's disposables ──
function probes() {
  const P = [];
  const add = (nome, chave, method, path, body, exige) => P.push({ nome, chave, method, path, body, exige });

  if (R.threadId) {
    const id = R.threadId;
    add('POST /api/thread/read', 'thread', 'POST', '/api/thread/read', { id });
    add('POST /api/thread/update', 'thread', 'POST', '/api/thread/update', { id, title: INVASOR, status: 'done' });
    add('POST /api/thread/favorite', 'thread', 'POST', '/api/thread/favorite', { id, on: true });
    add('POST /api/thread/archive', 'thread', 'POST', '/api/thread/archive', { id, on: true });
    add('POST /api/thread/delete', 'thread', 'POST', '/api/thread/delete', { id });
    add('DELETE /api/thread?id', 'thread', 'DELETE', `/api/thread?id=${encodeURIComponent(id)}`);
  }
  if (R.agentId) {
    const agentId = R.agentId;
    add('POST /api/agent/update', 'agent', 'POST', '/api/agent/update', { agentId, goal: INVASOR, instructions: INVASOR });
    add('POST /api/agent/rename', 'agent', 'POST', '/api/agent/rename', { agentId, name: INVASOR });
    add('POST /api/agent/webhook/token', 'webhook', 'POST', '/api/agent/webhook/token', { agentId });
    add('POST /api/agent/webhook/enabled', 'webhook', 'POST', '/api/agent/webhook/enabled', { agentId, enabled: false });
    // Assistant delete comes last among the 'agent' ones: if it goes through, the
    // following probes lose their target.
    add('POST /api/agent/delete', 'agent', 'POST', '/api/agent/delete', { agentId });
  }
  if (R.routineId) {
    const id = R.routineId;
    add('POST /api/routine/update', 'routine', 'POST', '/api/routine/update', { id, title: INVASOR, hour: 22 });
    add('POST /api/routine/run', 'routine', 'POST', '/api/routine/run', { id });
    add('POST /api/routine/delete', 'routine', 'POST', '/api/routine/delete', { id });
  }
  if (R.slug) {
    // Slug is namespaced by user: B's POST with A's slug creates/updates B's own
    // page. What's tested here is that A's isn't touched (and B's, if
    // it's created, gets deleted in cleanup).
    add('POST /api/memory/page (slug de A)', 'page', 'POST', '/api/memory/page', { slug: R.slug, title: INVASOR, body: INVASOR });
    add('POST /api/memory/page/delete', 'page', 'POST', '/api/memory/page/delete', { slug: R.slug });
  }
  if (R.taskId) {
    const id = R.taskId;
    add('POST /api/cockpit/task/update', 'cockpit', 'POST', '/api/cockpit/task/update', { id, title: INVASOR, body: INVASOR });
    add('POST /api/cockpit/task/approve', 'cockpit', 'POST', '/api/cockpit/task/approve', { id });
    add('POST /api/cockpit/task/run', 'cockpit', 'POST', '/api/cockpit/task/run', { id });
    add('POST /api/cockpit/task/chat', 'cockpit', 'POST', '/api/cockpit/task/chat', { id, message: 'oi' });
  }
  if (R.edgeId) add('DELETE /api/cockpit/edge?id', 'cockpit', 'DELETE', `/api/cockpit/edge?id=${encodeURIComponent(R.edgeId)}`);
  if (R.taskId && R.taskId2) add('POST /api/cockpit/edge (tarefas de A)', 'cockpit', 'POST', '/api/cockpit/edge', { fromTask: R.taskId2, toTask: R.taskId });
  if (R.groupId) {
    const id = R.groupId;
    add('POST /api/cockpit/group/update', 'cockpit', 'POST', '/api/cockpit/group/update', { id, title: INVASOR });
    add('POST /api/cockpit/group/run', 'cockpit', 'POST', '/api/cockpit/group/run', { id });
    add('DELETE /api/cockpit/group?id', 'cockpit', 'DELETE', `/api/cockpit/group?id=${encodeURIComponent(id)}`);
  }
  if (R.taskId) add('DELETE /api/cockpit/task?id', 'cockpit', 'DELETE', `/api/cockpit/task?id=${encodeURIComponent(R.taskId)}`);
  if (R.deviceId) {
    add('POST /api/device/tokens/enabled', 'device', 'POST', '/api/device/tokens/enabled', { id: R.deviceId, enabled: false });
    add('POST /api/device/tokens/revoke', 'device', 'POST', '/api/device/tokens/revoke', { id: R.deviceId });
  }
  if (R.connectionId) add('POST /api/connections/delete', 'connection', 'POST', '/api/connections/delete', { id: R.connectionId });
  if (R.fileId) add('DELETE /api/files?id', 'file', 'DELETE', `/api/files?id=${encodeURIComponent(R.fileId)}`);
  return P;
}

// Write endpoints with id that stay OUT, with the reason. None of them
// has a way to get a disposable target without touching something real of the owner's.
const NAO_COBERTO = [
  ['POST /api/home-items/delete', 'home item is generated by /api/home-refresh; no way to create a disposable one'],
  ['POST /api/apps/visibility', 'publish/unpublish requires a real app (container build)'],
  ['POST /api/apps/delete', 'deleting an app is irreversible and tears down the owner\'s container'],
  ['POST /api/apps/copy', 'copies from a public app; does not address a private resource by id'],
  ['POST /api/spaces/mode', 'there is no Space creation endpoint via the API (they are born through the assistant)'],
  ['POST /api/disconnect/provider', 'requires a real connected OAuth; disconnecting is destructive'],
  ['POST /api/google/accounts/remove', 'requires a real connected Google account'],
  ['POST /api/contacts/accept', 'requires a pending invite between the two accounts; would create a real link'],
  ['POST /api/contacts/decline', 'same'],
];

// ── Cleanup: account A itself undoes everything ──
async function cleanup() {
  const sobrou = [];
  const tenta = async (rotulo, who, method, path, body) => {
    const r = await call(who, method, path, body);
    if (r.status !== 200) sobrou.push(`${rotulo} (HTTP ${r.status})`);
  };
  if (R.fileId) await tenta('file', 'A', 'DELETE', `/api/files?id=${encodeURIComponent(R.fileId)}`);
  if (R.connectionId) await tenta('connection', 'A', 'POST', '/api/connections/delete', { id: R.connectionId });
  if (R.deviceId) await tenta('device token', 'A', 'POST', '/api/device/tokens/revoke', { id: R.deviceId });
  if (R.groupId) await tenta('sequence', 'A', 'DELETE', `/api/cockpit/group?id=${encodeURIComponent(R.groupId)}`);
  for (const id of [R.taskId, R.taskId2].filter(Boolean)) await tenta('task', 'A', 'DELETE', `/api/cockpit/task?id=${encodeURIComponent(id)}`);
  if (R.slug) {
    await tenta('memory page (A)', 'A', 'POST', '/api/memory/page/delete', { slug: R.slug });
    // If the probe created the same-named page in account B, it gets removed here.
    const b = await call('B', 'GET', `/api/memory/page?slug=${encodeURIComponent(R.slug)}`);
    if (b.status === 200) await tenta('memory page (B)', 'B', 'POST', '/api/memory/page/delete', { slug: R.slug });
  }
  if (R.routineId) await tenta('routine', 'A', 'POST', '/api/routine/delete', { id: R.routineId });
  if (R.threadId) await tenta('conversation', 'A', 'POST', '/api/thread/delete', { id: R.threadId });
  // Orphan threads that the chat/run probes may have created with the test's name.
  const th = await call('A', 'GET', '/api/threads');
  for (const t of (th.data?.threads || [])) {
    if (String(t.title || '').includes(MARCA) && t.id !== R.threadId) {
      await tenta('extra conversation', 'A', 'POST', '/api/thread/delete', { id: t.id });
    }
  }
  if (R.agentId) await tenta('assistant', 'A', 'POST', '/api/agent/delete', { agentId: R.agentId });
  return sobrou;
}

async function run() {
  console.log(`Base: ${BASE}`);
  console.log(`Tag for this run: ${MARCA}\n`);

  const me = { A: await call('A', 'GET', '/api/me'), B: await call('B', 'GET', '/api/me') };
  for (const w of ['A', 'B']) {
    if (me[w].status !== 200) { console.error(`Account ${w}: /api/me returned ${me[w].status} — invalid session.`); process.exit(2); }
    console.log(`Account ${w} = ${me[w].data?.name} / ${me[w].data?.subdomain}`);
  }
  console.log('');

  console.log('── Setup: creating the disposable resources on account A ──');
  const s = await setup();
  if (s.erro) { console.error(s.erro); process.exit(2); }
  console.log(`Created: ${Object.entries(R).filter(([k]) => k !== 'deviceToken').map(([k, v]) => `${k}=${String(v).slice(0, 8)}`).join(' ')}`);
  if (s.falta.length) console.log(`Could not create: ${s.falta.join('; ')}`);
  console.log('');

  let sobrou = [];
  try {
    const P = probes();
    console.log(`── Probes: B's session against the ${P.length} disposable targets of A ──`);
    for (const p of P) {
      const antes = await SNAP[p.chave]();
      if (retratoVazio(p.chave, antes)) {
        record(p.nome, p.chave, { status: '-' }, null, 'disposable target does not exist; probe did not run');
        continue;
      }
      const r = await call('B', p.method, p.path, p.body);
      // /task/run and /group/run respond 200 and continue in the background; gives a moment
      // for the effect (if any) to show up in the next snapshot.
      if (/\/run$/.test(p.path)) await new Promise((ok) => setTimeout(ok, 3000));
      const depois = await SNAP[p.chave]();
      const mudou = antes !== depois;
      const obs = mudou ? `antes=${antes.slice(0, 160)} depois=${depois.slice(0, 160)}` : null;
      record(p.nome, p.chave, r, mudou, obs);
    }
  } finally {
    console.log('\n── Cleanup (account A deleting what it created) ──');
    sobrou = await cleanup();
    console.log(sobrou.length ? `LEFT to delete by hand: ${sobrou.join('; ')}` : 'All deleted.');
  }

  const falhas = results.filter((r) => r.ok === false);
  console.log(`\nResumo: ${results.filter((r) => r.ok === true).length} passaram, ${falhas.length} falharam.`);
  console.log(`Still NOT covered (${NAO_COBERTO.length}):`);
  for (const [rota, motivo] of NAO_COBERTO) console.log(`  · ${rota} — ${motivo}`);
  if (process.env.JSON === '1') console.log('\n' + JSON.stringify({ marca: MARCA, results, naoCoberto: NAO_COBERTO, sobrou }, null, 2));
  process.exit(falhas.length ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(2); });
