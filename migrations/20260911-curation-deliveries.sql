-- Somente após aprovação específica. NÃO é executada por initDb. Sem backfill:
-- texto de thread não prova que uma edição foi entregue.
BEGIN;
CREATE TABLE mtr_harness.curation_deliveries (
 id uuid PRIMARY KEY,
 user_id uuid NOT NULL REFERENCES mtr_harness.users(id),
 routine_id uuid NOT NULL REFERENCES mtr_harness.routines(id) ON DELETE CASCADE,
 status text NOT NULL CHECK(status IN ('reserved','confirmed','uncertain')),
 article_keys text[] NOT NULL CHECK(cardinality(article_keys) BETWEEN 1 AND 8),
 body_sha256 text NOT NULL CHECK(length(body_sha256)=64),
 provider_id text,
 created_at timestamptz NOT NULL DEFAULT now(),
 confirmed_at timestamptz,
 CHECK(status<>'confirmed' OR (provider_id IS NOT NULL AND confirmed_at IS NOT NULL))
);
CREATE INDEX curation_scope_idx ON mtr_harness.curation_deliveries(user_id,routine_id,created_at DESC);
COMMIT;
