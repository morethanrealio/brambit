// Step-ceiling escalation across "say continue" turns (Naomi item 11).
//
// core-proto/core.mjs caps each turn at a fixed number of steps (22 by
// default, 40 in free/"livre" mode). When a turn hits that cap mid-task, it
// asks the person to say "continue" so the next turn can resume. Before this
// module, the NEXT turn restarted at the exact same cap, so a task bigger
// than one ceiling hit the ceiling again and repeated the identical message
// turn after turn (real case: Gabriel got it 4 times in 2 days; Camila's
// task fit in one continuation and never saw it twice).
//
// Rule, bounded on purpose (never unlimited cost):
//   - 1st hit of a streak: normal budget. core.mjs asks the person to say "continue".
//   - 2nd consecutive hit: budget is bumped ONCE (capped). If that bumped turn
//     ALSO hits the ceiling, core.mjs (via `ceilingRetry`) proposes splitting
//     the work into smaller parts instead of asking to "continue" again.
//   - 3rd+ consecutive hit: budget goes back to normal (cost stays bounded)
//     and core.mjs keeps proposing splitting rather than repeating either
//     message.
// The streak resets as soon as a turn finishes WITHOUT hitting the ceiling:
// that turn's assistant message carries no `termination`, so the next ceiling
// encountered in the conversation starts the streak over from step 1.
//
// State rides on the persisted assistant message, the same pattern server.mjs
// already uses for `inventoryCalculation`/`selo.meta`: no new table, no new
// column, just two fields alongside the message that's saved either way.

const CEILING_REASON = 'step_limit';
const BUMP_FACTOR = 2;
// Hard ceiling regardless of mode (livre's own budget is already 40), so a
// task that keeps hitting the ceiling can never run the budget away.
const BUMP_CAP = 60;

function lastAssistantMessage(history) {
  for (let i = (history || []).length - 1; i >= 0; i--) {
    if (history[i]?.role === 'assistant') return history[i];
  }
  return null;
}

// `baseMaxSteps` is what the caller would use with no escalation at all (22,
// or 40 in free/"livre" mode). Returns:
//   - maxSteps: the budget for THIS turn
//   - ceilingRetry: pass straight to runAgent({ ceilingRetry }) so core.mjs
//     proposes splitting instead of "say continue" if this turn also hits the ceiling
//   - annotate(message, termination): call once the turn's outcome is known,
//     on the SAME assistant message object server.mjs is about to persist
export function ceilingBudgetForTurn(baseHistory, baseMaxSteps) {
  const prev = lastAssistantMessage(baseHistory);
  const prevHitCeiling = prev?.termination === CEILING_REASON;
  const alreadyEscalated = prevHitCeiling && prev.stepCeilingEscalated === true;
  return {
    maxSteps: prevHitCeiling && !alreadyEscalated ? Math.min(baseMaxSteps * BUMP_FACTOR, BUMP_CAP) : baseMaxSteps,
    ceilingRetry: prevHitCeiling,
    annotate(message, termination) {
      if (termination !== CEILING_REASON) return; // turn closed fine: the streak resets on its own
      message.termination = CEILING_REASON;
      if (prevHitCeiling) message.stepCeilingEscalated = true; // sticky: the one bump is spent either way
    },
  };
}
