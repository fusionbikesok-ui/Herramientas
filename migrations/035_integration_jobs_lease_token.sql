-- P1: añade el token de lease sin modificar migraciones históricas.
ALTER TABLE integration_jobs ADD COLUMN lease_token TEXT;
