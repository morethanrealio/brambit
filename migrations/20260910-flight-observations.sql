-- NÃO é chamada pelo initDb. Executar somente após autorização específica.
-- Sem backfill: dados legados não têm identidade completa da consulta.
BEGIN;
CREATE TABLE mtr_harness.flight_monitor_observations (
  id bigserial PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES mtr_harness.users(id),
  routine_id uuid NOT NULL REFERENCES mtr_harness.routines(id) ON DELETE CASCADE,
  query_key text NOT NULL CHECK (length(query_key)=64),
  query jsonb NOT NULL,
  observation_day date NOT NULL,
  timezone text NOT NULL,
  observed_at timestamptz NOT NULL,
  price numeric(14,2) NOT NULL CHECK (price>0),
  currency text NOT NULL CHECK (currency='BRL'),
  source text NOT NULL CHECK (source='google_flights_serpapi'),
  from_cache boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id,routine_id,query_key,observed_at)
);
CREATE INDEX flight_monitor_previous_idx ON mtr_harness.flight_monitor_observations
 (user_id,routine_id,query_key,observation_day,observed_at DESC);
COMMIT;
