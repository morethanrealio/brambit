// Talking to an assistant's avatar (avatar-live.mjs, avatar-speech.mjs): the
// avatar service bills every second a session is open, so a session nobody
// watches or uses hangs up by itself, also one ended while it was still being
// created; its seconds are billed to the owner, and the day's minutes or the
// credit running out end it; and the face only says the chat's newest
// assistant reply, read from the database, once, without links or Markdown.
// Fake service and clock.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAvatarLive, LIMITS } from '../web/avatar-live.mjs';
import { spokenText, speechChunks } from '../web/avatar-speech.mjs';

const flush = () => new Promise((resolve) => setImmediate(resolve));
const RTC = { provider: 'agora', appId: 'app', channel: 'ch', uid: 'u', token: 'tok' };

function setup(t, { replies = [], gate = null, hasCredit } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1e12 });
  const calls = [], spoken = [], billed = [];
  let audio = 0, sessions = 0;
  const api = {
    async createSession(config, { avatarId }) {
      const id = `L${++sessions}`;
      calls.push(`create ${avatarId}`);
      await gate;
      return { id, rtc: RTC };
    },
    openStream: (config, id) => ({
      ready: Promise.resolve(),
      audio: (frame) => { audio += frame.length; },
      reply: (text) => calls.push(`reply ${text}`),
      cut: () => calls.push('cut'),
      hangup: () => calls.push(`hangup ${id}`),
    }),
  };
  const store = { latestReply: async () => replies[0] ?? null };
  const live = createAvatarLive({
    vidu: () => ({ host: 'vidu.test', key: 'k' }), api, store,
    tts: async (text, voice) => { spoken.push(`${voice}: ${text}`); return { pcm: Buffer.alloc(9600), usage: { model: 'tts' } }; },
    recordUsages: async (usages, dims) => (dims.kind === 'avatar' ? billed.push(usages[0].out) : calls.push(`bill ${dims.userId} ${dims.kind}`)),
    hasCredit, registerAgent: () => {}, now: () => Date.now(), onStop: () => {}, log: () => {}, info: () => {},
  });
  const tick = async (ms) => { for (let left = ms; left > 0; left -= 100) { t.mock.timers.tick(Math.min(100, left)); await flush(); } await flush(); };
  const seconds = () => billed.reduce((a, b) => a + b, 0);
  return { live, calls, spoken, replies, audio: () => audio, tick, seconds };
}

function watcher() {
  const res = { events: [], ended: false, writeHead() {}, write(chunk) { res.events.push(chunk); }, end() { res.ended = true; res.close?.(); }, on(name, fn) { if (name === 'close') res.close = fn; } };
  return res;
}

const open = (live, more = {}) => live.open({ userId: 'u1', agentId: 'agent-1-abc', threadId: 't1', photoId: 'p1', voice: 'Kore', ...more });

test('a session nobody watches, or where nothing is said, hangs up by itself', async (t) => {
  const { live, calls, tick, seconds } = setup(t);
  open(live);
  await flush();
  await tick(LIMITS.unwatched);
  assert.deepEqual(calls, ['create p1', 'hangup L1']);
  assert.equal(seconds(), LIMITS.unwatched / 1000, 'its seconds are billed when it ends');

  const s = open(live);
  const res = watcher();
  live.watch(s, res);
  await tick(LIMITS.unwatched + 1000);
  assert.equal(calls.at(-1), 'create p1', 'a watched session stays');
  assert.match(res.events.join(''), /event: rtc\ndata: .*"token":"tok"/);
  await tick(LIMITS.idle);
  assert.equal(calls.at(-1), 'hangup L2');
  assert.match(res.events.at(-1), /event: end\ndata: {"reason":"idle"}/);
  assert.equal(res.ended, true);
});

test('a session is billed every minute, and ends when the credit or the day\'s minutes run out', async (t) => {
  let credit = true;
  const { live, calls, tick, seconds } = setup(t, { hasCredit: async () => credit });
  const res = watcher();
  live.watch(open(live), res);
  await tick(LIMITS.billEvery * 2 + 100);
  assert.equal(seconds(), LIMITS.billEvery * 2 / 1000, 'billed while it is open');
  credit = false;
  await tick(LIMITS.billEvery);
  assert.match(res.events.at(-1), /"reason":"credit"/);
  assert.equal(seconds(), LIMITS.billEvery * 3 / 1000);

  credit = true;
  assert.throws(() => open(live, { usedToday: LIMITS.daily - 30e3 }), { code: 'daily' });
  const late = watcher();
  live.watch(open(live, { usedToday: LIMITS.daily - 90e3 }), late);
  await tick(90e3);
  assert.match(late.events.at(-1), /"reason":"daily"/);
  assert.equal(calls.at(-1), 'hangup L2');
});

test('a session ended while it was being created hangs up as soon as it exists', async (t) => {
  let open_;
  const { live, calls } = setup(t, { gate: new Promise((resolve) => { open_ = resolve; }) });
  live.end(open(live), 'hangup');
  open_();
  await flush();
  await flush();
  assert.deepEqual(calls, ['create p1', 'hangup L1']);
});

test('the face says the chat\'s newest assistant reply once, without links or Markdown', async (t) => {
  const { live, calls, spoken, replies, audio, tick } = setup(t, { replies: [{ id: '5', content: 'already on screen' }] });
  const s = open(live, { lastReplyId: '5' });
  live.watch(s, watcher());
  await flush();
  assert.equal(await live.speak(s), false, 'a reply from before the session is not said');
  replies.unshift({ id: '6', content: '**Done!** See [the doc](https://example.com/doc).\nhttps://example.com/x' });
  assert.equal(await live.speak(s), true);
  assert.equal(await live.speak(s), false, 'the same reply is not said twice');
  await tick(1000);
  assert.deepEqual(spoken, ['Kore: Done! See the doc.']);
  assert.ok(calls.includes('reply Done! See the doc.'));
  assert.ok(calls.includes('bill u1 tts'), 'the speech is billed to the owner');
  assert.equal(audio(), 9600);
});

test('a reply becomes plain sentences, made into speech in short pieces', () => {
  const text = spokenText('## Plan\n- Buy **milk** 🥛\n- Call `Ana`\n\n```js\nx()\n```\n| a | b |\n|---|---|\n| 1 | 2 |\nMore at <https://example.com>.');
  assert.equal(text, 'Plan. Buy milk. Call Ana. a, b. 1, 2. More at .');
  const chunks = speechChunks(Array.from({ length: 30 }, (_, i) => `Sentence number ${i} is here.`).join(' '));
  assert.ok(chunks[0].length <= 160 && chunks.every((c) => c.length <= 300));
  assert.equal(chunks.join(' '), Array.from({ length: 30 }, (_, i) => `Sentence number ${i} is here.`).join(' '));
});
