-- Company account F1 (company-shared credit).
-- RUN BEFORE DEPLOYING the F1 code: the new code reads and writes
-- execution_credit_calls.org_id on every credit reservation, and server boot
-- NEVER creates or alters this table (it only comes from an explicit migration).
-- Running it in production requires the operator's separate approval.
--
-- Additive: does not reprice, delete or rewrite anything. Old reservations keep
-- org_id NULL, which is exactly "paid by the person" (today's behavior).
--
-- No FK to mtr_harness.orgs on purpose: this migration runs before deploy,
-- when the orgs table may not exist yet (boot creates it, empresa.mjs).
-- And a call's billing record must not vanish or change owner together with
-- the company.
BEGIN;
ALTER TABLE mtr_harness.execution_credit_calls ADD COLUMN IF NOT EXISTS org_id uuid;
-- Reservas em aberto da empresa: somadas em toda admissão de qualquer membro.
CREATE INDEX IF NOT EXISTS execution_credit_org_holds_idx ON mtr_harness.execution_credit_calls(org_id)
  WHERE org_id IS NOT NULL AND state IN ('reserved','dispatched','uncertain');
COMMIT;
