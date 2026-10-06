-- Vigía de formato de publicaciones (2026-09-12).
--
-- El 2026-09-11 la publicación MLA1873586405 (cubierta Continental GP5000, FB-64881) se enganchó
-- sola a un producto de catálogo llamado "... Kit De 2 Unidades" y se vendió al precio de una
-- unidad el mismo día. Nadie la tocó: la cambió la sincronización. Esta tabla guarda cada cambio
-- de formato detectado para poder pausar, avisar y revisar después.
--
-- `catalog_product_id` no se persistía: el cache sólo tenía `catalogo` (booleano), que no cambia
-- cuando una publicación de catálogo salta de un producto a otro. Sin esta columna el incidente
-- que originó todo sería indetectable.
ALTER TABLE ml_publicaciones_cache ADD COLUMN catalog_product_id TEXT;

CREATE TABLE IF NOT EXISTS ml_publicacion_cambios (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  clave          TEXT    NOT NULL,
  item_id        TEXT    NOT NULL,
  sku            TEXT,
  campo          TEXT    NOT NULL,
  valor_anterior TEXT,
  valor_nuevo    TEXT,
  pausada        INTEGER NOT NULL DEFAULT 0,
  pausa_error    TEXT,
  detectado_en   TEXT    NOT NULL,
  revisado_en    TEXT,
  revisado_por   TEXT
);

CREATE INDEX IF NOT EXISTS idx_ml_pub_cambios_sin_revisar
  ON ml_publicacion_cambios(revisado_en, clave);
CREATE INDEX IF NOT EXISTS idx_ml_pub_cambios_clave
  ON ml_publicacion_cambios(clave, id);
