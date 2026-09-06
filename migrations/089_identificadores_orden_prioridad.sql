-- Orden de prioridad de identificadores dentro de un Producto Fusion.
--
-- Un producto puede tener varios GTIN activos y todos legítimos: son los
-- códigos que el mismo artículo lleva en distintos mercados (medido el
-- 2026-09-06: 210 pares SKU con GTIN distinto entre ML y Woo, por ejemplo
-- Shimano-JP 4524667220343 contra Shimano-US 689228220348). Tras sembrar los
-- GTIN de ML quedan 39 productos con más de un identificador activo.
--
-- Cuál de ellos representa al producto no se decide por una regla fija sino por
-- un orden explícito y reordenable, como el orden de arranque de una BIOS: se
-- recorre la lista y gana el primero disponible. `orden` menor gana.
--
-- Decisión 2026-09-06: esto SUPERA el invariante "una unidad admite como máximo
-- un EAN activo y un UPC activo" (docs/superpowers/plans/
-- 2026-09-04-identidad-productos.md, §Invariantes). Motivo: es falso contra los
-- datos —22 productos tienen dos activos del mismo subtipo, con códigos
-- válidos— y limitar a uno por familia obligaría a descartar identificadores
-- reales. El orden resuelve la ambigüedad sin perder información, que es lo que
-- el modelo 0..N existe para permitir.
--
-- `orden` no lleva índice único a propósito: con UNIQUE, reordenar exigiría
-- swaps en varios pasos y un UPDATE simple fallaría a mitad de camino. El
-- desempate es determinista igual, por (orden, id).

ALTER TABLE identificadores_producto ADD COLUMN orden INTEGER NOT NULL DEFAULT 100;

-- Prioridad por defecto de la fuente, reordenable desde Productos Fusion.
-- Woo primero porque es el valor que Woo ya publica en `global_unique_id`:
-- así el orden inicial no cambia en silencio lo que hoy ve un cliente.
ALTER TABLE identidad_config ADD COLUMN identificadores_prioridad TEXT NOT NULL DEFAULT 'woo,ml,manual';

UPDATE identificadores_producto SET orden = CASE fuente
  WHEN 'woo' THEN 10
  WHEN 'ml' THEN 20
  WHEN 'manual' THEN 30
  ELSE 100 END
WHERE tipo = 'gtin';

CREATE INDEX IF NOT EXISTS idx_identificadores_orden
  ON identificadores_producto(producto_id, tipo, estado, orden);
