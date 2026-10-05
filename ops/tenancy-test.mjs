#!/usr/bin/env node
// ── Suíte de isolamento entre contas (Fase 1 da revisão de segurança de dados) ──
//
// Pergunta que ela responde, com prova em execução e não por leitura de código:
// "com a sessão da conta B, dá pra ler alguma coisa da conta A?"
//
// Como funciona, em duas etapas:
//   1. DESCOBERTA  — com a sessão de cada conta, lista os ids REAIS dela pelos
//      endpoints de listagem (threads, arquivos/mídia, agentes, páginas de
//      memória, spaces, rotinas, cockpit, devices, conexões, MCP, home).
//   2. PROBE       — repete cada endpoint que aceita id, agora com a sessão da
//      OUTRA conta (e também sem sessão nenhuma), e exige recusa (401/403/404).
//      Resposta 200 com conteúdo do dono = FALHA de isolamento.
//
// Só GET/HEAD nesta versão: nenhum probe muda estado. Os endpoints de escrita
// que aceitam id estão catalogados em WRITE_SURFACE lá embaixo e saem como SKIP
// com o motivo, pra ninguém achar que estão cobertos.
//
// Uso:
//   SID_A=<sid da conta A> SID_B=<sid da conta B> node ops/tenancy-test.mjs
//   BASE=http://127.0.0.1:8080  (padrão: servidor local)
//   BASE=https://seu-dominio ALLOW_REMOTE=1  (qualquer alvo fora desta máquina,
//     produção inclusive, exige ALLOW_REMOTE=1; ver ops/tenancy-base.mjs)
//   JSON=1  imprime o relatório em JSON no fim (pra CI)
//
// Os SIDs são cookies de sessão de verdade (tabela `sessions`, coluna `token`).
// Nunca commitar SID no repo nem imprimir no relatório: o script só mostra os 6
// primeiros caracteres, o suficiente pra distinguir uma conta da outra.
//
// Saída: exit 0 se nenhum FALHOU; exit 1 se algum falhou.

import { baseOrExit } from './tenancy-base.mjs';

const SID = { A: process.env.SID_A || '', B: process.env.SID_B || '' };

if (!SID.A || !SID.B) {
  console.error('Faltou SID_A e/ou SID_B (cookie de sessão de cada conta).');
  process.exit(2);
}
const BASE = baseOrExit();

const short = (s) => (s ? String(s).slice(0, 6) + '…' : '(sem sessão)');
const other = (who) => (who === 'A' ? 'B' : 'A');

// ── Cliente HTTP ──
// `who` é 'A', 'B' ou 'anon'. Origin só vai em requisição que muda estado (o
// csrfOk do server exige Origin/Referer conhecido fora de GET/HEAD).
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
    try { data = JSON.parse(t); } catch { /* resposta não-JSON com content-type JSON */ }
    return { status: r.status, data, bytes: t.length, ct };
  }
  const buf = await r.arrayBuffer();
  return { status: r.status, data: null, bytes: buf.byteLength, ct };
}

// ── Etapa 1: descoberta ──
// Cada conta lista o que é dela. Tudo aqui é leitura do PRÓPRIO dado, com a
// sessão do dono: se algo falhar, é problema de sessão, não de isolamento.
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
    inv.error = `/api/me devolveu ${me.status} — sessão inválida ou expirada`;
    return inv;
  }
  // /api/me não devolve id nem e-mail. O id sai do prefixo da chave de mídia
  // (o S3 grava em "<userId>/<arquivo>"), que é justamente o que o /api/media
  // usa pra decidir se a mídia é do requisitante.
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
  // Admin não é papel no banco, é o e-mail em ADMIN_EMAIL. Descobre pela porta:
  // a rota de whitelist responde 200 só pra ele e 403 pro resto. Importa porque
  // alguns endpoints (ex.: /api/usage?user=) mudam de comportamento pra admin.
  inv.admin = (await call(who, 'GET', '/api/admin/whitelist')).status === 200;
  const uuid = /^([0-9a-f-]{36})\//i.exec(inv.mediaKeys[0] || '');
  // Conta sem nenhuma mídia não revela o próprio id por API; aceita o id vindo
  // do ambiente (UID_A / UID_B) pra não deixar o probe de /api/usage sem alvo.
  inv.userId = uuid ? uuid[1] : (process.env[`UID_${who}`] || null);
  return inv;
}

// ── Etapa 2: probes ──
// Cada probe é: pegar um id do dono e bater no endpoint com a sessão do intruso.
// `ok` recebe a resposta e devolve true quando o servidor recusou como deveria.
const recusou = (r) => r.status === 401 || r.status === 403 || r.status === 404;

const results = [];
function record(nome, alvo, intruso, r, ok, obs) {
  results.push({ nome, alvo, intruso, status: r.status, bytes: r.bytes, ok, obs: obs || null });
  const tag = ok === null ? 'SKIP' : ok ? 'PASSOU' : 'FALHOU';
  const linha = `[${tag}] ${nome} — id de ${alvo}, sessão de ${intruso} → HTTP ${r.status}${r.bytes ? ` (${r.bytes}B)` : ''}`;
  console.log(obs ? `${linha}  · ${obs}` : linha);
}

// Probes de leitura: [nome, caminho a partir do id, campo do inventário]
const READ_PROBES = [
  ['GET /api/thread?id',                (id) => `/api/thread?id=${encodeURIComponent(id)}`,            'threads'],
  ['GET /api/media?key',                (k)  => `/api/media?key=${encodeURIComponent(k)}`,             'mediaKeys'],
  ['GET /api/agent/get?agentId',        (id) => `/api/agent/get?agentId=${encodeURIComponent(id)}`,    'agents'],
  ['GET /api/agent/webhook/get',        (id) => `/api/agent/webhook/get?agentId=${encodeURIComponent(id)}`, 'agents'],
  ['GET /api/memory/prompt?agentId',    (id) => `/api/memory/prompt?agentId=${encodeURIComponent(id)}`, 'agents'],
  ['GET /api/memory/page?slug',         (s)  => `/api/memory/page?slug=${encodeURIComponent(s)}`,       'pagesSo'],
];

// Endpoints de escrita que aceitam id. NÃO são exercitados aqui: se o
// isolamento estiver furado, o probe apagaria/alteraria dado real do dono.
// Ficam listados pra o relatório dizer explicitamente o que não foi coberto.
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
  console.log(`Sessões: A=${short(SID.A)}  B=${short(SID.B)}\n`);

  const invA = await discover('A');
  const invB = await discover('B');
  for (const inv of [invA, invB]) {
    if (inv.error) { console.error(`Conta ${inv.who}: ${inv.error}`); process.exit(2); }
    console.log(`Conta ${inv.who} = ${inv.nome} / ${inv.subdomain} (userId ${inv.userId || 'não descoberto'})`);
    console.log(`  threads=${inv.threads.length} mídia=${inv.mediaKeys.length} agentes=${inv.agents.length} ` +
      `páginas=${inv.pages.length} spaces=${inv.spaces.length} rotinas=${inv.routines.length} ` +
      `tarefas=${inv.tasks.length} devices=${inv.devices.length} conexões=${inv.connections.length} ` +
      `mcp=${inv.mcp.length} home=${inv.homeItems.length} apps=${inv.apps.length}`);
  }
  console.log('');

  const inv = { A: invA, B: invB };
  // Slug de página é namespaced por usuário: um 200 num slug que as DUAS contas
  // têm não prova nada. Os slugs exclusivos vão pro probe de status; os
  // compartilhados vão pro probe de comparação de conteúdo, mais abaixo.
  const compartilhados = invA.pages.filter((s) => invB.pages.includes(s));
  invA.pagesSo = invA.pages.filter((s) => !compartilhados.includes(s));
  invB.pagesSo = invB.pages.filter((s) => !compartilhados.includes(s));

  for (const [nome, mk, campo] of READ_PROBES) {
    for (const dono of ['A', 'B']) {
      const ids = inv[dono][campo] || [];
      if (!ids.length) { record(nome, dono, other(dono), { status: 0, bytes: 0 }, null, 'a conta não tem esse recurso'); continue; }
      const id = ids[0];
      const path = mk(id);
      const r = await call(other(dono), 'GET', path);
      record(nome, dono, other(dono), r, recusou(r));

      // Mesmo id, sem sessão nenhuma.
      const anon = await call('anon', 'GET', path);
      record(nome + ' (anônimo)', dono, 'anon', anon, recusou(anon));
    }
  }

  // HEAD na mídia: o caminho de bytes tem tratamento próprio (Range/HEAD), então
  // vale exercitar separado do GET. Idem Range, que responde 206 e é outro ramo.
  for (const dono of ['A', 'B']) {
    const k = (inv[dono].mediaKeys || [])[0];
    if (!k) continue;
    const p = `/api/media?key=${encodeURIComponent(k)}`;
    const h = await call(other(dono), 'HEAD', p);
    record('HEAD /api/media?key', dono, other(dono), h, recusou(h));
  }

  // Slug que as duas contas têm: o teste é de CONTEÚDO. Cada uma lê o mesmo
  // slug e as respostas têm que ser diferentes (cada um vê a sua página).
  // Iguais = a mesma página está servindo as duas contas.
  for (const slug of compartilhados) {
    const a = await call('A', 'GET', `/api/memory/page?slug=${encodeURIComponent(slug)}`);
    const b = await call('B', 'GET', `/api/memory/page?slug=${encodeURIComponent(slug)}`);
    const igual = a.status === 200 && b.status === 200 &&
      JSON.stringify(a.data?.page?.content ?? a.data) === JSON.stringify(b.data?.page?.content ?? b.data);
    record(`GET /api/memory/page?slug=${slug} (conteúdo)`, 'A', 'B', b, !igual,
      igual ? 'as duas contas recebem a MESMA página' : 'cada conta recebe a sua página');
  }

  // /api/usage?user= não dá pra julgar pelo status: pra não-admin o servidor
  // ignora o parâmetro e devolve 200 com o consumo do PRÓPRIO requisitante. A
  // prova é comparar as duas respostas — se pedir o id do outro muda o número,
  // o parâmetro foi honrado e isso É vazamento.
  for (const dono of ['A', 'B']) {
    const alvoId = inv[dono].userId;
    const intruso = other(dono);
    if (!alvoId) { record('GET /api/usage?user', dono, intruso, { status: 0, bytes: 0 }, null, 'não descobri o userId (conta sem mídia)'); continue; }
    if (inv[intruso].admin) {
      record('GET /api/usage?user', dono, intruso, { status: 0, bytes: 0 }, null,
        'sessão é a conta de ADMIN_EMAIL — ler consumo agregado de outro usuário é o comportamento desenhado');
      continue;
    }
    const proprio = await call(intruso, 'GET', '/api/usage?by=day');
    const cruzado = await call(intruso, 'GET', `/api/usage?by=day&user=${encodeURIComponent(alvoId)}`);
    const igual = JSON.stringify(proprio.data) === JSON.stringify(cruzado.data);
    record('GET /api/usage?user', dono, intruso, cruzado, igual,
      igual ? 'parâmetro ignorado (resposta idêntica à própria)' : 'RESPOSTA MUDOU ao pedir o id do outro');
  }

  // Escalada de privilégio: sessão comum não pode abrir rota de admin.
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
  console.log(`\nResumo: ${passes.length} passaram, ${falhas.length} falharam, ${skips.length} pulados.`);
  console.log(`Superfície de ESCRITA não coberta nesta rodada (${WRITE_SURFACE.length} endpoints):`);
  for (const w of WRITE_SURFACE) console.log(`  · ${w}`);
  if (process.env.JSON === '1') console.log('\n' + JSON.stringify({ results, writeSurface: WRITE_SURFACE }, null, 2));
  process.exit(falhas.length ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(2); });
