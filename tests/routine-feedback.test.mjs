// A routine reads what its owner wrote in the delivery channel since its last
// run. The read is scoped by SQL to one owner and one assistant, and the block
// has a size ceiling: a wider scope would show one person's chat to another
// person's routine, and a block without the ceiling would grow with every busy
// chat, both without any error.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { channelMessagesSinceLastRun, routineChannelFeedbackBlock } from '../web/routine-feedback.mjs';

const id = (n) => '00000000-0000-0000-0000-' + String(n).padStart(12, '0');
const OWNER = id(1), OTHER = id(2), AGENT = id(10), OTHER_AGENT = id(11);
const db = new PGlite();
await db.exec(`CREATE SCHEMA s;
CREATE TABLE s.threads(id uuid PRIMARY KEY, agent_id uuid, user_id uuid, title text, updated_at timestamptz DEFAULT now(), deleted_at timestamptz);
CREATE TABLE s.messages(id bigserial PRIMARY KEY, thread_id uuid, role text, content text, ts timestamptz);`);
const thread = (n, agent, user, title, deleted = false) => db.query('INSERT INTO s.threads(id,agent_id,user_id,title,deleted_at) VALUES($1,$2,$3,$4,$5)', [id(n), agent, user, title, deleted ? new Date() : null]);
const message = (n, role, content, hoursAgo) => db.query(`INSERT INTO s.messages(thread_id,role,content,ts) VALUES($1,$2,$3,now() - make_interval(hours => $4))`, [id(n), role, content, hoursAgo]);
await thread(100, AGENT, OWNER, '⏰ Training');
await thread(101, AGENT, OWNER, 'WhatsApp');
await thread(102, AGENT, OTHER, 'WhatsApp');
await thread(103, OTHER_AGENT, OWNER, 'WhatsApp');
await thread(104, AGENT, OWNER, 'Telegram', true);
await message(100, 'assistant', 'delivery of yesterday', 24);
await message(101, 'user', 'before the last run', 30);
await message(101, 'user', 'I am travelling until Tuesday', 10);
await message(101, 'assistant', 'Noted, have a good trip', 10);
await message(101, 'user', 'and no stairs please', 2);
await message(102, 'user', 'message of another person', 3);
await message(103, 'user', 'message to another assistant', 3);
await message(104, 'user', 'message in a deleted conversation', 3);
const read = (over = {}) => channelMessagesSinceLastRun({ agentId: AGENT, userId: OWNER, channel: 'whatsapp', title: 'Training', routineThreadId: id(100), ...over }, db, 's');

test('reads only the owner\'s own messages to this assistant, since the last delivery', async () => {
  assert.deepEqual((await read()).map((m) => m.content), ['I am travelling until Tuesday', 'and no stairs please']);
  assert.deepEqual(await read({ channel: 'telegram' }), []);
  assert.deepEqual(await read({ channel: 'none' }), []);
});

test('a routine that never delivered looks back one week at most', async () => {
  await thread(105, AGENT, OWNER, '⏰ New');
  await message(101, 'user', 'older than the window', 24 * 8);
  assert.deepEqual((await read({ routineThreadId: id(105) })).map((m) => m.content), ['before the last run', 'I am travelling until Tuesday', 'and no stairs please']);
});

test('the block keeps the most recent messages under the ceiling', () => {
  const messages = Array.from({ length: 12 }, (_, i) => ({ content: `m${i} ` + 'y'.repeat(900), ts: new Date(Date.UTC(2026, 10, 20, i)) }));
  const lines = routineChannelFeedbackBlock(messages, { kind: 'routine', channel: 'whatsapp', timeZone: 'UTC' }).split('\n').filter((l) => l.startsWith('- '));
  assert.equal(lines.length, 4);
  assert.match(lines.at(-1), /m11 /);
  assert.ok(lines.join('').length < 2200);
  assert.equal(routineChannelFeedbackBlock(messages, { kind: 'routine', channel: 'whatsapp', ownControl: true }), '');
  assert.equal(routineChannelFeedbackBlock(messages, { kind: 'routine', channel: 'none' }), '');
});
