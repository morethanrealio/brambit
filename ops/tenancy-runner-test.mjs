#!/usr/bin/env node
// ── Cross-account isolation: the Runner channel (Phase 1, part 3) ─────────────
//
// The Runner is the product's most serious surface: a frame accepted on the wrong device
// doesn't just leak a record, it runs a command on someone's machine or poisons the output
// the other person's assistant will read. Correlation is by `reqId` (a string), and the
// question is whether A's `reqId` can be answered by B's device.
//
// Two proofs, because each one reaches a different thing:
//
//   PART 1 (real module, in-process) — imports `web/runner.mjs` (no imports,
//   state only in memory) and sets up the situation that HTTP doesn't let you set up without
//   going through the model: a command REALLY pending for A. Then B's device
//   tries to answer that reqId, send a file chunk and close the command.
//   This is where the `rec.userId !== userId` defense is actually exercised.
//
//   PART 2 (HTTP, production) — the same channel through the front door: device
//   token is accepted, addressing is by owner, and B's session never sees A's
//   device. Proves that what part 1 shows at the module level holds in the process that
//   is actually live.
//
// Security guard: if the owner's real Runner is online, part 2
// does NOT register a fake device on their account (pickDevice picks the most
// recent heartbeat and a fake device would hijack a real command). In that case the step is
// skipped with the reason written down, never silently.
//
// Usage:
//   node ops/tenancy-runner-test.mjs                 (only part 1, no network)
//   SID_A=… SID_B=… node ops/tenancy-runner-test.mjs (part 1 + part 2, on the local server)
//   BASE=https://your-domain ALLOW_REMOTE=1 SID_A=… SID_B=… …  (part 2 in production;
//     without ALLOW_REMOTE=1 the probe refuses a target outside this machine)
//   JSON=1  prints the report in JSON at the end (tenancy-contract.test.mjs reads it)

import { runnerPoll, runnerExec, runnerResult, runnerReadFile, runnerStatus } from '../web/runner.mjs';
import { baseOrExit } from './tenancy-base.mjs';

let BASE = ''; // resolved only if part 2 is going to run (part 1 doesn't use the network)
const SID = { A: process.env.SID_A || '', B: process.env.SID_B || '' };
const UA = '11111111-1111-1111-1111-111111111111';
const UB = '22222222-2222-2222-2222-222222222222';
const INVASOR = 'INVADIDO-POR-B';

const results = [];
function check(nome, ok, obs) {
  results.push({ nome, ok, obs: obs || null });
  console.log(`[${ok === null ? 'SKIP' : ok ? 'PASSOU' : 'FALHOU'}] ${nome}${obs ? `  · ${obs}` : ''}`);
}
const sentinela = (ms) => new Promise((r) => setTimeout(() => r({ type: '__nada__' }), ms));

// ── PART 1: the real module ──
async function parte1() {
  console.log('── Parte 1: web/runner.mjs em processo (comando de A pendente de verdade) ──');
  const meta = { hostname: 'maquina-de-teste', os: 'linux', version: '2.1.1' };

  // Registers both devices and leaves each one hanging on the long-poll, which is how
  // the real runner sits.
  const pollA = runnerPoll(UA, 'devA', meta);
  const pollB = runnerPoll(UB, 'devB', meta);
  await sentinela(50);

  check('runnerStatus separa os devices por dono',
    runnerStatus(UA).deviceId === 'devA' && runnerStatus(UB).deviceId === 'devB',
    `A→${runnerStatus(UA).deviceId} B→${runnerStatus(UB).deviceId}`);

  // A's command: goes to A's device and creates the pending reqId.
  const execA = runnerExec(UA, 'echo saida-legitima', { threadId: 'thread-de-A', timeout: 20_000 });
  const frameA = await pollA;
  check('comando de A chega no device de A', frameA?.type === 'exec' && !!frameA.reqId, `frame=${frameA?.type}`);

  // B's device cannot receive A's command.
  const oQueBRecebeu = await Promise.race([pollB, sentinela(2000)]);
  check('device de B não recebe o comando de A', oQueBRecebeu?.type === '__nada__',
    `B recebeu: ${JSON.stringify(oQueBRecebeu)}`);

  // B tries to poison the output of A's command.
  const r1 = runnerResult(UB, 'devB', { reqId: frameA.reqId, type: 'stdout', chunk: INVASOR });
  check('B não consegue escrever na saída do comando de A',
    r1?.ok === false && /outro usuário/.test(r1.error || ''), JSON.stringify(r1));

  // B tries to close A's command (would deny service even without reading anything).
  const r2 = runnerResult(UB, 'devB', { reqId: frameA.reqId, type: 'exit', exitCode: 0 });
  check('B não consegue encerrar o comando de A',
    r2?.ok === false && /outro usuário/.test(r2.error || ''), JSON.stringify(r2));

  // File channel: same reqId correlation, its own check.
  const lerA = runnerReadFile(UA, '/tmp/arquivo-de-teste', { timeout: 8000 });
  const pollA2 = runnerPoll(UA, 'devA', meta);
  const frameF = await Promise.race([pollA2, sentinela(2000)]);
  if (frameF?.type === 'readfile') {
    const r3 = runnerResult(UB, 'devB', { reqId: frameF.reqId, type: 'filechunk', seq: 0, chunk: Buffer.from(INVASOR).toString('base64') });
    check('B não consegue injetar bytes no arquivo pedido por A',
      r3?.ok === false && /outro usuário/.test(r3.error || ''), JSON.stringify(r3));
    const r4 = runnerResult(UB, 'devB', { reqId: frameF.reqId, type: 'filedone', size: 0 });
    check('B não consegue encerrar a transferência de A',
      r4?.ok === false && /outro usuário/.test(r4.error || ''), JSON.stringify(r4));
    // Ends the transfer via the owner, otherwise the test waits for the timeout.
    runnerResult(UA, 'devA', { reqId: frameF.reqId, type: 'filedone', error: 'fim do teste' });
  } else {
    check('B não consegue injetar bytes no arquivo pedido por A', null, 'frame readfile não chegou');
    check('B não consegue encerrar a transferência de A', null, 'frame readfile não chegou');
  }
  const arq = await lerA;
  check('pedido de arquivo de A não trouxe bytes do invasor',
    !JSON.stringify(arq).includes(INVASOR), `resultado=${(arq.error || 'ok').slice(0, 60)}`);

  // Closes A's command via the right device and checks that nothing from the intruder got in.
  runnerResult(UA, 'devA', { reqId: frameA.reqId, type: 'stdout', chunk: 'saida-legitima' });
  runnerResult(UA, 'devA', { reqId: frameA.reqId, type: 'exit', exitCode: 0 });
  const saida = await execA;
  check('saída entregue a A é só a legítima',
    saida.saida === 'saida-legitima' && !JSON.stringify(saida).includes(INVASOR),
    `saida=${JSON.stringify(saida.saida)}`);

  // Comando de B vai pro device de B, nunca pro de A.
  const pollB2 = runnerPoll(UB, 'devB', meta);
  const pollA3 = runnerPoll(UA, 'devA', meta);
  const execB = runnerExec(UB, 'echo comando-de-B', { threadId: 'thread-de-B', timeout: 8000 });
  const [fb, fa] = [await Promise.race([pollB2, sentinela(2000)]), await Promise.race([pollA3, sentinela(1)])];
  check('comando de B não cai no device de A', fb?.type === 'exec' && fa?.type === '__nada__',
    `B recebeu ${fb?.type}, A recebeu ${fa?.type}`);
  if (fb?.reqId) runnerResult(UB, 'devB', { reqId: fb.reqId, type: 'exit', exitCode: 0 });
  await execB;
}

// ── PART 2: the channel through the front door, in production ──
async function call(who, method, path, { body, bearer } = {}) {
  const headers = {};
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  else if (who) headers.cookie = `sid=${SID[who]}`;
  if (method !== 'GET' && method !== 'HEAD') headers.origin = BASE;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const r = await fetch(BASE + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, redirect: 'manual' });
  const t = await r.text();
  let data = null; try { data = JSON.parse(t); } catch {}
  return { status: r.status, data, raw: t };
}

async function parte2() {
  console.log('\n── Parte 2: canal do runner pela HTTP ──');
  const criados = [];
  try {
    const st0 = await call('A', 'GET', '/api/runner/status');
    if (st0.data?.online) {
      check('device falso na conta A', null, 'o Runner de verdade do dono está online; não registro device falso pra não sequestrar comando real');
      check('sessão de B não enxerga o device de A', st0.data.online === true && (await call('B', 'GET', '/api/runner/status')).data?.online !== true,
        'runner real de A online e B continua offline');
      return criados;
    }

    const tk = {};
    for (const who of ['A', 'B']) {
      const d = await call(who, 'POST', '/api/device/tokens', { body: { label: 'zz-tenancy-runner' } });
      if (d.status !== 200 || !d.data?.token) { check(`token de device da conta ${who}`, false, `HTTP ${d.status}`); return criados; }
      tk[who] = d.data.token; criados.push([who, d.data.device.id]);
    }

    // Invalid token doesn't get in.
    const ruim = await call(null, 'GET', '/api/runner/poll', { bearer: 'token-invalido-de-teste' });
    check('poll com token inválido é recusado', ruim.status === 401, `HTTP ${ruim.status}`);

    // Registers A's fake device (the owner is offline, verified above) and
    // checks that only account A can see it.
    const pollA = call(null, 'GET', '/api/runner/poll?hostname=zz-tenancy&os=linux&v=2.1.1', { bearer: tk.A });
    await sentinela(1500);
    const stA = await call('A', 'GET', '/api/runner/status');
    const stB = await call('B', 'GET', '/api/runner/status');
    check('device de A aparece pra A', stA.data?.online === true, `deviceId=${String(stA.data?.deviceId).slice(0, 8)}`);
    check('device de A NÃO aparece pra B', stB.data?.online !== true, `status de B: online=${stB.data?.online}`);

    // With B's token, try to answer a reqId that isn't theirs.
    const forjado = await call(null, 'POST', '/api/runner/result', { bearer: tk.B, body: { reqId: 'reqid-forjado-de-teste', type: 'stdout', chunk: INVASOR } });
    check('result com reqId forjado não é aceito como saída válida',
      forjado.status === 200 && forjado.data?.ignored === true, JSON.stringify(forjado.data));

    // A's poll cannot be served by B's token: B gets idle.
    const pollB = await call(null, 'GET', '/api/runner/poll?hostname=zz-tenancy-b&v=2.1.1', { bearer: tk.B });
    check('poll de B só recebe idle (nunca frame de A)', pollB.data?.type === 'idle', JSON.stringify(pollB.data).slice(0, 80));
    await pollA;
  } finally {
    for (const [who, id] of criados) await call(who, 'POST', '/api/device/tokens/revoke', { body: { id } });
    if (criados.length) console.log(`Devices de teste revogados: ${criados.length}`);
  }
  return criados;
}

(async () => {
  await parte1();
  if (SID.A && SID.B) { BASE = baseOrExit(); await parte2(); }
  else console.log('\n(Parte 2 pulada: sem SID_A/SID_B.)');

  const falhas = results.filter((r) => r.ok === false);
  const pulados = results.filter((r) => r.ok === null);
  console.log(`\nResumo: ${results.filter((r) => r.ok === true).length} passaram, ${falhas.length} falharam, ${pulados.length} pulados.`);
  console.log('NÃO coberto: disparar um exec de verdade por HTTP exige o modelo chamar a tool `terminal`; ' +
    'a pendência real com reqId de A é montada na parte 1, direto no módulo que produção usa.');
  if (process.env.JSON === '1') console.log('\n' + JSON.stringify({ results }, null, 2));
  process.exit(falhas.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
