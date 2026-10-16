-- Run only as an explicit deployment migration. Historical provider timeouts
-- cannot be priced reliably and must not keep blocking the user's balance.
-- The original row, quote and diagnostics remain available for audit.
BEGIN;
UPDATE mtr_harness.execution_credit_calls
SET state='waived',
    record=jsonb_set(
      jsonb_set(record,'{state}','"waived"'::jsonb,true),
      '{waiver}',
      jsonb_build_object('reason','legacy_provider_result_unknown','billCredits',0,'at',(extract(epoch FROM clock_timestamp())*1000)::bigint),
      true
    ),
    updated_at=now()
WHERE state='uncertain';
COMMIT;
