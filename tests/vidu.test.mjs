// The installation's Vidu model and idle gestures (VIDU_MODEL, VIDU_IDLE_MOTION)
// reach the session request; a bad value keeps the default. No network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { viduConfig, createSession, VIDU_DEFAULT_MODEL } from '../web/vidu.mjs';

const REPLY = JSON.stringify({ live: { id: '1' }, managed_rtc: { provider: 'agora' } });

async function sessionBody(config) {
  let body;
  const fetchImpl = async (_url, init) => { body = JSON.parse(init.body); return new Response(REPLY); };
  await createSession({ ...config, fetchImpl }, { avatarId: 'p1' });
  return body;
}

test('the configured model and gestures open the session; bad ones keep the defaults', async () => {
  const quiet = { enabled: false };
  const set = await sessionBody(viduConfig({ key: 'k', model: 'Vidu-S2', idleMotion: JSON.stringify(quiet) }));
  assert.equal(set.model, 'vidu-s2');
  assert.deepEqual(set.idle_motion, quiet);

  const plain = await sessionBody(viduConfig({ key: 'k', model: '', idleMotion: '' }));
  const bad = await sessionBody(viduConfig({ key: 'k', model: 'gpt-4o', idleMotion: '{"motions":' }));
  assert.equal(plain.model, VIDU_DEFAULT_MODEL);
  assert.deepEqual(bad, plain);
  assert.equal(plain.idle_motion.enabled, true);
});
