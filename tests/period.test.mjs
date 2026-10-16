import test from 'node:test';
import assert from 'node:assert/strict';
import { currentPeriod } from '../web/periodo.mjs';

// The billing month starts at local midnight of day 1; a shift here moves
// usage between months without any error.
test('month window starts at local midnight, across time zones and DST', () => {
  assert.deepEqual(currentPeriod(new Date('2026-10-01T02:00:00Z'), 'America/Sao_Paulo'),
    { start: '2026-09-01T03:00:00.000Z', end: '2026-10-01T03:00:00.000Z' });
  assert.deepEqual(currentPeriod(new Date('2026-03-15T12:00:00Z'), 'Europe/Berlin'),
    { start: '2026-02-28T23:00:00.000Z', end: '2026-03-31T22:00:00.000Z' });
  assert.deepEqual(currentPeriod(new Date('2026-12-31T23:00:00Z'), 'UTC'),
    { start: '2026-12-01T00:00:00.000Z', end: '2027-01-01T00:00:00.000Z' });
});
