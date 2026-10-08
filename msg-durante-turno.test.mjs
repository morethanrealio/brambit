// Offline test of the message that arrives WHILE THE TURN IS IN PROGRESS.
// Nothing goes out to the network (fetch and database stubbed) and no model is called: the
// provider is fake and the test controls step by step what it returns.
// Run with: node msg-durante-turno.test.mjs
process.env.WA_TOKEN = 'x';
process.env.WA_PHONE_NUMBER_ID = '1';
process.env.WA_VERIFY_TOKEN = 'v';
process.env.WA_DEBOUNCE_MS = '10'; // short debounce so the test doesn't wait 3s

let ok = 0, fail = 0;
const t = (nome, cond) => { if (cond) { ok++; console.log('  ok  ', nome); } else { fail++; console.log('  FALHA', nome); } };

const { runAgent } = await import('./core-proto/core.mjs');
const registry = { defs: [], run: async () => 'ok' };
const semTools = { system: 's', tools: registry };

// ── A) core: a mensagem entra na fronteira de passo ──
{
  const vistos = [];
  let poll = 1;
  const r = await runAgent({
    ...semTools, userInput: 'faz A',
    provider: {
      name: 'fake',
      complete: async ({ messages }) => {
        vistos.push(messages.map((m) => `${m.role}${m.meta ? ':' + m.meta : ''}`).join('|'));
        return vistos.length === 1
          ? { stop: 'tool', toolCalls: [{ id: '1', name: 'x', args: {} }] }
          : { stop: 'end', text: 'ok, fiz B' };
      },
    },
    pollNewUserMsg: () => (poll-- > 0 ? { text: 'na verdade faz B' } : null),
  });
  const injetada = r.messages.find((m) => m.meta === 'interject');
  t('injeta no passo 0 e o modelo vê', vistos[0] === 'user|user:interject');
  t('texto do usuário chega inteiro', injetada?.content.includes('na verdade faz B'));
  // raw = what the server writes to the history (without the instruction wrapper).
  t('raw guarda só a fala do usuário', injetada?.raw === 'na verdade faz B');
  t('turno entrega a resposta nova', r.text === 'ok, fiz B');
}

// ── B) delivery time arrived: the draft is NOT sent ──
{
  let poll = 0;
  const eventos = [];
  const r = await runAgent({
    ...semTools, userInput: 'me manda o resumo',
    provider: {
      name: 'fake',
      complete: async () => ({ stop: 'end', text: ++poll === 1 ? 'RASCUNHO obsoleto' : 'resposta contemplando tudo' }),
    },
    // null on the 1st query (step 0 boundary) and text on the 2nd (pre-delivery).
    pollNewUserMsg: () => (poll === 1 ? { text: 'esquece, quero outra coisa' } : null),
    onEvent: (e) => eventos.push(e.type),
  });
  t('não entrega a resposta obsoleta', r.text === 'resposta contemplando tudo');
  t('rascunho não vai pro history como assistant', !r.messages.some((m) => m.role === 'assistant' && m.content.includes('RASCUNHO')));
  t('rascunho vai pro contexto do modelo', r.messages.some((m) => m.meta === 'interject' && m.content.includes('RASCUNHO')));
  // The discarded draft does NOT enter the raw -> it doesn't persist in the history nor is it
  // resent in subsequent turns (input-token cost).
  const inj = r.messages.find((m) => m.meta === 'interject');
  t('raw da pré-entrega não carrega o rascunho', inj?.raw === 'esquece, quero outra coisa');
  t('evento interject_predraft emitido', eventos.includes('interject_predraft'));
}

// ── C) interjection cap: a user firing off messages doesn't lock up the turn ──
{
  let chamadas = 0, injetadas = 0;
  const r = await runAgent({
    ...semTools, userInput: 'vai',
    provider: { name: 'fake', complete: async () => { chamadas++; return { stop: 'end', text: `t${chamadas}` }; } },
    pollNewUserMsg: () => ({ text: 'mais uma' }), // nunca para
    onEvent: (e) => { if (e.type === 'interject' || e.type === 'interject_predraft') injetadas++; },
  });
  t('teto de 3 interjeições respeitado', injetadas === 3);
  t('turno termina mesmo com fila infinita', !!r.text);
}

// ── D) a broken channel does not bring down the turn ──
{
  const eventos = [];
  const r = await runAgent({
    ...semTools, userInput: 'vai',
    provider: { name: 'fake', complete: async () => ({ stop: 'end', text: 'pronto' }) },
    pollNewUserMsg: () => { throw new Error('canal morreu'); },
    onEvent: (e) => eventos.push(e.type),
  });
  t('erro no canal não quebra o turno', r.text === 'pronto');
  t('erro do canal fica visível em onEvent', eventos.includes('interject_error'));
}

// ── E) without the channel, behavior identical to before ──
{
  const r = await runAgent({
    ...semTools, userInput: 'vai',
    provider: { name: 'fake', complete: async () => ({ stop: 'end', text: 'pronto' }) },
  });
  t('sem pollNewUserMsg nada é injetado', !r.messages.some((m) => m.meta));
}

// ── F) WhatsApp: 2nd message during the turn becomes ONE single response ──
const enviados = [];
globalThis.fetch = async (_url, opts) => {
  const body = JSON.parse(opts.body);
  if (body.type === 'text') enviados.push(body.text.body);
  return { ok: true, json: async () => ({ messages: [{ id: 'wamid.out' }] }) };
};
const wa = await import('./web/whatsapp.mjs');

const dbStub = {
  getWhatsAppLink: async () => ({ user_id: 'u1', enabled: true, active_agent_id: 'a1' }),
  listAgents: async () => [{ id: 'a1', name: 'Bot' }],
  touchWaInbound: async () => {},
  claimWaMsg: async () => true,
};
const payload = (id, texto) => ({
  entry: [{ changes: [{ value: { messages: [{ id, from: '5511999999999', type: 'text', text: { body: texto } }] } }] }],
});
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

{
  let vistoNoMeio = null;
  let solta;
  const h = wa.createWhatsAppHandler({
    db: dbStub,
    loadAgent: async () => ({ id: 'a1', name: 'Bot' }),
    runConversation: async (_agent, _uid, message, _img, _files, extra) => {
      // Turn in flight: the test sends the 2nd message and only then queries the channel.
      await new Promise((r) => { solta = r; });
      // The poll is asynchronous (core contract: ()=>Promise<{text}|null>).
      vistoNoMeio = await extra.pollNewUserMsg();
      return { text: `respondi: ${message} + ${vistoNoMeio?.text || 'nada'}` };
    },
  });
  await h.process(payload('wamid.1', 'primeira'));
  await espera(40); // debounce -> turn starts and stops at the await above
  await h.process(payload('wamid.2', 'segunda'));
  solta();
  await espera(40);
  t('2ª msg chega DENTRO do turno em voo', vistoNoMeio?.text === 'segunda');
  t('sai UMA resposta só (não a obsoleta + a nova)', enviados.length === 1);
  t('a resposta contempla as duas mensagens', enviados[0] === 'respondi: primeira + segunda');
}

// ── G) what the turn doesn't consume is not lost: it becomes the next turn ──
{
  enviados.length = 0;
  const rodadas = [];
  let solta;
  const h = wa.createWhatsAppHandler({
    db: dbStub,
    loadAgent: async () => ({ id: 'a1', name: 'Bot' }),
    // Este turno NUNCA consulta o canal (simula modelo preso numa tool longa).
    runConversation: async (_agent, _uid, message) => {
      rodadas.push(message);
      if (rodadas.length === 1) await new Promise((r) => { solta = r; });
      return { text: `ok ${rodadas.length}` };
    },
  });
  await h.process(payload('wamid.3', 'primeira'));
  await espera(40);
  await h.process(payload('wamid.4', 'segunda'));
  solta();
  await espera(120); // fim do 1º turno + debounce do rebote
  t('mensagem não consumida vira o turno seguinte', rodadas.length === 2 && rodadas[1] === 'segunda');
  t('duas respostas nesse caso (nada sumiu)', enviados.length === 2);
}

// ── H) dedup: a Meta retry with the same wamid does not run twice ──
{
  let rodou = 0;
  const usados = new Set();
  const h = wa.createWhatsAppHandler({
    // Durable claimWaMsg: the 2nd claim of the same id fails (that's what Postgres does).
    db: { ...dbStub, claimWaMsg: async (id) => (usados.has(id) ? false : (usados.add(id), true)) },
    loadAgent: async () => ({ id: 'a1', name: 'Bot' }),
    runConversation: async () => { rodou++; return { text: 'ok' }; },
  });
  await h.process(payload('wamid.9', 'oi'));
  await h.process(payload('wamid.9', 'oi')); // retry da Meta
  await espera(60);
  t('retry do mesmo wamid roda 1x', rodou === 1);
}

// ── I) WA_INTERJECT=0 volta ao caminho antigo (chave de desligamento) ──
{
  enviados.length = 0;
  process.env.WA_INTERJECT = '0';
  const rodadas = [];
  let vistoNoMeio = 'nao-consultado';
  let solta;
  const h = wa.createWhatsAppHandler({
    db: dbStub,
    loadAgent: async () => ({ id: 'a1', name: 'Bot' }),
    runConversation: async (_agent, _uid, message, _img, _files, extra) => {
      rodadas.push(message);
      if (rodadas.length === 1) {
        await new Promise((r) => { solta = r; });
        vistoNoMeio = extra.pollNewUserMsg; // deve vir null com a chave desligada
      }
      return { text: `ok ${rodadas.length}` };
    },
  });
  await h.process(payload('wamid.10', 'primeira'));
  await espera(40);
  await h.process(payload('wamid.11', 'segunda'));
  solta();
  await espera(120);
  t('chave off: canal não é passado ao turno', vistoNoMeio === null);
  t('chave off: 2ª msg vira turno próprio (comportamento antigo)', rodadas.length === 2 && rodadas[1] === 'segunda');
  t('chave off: duas respostas', enviados.length === 2);
  process.env.WA_INTERJECT = '1';
}

// ── J) a gated confirmation in the middle of the turn does not become an interjection ──
// Reproduces the real race: the assistant records the publication, the person sends
// "Pode" before the turn ends, and WhatsApp needs to return that message
// as a NEW turn for the deterministic gate to execute exactly once.
{
  enviados.length = 0;
  const {
    deferIncomingWhileConfirmationPending,
    gateTool,
    isConfirmation,
    takePending,
  } = await import('./web/confirm.mjs');
  const threadId = 'wa-confirmation-boundary';
  const rodadas = [];
  let executions = 0;
  let releaseFirst;
  let signalStarted;
  const firstStarted = new Promise((r) => { signalStarted = r; });
  const waitForSecond = new Promise((r) => { releaseFirst = r; });
  const h = wa.createWhatsAppHandler({
    db: dbStub,
    loadAgent: async () => ({ id: 'a1', name: 'Bot' }),
    runConversation: async (_agent, _uid, message, _img, _files, extra) => {
      rodadas.push(message);
      if (rodadas.length === 1) {
        await gateTool({
          name: 'publicar_sistema',
          run: async () => { executions++; return { ok: true }; },
        }, threadId).run({ nome_do_sistema: 'demo' });
        signalStarted();
        await waitForSecond;
        const safePoll = deferIncomingWhileConfirmationPending(threadId, extra.pollNewUserMsg);
        t('confirmação pendente não entra no turno ainda aberto', await safePoll() === null);
        return { text: 'Posso publicar?' };
      }
      const pending = takePending(threadId);
      if (pending && isConfirmation(message)) await pending.run(pending.args);
      return { text: 'Publicado.' };
    },
  });
  await h.process(payload('wamid.12', 'publique o app'));
  await firstStarted;
  await h.process(payload('wamid.13', 'Pode'));
  releaseFirst();
  await espera(120);
  t('o Pode preservado vira o turno seguinte', rodadas.length === 2 && rodadas[1] === 'Pode');
  t('a publicação confirmada executa exatamente uma vez', executions === 1);
  takePending(threadId);
}

// ── K) a long turn gives ONE sign of life and preserves the order of the response ──
{
  enviados.length = 0;
  process.env.WA_TURN_HEARTBEAT_MS = '15';
  let solta;
  const h = wa.createWhatsAppHandler({
    db: dbStub,
    loadAgent: async () => ({ id: 'a1', name: 'Bot' }),
    runConversation: async () => {
      await new Promise((r) => { solta = r; });
      return { text: 'resposta final' };
    },
  });
  await h.process(payload('wamid.14', 'trabalho demorado'));
  await espera(40); // debounce de 10ms + heartbeat de 15ms
  t('turno longo envia recibo de andamento', enviados[0]?.includes('Ainda estou trabalhando nisso'));
  await espera(35);
  t('recibo de andamento é enviado uma única vez', enviados.length === 1);
  solta();
  await espera(30);
  t('resposta final chega depois do recibo', enviados.length === 2 && enviados[1] === 'resposta final');

  // A quick turn should not gain an extra operational message.
  enviados.length = 0;
  const quick = wa.createWhatsAppHandler({
    db: dbStub,
    loadAgent: async () => ({ id: 'a1', name: 'Bot' }),
    runConversation: async () => ({ text: 'rápido' }),
  });
  await quick.process(payload('wamid.15', 'pergunta rápida'));
  await espera(45);
  t('turno rápido envia só a resposta', enviados.length === 1 && enviados[0] === 'rápido');
  delete process.env.WA_TURN_HEARTBEAT_MS;
}

console.log(`\n${ok} ok, ${fail} falha(s)`);
process.exit(fail ? 1 : 0);
