// Regressões da revisão de qualidade de 23/09. Store real em PGlite isolado;
// ferramentas sintéticas e rede bloqueada para não tocar serviços externos.
import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import net from 'node:net';
import tls from 'node:tls';

const denied = () => { throw Error('External IO forbidden'); };
net.Socket.prototype.connect = tls.connect = globalThis.fetch = denied;
registerHooks({resolve(specifier, context, next) {
  if (specifier === './compras.mjs' && context.parentURL?.endsWith('/web/confirm.mjs')) {
    return {url:'data:text/javascript,export const descreverCarrinho=()=>null;export const plataformaDoCarrinho=()=>null;',shortCircuit:true};
  }
  return next(specifier, context);
}});
const { confirmationFixture } = await import('./test-support/confirmation-fixture.mjs');
const { createConfirmationSession, withConfirmationSession } = await import('./web/confirmation-session.mjs');
const { gateTool, setOwnerText, setThreadLanguage, CHANNEL_CTX_END } = await import('./web/confirm.mjs');
const { handleConfirmation, proposalPresentation, confirmationTargetsInMessage } = await import('./web/confirmation-flow.mjs');
const { standaloneRefusal } = await import('./web/turn-claim-guard.mjs');

async function fixture(t, language = 'pt-BR') {
  const f = await confirmationFixture();
  t.after(() => f.db.close());
  setThreadLanguage(f.scope.threadId, language);
  const effects = [];
  let last = '';
  const tool = {name:'calendar_create',run:async args => {
    effects.push(args);
    return {ok:true,id:'synthetic-event',agenda:'Work'};
  }};
  const session = () => createConfirmationSession(f.store, f.scope);
  async function propose(titles = ['Evento de teste'], {present = true, ownerText = 'Crie o evento de teste'} = {}) {
    const s = await session();
    setOwnerText(f.scope.threadId, '', ownerText);
    await withConfirmationSession(s, async () => {
      for (const title of titles) await gateTool(tool, f.scope.threadId).run({
        title,start:'2026-09-24T13:00:00',end:'2026-09-24T13:30:00',
      });
    });
    const rows = s.pending().filter(row => s.createdIds.has(row.id));
    last = present ? proposalPresentation(rows) : '';
    if (present) await f.store.present(f.scope, rows.map(row => row.id));
    return rows;
  }
  async function decide(message, extra = {}) {
    const s = await session();
    s.language = language;
    s.implicitTargetIds = confirmationTargetsInMessage(s.pending(), last);
    s.implicitTargetId = s.implicitTargetIds.length === 1 ? s.implicitTargetIds[0] : null;
    const result = await withConfirmationSession(s, () => handleConfirmation(s, {
      message,resolveTool:async () => ({confirmationTool:tool}),...extra,
    }));
    last = result?.text || 'Resposta comum sem proposta';
    return result;
  }
  return {...f,effects,session,propose,decide,show:text => { last = text; }};
}

const NEW_REQUESTS = [
  'Pode ir na sessao de supermercado',
  'Pode criar uma lista de supermercado',
  'Go ahead and move the groceries to the supermarket section',
  'Puedes poner los alimentos en la sección de supermercado',
];

test('sem pendências, pedidos novos chegam ao turno normal em PT/EN/ES', async t => {
  const f = await fixture(t);
  for (const message of NEW_REQUESTS) assert.equal(await f.decide(message), null, message);
  assert.deepEqual(await f.store.list(f.scope), []);
  assert.deepEqual(f.effects, []);
});

test('pedidos novos nunca autorizam uma proposta que esteja pendente', async t => {
  const f = await fixture(t);
  const [row] = await f.propose();
  for (const message of NEW_REQUESTS) {
    f.show(proposalPresentation([row]));
    await f.decide(message);
    assert.equal((await f.store.list(f.scope))[0].state, 'pending', message);
  }
  assert.deepEqual(f.effects, []);
});

const REFUSALS = [
  ['pt-BR', ['Não precisa fazer nada', 'Não precisa fazer mais nada.', 'Por favor, não faça nada.', 'Não é necessário fazer nada, obrigado.', 'Não precisa fazer isso'], /Cancelei/],
  ['en', ['No need to do anything', "You don't need to do anything.", 'Please do not do anything.', 'No need to proceed, thanks.', 'No need to do that', "You don't need to do that."], /canceled/],
  ['es', ['No hace falta hacer nada', 'No necesitas hacer nada.', 'Por favor, no hagas nada.', 'No es necesario hacer nada, gracias.', 'No hace falta hacer eso', 'No es necesario hacer eso.'], /Cancelé/],
];
for (const [language, messages, expected] of REFUSALS) {
  test(`recusa natural em ${language} persiste cancelamento antes do recibo`, async t => {
    const f = await fixture(t, language);
    for (const [index, message] of messages.entries()) {
      const [row] = await f.propose([`Synthetic ${index}`]);
      const inputId = `refusal-${index}`;
      const result = await f.decide(message, {inputId});
      assert.match(result?.text || '', expected, message);
      const persisted = (await f.session()).rows.find(current => current.id === row.id);
      assert.equal(persisted.state, 'canceled', message);
      assert.equal(persisted.decisionKey, inputId, message);
      const replay = await f.decide('confirmo', {inputId});
      assert.equal(replay.replay, true, message);
      assert.equal((await f.session()).rows.find(current => current.id === row.id).state, 'canceled');
    }
    assert.deepEqual(f.effects, []);
  });
}

const CONTINUATIONS = [
  'Não precisa fazer nada?',
  'Não precisa fazer nada, só me mostre a lista',
  'Não precisa fazer nada se estiver certo',
  'No need to do anything?',
  "Don't do anything until tomorrow",
  "You don't need to do anything, just show me the list",
  '¿No hace falta hacer nada?',
  'No hace falta hacer nada si está correcto',
  'No hagas nada, solo muestra la lista',
  'No need to do that?',
  "You don't need to do that until tomorrow",
  'No need to do that, just show me the list',
  '¿No hace falta hacer eso?',
  'No es necesario hacer eso si está correcto',
  'No hace falta hacer eso, solo muestra la lista',
];
test('perguntas, condições e pedidos adicionais não são recusas isoladas', async t => {
  const f = await fixture(t);
  const [row] = await f.propose();
  for (const message of CONTINUATIONS) {
    assert.equal(standaloneRefusal(message), false, message);
    f.show(proposalPresentation([row]));
    await f.decide(message);
    assert.equal((await f.store.list(f.scope))[0].state, 'pending', message);
  }
  assert.deepEqual(f.effects, []);
});

test('falha de persistência não produz recibo de cancelamento nem executa a ação', async t => {
  const f = await fixture(t);
  await f.propose();
  f.failNext(/SET state=\$5,finished_at/);
  await assert.rejects(f.decide('Não precisa fazer nada'), /synthetic database failure/);
  assert.equal((await f.store.list(f.scope))[0].state, 'pending');
  assert.deepEqual(f.effects, []);
});

test('recusa sem alvo não cancela propostas antigas, invisíveis ou múltiplas', async t => {
  const f = await fixture(t);
  const [hidden] = await f.propose(['Oculto'], {present:false});
  await f.decide('Não precisa fazer nada');
  assert.equal((await f.store.list(f.scope))[0].state, 'pending');
  await f.decide(`Não precisa fazer nada pedido ${hidden.number}`);
  assert.equal((await f.store.list(f.scope))[0].state, 'pending', 'cartão ainda não apresentado');
  const [current] = await f.propose(['Atual']);
  await f.decide('Não precisa fazer nada');
  assert.ok((await f.store.list(f.scope)).every(row => row.state === 'pending'));
  await f.store.present(f.scope, [hidden.id]);
  const rows = (await f.session()).pending();
  f.show(proposalPresentation(rows));
  await f.decide('Não precisa fazer nada');
  assert.ok((await f.store.list(f.scope)).every(row => row.state === 'pending'));
  f.show('Resposta sem proposta');
  await f.decide(`Não precisa fazer nada pedido ${current.number}`);
  const persisted = await f.store.list(f.scope);
  assert.equal(persisted.find(row => row.id === current.id).state, 'canceled');
  assert.equal(persisted.find(row => row.id === hidden.id).state, 'pending');
  assert.deepEqual(f.effects, []);
});

test('recusa por citação cancela somente a proposta indicada pelo transporte', async t => {
  const f = await fixture(t);
  const [first] = await f.propose(['Primeiro']);
  const [second] = await f.propose(['Segundo']);
  await f.store.bind(f.scope, [first.id], {channel:'whatsapp',messageId:'first-card'});
  for (const target of [null, {}, {channel:'telegram',messageId:'first-card'}, {channel:'whatsapp',messageId:'unknown-card'}]) {
    await f.decide('Não precisa fazer nada', {target});
    assert.ok((await f.store.list(f.scope)).every(row => row.state === 'pending'));
  }
  await f.decide('Não precisa fazer nada', {target:{channel:'whatsapp',messageId:'first-card'}});
  const persisted = await f.store.list(f.scope);
  assert.equal(persisted.find(row => row.id === first.id).state, 'canceled');
  assert.equal(persisted.find(row => row.id === second.id).state, 'pending');
  assert.deepEqual(f.effects, []);
});

test('palavras da recusa não identificam por coincidência uma proposta fora do contexto', async t => {
  const f = await fixture(t);
  await f.propose(['Nada']);
  f.show('Conversa sobre outro assunto, sem cartão');
  await f.decide('Não precisa fazer nada');
  assert.equal((await f.store.list(f.scope))[0].state, 'pending');
  assert.deepEqual(f.effects, []);
});

test('texto citado não cancela e ausência de pendências preserva referências e replay', async t => {
  const f = await fixture(t);
  const [row] = await f.propose();
  const target = {channel:'whatsapp',messageId:'proposal-card'};
  await f.store.bind(f.scope, [row.id], target);
  await f.decide(`[Não precisa fazer nada]${CHANNEL_CTX_END}Como funciona?`, {target});
  assert.equal((await f.store.list(f.scope))[0].state, 'pending');
  await f.decide('Não precisa fazer nada', {target,inputId:'cancel-message'});
  for (const extra of [{target}, {inputId:'cancel-message'}]) {
    assert.equal((await f.decide('pode', extra)).replay, true);
  }
  assert.equal((await f.decide(`confirmo pedido ${row.number}`)).replay, true);
  assert.ok((await f.decide('confirmo pedido 999')).text);
  assert.ok((await f.decide('pode', {target:{channel:'whatsapp',messageId:'unknown'}})).text);
  assert.deepEqual(await f.decide('👍', {target:{channel:'whatsapp',messageId:'unknown'},viaReaction:true}), {ignore:true});
  assert.equal(await f.decide(NEW_REQUESTS[0]), null);
  assert.deepEqual(f.effects, []);
});

for (const [language, request, refusal] of [
  ['pt-BR', 'Pode ir na seção de supermercado', 'Não precisa fazer isso'],
  ['en', 'Go ahead and move the groceries to the supermarket section', 'No need to do that'],
  ['es', 'Puedes poner los alimentos en la sección de supermercado', 'No hace falta hacer eso'],
]) {
  test(`pedido novo e recusa ambígua preservam escopo em ${language}`, async t => {
    const f = await fixture(t, language);
    assert.equal(await f.decide(request), null);
    assert.deepEqual(await f.store.list(f.scope), []);
    const rows = await f.propose(['First synthetic event','Second synthetic event']);
    await f.decide(refusal);
    assert.ok((await f.store.list(f.scope)).every(row => row.state === 'pending'));
    f.show(proposalPresentation(rows));
    await f.decide(request);
    assert.ok((await f.store.list(f.scope)).every(row => row.state === 'pending'));
    assert.deepEqual(f.effects, []);
  });
}
