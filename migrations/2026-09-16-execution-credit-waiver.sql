-- Useful provider responses without metering are not user-debt. Preserve their
-- audit row, waive the unknown charge and release the admission hold.
BEGIN;
ALTER TABLE mtr_harness.execution_credit_calls
  DROP CONSTRAINT IF EXISTS execution_credit_calls_state_check;
ALTER TABLE mtr_harness.execution_credit_calls
  ADD CONSTRAINT execution_credit_calls_state_check
  CHECK(state IN ('reserved','dispatched','uncertain','settled','cancelled','waived'));
COMMIT;
