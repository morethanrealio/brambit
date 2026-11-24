// The overview of the person's other conversations carries what they wrote
// there lately. Going back to the start of the summary alone would bring no
// error, only an assistant that does not know what was said yesterday on the
// other channel; and a routine's prompt or a webhook payload shown as "the
// person wrote" would put words in their mouth.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { crossChannelDigest } from '../web/conversations-overview.mjs';
import { markVoiceInput } from '../web/voice-input.mjs';

const id = (n) => '00000000-0000-0000-0000-' + String(n).padStart(12, '0');
const OWNER = id(1), OTHER = id(2), AGENT = id(10), TEAM = id(11);
const db = new PGlite();
await db.exec(`CREATE SCHEMA s;
CREATE TABLE s.agents(id uuid PRIMARY KEY, name text, category text);
CREATE TABLE s.threads(id uuid PRIMARY KEY, agent_id uuid, user_id uuid, title text, summary text, webhook_skill text NOT NULL DEFAULT '', updated_at timestamptz DEFAULT now(), deleted_at timestamptz);
CREATE TABLE s.messages(id bigserial PRIMARY KEY, thread_id uuid, role text, content text, ts timestamptz);
INSERT INTO s.agents VALUES ('${AGENT}', 'Flor', 'pessoal'), ('${TEAM}', 'Team', 'grupo');`);
const thread = (n, title, { agent = AGENT, user = OWNER, summary = '', webhook = '' } = {}) => db.query('INSERT INTO s.threads(id,agent_id,user_id,title,summary,webhook_skill) VALUES($1,$2,$3,$4,$5,$6)', [id(n), agent, user, title, summary, webhook]);
const message = (n, role, content, hoursAgo) => db.query(`INSERT INTO s.messages(thread_id,role,content,ts) VALUES($1,$2,$3,now() - make_interval(hours => $4))`, [id(n), role, content, hoursAgo]);
await thread(100, 'Web chat');
await thread(101, 'Telegram', { summary: 'Training plan agreed two weeks ago: three runs a week.' });
await thread(102, '⏰ Training', { summary: 'Daily training deliveries.' });
await thread(103, 'Orders', { webhook: 'orders' });
await thread(104, 'Slack', { agent: TEAM });
await thread(105, 'Telegram', { user: OTHER });
await message(101, 'user', 'older than the window', 24 * 8);
await message(101, 'user', 'first of four', 30);
await message(101, 'user', 'I am travelling until Tuesday', 10);
await message(101, 'assistant', 'Noted, have a good trip', 10);
await message(101, 'user', markVoiceInput('any ideas for the hotel room?'), 9);
await message(101, 'user', 'x'.repeat(500), 2);
await message(102, 'user', 'Send today\'s training.', 5);
await message(103, 'user', '{"order": 1}', 5);
await message(104, 'user', 'a colleague speaking', 5);
await message(105, 'user', 'message of another person', 1);
const lines = (await crossChannelDigest(OWNER, id(100), 'UTC', db, 's')).split('\n');
const line = (title) => lines.find((l) => l.startsWith(`- "${title}"`));

test('a conversation with a summary shows the person\'s latest messages, the summary only as topic', () => {
  const telegram = line('Telegram');
  assert.match(telegram, /topic: Training plan agreed two weeks ago.* · the person wrote: /);
  assert.match(telegram, /"I am travelling until Tuesday" \| \(.+\) "🎤 any ideas for the hotel room\?" \| \(.+\) "x{119}…"$/);
  assert.doesNotMatch(telegram, /first of four|older than the window|Noted/);
  assert.equal(lines.length, 4);
  assert.ok(!lines.some((l) => l.includes('another person')));
});

test('a routine\'s prompt, a webhook payload and a team channel are not shown as the person\'s words', () => {
  assert.equal(line('⏰ Training').split(': ').slice(1).join(': '), 'Daily training deliveries.');
  assert.match(line('Orders'), /\): \{"order": 1\}$/);
  assert.match(line('Slack'), /\): a colleague speaking$/);
  assert.ok(!lines.some((l) => !l.startsWith('- "Telegram"') && l.includes('the person wrote')));
});
