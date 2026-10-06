-- U0.B: idempotencia de confirmación y metadatos consumibles por la cola de etiquetas.
ALTER TABLE despacho_controles ADD COLUMN confirmacion_idempotencia TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_despacho_confirmacion_idempotencia
  ON despacho_controles(confirmacion_idempotencia)
  WHERE confirmacion_idempotencia IS NOT NULL;
ALTER TABLE etiquetas_cola ADD COLUMN formato_ancho_mm INTEGER NOT NULL DEFAULT 50 CHECK (formato_ancho_mm > 0);
ALTER TABLE etiquetas_cola ADD COLUMN formato_alto_mm INTEGER NOT NULL DEFAULT 25 CHECK (formato_alto_mm > 0);
ALTER TABLE etiquetas_cola ADD COLUMN tipo_etiqueta TEXT NOT NULL DEFAULT 'interna';
