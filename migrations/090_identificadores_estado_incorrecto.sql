-- Estado `incorrecto` para el identificador descartado al resolver un conflicto.
--
-- El plan lo pide desde el principio: «la persona elige cuál coincide, el
-- descartado queda marcado incorrecto y se crea una tarea de catálogo»
-- (docs/superpowers/plans/2026-09-04-identidad-productos.md). La 088 no lo
-- incluyó porque hasta que hubo con qué resolver los conflictos no había nada
-- que marcar; ahora sí.
--
-- `incorrecto` no es lo mismo que `historico`, y por eso no se reutiliza aquel:
-- `historico` es un código que fue válido para ese producto y dejó de serlo
-- —queda reservado y no se reasigna—, mientras que `incorrecto` es un código
-- que nunca debió estar ahí y hay que corregirlo en el canal de origen.
-- Colapsarlos perdería justamente la información que dispara la tarea de
-- catálogo.
--
-- SQLite no admite modificar un CHECK, así que la tabla se recrea. Se hace
-- ahora, con 11022 filas y ningún consumidor externo del campo: cuanto más
-- tarde, más cara la misma operación.

ALTER TABLE identificadores_producto RENAME TO identificadores_producto_old;
DROP TRIGGER IF EXISTS trg_identificadores_sin_borrado;
DROP INDEX IF EXISTS uq_identificadores_valor_activo;
DROP INDEX IF EXISTS idx_identificadores_producto;
DROP INDEX IF EXISTS idx_identificadores_conflicto;
DROP INDEX IF EXISTS idx_identificadores_orden;

CREATE TABLE identificadores_producto (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tipo TEXT NOT NULL CHECK (tipo IN ('fusion_sku', 'woo_sku', 'gtin')),
  valor_normalizado TEXT NOT NULL,
  valor_crudo TEXT,
  subtipo TEXT CHECK (subtipo IS NULL OR subtipo IN ('ean_8', 'upc_a', 'ean_13', 'gtin_14')),
  fuente TEXT CHECK (fuente IS NULL OR fuente IN ('woo', 'ml', 'manual')),
  producto_id INTEGER NOT NULL REFERENCES productos_fusion(id),
  estado TEXT NOT NULL DEFAULT 'reservado'
    CHECK (estado IN ('activo', 'historico', 'reservado', 'conflicto', 'incorrecto')),
  orden INTEGER NOT NULL DEFAULT 100,
  -- Quién resolvió el conflicto y por qué, para que la decisión sea auditable
  -- sin tener que cruzar el historial por timestamp.
  resuelto_por TEXT,
  resuelto_en TEXT,
  motivo_resolucion TEXT,
  transferido_desde_producto_id INTEGER REFERENCES productos_fusion(id),
  transferido_por TEXT,
  motivo_transferencia TEXT,
  creado_en TEXT NOT NULL,
  actualizado_en TEXT NOT NULL
);

INSERT INTO identificadores_producto
  (id, tipo, valor_normalizado, valor_crudo, subtipo, fuente, producto_id, estado, orden,
   transferido_desde_producto_id, transferido_por, motivo_transferencia, creado_en, actualizado_en)
SELECT id, tipo, valor_normalizado, valor_crudo, subtipo, fuente, producto_id, estado, orden,
   transferido_desde_producto_id, transferido_por, motivo_transferencia, creado_en, actualizado_en
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
CREATE INDEX IF NOT EXISTS idx_identificadores_orden
  ON identificadores_producto(producto_id, tipo, estado, orden);
