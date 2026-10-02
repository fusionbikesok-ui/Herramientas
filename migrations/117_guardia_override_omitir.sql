-- Un override explícito es parte de la intención durable de la operación.
ALTER TABLE guardia_ml_operaciones ADD COLUMN override_omitir INTEGER NOT NULL DEFAULT 0;
