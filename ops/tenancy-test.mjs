#!/usr/bin/env node
// ── Cross-account isolation suite (Phase 1 of the data security review) ──
//
// Question it answers, with proof at runtime rather than by reading the code:
// "with account B's session, can you read anything from account A?"
//
// How it works, in two steps:
//   1. DISCOVERY  — with each account's session, lists its REAL ids via the
//      listing endpoints (threads, files/media, agents, memory pages,
//      spaces, routines, cockpit, devices, connections, MCP, home).
//   2. PROBE       — repeats each endpoint that accepts an id, now with the
//      OTHER account's session (and also with no session at all), and requires a refusal (401/403/404).
//      A 200 response with the owner's content = isolation FAILURE.
//
// Only GET/HEAD in this version: no probe changes state. The write endpoints
// that accept an id are cataloged in WRITE_SURFACE further down and come out as SKIP
// with the reason, so nobody thinks they're covered.
//
// Usage:
//   SID_A=<account A's sid> SID_B=<account B's sid> node ops/tenancy-test.mjs
//   BASE=http://127.0.0.1:8080  (default: local server)
//   BASE=https://your-domain ALLOW_REMOTE=1  (any target outside this machine,
//     production included, requires ALLOW_REMOTE=1; see ops/tenancy-base.mjs)
//   JSON=1  prints the report in JSON at the end (for CI)
//
// The SIDs are real session cookies (`sessions` table, `token` column).
// Never commit a SID to the repo nor print it in the report: the script only shows the first
// 6 characters, enough to tell one account from the other.
//
// Output: exit 0 if none FAILED; exit 1 if any failed.

import { baseOrExit } from './tenancy-base.mjs';

const SID = { A: process.env.SID_A || '', B: process.env.SID_B || '' };

if (!SID.A || !SID.B) {
  console.error('Missing SID_A and/or SID_B (session cookie for each account).');
  process.exit(2);
}
const BASE = baseOrExit();

const short = (s) => (s ? String(s).slice(0, 6) + '…' : '(no session)');
const other = (who) => (who === 'A' ? 'B' : 'A');

// ── HTTP client ──
// `who` is 'A', 'B' or 'anon'. Origin only goes in a request that changes state (the
// server's csrfOk requires a known Origin/Referer outside of GET/HEAD).
async function call(who, method, path, { body } = {}) {
  const headers = {};
  if (who !== 'anon') headers.cookie = `sid=${SID[who]}`;
  if (body) { headers['content-type'] = 'application/json'; headers.origin = BASE; }
  let r;
  try {
    r = await fetch(BASE + path, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      redirect: 'manual',
    });
  } catch (e) {
    return { status: 0, error: String(e?.message || e), data: null, bytes: 0 };
  }
  const ct = r.headers.get('content-type') || '';
  if (method === 'HEAD') return { status: r.status, data: null, bytes: Number(r.headers.get('content-length') || 0), ct };
  if (ct.includes('json')) {
    const t = await r.text();
    let data = null;
    try { data = JSON.parse(t); } catch { /* non-JSON response with JSON content-type */ }
    return { status: r.status, data, bytes: t.length, ct };
  }
  const buf = await r.arrayBuffer();
  return { status: r.status, data: null, bytes: buf.byteLength, ct };
}

// ── Step 1: discovery ──
// Each account lists what's theirs. Everything here is reading its OWN data, with the
// owner's session: if something fails, it's a session problem, not isolation.
async function discover(who) {
  const inv = {
    who,
    email: null,
    userId: null,
    threads: [], mediaKeys: [], fileIds: [], agents: [], pages: [],
    spaces: [], routines: [], tasks: [], groups: [], devices: [],
    connections: [], mcp: [], homeItems: [], apps: [], subdomain: null,
    admin: false,
  };

  const me = await call(who, 'GET', '/api/me');
  if (me.status !== 200) {
    inv.error = `/api/me returned ${me.status} — invalid or expired session`;
    return inv;
  }
  // /api/me doesn't return id or e-mail. The id comes out of the media key's prefix
  // (S3 writes to "<userId>/<arquivo>"), which is exactly what /api/media
  // uses to decide whether the media belongs to the requester.
  inv.nome = me.data?.name || null;
  inv.subdomain = me.data?.subdomain || null;
  inv.apps = (me.data?.apps || []).map((a) => a.system || a.sistema).filter(Boolean);
  inv.agents = (me.data?.agents || []).map((a) => a.id).filter(Boolean);

  const grab = async (path, pick) => {
    const r = await call(who, 'GET', path);
    if (r.status !== 200) return [];
    try { return pick(r.data) || []; } catch { return []; }
  };

  inv.threads = await grab('/api/threads', (d) => (d.threads || []).map((t) => t.id));
  inv.fileIds = await grab('/api/files', (d) => (d.files || []).map((f) => f.id));
  inv.mediaKeys = await grab('/api/files', (d) => (d.files || [])
    .map((f) => {
      const m = /key=([^&]+)/.exec(f.url || '');
      return m ? decodeURIComponent(m[1]) : null;
    })
    .filter(Boolean));
  const lk = await call(who, 'GET', '/api/likeness');
  if (lk.status === 200 && lk.data?.anchorUrl) {
    const m = /key=([^&]+)/.exec(lk.data.anchorUrl);
    if (m) inv.mediaKeys.push(decodeURIComponent(m[1]));
  }
  inv.pages = await grab('/api/memory/overview', (d) => (d.pages || []).map((p) => p.slug));
  if (!inv.agents.length) inv.agents = await grab('/api/memory/overview', (d) => (d.agents || []).map((a) => a.id));
  inv.spaces = await grab('/api/spaces', (d) => (d.spaces || d || []).map((s) => s.id));
  inv.routines = await grab('/api/routines', (d) => (d.routines || []).map((r) => r.id));
  const ck = await call(who, 'GET', '/api/cockpit');
  if (ck.status === 200) {
    inv.tasks = (ck.data?.tasks || []).map((t) => t.id);
    inv.groups = (ck.data?.groups || []).map((g) => g.id);
  }
  inv.devices = await grab('/api/device/tokens', (d) => (d.devices || []).map((x) => x.id));
  inv.connections = await grab('/api/connections', (d) => (d.connections || []).map((c) => c.id));
  inv.mcp = await grab('/api/mcp', (d) => (d.servers || []).map((s) => s.id));
  inv.homeItems = await grab('/api/home-items', (d) => [...(d.notes || []), ...(d.suggestions || [])].map((i) => i.id));
  // Admin isn't a role in the database, it's the e-mail in ADMIN_EMAIL. Detected from the
  // outside: the whitelist route responds 200 only for them and 403 for everyone else. It matters because
  // some endpoints (e.g.: /api/usage?user=) change behavior for admin.
  inv.admin = (await call(who, 'GET', '/api/admin/whitelist')).status === 200;
  const uuid = /^([0-9a-f-]{36})\//i.exec(inv.mediaKeys[0] || '');
  // An account with no media at all doesn't reveal its own id via the API; accepts the id coming
  // from the environment (UID_A / UID_B) so as not to leave the /api/usage probe without a target.
  inv.userId = uuid ? uuid[1] : (process.env[`UID_${who}`] || null);
  return inv;
}

// ── Step 2: probes ──
// Each probe is: take an id from the owner and hit the endpoint with the intruder's session.
// `ok` receives the response and returns true when the server refused as it should.
const recusou = (r) => r.status === 401 || r.status === 403 || r.status === 404;

const results = [];
function record(nome, alvo, intruso, r, ok, obs) {
  results.push({ nome, alvo, intruso, status: r.status, bytes: r.bytes, ok, obs: obs || null });
  const tag = ok === null ? 'SKIP' : ok ? 'PASSOU' : 'FALHOU';
  const linha = `[${tag}] ${nome} — id of ${alvo}, session of ${intruso} → HTTP ${r.status}${r.bytes ? ` (${r.bytes}B)` : ''}`;
  console.log(obs ? `${linha}  · ${obs}` : linha);
}

// Read probes: [name, path from the id, inventory field]
const READ_PROBES = [
  ['GET /api/thread?id',                (id) => `/api/thread?id=${encodeURIComponent(id)}`,            'threads'],
  ['GET /api/media?key',                (k)  => `/api/media?key=${encodeURIComponent(k)}`,             'mediaKeys'],
  ['GET /api/agent/get?agentId',        (id) => `/api/agent/get?agentId=${encodeURIComponent(id)}`,    'agents'],
  ['GET /api/agent/webhook/get',        (id) => `/api/agent/webhook/get?agentId=${encodeURIComponent(id)}`, 'agents'],
  ['GET /api/memory/prompt?agentId',    (id) => `/api/memory/prompt?agentId=${encodeURIComponent(id)}`, 'agents'],
  ['GET /api/memory/page?slug',         (s)  => `/api/memory/page?slug=${encodeURIComponent(s)}`,       'pagesSo'],
];

// Write endpoints that accept an id. They are NOT exercised here: if
// isolation is broken, the probe would delete/alter the owner's real data.
// They stay listed so the report explicitly states what wasn't covered.
const WRITE_SURFACE = [
  'POST /api/thread/read', 'POST /api/thread/update', 'POST /api/thread/delete',
  'DELETE /api/thread', 'POST /api/thread/favorite', 'POST /api/thread/archive',
  'DELETE /api/files?id', 'POST /api/home-items/delete',
  'POST /api/agent/update', 'POST /api/agent/rename', 'POST /api/agent/delete',
  'POST /api/agent/webhook/token', 'POST /api/agent/webhook/enabled',
  'POST /api/apps/visibility', 'POST /api/apps/delete', 'POST /api/apps/copy',
  'POST /api/spaces/mode', 'POST /api/memory/page', 'POST /api/memory/page/delete',
  'POST /api/routine/update', 'POST /api/routine/delete', 'POST /api/routine/run',
  'POST /api/cockpit/task/update', 'DELETE /api/cockpit/task', 'POST /api/cockpit/task/run',
  'POST /api/cockpit/task/chat', 'POST /api/cockpit/task/approve',
  'POST /api/cockpit/edge', 'DELETE /api/cockpit/edge',
  'POST /api/cockpit/group/update', 'DELETE /api/cockpit/group', 'POST /api/cockpit/group/run',
  'POST /api/device/tokens/enabled', 'POST /api/device/tokens/revoke',
  'POST /api/connections/delete', 'POST /api/disconnect/provider',
  'POST /api/google/accounts/remove', 'POST /api/contacts/accept', 'POST /api/contacts/decline',
  'POST /api/runner/result (token de device)', 'POST /api/device/chat (token de device)',
];

async function run() {
  console.log(`Base: ${BASE}`);
  console.log(`Sessions: A=${short(SID.A)}  B=${short(SID.B)}\n`);

  const invA = await discover('A');
  const invB = await discover('B');
  for (const inv of [invA, invB]) {
    if (inv.error) { console.error(`Account ${inv.who}: ${inv.error}`); process.exit(2); }
    console.log(`Account ${inv.who} = ${inv.nome} / ${inv.subdomain} (userId ${inv.userId || 'not found'})`);
    console.log(`  threads=${inv.threads.length} media=${inv.mediaKeys.length} agents=${inv.agents.length} ` +
      `pages=${inv.pages.length} spaces=${inv.spaces.length} routines=${inv.routines.length} ` +
      `tasks=${inv.tasks.length} devices=${inv.devices.length} connections=${inv.connections.length} ` +
      `mcp=${inv.mcp.length} home=${inv.homeItems.length} apps=${inv.apps.length}`);
  }
  console.log('');

  const inv = { A: invA, B: invB };
  // Page slug is namespaced by user: a 200 on a slug that BOTH accounts
  // have proves nothing. Exclusive slugs go to the status probe; the
  // shared ones go to the content-comparison probe, further below.
  const compartilhados = invA.pages.filter((s) => invB.pages.includes(s));
  invA.pagesSo = invA.pages.filter((s) => !compartilhados.includes(s));
  invB.pagesSo = invB.pages.filter((s) => !compartilhados.includes(s));

  for (const [nome, mk, campo] of READ_PROBES) {
    for (const dono of ['A', 'B']) {
      const ids = inv[dono][campo] || [];
      if (!ids.length) { record(nome, dono, other(dono), { status: 0, bytes: 0 }, null, 'the account does not have this resource'); continue; }
      const id = ids[0];
      const path = mk(id);
      const r = await call(other(dono), 'GET', path);
      record(nome, dono, other(dono), r, recusou(r));

      // Same id, with no session at all.
      const anon = await call('anon', 'GET', path);
      record(nome + ' (anonymous)', dono, 'anon', anon, recusou(anon));
    }
  }

  // HEAD on media: the bytes path has its own handling (Range/HEAD), so
  // it's worth exercising separately from GET. Same for Range, which responds 206 and is a different branch.
  for (const dono of ['A', 'B']) {
    const k = (inv[dono].mediaKeys || [])[0];
    if (!k) continue;
    const p = `/api/media?key=${encodeURIComponent(k)}`;
    const h = await call(other(dono), 'HEAD', p);
    record('HEAD /api/media?key', dono, other(dono), h, recusou(h));
  }

  // Slug that both accounts have: the test is about CONTENT. Each one reads the same
  // slug and the responses have to be different (each sees their own page).
  // Equal = the same page is serving both accounts.
  for (const slug of compartilhados) {
    const a = await call('A', 'GET', `/api/memory/page?slug=${encodeURIComponent(slug)}`);
    const b = await call('B', 'GET', `/api/memory/page?slug=${encodeURIComponent(slug)}`);
    const igual = a.status === 200 && b.status === 200 &&
      JSON.stringify(a.data?.page?.content ?? a.data) === JSON.stringify(b.data?.page?.content ?? b.data);
    record(`GET /api/memory/page?slug=${slug} (content)`, 'A', 'B', b, !igual,
      igual ? 'both accounts receive the SAME page' : 'each account receives its own page');
  }

  // /api/usage?user= can't be judged by status: for non-admin the server
  // ignores the parameter and returns 200 with the requester's OWN usage. The
  // proof is comparing the two responses — if asking for the other's id changes the number,
  // the parameter was honored and that IS a leak.
  for (const dono of ['A', 'B']) {
    const alvoId = inv[dono].userId;
    const intruso = other(dono);
    if (!alvoId) { record('GET /api/usage?user', dono, intruso, { status: 0, bytes: 0 }, null, 'could not find the userId (account without media)'); continue; }
    if (inv[intruso].admin) {
      record('GET /api/usage?user', dono, intruso, { status: 0, bytes: 0 }, null,
        'session is the ADMIN_EMAIL account — reading another user\'s aggregated usage is the intended behavior');
      continue;
    }
    const proprio = await call(intruso, 'GET', '/api/usage?by=day');
    const cruzado = await call(intruso, 'GET', `/api/usage?by=day&user=${encodeURIComponent(alvoId)}`);
    const igual = JSON.stringify(proprio.data) === JSON.stringify(cruzado.data);
    record('GET /api/usage?user', dono, intruso, cruzado, igual,
      igual ? 'parameter ignored (response identical to its own)' : 'RESPONSE CHANGED when asking for the other\'s id');
  }

  // Privilege escalation: a regular session cannot open the admin route.
  for (const who of ['A', 'B']) {
    if (inv[who].admin) continue;
    for (const rota of ['/api/admin/whitelist', '/api/admin/waitlist', '/api/admin/mobile-errors', '/api/signups']) {
      const r = await call(who, 'GET', rota);
      record(`GET ${rota}`, 'admin', who, r, recusou(r) || r.status === 405);
    }
  }

  const falhas = results.filter((r) => r.ok === false);
  const passes = results.filter((r) => r.ok === true);
  const skips = results.filter((r) => r.ok === null);
  console.log(`\nSummary: ${passes.length} passed, ${falhas.length} failed, ${skips.length} skipped.`);
  console.log(`WRITE surface not covered in this round (${WRITE_SURFACE.length} endpoints):`);
  for (const w of WRITE_SURFACE) console.log(`  · ${w}`);
  if (process.env.JSON === '1') console.log('\n' + JSON.stringify({ results, writeSurface: WRITE_SURFACE }, null, 2));
  process.exit(falhas.length ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(2); });
