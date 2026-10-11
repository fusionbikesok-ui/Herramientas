-- Fase D: ventas por publicación. El ítem de un pedido guardaba solo el SKU, y agrupar por SKU atribuye
-- las mismas ventas a publicaciones distintas que lo comparten. `ml_key` = item + variación (clave de
-- ml_publicaciones_cache). Aditiva: las filas viejas quedan NULL y se completan con la reconciliación de 30 días.
ALTER TABLE gestion_pedido_items ADD COLUMN ml_key TEXT;
CREATE INDEX IF NOT EXISTS idx_gestion_pedido_items_ml_key ON gestion_pedido_items(ml_key);
