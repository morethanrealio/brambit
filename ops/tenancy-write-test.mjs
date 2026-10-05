#!/usr/bin/env node
// ── Isolamento entre contas: superfície de ESCRITA (Fase 1, parte 2) ──────────
//
// A suíte irmã (ops/tenancy-test.mjs) só faz leitura. Esta cobre os endpoints
// que MUDAM estado e aceitam um id, que são justamente os perigosos: se a checagem
// de dono falhar num deles, a conta B não lê o dado de A — ela apaga.
//
// Regra que torna isso seguro de rodar em produção: nenhum probe aponta pra
// recurso real do dono. O teste CRIA antes, na conta A, um conjunto descartável
// (assistente, conversa, rotina, página, tarefas, sequência, aresta, device,
// conexão, arquivo), a conta B tenta destruir/alterar ESSES, e no fim tudo é
// apagado pela própria conta A. Se o isolamento estiver furado, o que se perde é
// lixo de teste.
//
// Veredito NÃO é o status HTTP: vários handlers respondem 200 mesmo sem afetar
// nada (o UPDATE tem `WHERE user_id = $x` e casa zero linhas). O que vale é o
// EFEITO: antes de cada probe tira-se um retrato do recurso pela sessão de A,
// roda-se o probe com a sessão de B, e tira-se o retrato de novo. Mudou = FALHOU.
//
// Uso:
//   SID_A=<sid da conta A> SID_B=<sid da conta B> node ops/tenancy-write-test.mjs
//   BASE=http://127.0.0.1:8080  (padrão: servidor local)
//   BASE=https://seu-dominio ALLOW_REMOTE=1  (qualquer alvo fora desta máquina,
//     produção inclusive, exige ALLOW_REMOTE=1; ver ops/tenancy-base.mjs)
//   JSON=1  imprime o relatório em JSON no fim (pra CI)
//
// A limpeza roda em `finally`: se o processo morrer no meio, sobra lixo com o
// prefixo `zz-tenancy-` na conta A, seguro de apagar à mão.
//
// Saída: exit 0 se nenhum FALHOU; 1 se algum falhou; 2 em erro de setup.

import { baseOrExit } from './tenancy-base.mjs';

const SID = { A: process.env.SID_A || '', B: process.env.SID_B || '' };

if (!SID.A || !SID.B) {
  console.error('Faltou SID_A e/ou SID_B (cookie de sessão de cada conta).');
  process.exit(2);
}
const BASE = baseOrExit();

const MARCA = 'zz-tenancy-' + Date.now().toString(36);
const INVASOR = 'INVADIDO-POR-B';

async function call(who, method, path, body) {
  const headers = {};
  if (who !== 'anon') headers.cookie = `sid=${SID[who]}`;
  // csrfOk() libera GET/HEAD/OPTIONS e exige Origin conhecido no resto. Sem este
  // header todo probe de escrita tomaria 403 de CSRF e o teste "passaria" sem ter
  // exercitado nada — falso verde, o pior resultado possível aqui.
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
  try { data = JSON.parse(t); } catch { /* não-JSON */ }
  return { status: r.status, data, raw: t };
}

// ── Retratos: o que a conta A vê do próprio recurso, agora ──
// Cada chave devolve uma string estável. Compara-se a string antes/depois de cada
// probe; qualquer diferença é efeito colateral do intruso.
const R = {};   // ids dos recursos descartáveis criados na conta A
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
    // callCount/lastUsedAt mexem sozinhos se o webhook for usado; o que importa
    // aqui é existir, estar ligado/desligado e o hint do token.
    const d = g.data || {};
    return JSON.stringify({ status: g.status, exists: d.exists, enabled: d.enabled, hint: d.hint });
  },
  routine: async () => {
    const l = await call('A', 'GET', '/api/routines');
    const r = (l.data?.routines || []).find((x) => x.id === R.routineId);
    // last_run_at muda quando a rotina roda — e é EXATAMENTE o que o probe de
    // /api/routine/run tentaria provocar, então fica dentro da comparação.
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
    // last_seen_at mexe com heartbeat de runner; este device de teste nunca
    // pollou, então o objeto inteiro serve.
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

// Um retrato vazio (recurso não existe) faz antes === depois === 'null' e o probe
// "passa" sem ter alvo nenhum. Isso é falso verde, o pior resultado possível aqui,
// então retrato vazio vira SKIP explícito.
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

// ── Setup: cria o descartável na conta A ──
async function setup() {
  const falta = [];

  const ag = await call('A', 'POST', '/api/agent', {
    name: `ZZ ${MARCA}`,
    goal: 'Recurso descartável do teste de isolamento entre contas.',
    instructions: 'Não usar. Criado por ops/tenancy-write-test.mjs.',
  });
  if (ag.status !== 200 || !ag.data?.id) return { erro: `não criei o assistente de teste: HTTP ${ag.status} ${ag.raw?.slice(0, 200)}` };
  R.agentId = ag.data.id;

  const th = await call('A', 'POST', '/api/thread', { agentId: R.agentId, title: `ZZ ${MARCA} thread` });
  if (th.status === 200 && th.data?.id) R.threadId = th.data.id; else falta.push(`thread (HTTP ${th.status})`);

  // Webhook do assistente de teste: o probe de /webhook/enabled só é significativo
  // se já existir token (o handler recusa ativar sem token), então gera aqui.
  const wh = await call('A', 'POST', '/api/agent/webhook/token', { agentId: R.agentId });
  if (wh.status !== 200) falta.push(`webhook do assistente (HTTP ${wh.status})`);

  const ro = await call('A', 'POST', '/api/routine', {
    agentId: R.agentId, title: `ZZ ${MARCA} rotina`,
    prompt: 'Recurso descartável do teste de isolamento.',
    // `days` é coluna de texto (default 'daily'), não array. Hora 3 da manhã e
    // vida útil de minutos: a rotina morre muito antes de qualquer disparo.
    hour: 3, days: 'daily', tz: 'America/Sao_Paulo',
  });
  if (ro.status === 200 && ro.data?.id) R.routineId = ro.data.id; else falta.push(`rotina (HTTP ${ro.status} ${ro.raw?.slice(0, 120)})`);

  const pg = await call('A', 'POST', '/api/memory/page', {
    slug: MARCA, title: `ZZ ${MARCA}`, body: 'CONTEUDO-ORIGINAL-DE-A',
  });
  if (pg.status === 200 && pg.data?.page?.slug) R.slug = pg.data.page.slug; else falta.push(`página de memória (HTTP ${pg.status})`);

  for (const [k, titulo] of [['taskId', 'tarefa 1'], ['taskId2', 'tarefa 2']]) {
    const t = await call('A', 'POST', '/api/cockpit/task', {
      agentId: R.agentId, title: `ZZ ${MARCA} ${titulo}`,
      body: 'Recurso descartável do teste de isolamento.', posX: 10, posY: 10, kind: 'task',
    });
    if (t.status === 200 && t.data?.task?.id) R[k] = t.data.task.id; else falta.push(`${titulo} do cockpit (HTTP ${t.status})`);
  }
  if (R.taskId && R.taskId2) {
    const ed = await call('A', 'POST', '/api/cockpit/edge', { fromTask: R.taskId, toTask: R.taskId2 });
    if (ed.status === 200 && ed.data?.edge?.id) R.edgeId = ed.data.edge.id; else falta.push(`aresta do cockpit (HTTP ${ed.status})`);
  }
  const gr = await call('A', 'POST', '/api/cockpit/group', { title: `ZZ ${MARCA} sequência`, posX: 200, posY: 200 });
  if (gr.status === 200 && gr.data?.group?.id) {
    R.groupId = gr.data.group.id;
    // Sequência precisa de agente + fila pra o /group/run chegar na execução; sem
    // isso o probe morre em 400 de validação e não testa posse nenhuma.
    await call('A', 'POST', '/api/cockpit/group/update', { id: R.groupId, agentId: R.agentId, taskIds: [R.taskId].filter(Boolean) });
  } else falta.push(`sequência do cockpit (HTTP ${gr.status})`);

  const dv = await call('A', 'POST', '/api/device/tokens', { label: `ZZ ${MARCA}` });
  if (dv.status === 200 && dv.data?.device?.id) { R.deviceId = dv.data.device.id; R.deviceToken = dv.data.token; }
  else falta.push(`device token (HTTP ${dv.status})`);

  const cn = await call('A', 'POST', '/api/connections', {
    provider: `zz-tenancy-test`, kind: 'apikey', label: `ZZ ${MARCA}`, secret: 'valor-descartavel-de-teste',
  });
  if (cn.status === 200 && cn.data?.connection?.id) R.connectionId = cn.data.connection.id;
  else falta.push(`conexão no cofre (HTTP ${cn.status} ${cn.raw?.slice(0, 120)})`);

  const up = await call('A', 'POST', '/api/feed/upload', {
    data: Buffer.from(`arquivo descartável do teste ${MARCA}`).toString('base64'),
    mimeType: 'text/plain', name: `${MARCA}.txt`,
  });
  if (up.status === 200 && up.data?.key) {
    R.fileKey = up.data.key;
    const fl = await call('A', 'GET', '/api/files');
    R.fileId = (fl.data?.files || []).find((f) => f.url?.includes(encodeURIComponent(R.fileKey)))?.id || null;
  }
  if (!R.fileId) falta.push(`arquivo (HTTP ${up.status})`);

  return { falta };
}

// ── Probes: a conta B mira os descartáveis de A ──
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
    // Delete do assistente vem por último entre os de 'agent': se passar, os
    // probes seguintes perdem o alvo.
    add('POST /api/agent/delete', 'agent', 'POST', '/api/agent/delete', { agentId });
  }
  if (R.routineId) {
    const id = R.routineId;
    add('POST /api/routine/update', 'routine', 'POST', '/api/routine/update', { id, title: INVASOR, hour: 22 });
    add('POST /api/routine/run', 'routine', 'POST', '/api/routine/run', { id });
    add('POST /api/routine/delete', 'routine', 'POST', '/api/routine/delete', { id });
  }
  if (R.slug) {
    // Slug é namespaced por usuário: o POST de B com o slug de A cria/atualiza a
    // página DE B. O que se testa aqui é que a de A não é tocada (e a de B, se
    // nascer, é apagada na limpeza).
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

// Endpoints de escrita com id que continuam DE FORA, com o motivo. Nenhum deles
// tem como ganhar um alvo descartável sem mexer em coisa real do dono.
const NAO_COBERTO = [
  ['POST /api/home-items/delete', 'item de home é gerado pelo /api/home-refresh; não há como criar um descartável'],
  ['POST /api/apps/visibility', 'publicar/despublicar exige um app real (build de container)'],
  ['POST /api/apps/delete', 'apagar app é irreversível e derruba o container do dono'],
  ['POST /api/apps/copy', 'copia a partir de app público; não endereça recurso privado por id'],
  ['POST /api/spaces/mode', 'não existe endpoint de criação de Space pela API (nascem pelo assistente)'],
  ['POST /api/disconnect/provider', 'exige OAuth conectado de verdade; desconectar é destrutivo'],
  ['POST /api/google/accounts/remove', 'exige conta Google conectada de verdade'],
  ['POST /api/contacts/accept', 'exige convite pendente entre as duas contas; criaria vínculo real'],
  ['POST /api/contacts/decline', 'idem'],
];

// ── Limpeza: a própria conta A desfaz tudo ──
async function cleanup() {
  const sobrou = [];
  const tenta = async (rotulo, who, method, path, body) => {
    const r = await call(who, method, path, body);
    if (r.status !== 200) sobrou.push(`${rotulo} (HTTP ${r.status})`);
  };
  if (R.fileId) await tenta('arquivo', 'A', 'DELETE', `/api/files?id=${encodeURIComponent(R.fileId)}`);
  if (R.connectionId) await tenta('conexão', 'A', 'POST', '/api/connections/delete', { id: R.connectionId });
  if (R.deviceId) await tenta('device token', 'A', 'POST', '/api/device/tokens/revoke', { id: R.deviceId });
  if (R.groupId) await tenta('sequência', 'A', 'DELETE', `/api/cockpit/group?id=${encodeURIComponent(R.groupId)}`);
  for (const id of [R.taskId, R.taskId2].filter(Boolean)) await tenta('tarefa', 'A', 'DELETE', `/api/cockpit/task?id=${encodeURIComponent(id)}`);
  if (R.slug) {
    await tenta('página de memória (A)', 'A', 'POST', '/api/memory/page/delete', { slug: R.slug });
    // Se o probe criou a página homônima na conta B, ela sai aqui.
    const b = await call('B', 'GET', `/api/memory/page?slug=${encodeURIComponent(R.slug)}`);
    if (b.status === 200) await tenta('página de memória (B)', 'B', 'POST', '/api/memory/page/delete', { slug: R.slug });
  }
  if (R.routineId) await tenta('rotina', 'A', 'POST', '/api/routine/delete', { id: R.routineId });
  if (R.threadId) await tenta('conversa', 'A', 'POST', '/api/thread/delete', { id: R.threadId });
  // Threads órfãs que os probes de chat/run possam ter criado com o nome do teste.
  const th = await call('A', 'GET', '/api/threads');
  for (const t of (th.data?.threads || [])) {
    if (String(t.title || '').includes(MARCA) && t.id !== R.threadId) {
      await tenta('conversa extra', 'A', 'POST', '/api/thread/delete', { id: t.id });
    }
  }
  if (R.agentId) await tenta('assistente', 'A', 'POST', '/api/agent/delete', { agentId: R.agentId });
  return sobrou;
}

async function run() {
  console.log(`Base: ${BASE}`);
  console.log(`Marca desta rodada: ${MARCA}\n`);

  const me = { A: await call('A', 'GET', '/api/me'), B: await call('B', 'GET', '/api/me') };
  for (const w of ['A', 'B']) {
    if (me[w].status !== 200) { console.error(`Conta ${w}: /api/me devolveu ${me[w].status} — sessão inválida.`); process.exit(2); }
    console.log(`Conta ${w} = ${me[w].data?.name} / ${me[w].data?.subdomain}`);
  }
  console.log('');

  console.log('── Setup: criando os recursos descartáveis na conta A ──');
  const s = await setup();
  if (s.erro) { console.error(s.erro); process.exit(2); }
  console.log(`Criados: ${Object.entries(R).filter(([k]) => k !== 'deviceToken').map(([k, v]) => `${k}=${String(v).slice(0, 8)}`).join(' ')}`);
  if (s.falta.length) console.log(`Não consegui criar: ${s.falta.join('; ')}`);
  console.log('');

  let sobrou = [];
  try {
    const P = probes();
    console.log(`── Probes: sessão de B contra os ${P.length} alvos descartáveis de A ──`);
    for (const p of P) {
      const antes = await SNAP[p.chave]();
      if (retratoVazio(p.chave, antes)) {
        record(p.nome, p.chave, { status: '-' }, null, 'alvo descartável não existe; probe não rodou');
        continue;
      }
      const r = await call('B', p.method, p.path, p.body);
      // /task/run e /group/run respondem 200 e seguem em background; dá um respiro
      // pro efeito (se houver) aparecer no retrato seguinte.
      if (/\/run$/.test(p.path)) await new Promise((ok) => setTimeout(ok, 3000));
      const depois = await SNAP[p.chave]();
      const mudou = antes !== depois;
      const obs = mudou ? `antes=${antes.slice(0, 160)} depois=${depois.slice(0, 160)}` : null;
      record(p.nome, p.chave, r, mudou, obs);
    }
  } finally {
    console.log('\n── Limpeza (conta A apagando o que criou) ──');
    sobrou = await cleanup();
    console.log(sobrou.length ? `SOBROU pra apagar à mão: ${sobrou.join('; ')}` : 'Tudo apagado.');
  }

  const falhas = results.filter((r) => r.ok === false);
  console.log(`\nResumo: ${results.filter((r) => r.ok === true).length} passaram, ${falhas.length} falharam.`);
  console.log(`Continua NÃO coberto (${NAO_COBERTO.length}):`);
  for (const [rota, motivo] of NAO_COBERTO) console.log(`  · ${rota} — ${motivo}`);
  if (process.env.JSON === '1') console.log('\n' + JSON.stringify({ marca: MARCA, results, naoCoberto: NAO_COBERTO, sobrou }, null, 2));
  process.exit(falhas.length ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(2); });
