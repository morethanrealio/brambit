// Issue #19: the notes and suggestions came back empty when a label opened the text.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseOnboard } from '../web/onboard-parse.mjs';

test('labels at the very start of the text', () => {
  const r = parseOnboard('PARA_LEMBRAR:\n- Supplier meeting on Thursday\n\nSUGESTOES:\n- Reply to the supplier\n- Review the contract');
  assert.equal(r.welcome, '');
  assert.deepEqual(r.notes, ['Supplier meeting on Thursday']);
  assert.deepEqual(r.suggestions, ['Reply to the supplier', 'Review the contract']);
});

test('a greeting before the labels', () => {
  const r = parseOnboard('Hi! Good to see you.\n\nPARA_LEMBRAR:\n- Supplier meeting on Thursday\n\nSUGESTOES:\n- Check the calendar');
  assert.equal(r.welcome, 'Hi! Good to see you.');
  assert.deepEqual(r.notes, ['Supplier meeting on Thursday']);
  assert.deepEqual(r.suggestions, ['Check the calendar']);
});

test('only SUGESTOES, at the start', () => {
  const r = parseOnboard('SUGESTOES:\n- Check the calendar');
  assert.deepEqual(r, { welcome: '', suggestions: ['Check the calendar'], notes: [] });
});
