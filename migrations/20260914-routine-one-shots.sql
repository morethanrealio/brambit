CREATE TABLE IF NOT EXISTS mtr_harness.routine_one_shots (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  routine_id  uuid NOT NULL REFERENCES mtr_harness.routines(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES mtr_harness.users(id) ON DELETE CASCADE,
  run_at      timestamptz NOT NULL,
  status      text NOT NULL DEFAULT 'pending',
  outcome     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  started_at  timestamptz,
  finished_at timestamptz
);
CREATE INDEX IF NOT EXISTS routine_one_shots_due_idx
  ON mtr_harness.routine_one_shots(status, run_at);
CREATE UNIQUE INDEX IF NOT EXISTS routine_one_shots_pending_idx
  ON mtr_harness.routine_one_shots(routine_id, run_at) WHERE status='pending';
