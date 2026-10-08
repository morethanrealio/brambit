import assert from 'node:assert/strict';
import { startTurnHeartbeat } from '../web/turn-heartbeat.mjs';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let checks = 0;
const eq = (actual, expected) => { assert.deepEqual(actual, expected); checks++; };

// Fast turn cancels the receipt.
{
  let sends = 0;
  const finish = startTurnHeartbeat({ afterMs: 15, send: async () => { sends++; } });
  await finish();
  await wait(25);
  eq(sends, 0);
}

// Long turn sends only once and finish waits for the in-flight send.
{
  const events = [];
  let release;
  const finish = startTurnHeartbeat({
    afterMs: 10,
    send: async () => {
      events.push('started');
      await new Promise((resolve) => { release = resolve; });
      events.push('sent');
    },
  });
  await wait(20);
  eq(events, ['started']);
  const finishing = finish().then(() => events.push('finished'));
  await wait(5);
  eq(events, ['started']);
  release();
  await finishing;
  eq(events, ['started', 'sent', 'finished']);
  await wait(20);
  eq(events, ['started', 'sent', 'finished']);
}

// Failure in the receipt is observable, but doesn't bring down the turn.
{
  const errors = [];
  const finish = startTurnHeartbeat({
    afterMs: 5,
    send: async () => { throw new Error('synthetic'); },
    onError: (e) => errors.push(e.message),
  });
  await wait(12);
  await finish();
  eq(errors, ['synthetic']);
}

console.log(`${checks} verificações passaram: heartbeat único, ordenado e tolerante a falha.`);

// Telegram integration: the receipt goes out while the model is working and the
// final reply only comes after. Fetch is entirely simulated.
{
  process.env.TELEGRAM_TURN_HEARTBEAT_MS = '10';
  const sent = [];
  let updatePolls = 0;
  let releaseTurn;
  globalThis.fetch = async (url, init) => {
    const method = String(url).split('/').pop();
    const body = JSON.parse(init?.body || '{}');
    if (method === 'getUpdates') {
      if (updatePolls++ === 0) {
        return { json: async () => ({ ok: true, result: [{
          update_id: 1,
          message: { message_id: 2, chat: { id: 123 }, text: 'faça algo demorado' },
        }] }) };
      }
      return new Promise(() => {}); // next poll stays parked, no I/O
    }
    if (method === 'sendMessage') sent.push(body.text);
    return { json: async () => ({ ok: true, result: { message_id: sent.length + 10 } }) };
  };
  const { createTelegramManager } = await import('../web/telegram.mjs');
  const bot = { token: 'synthetic', enabled: true, chat_id: '123', agent_id: 'a1', user_id: 'u1' };
  const manager = createTelegramManager({
    db: {
      getTelegramBot: async () => bot,
      bindTelegramChat: async () => {},
      setTelegramOffset: async () => {},
    },
    loadAgent: async () => ({ id: 'a1' }),
    runConversation: async () => {
      await new Promise((resolve) => { releaseTurn = resolve; });
      return { text: 'resposta final' };
    },
  });
  manager.addBot(bot);
  await wait(25);
  eq(sent, ['Ainda estou trabalhando nisso, já te respondo.']);
  releaseTurn();
  await wait(15);
  eq(sent, [
    'Ainda estou trabalhando nisso, já te respondo.',
    'resposta final',
  ]);
  manager.removeBot(bot.token);
  delete process.env.TELEGRAM_TURN_HEARTBEAT_MS;
}

console.log(`${checks} verificações totais incluindo o adaptador Telegram simulado.`);
