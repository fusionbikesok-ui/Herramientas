-- 0031 — E3: cuenta ML seleccionada por corrida.
-- Nullable para conservar corridas históricas creadas antes de congelar una cuenta explícita.
SET lock_timeout = '5s';

ALTER TABLE catalog.e3_canario_corridas
  ADD COLUMN channel_account_id uuid REFERENCES core.channel_accounts(id) ON DELETE RESTRICT;
