// The adjustments of a routine are written by the assistant, in the middle of
// a chat, and read by every run. A write with a wider scope would let one
// person change another person's routine, a write of the whole configuration
// would erase the run's heartbeat, and a list without ceiling or expiry would
// grow into every run's request; none of them raises an error.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { MAX_ADJUSTMENTS, activeAdjustments, addRoutineAdjustment, removeRoutineAdjustment, routineAdjustmentsBlock, routineAdjustmentsListing, createRoutineAdjustmentTools } from '../web/routine-adjustments.mjs';
import { createRoutineSelect } from '../web/routine-select.mjs';

const id = (n) => '00000000-0000-0000-0000-' + String(n).padStart(12, '0');
const OWNER = id(1), OTHER = id(2), TZ = 'America/Sao_Paulo';
const db = new PGlite();
await db.exec(`CREATE SCHEMA s; CREATE TABLE s.routines(id uuid PRIMARY KEY, user_id uuid, tz text, config jsonb DEFAULT '{}'::jsonb);`);
const routine = (n, user, config = {}) => db.query('INSERT INTO s.routines(id,user_id,tz,config) VALUES($1,$2,$3,$4)', [id(n), user, TZ, JSON.stringify(config)]);
const config = async (n) => (await db.query('SELECT config FROM s.routines WHERE id=$1', [id(n)])).rows[0].config;
const add = (n, text, over = {}) => addRoutineAdjustment({ routineId: id(n), userId: OWNER, text, ...over }, db, 's');
const day = (offset) => new Date(Date.now() + offset * 86400000).toLocaleDateString('en-CA', { timeZone: TZ });

test('a line is appended to the owner\'s routine only, and leaves the rest of the configuration alone', async () => {
  await routine(10, OWNER, { execution: { status: 'running' } });
  await routine(11, OTHER);
  const first = await add(10, '  No leg exercises:\n knee injury ');
  assert.equal(first.ok, true);
  assert.equal(first.adjustment.text, 'No leg exercises: knee injury');
  assert.equal((await add(10, 'no leg exercises: knee injury')).already, true);
  assert.equal((await add(10, 'Hotel without gym', { until: day(3) })).ok, true);
  const saved = await config(10);
  assert.deepEqual(saved.execution, { status: 'running' });
  assert.deepEqual(saved.adjustments.map((a) => [a.text, a.until]), [['No leg exercises: knee injury', undefined], ['Hotel without gym', day(3)]]);
  assert.equal((await add(11, 'not mine')).code, 'NOT_FOUND');
  assert.deepEqual(await config(11), {});
  assert.equal((await removeRoutineAdjustment({ routineId: id(10), userId: OTHER, adjustmentId: first.adjustment.id }, db, 's')).ok, false);
  const removed = await removeRoutineAdjustment({ routineId: id(10), userId: OWNER, adjustmentId: '#' + first.adjustment.id }, db, 's');
  assert.equal(removed.removed.text, 'No leg exercises: knee injury');
  assert.deepEqual((await config(10)).adjustments.map((a) => a.text), ['Hotel without gym']);
  assert.deepEqual((await config(10)).execution, { status: 'running' });
});

test('refuses what cannot be kept: a full list, a past date, a routine with its own control', async () => {
  await routine(20, OWNER, { adjustments: [{ id: 'old001', text: 'expired yesterday', at: new Date().toISOString(), until: day(-1) }] });
  await routine(21, OWNER, { curation: {} });
  for (let i = 0; i < MAX_ADJUSTMENTS; i++) assert.equal((await add(20, `line ${i}`)).ok, true);
  const full = await add(20, 'one too many');
  assert.equal(full.code, 'FULL');
  assert.equal(full.adjustments.length, MAX_ADJUSTMENTS);
  // The expired line gave its place to a new one and left the database.
  assert.equal((await config(20)).adjustments.some((a) => a.id === 'old001'), false);
  assert.equal((await add(21, 'only bars')).code, 'OWN_CONTROL');
  await routine(22, OWNER);
  assert.equal((await add(22, 'travelling', { until: day(-1) })).code, 'PAST_DATE');
  assert.equal((await add(22, 'travelling', { until: '2026-02-30' })).code, 'INVALID_DATE');
  assert.equal((await add(22, 'x'.repeat(241))).code, 'TEXT_TOO_LONG');
  assert.deepEqual(await config(22), {});
});

test('a run receives only the lines that still apply, and only in a routine without its own control', () => {
  const stored = { adjustments: [
    { id: 'a', text: 'No leg exercises', at: '2026-11-20T12:00:00Z' },
    { id: 'b', text: 'Hotel without gym', at: '2026-11-22T12:00:00Z', until: '2026-11-26' },
    { id: 'c', text: 'Had a fever', at: '2026-11-10T12:00:00Z', until: '2026-11-12' },
  ] };
  const now = new Date('2026-11-27T02:30:00Z'); // still the 26th in São Paulo
  const active = activeAdjustments(stored, { timeZone: TZ, now });
  assert.deepEqual(active.map((a) => a.id), ['a', 'b']);
  const block = routineAdjustmentsBlock(active, { kind: 'routine' });
  assert.match(block, /- \(noted 2026-11-20\) No leg exercises\n- \(noted 2026-11-22, applies until 2026-11-26\) Hotel without gym$/);
  assert.equal(activeAdjustments(stored, { timeZone: TZ, now: new Date('2026-11-27T03:30:00Z') }).length, 1);
  assert.equal(routineAdjustmentsBlock(active, { kind: 'routine', ownControl: true }), '');
  assert.equal(routineAdjustmentsBlock(active, { kind: 'chat' }), '');
  assert.equal(routineAdjustmentsBlock([], { kind: 'routine' }), '');
});

test('the chat tools note and remove a line on the routine the owner named', async () => {
  await db.query('ALTER TABLE s.routines ADD COLUMN title text');
  await routine(30, OWNER);
  await db.query('UPDATE s.routines SET title=$2 WHERE id=$1', [id(30), 'Training of the day']);
  const listRoutines = async (userId) => (await db.query('SELECT id, title, tz, config FROM s.routines WHERE user_id=$1 AND title IS NOT NULL', [userId])).rows;
  const [note, remove] = createRoutineAdjustmentTools({ userId: OWNER, listRoutines, ...createRoutineSelect({ userTz: TZ }),
    add: (a) => addRoutineAdjustment(a, db, 's'), remove: (a) => removeRoutineAdjustment(a, db, 's') });
  const noted = await note.run({ title: 'training', text: 'No leg exercises: knee injury.', valid_until: day(5) });
  assert.equal(noted.result, 'noted');
  const [{ id: code }] = (await config(30)).adjustments;
  assert.equal(noted.adjustment, `[${code}] No leg exercises: knee injury. (applies until ${day(5)})`);
  assert.match(routineAdjustmentsListing((await listRoutines(OWNER))[0]), new RegExp(`\\[${code}\\] No leg exercises`));
  assert.equal((await note.run({ title: 'no such routine', text: 'x' })).ok, false);
  const wrong = await remove.run({ title: 'training', adjustment: 'zzzzzz' });
  assert.deepEqual([wrong.ok, wrong.adjustments.length], [false, 1]);
  assert.equal((await remove.run({ title: 'training', adjustment: code })).removed, 'No leg exercises: knee injury.');
  assert.equal(routineAdjustmentsListing((await listRoutines(OWNER))[0]), '');
});
