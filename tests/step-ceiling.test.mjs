// Naomi item 11: a turn that hits the step ceiling asks the person to say
// "continue", but the next turn restarted at the exact same ceiling, so a
// task bigger than one ceiling hit it again and repeated the identical
// message turn after turn (Gabriel got it 4 times in 2 days).
//
// Two things are covered here:
//   1. web/step-ceiling.mjs's ceilingBudgetForTurn(): the bounded, self-resetting
//      escalation across a "say continue" streak (unit, no network/model).
//   2. core-proto/core.mjs's runAgent({ ceilingRetry }): once the caller reports
//      the bumped turn ALSO hit the ceiling, the closing message proposes
//      splitting the work instead of asking to "continue" again.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ceilingBudgetForTurn } from '../web/step-ceiling.mjs';
import { runAgent, ToolRegistry } from '../core-proto/core.mjs';

test('no previous ceiling hit: base budget, no retry flag', () => {
  const r = ceilingBudgetForTurn([{ role: 'assistant', content: 'done' }], 22);
  assert.equal(r.maxSteps, 22);
  assert.equal(r.ceilingRetry, false);
});

test('empty history: base budget, no retry flag', () => {
  const r = ceilingBudgetForTurn([], 22);
  assert.equal(r.maxSteps, 22);
  assert.equal(r.ceilingRetry, false);
});

test('previous turn ended at the ceiling: budget bumps ONCE (capped) and ceilingRetry is on', () => {
  const r = ceilingBudgetForTurn([{ role: 'assistant', content: 'wip', termination: 'step_limit' }], 22);
  assert.equal(r.maxSteps, 44); // 22 * BUMP_FACTOR
  assert.equal(r.ceilingRetry, true);
});

test('bump respects the hard cap even for a larger base (livre mode)', () => {
  const r = ceilingBudgetForTurn([{ role: 'assistant', content: 'wip', termination: 'step_limit' }], 40);
  assert.equal(r.maxSteps, 60); // 40 * 2 = 80, capped at BUMP_CAP (60)
});

test('bumped turn hits the ceiling AGAIN (already escalated): budget goes back to base, ceilingRetry stays on', () => {
  const prev = { role: 'assistant', content: 'wip', termination: 'step_limit', stepCeilingEscalated: true };
  const r = ceilingBudgetForTurn([prev], 22);
  assert.equal(r.maxSteps, 22);
  assert.equal(r.ceilingRetry, true);
});

test('annotate marks the streak on the persisted message only when this turn also hit the ceiling', () => {
  const r = ceilingBudgetForTurn([{ role: 'assistant', content: 'wip', termination: 'step_limit' }], 22);
  const persisted = { role: 'assistant', content: 'ok' };
  r.annotate(persisted, 'step_limit');
  assert.equal(persisted.termination, 'step_limit');
  assert.equal(persisted.stepCeilingEscalated, true, 'the one bump is spent either way');
});

test('annotate leaves the message untouched when the turn closes fine: the streak resets on its own', () => {
  const r = ceilingBudgetForTurn([{ role: 'assistant', content: 'wip', termination: 'step_limit' }], 22);
  const persisted = { role: 'assistant', content: 'ok' };
  r.annotate(persisted, 'completed');
  assert.equal(persisted.termination, undefined);
  assert.equal(persisted.stepCeilingEscalated, undefined);
  // and the NEXT turn sees a clean history: no bump, no retry flag.
  const next = ceilingBudgetForTurn([persisted], 22);
  assert.equal(next.maxSteps, 22);
  assert.equal(next.ceilingRetry, false);
});

test('a non-ceiling termination (e.g. repeated_calls) does not start a streak', () => {
  const r = ceilingBudgetForTurn([{ role: 'assistant', content: 'wip', termination: 'repeated_calls' }], 22);
  assert.equal(r.maxSteps, 22);
  assert.equal(r.ceilingRetry, false);
});

// --- core.mjs integration: the closing message runAgent() produces when it hits the cap ---

// A tool that always succeeds; the provider varies its args every call so the
// anti-loop guard (3 identical calls in a row) never fires and the loop runs
// out the full step budget instead (termination: 'step_limit').
const tools = new ToolRegistry().add({ name: 'passo', description: 'x', parameters: {}, run: async () => 'ok' });
let n = 0;
const neverEndingProvider = {
  name: 'offline',
  complete: async () => ({ stop: 'tool', toolCalls: [{ id: `c${n}`, name: 'passo', args: { i: n++ } }] }),
};

test('ceilingRetry=false (first hit of a streak): closing message asks to say "continue"', async () => {
  n = 0;
  const r = await runAgent({ provider: neverEndingProvider, tools, system: 's', userInput: 'faz a tarefa toda', maxSteps: 2, ceilingRetry: false });
  assert.equal(r.termination, 'step_limit');
  assert.match(r.text, /continua/);
  assert.doesNotMatch(r.text, /dividir/);
});

test('ceilingRetry=true (bumped turn hit the ceiling again): closing message proposes splitting, not "say continue" again', async () => {
  n = 0;
  const r = await runAgent({ provider: neverEndingProvider, tools, system: 's', userInput: 'faz a tarefa toda', maxSteps: 2, ceilingRetry: true });
  assert.equal(r.termination, 'step_limit');
  assert.match(r.text, /dividir/);
  assert.doesNotMatch(r.text, /me diz "continua"/);
});
