// The Telegram bot chat can only be bound by whoever has the pairing
// code (which only appears on the owner's Connections screen, in an authenticated session).
// Before, the FIRST message that arrived would bind the bot: whoever discovered the
// @username before the owner became the owner of the chat. These tests guard against this.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTelegramManager, codeEq } from './web/telegram.mjs';

const CODIGO = 'a1b2c3d4e5f6';

// Minimal environment: a fake db with a registered bot and no chat bound yet,
// and a fake fetch in place of the Telegram API (no network leaves from here).
function cenario({ chatId = null, pairCode = CODIGO } = {}) {
  const enviadas = [];
  const amarrados = [];
  const bot = { token: 'TOKEN123', enabled: true, chat_id: chatId, pair_code: pairCode, agent_id: 'ag1' };
  const db = {
    async getTelegramBot() { return { ...bot }; },
    async bindTelegramChat(token, cid) { amarrados.push([token, cid]); bot.chat_id = cid; },
  };
  const fetchOriginal = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init?.body || '{}');
    if (String(url).endsWith('/sendMessage')) enviadas.push(body.text);
    return { json: async () => ({ ok: true, result: { message_id: 1 } }) };
  };
  const mgr = createTelegramManager({
    db,
    runConversation: async () => ({ text: 'oi' }),
    loadAgent: async () => ({ id: 'ag1' }),
  });
  return { mgr, bot, enviadas, amarrados, restaurar: () => { globalThis.fetch = fetchOriginal; } };
}

const update = (texto, chat = '999') => ({ message: { chat: { id: chat }, text: texto } });

test('mensagem qualquer de um estranho não amarra o bot', async () => {
  const c = cenario();
  try {
    await c.mgr.handleUpdate({ token: 'TOKEN123' }, update('oi, tudo bem?'));
    assert.deepEqual(c.amarrados, []);
    assert.match(c.enviadas.join(' '), /link de ativação/);
  } finally { c.restaurar(); }
});

test('/start sem código não amarra', async () => {
  const c = cenario();
  try {
    await c.mgr.handleUpdate({ token: 'TOKEN123' }, update('/start'));
    assert.deepEqual(c.amarrados, []);
  } finally { c.restaurar(); }
});

test('/start com código errado não amarra', async () => {
  const c = cenario();
  try {
    await c.mgr.handleUpdate({ token: 'TOKEN123' }, update('/start codigoerrado'));
    assert.deepEqual(c.amarrados, []);
  } finally { c.restaurar(); }
});

test('/start com o código certo amarra o chat', async () => {
  const c = cenario();
  try {
    await c.mgr.handleUpdate({ token: 'TOKEN123' }, update('/start ' + CODIGO));
    assert.deepEqual(c.amarrados, [['TOKEN123', '999']]);
  } finally { c.restaurar(); }
});

test('/start@nomedobot com o código certo também amarra', async () => {
  const c = cenario();
  try {
    await c.mgr.handleUpdate({ token: 'TOKEN123' }, update('/start@meu_bot ' + CODIGO));
    assert.deepEqual(c.amarrados, [['TOKEN123', '999']]);
  } finally { c.restaurar(); }
});

test('bot sem código de pareamento não amarra por /start nenhum', async () => {
  const c = cenario({ pairCode: null });
  try {
    await c.mgr.handleUpdate({ token: 'TOKEN123' }, update('/start '));
    await c.mgr.handleUpdate({ token: 'TOKEN123' }, update('/start qualquercoisa'));
    assert.deepEqual(c.amarrados, []);
  } finally { c.restaurar(); }
});

test('com o chat já amarrado, outro chat continua recusado', async () => {
  const c = cenario({ chatId: '111' });
  try {
    await c.mgr.handleUpdate({ token: 'TOKEN123' }, update('/start ' + CODIGO, '999'));
    assert.deepEqual(c.amarrados, []);
    assert.match(c.enviadas.join(' '), /privado/);
  } finally { c.restaurar(); }
});

test('codeEq recusa vazio e tamanho diferente sem estourar', () => {
  assert.equal(codeEq('', ''), false);
  assert.equal(codeEq(null, null), false);
  assert.equal(codeEq('abc', 'abcd'), false);
  assert.equal(codeEq('abc', 'abc'), true);
});
