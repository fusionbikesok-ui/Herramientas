-- Identificadores GTIN: forma canónica GS1, subtipo, valor crudo y fuente.
--
-- Problema que resuelve (medido 2026-09-06):
--   * `valor_normalizado` guardaba el código crudo — `normalizarGtin` sólo
--     validaba el largo. Por eso `0602883701731` y `602883701731` eran dos
--     identificadores distintos, y 13 de los 650 pares SKU comparables entre
--     ML y Woo se leían como códigos diferentes siendo el mismo.
--   * El `UNIQUE (tipo, valor_normalizado)` de tabla es global, así que un
--     código en conflicto no se podía ni registrar: la segunda fila fallaba y
--     el `INSERT OR IGNORE` del llamador la descartaba en silencio. Eso choca
--     con la máquina de estados del plan, que exige alertar y dejar decidir.
--
-- SQLite no admite quitar una constraint de tabla, así que la tabla se recrea.
-- El índice único pasa a ser parcial sobre `estado = 'activo'`: un producto
-- puede conservar identificadores históricos o en conflicto con el mismo valor,
-- pero sólo uno puede estar activo.

ALTER TABLE identificadores_producto RENAME TO identificadores_producto_old;
DROP TRIGGER IF EXISTS trg_identificadores_sin_borrado;

CREATE TABLE identificadores_producto (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tipo TEXT NOT NULL CHECK (tipo IN ('fusion_sku', 'woo_sku', 'gtin')),
  -- Clave de comparación. Para `gtin` es el canónico GS1 de 14 dígitos; para
  -- los SKU sigue siendo el valor tal cual, que ya es su propia clave.
  valor_normalizado TEXT NOT NULL,
  -- Representación tal como la entregó la fuente, que el plan exige preservar.
  valor_crudo TEXT,
  -- Sólo para `tipo = 'gtin'`: describe la representación recibida, no un tipo
  -- "verdadero" inferido bajo el relleno de ceros (ver lib/gtin.js).
  subtipo TEXT CHECK (subtipo IS NULL OR subtipo IN ('ean_8', 'upc_a', 'ean_13', 'gtin_14')),
  fuente TEXT CHECK (fuente IS NULL OR fuente IN ('woo', 'ml', 'manual')),
  producto_id INTEGER NOT NULL REFERENCES productos_fusion(id),
  estado TEXT NOT NULL DEFAULT 'reservado'
    CHECK (estado IN ('activo', 'historico', 'reservado', 'conflicto')),
  transferido_desde_producto_id INTEGER REFERENCES productos_fusion(id),
  transferido_por TEXT,
  motivo_transferencia TEXT,
  creado_en TEXT NOT NULL,
  actualizado_en TEXT NOT NULL
);

-- Backfill. El canónico se arma con relleno de texto, nunca con aritmética:
-- convertir a entero para rellenar destruiría el cero significativo de un
-- UPC-A como 036000291452. Los identificadores existentes son todos de Woo
-- (740 filas `gtin`, exactamente los GTIN válidos del catálogo Woo).
INSERT INTO identificadores_producto
  (id, tipo, valor_normalizado, valor_crudo, subtipo, fuente, producto_id, estado,
   transferido_desde_producto_id, transferido_por, motivo_transferencia, creado_en, actualizado_en)
SELECT
  id,
  tipo,
  CASE WHEN tipo = 'gtin'
    THEN substr('00000000000000' || valor_normalizado, -14, 14)
    ELSE valor_normalizado END,
  CASE WHEN tipo = 'gtin' THEN valor_normalizado ELSE NULL END,
  CASE WHEN tipo = 'gtin' THEN
    CASE length(valor_normalizado)
      WHEN 8 THEN 'ean_8'
      WHEN 12 THEN 'upc_a'
      WHEN 13 THEN 'ean_13'
      WHEN 14 THEN 'gtin_14'
    END
  END,
  CASE WHEN tipo = 'gtin' THEN 'woo' ELSE NULL END,
  producto_id,
  estado,
  transferido_desde_producto_id,
  transferido_por,
  motivo_transferencia,
  creado_en,
  actualizado_en
FROM identificadores_producto_old;

DROP TABLE identificadores_producto_old;

CREATE TRIGGER IF NOT EXISTS trg_identificadores_sin_borrado
BEFORE DELETE ON identificadores_producto
BEGIN
  SELECT RAISE(ABORT, 'identificador reservado no admite borrado fisico');
END;

CREATE UNIQUE INDEX IF NOT EXISTS uq_identificadores_valor_activo
  ON identificadores_producto(tipo, valor_normalizado) WHERE estado = 'activo';
CREATE INDEX IF NOT EXISTS idx_identificadores_producto
  ON identificadores_producto(producto_id, tipo, estado);
CREATE INDEX IF NOT EXISTS idx_identificadores_conflicto
  ON identificadores_producto(tipo, valor_normalizado) WHERE estado = 'conflicto';
