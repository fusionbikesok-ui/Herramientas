-- E2: congela la versión de la regla de fotos usada por cada preparación.
-- Se ejecuta mediante openDb() y su registro _schema_migrations; no ejecutar este
-- archivo suelto sobre una base ya migrada porque SQLite no soporta ADD COLUMN IF NOT EXISTS.
ALTER TABLE preparacion_perfiles ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE preparacion_perfiles_sku ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE preparacion_items ADD COLUMN perfil_version INTEGER NOT NULL DEFAULT 1;
