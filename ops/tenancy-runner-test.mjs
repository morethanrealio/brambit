#!/usr/bin/env node
// ── Isolamento entre contas: o canal do Runner (Fase 1, parte 3) ─────────────
//
// O Runner é a superfície mais séria do produto: um frame aceito no device errado
// não vaza um registro, executa comando na máquina de alguém ou envenena a saída
// que o assistente do outro vai ler. A correlação é por `reqId` (uma string), e a
// pergunta é se o `reqId` de A pode ser respondido pelo device de B.
//
// Duas provas, porque cada uma alcança uma coisa:
//
//   PARTE 1 (módulo real, em processo) — importa `web/runner.mjs` (sem imports,
//   estado só em memória) e monta a situação que a HTTP não deixa montar sem
//   passar pelo modelo: um comando REALMENTE pendente para A. Aí o device de B
//   tenta responder aquele reqId, mandar chunk de arquivo e fechar o comando.
//   É onde a defesa `rec.userId !== userId` é de fato exercitada.
//
//   PARTE 2 (HTTP, produção) — o mesmo canal pela porta da frente: token de
//   device é aceito, endereçamento é por dono, e a sessão de B nunca enxerga o
//   device de A. Prova que o que a parte 1 mostra no módulo vale no processo que
//   está no ar.
//
// Guarda de segurança: se o Runner de verdade do dono estiver online, a parte 2
// NÃO registra device falso na conta dele (pickDevice escolhe o heartbeat mais
// recente e um device falso sequestraria um comando real). Nesse caso o passo é
// pulado com o motivo escrito, nunca silenciosamente.
//
// Uso:
//   node ops/tenancy-runner-test.mjs                 (só a parte 1, sem rede)
//   SID_A=… SID_B=… node ops/tenancy-runner-test.mjs (parte 1 + parte 2, no servidor local)
//   BASE=https://seu-dominio ALLOW_REMOTE=1 SID_A=… SID_B=… …  (parte 2 em produção;
//     sem ALLOW_REMOTE=1 a sonda recusa alvo fora desta máquina)
//   JSON=1  imprime o relatório em JSON no fim (tenancy-contract.test.mjs lê)

import { runnerPoll, runnerExec, runnerResult, runnerReadFile, runnerStatus } from '../web/runner.mjs';
import { baseOrExit } from './tenancy-base.mjs';

let BASE = ''; // resolvido só se a parte 2 for rodar (a parte 1 não usa rede)
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

// ── PARTE 1: o módulo real ──
async function parte1() {
  console.log('── Parte 1: web/runner.mjs em processo (comando de A pendente de verdade) ──');
  const meta = { hostname: 'maquina-de-teste', os: 'linux', version: '2.1.1' };

  // Registra os dois devices e deixa cada um pendurado no long-poll, que é como
  // o runner de verdade fica.
  const pollA = runnerPoll(UA, 'devA', meta);
  const pollB = runnerPoll(UB, 'devB', meta);
  await sentinela(50);

  check('runnerStatus separa os devices por dono',
    runnerStatus(UA).deviceId === 'devA' && runnerStatus(UB).deviceId === 'devB',
    `A→${runnerStatus(UA).deviceId} B→${runnerStatus(UB).deviceId}`);

  // Comando de A: vai para o device de A e cria o reqId pendente.
  const execA = runnerExec(UA, 'echo saida-legitima', { threadId: 'thread-de-A', timeout: 20_000 });
  const frameA = await pollA;
  check('comando de A chega no device de A', frameA?.type === 'exec' && !!frameA.reqId, `frame=${frameA?.type}`);

  // O device de B não pode receber o comando de A.
  const oQueBRecebeu = await Promise.race([pollB, sentinela(2000)]);
  check('device de B não recebe o comando de A', oQueBRecebeu?.type === '__nada__',
    `B recebeu: ${JSON.stringify(oQueBRecebeu)}`);

  // B tenta envenenar a saída do comando de A.
  const r1 = runnerResult(UB, 'devB', { reqId: frameA.reqId, type: 'stdout', chunk: INVASOR });
  check('B não consegue escrever na saída do comando de A',
    r1?.ok === false && /outro usuário/.test(r1.error || ''), JSON.stringify(r1));

  // B tenta fechar o comando de A (negaria serviço mesmo sem ler nada).
  const r2 = runnerResult(UB, 'devB', { reqId: frameA.reqId, type: 'exit', exitCode: 0 });
  check('B não consegue encerrar o comando de A',
    r2?.ok === false && /outro usuário/.test(r2.error || ''), JSON.stringify(r2));

  // Canal de arquivo: mesma correlação por reqId, checagem própria.
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
    // Encerra a transferência pelo dono, senão o teste espera o timeout.
    runnerResult(UA, 'devA', { reqId: frameF.reqId, type: 'filedone', error: 'fim do teste' });
  } else {
    check('B não consegue injetar bytes no arquivo pedido por A', null, 'frame readfile não chegou');
    check('B não consegue encerrar a transferência de A', null, 'frame readfile não chegou');
  }
  const arq = await lerA;
  check('pedido de arquivo de A não trouxe bytes do invasor',
    !JSON.stringify(arq).includes(INVASOR), `resultado=${(arq.error || 'ok').slice(0, 60)}`);

  // Fecha o comando de A pelo device certo e confere que nada do invasor entrou.
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

// ── PARTE 2: o canal pela porta da frente, em produção ──
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

    // Token inválido não entra.
    const ruim = await call(null, 'GET', '/api/runner/poll', { bearer: 'token-invalido-de-teste' });
    check('poll com token inválido é recusado', ruim.status === 401, `HTTP ${ruim.status}`);

    // Registra o device falso de A (o dono está offline, verificado acima) e
    // confere que só a conta A o enxerga.
    const pollA = call(null, 'GET', '/api/runner/poll?hostname=zz-tenancy&os=linux&v=2.1.1', { bearer: tk.A });
    await sentinela(1500);
    const stA = await call('A', 'GET', '/api/runner/status');
    const stB = await call('B', 'GET', '/api/runner/status');
    check('device de A aparece pra A', stA.data?.online === true, `deviceId=${String(stA.data?.deviceId).slice(0, 8)}`);
    check('device de A NÃO aparece pra B', stB.data?.online !== true, `status de B: online=${stB.data?.online}`);

    // Com o token de B, tentar responder um reqId que não é dele.
    const forjado = await call(null, 'POST', '/api/runner/result', { bearer: tk.B, body: { reqId: 'reqid-forjado-de-teste', type: 'stdout', chunk: INVASOR } });
    check('result com reqId forjado não é aceito como saída válida',
      forjado.status === 200 && forjado.data?.ignored === true, JSON.stringify(forjado.data));

    // O poll de A não pode ser servido pelo token de B: B recebe idle.
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
