-- Fase E-1c (spec 2026-10-11-fase-e-webhooks-design.md, fila product.deleted): bajas de Woo CONFIRMADAS por una relectura
-- (404 `invalid_id` o status=trash, o una variación que el padre vigente ya no devuelve). Una fila por SKU dado de baja.
-- `stock.bolsa` lleva a 0 las publicaciones de ML vinculadas a un SKU con baja vigente, aunque el producto ya no esté en
-- `catalogo_cache` (sin esta fila el CTE de stock no tiene nada que empujar). La fila se levanta sola cuando el SKU reaparece
-- en el catálogo (producto restaurado o recreado).
CREATE TABLE IF NOT EXISTS woo_bajas_confirmadas (
  sku TEXT PRIMARY KEY,
  id_woo INTEGER,
  motivo TEXT NOT NULL,
  confirmada_en TEXT NOT NULL
);
