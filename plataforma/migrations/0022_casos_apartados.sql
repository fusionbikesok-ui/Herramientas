-- 0022 — Rediseño de la bandeja: «No estoy seguro» aparta un caso sin decidirlo. No es una decisión
-- (no escribe identity_decisions ni mueve el vínculo), así que la calibración no lo ve.
SET lock_timeout = '5s';
ALTER TABLE catalog.identity_cases
  ADD COLUMN apartado_en timestamptz,
  ADD COLUMN apartado_por text,
  ADD COLUMN apartado_motivo text;
CREATE TABLE catalog.identity_case_marks (
  idempotency_key text PRIMARY KEY,
  case_id uuid NOT NULL REFERENCES catalog.identity_cases(id),
  accion text NOT NULL CHECK (accion IN ('apartar','desapartar')),
  version int NOT NULL,
  creado_en timestamptz NOT NULL DEFAULT now());
COMMENT ON COLUMN catalog.identity_cases.apartado_en IS
  'Marcado «No estoy seguro» en la bandeja: sale de la cola normal hasta que se decide o se desaparta.';
