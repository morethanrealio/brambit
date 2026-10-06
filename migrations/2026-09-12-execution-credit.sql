-- PROPOSAL ONLY. Production execution requires the operator's separate approval.
-- Additive ledger; does not backfill/reprice/delete existing usage or grants.
BEGIN;
CREATE TABLE mtr_harness.execution_credit_calls (
  user_id uuid NOT NULL REFERENCES mtr_harness.users(id) ON DELETE CASCADE,
  call_id text NOT NULL CHECK(length(call_id) BETWEEN 1 AND 200),
  state text NOT NULL CHECK(state IN ('reserved','dispatched','uncertain','settled','cancelled')),
  quote bigint NOT NULL CHECK(quote >= 0),
  record jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id,call_id)
);
CREATE INDEX execution_credit_holds_idx ON mtr_harness.execution_credit_calls(user_id)
  WHERE state IN ('reserved','dispatched','uncertain');
COMMIT;
