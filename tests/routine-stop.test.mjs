// Stopping a routine pauses it at once; only an explicit permanent delete waits
// for the owner. Before this, every "stop" became a delete card, and a reply the
// gate did not read as a yes left the routine running every day.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { gateTool, takePending } from '../web/confirm.mjs';
import { createStopRoutineTool, selfStopOnly } from '../web/routine-stop.mjs';

function routines() {
  const effects = [];
  const rows = [{ id: 'routine-A', title: 'Creme no cotovelo', enabled: true }];
  const tool = createStopRoutineTool({
    userId: 'u1',
    listRoutines: async () => structuredClone(rows),
    updateRoutine: async (id, _user, fields) => { effects.push(['update', id, fields]); },
    deleteRoutine: async (id) => { effects.push(['delete', id]); },
    resolveRoutine: (rs, { titulo }) => ({ row: rs.find((r) => r.title.includes(titulo)) }),
    routineCode: () => 'a1b2',
    routineCadence: () => 'daily 08:00',
  });
  return { tool, effects, rows };
}

test('stopping pauses right away, with no card', async () => {
  const { tool, effects } = routines();
  const thread = crypto.randomUUID();
  const res = await gateTool(tool, thread).run({ titulo: 'Creme' });
  assert.equal(res.result, 'paused');
  assert.deepEqual(effects, [['update', 'routine-A', { enabled: false }]]);
  assert.equal(takePending(thread), undefined);
});

test('a permanent delete waits for the owner', async () => {
  const { tool, effects } = routines();
  const thread = crypto.randomUUID();
  await gateTool(tool, thread).run({ titulo: 'Creme', permanently: true });
  assert.deepEqual(effects, []);
  const card = takePending(thread);
  assert.ok(card);
  assert.equal((await card.run(card.args)).result, 'deleted');
  assert.deepEqual(effects, [['delete', 'routine-A']]);
});

test('a routine ending itself never deletes', async () => {
  const { tool, effects } = routines();
  await selfStopOnly(tool).run({ titulo: 'Creme', permanently: true });
  assert.deepEqual(effects, [['update', 'routine-A', { enabled: false }]]);
});
