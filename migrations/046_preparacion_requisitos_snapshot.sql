-- E2: conserva los requisitos de foto que aplicaban al iniciar el ítem.
-- Se ejecuta mediante openDb() y su registro _schema_migrations; no ejecutar este
-- archivo suelto sobre una base ya migrada porque SQLite no soporta ADD COLUMN IF NOT EXISTS.
ALTER TABLE preparacion_items ADD COLUMN requisitos_json_snapshot TEXT;
