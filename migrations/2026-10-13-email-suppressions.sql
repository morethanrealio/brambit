-- Email suppression list (web/email-suppression.mjs): addresses that can no
-- longer receive mail, fed by hard bounces and by Apple's Sign in with Apple
-- notifications. Server boot NEVER creates this table. Until it exists the code
-- treats every address as deliverable (fail-open), so deploying the code first
-- is safe. Running it in production requires the operator's separate approval.
BEGIN;
CREATE TABLE mtr_harness.email_suppressions (
 email text PRIMARY KEY CHECK(email<>'' AND email=lower(btrim(email))),
 source text NOT NULL CHECK(source IN ('bounce','apple')),
 reason text NOT NULL,
 detail text,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
COMMIT;
