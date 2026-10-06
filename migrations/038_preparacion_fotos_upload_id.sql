-- Idempotencia de cargas de evidencia desde dispositivos móviles.
ALTER TABLE preparacion_fotos ADD COLUMN upload_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS uq_preparacion_fotos_upload
  ON preparacion_fotos(preparacion_id, upload_id)
  WHERE upload_id IS NOT NULL;
