-- Auditoría de precios ML como proyección local (2026-09-16).
-- Las columnas nuevas de `ml_publicaciones_cache` (category_id, listing_type_id, free_shipping) y de
-- `ml_precio_auditoria` (huella_fuente, origen_ml_en, origen_woo_en, pendiente_motivo) se agregan desde
-- db/index.js consultando PRAGMA table_info: ALTER TABLE ADD COLUMN no es idempotente en SQLite.
-- Este archivo crea sólo lo que sí lo es.

-- Estado durable de la última sincronización automática/manual de la auditoría (una fila).
CREATE TABLE IF NOT EXISTS precios_auditoria_estado (
  id                    INTEGER PRIMARY KEY CHECK (id = 1),
  ultima_sync_en        TEXT,   -- última corrida terminada sin error
  ultima_sync_origen    TEXT,   -- ml_completo | ml_acotado | woo | cron | manual | manual_precio
  ultima_completa_en    TEXT,   -- última corrida sobre todo el universo con poda (tras refresco ML completo)
  ultimo_error          TEXT,
  ultimo_error_en       TEXT
);
INSERT OR IGNORE INTO precios_auditoria_estado (id) VALUES (1);

CREATE INDEX IF NOT EXISTS idx_ml_precio_auditoria_pendiente ON ml_precio_auditoria(pendiente_motivo)
  WHERE pendiente_motivo IS NOT NULL;
