// Caso Luffy 05/10/2026: o turno terminou, o envio pelo Telegram falhou na rede e
// o canal mandou "Tenta de novo?" fora do histórico; o "pode tentar de novo sim"
// seguinte virou devolutiva da jornada. Aqui: resposta pronta é reenviada sem
// rodar o turno de novo, e todo aviso de erro entra no histórico. Fetch simulado.
import assert from 'node:assert/strict';
import test from 'node:test';

process.env.CANAL_REENVIO_MS = '0,0';
const { createTelegramManager } = await import('./web/telegram.mjs');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function rodar({ runConversation, falhasDaResposta = 0 }) {
  const sent = [], registrados = [];
  let polls = 0, turnos = 0, falhas = falhasDaResposta;
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const method = String(url).split('/').pop();
    const body = JSON.parse(init?.body || '{}');
    if (method === 'getUpdates') {
      if (polls++ === 0) return { json: async () => ({ ok: true, result: [{ update_id: 1, message: { message_id: 2, chat: { id: 123 }, text: 'anota que paguei o André' } }] }) };
      return new Promise(() => {});
    }
    if (method === 'sendMessage') {
      if (body.text === 'Anotado.' && falhas-- > 0) throw new TypeError('fetch failed');
      sent.push(body.text);
    }
    return { json: async () => ({ ok: true, result: { message_id: sent.length + 10 } }) };
  };
  const bot = { token: 'synthetic', enabled: true, chat_id: '123', agent_id: 'a1', user_id: 'u1' };
  const manager = createTelegramManager({
    db: { getTelegramBot: async () => bot, bindTelegramChat: async () => {}, setTelegramOffset: async () => {} },
    loadAgent: async () => ({ id: 'a1' }),
    runConversation: async (...args) => { turnos++; return runConversation(...args); },
    avisoCanal: { idiomaDe: async () => ({ language: 'pt-BR' }), registrar: async (r) => { registrados.push(r); } },
  });
  manager.addBot(bot);
  await wait(30);
  manager.removeBot(bot.token);
  globalThis.fetch = original;
  return { sent, registrados, turnos };
}

test('falha de rede no envio: reenvia a resposta pronta, sem aviso e sem novo turno', async () => {
  const r = await rodar({ runConversation: async () => ({ text: 'Anotado.' }), falhasDaResposta: 1 });
  assert.deepEqual(r.sent, ['Anotado.']);
  assert.equal(r.turnos, 1);
  assert.deepEqual(r.registrados, []);
});

test('envio que não se recupera: aviso de entrega no histórico, sem pedir pra refazer', async () => {
  const r = await rodar({ runConversation: async () => ({ text: 'Anotado.' }), falhasDaResposta: 9 });
  assert.equal(r.turnos, 1);
  assert.equal(r.sent.length, 1);
  assert.match(r.sent[0], /sem refazer nada/);
  assert.deepEqual(r.registrados.map((x) => [x.text, x.pergunta]), [[r.sent[0], null]]);
});

test('turno que quebra: aviso e pergunta entram no histórico', async () => {
  const r = await rodar({ runConversation: async () => { throw new Error('provider caiu'); } });
  assert.equal(r.sent.length, 1);
  assert.match(r.sent[0], /não consegui terminar de responder/);
  assert.deepEqual(r.registrados.map((x) => [x.text, x.pergunta]), [[r.sent[0], 'anota que paguei o André']]);
});

// WhatsApp tem caminho próprio (fila de entrada): até 05/10 a falha de envio com a
// fila ligada só marcava a mensagem como incerta, e a pessoa ficava sem nada.
async function rodarWa({ falhasDaResposta }) {
  Object.assign(process.env, { WA_PHONE_NUMBER_ID: 'synthetic-phone', WA_TOKEN: 'synthetic', WA_DEBOUNCE_MS: '0', WA_TURN_HEARTBEAT_MS: '0' });
  const { createWhatsAppHandler } = await import('./web/whatsapp.mjs');
  const sent = [], registrados = [];
  let turnos = 0, falhas = falhasDaResposta;
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init?.body || '{}');
    if (body.type === 'text') {
      if (body.text.body === 'Anotado.' && falhas-- > 0) throw new TypeError('fetch failed');
      sent.push(body.text.body);
      return { ok: true, json: async () => ({ messages: [{ id: 'out-' + sent.length }] }) };
    }
    return { ok: true, json: async () => ({ success: true }) };
  };
  const h = createWhatsAppHandler({
    db: { getWhatsAppLink: async () => ({ enabled: true, user_id: 'u1', active_agent_id: 'a1' }), listAgents: async () => [{ id: 'a1', name: 'Alpha' }], touchWaInbound: async () => {} },
    loadAgent: async () => ({ id: 'a1', name: 'Alpha' }),
    runConversation: async () => { turnos++; return { text: 'Anotado.' }; },
    avisoCanal: { idiomaDe: async () => ({ language: 'pt-BR' }), registrar: async (r) => { registrados.push(r); } },
  });
  await h.process({ entry: [{ changes: [{ value: { metadata: { phone_number_id: 'synthetic-phone' }, messages: [{ id: 'in-1', from: '5511000000000', type: 'text', text: { body: 'anota que paguei o André' } }] } }] }] });
  await wait(50);
  globalThis.fetch = original;
  return { sent, registrados, turnos };
}

test('WhatsApp: reenvia a resposta pronta e, se não sair, avisa no histórico', async () => {
  const ok = await rodarWa({ falhasDaResposta: 1 });
  assert.deepEqual([ok.sent, ok.turnos, ok.registrados], [['Anotado.'], 1, []]);
  const falhou = await rodarWa({ falhasDaResposta: 9 });
  assert.equal(falhou.turnos, 1);
  assert.equal(falhou.sent.length, 1);
  assert.match(falhou.sent[0], /sem refazer nada/);
  assert.deepEqual(falhou.registrados.map((x) => [x.text, x.pergunta]), [[falhou.sent[0], null]]);
});
