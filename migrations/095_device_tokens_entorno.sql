-- migrations/095_device_tokens_entorno.sql
-- Entorno APNs del token. Un token de sandbox (dev client) y uno de producción
-- (TestFlight / App Store) NO son intercambiables: mandar al host equivocado devuelve
-- BadDeviceToken o falla en silencio, que es la clase de falla que dejó la push muerta.
--
-- El default es 'production' porque todos los tokens que existan al aplicar esto vienen de
-- builds de TestFlight.
--
-- Igual que la 094: la fuente que se ejecuta es el bloque guardado de `db/index.js`; este
-- archivo es la declaración legible del esquema.
ALTER TABLE device_tokens ADD COLUMN entorno TEXT NOT NULL DEFAULT 'production';
CREATE INDEX IF NOT EXISTS idx_device_tokens_entorno ON device_tokens(entorno) WHERE revocado_en IS NULL;
