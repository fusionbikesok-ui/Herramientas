-- Un solo ejecutor de escrituras remotas, con dos tipos de operación.
--
-- `identidad_operaciones` estaba modelada para la saga de corrección de SKU: exigía
-- `decision_id` y `sku_objetivo`. Una protección por baja de Woo (PM-104) no tiene ninguna de
-- las dos —nace de un webhook confirmado, no de una decisión humana, y no hay SKU objetivo
-- porque el producto ya no existe en Woo—.
--
-- Se eligió ampliar esta tabla en vez de darle a la protección su propia tabla y su propio
-- worker: la maquinaria de seguridad (modo + flag, canario, lote máximo, claim contra
-- concurrencia, reintentos y verificación remota de cada paso) es justamente lo que no
-- conviene duplicar, porque es donde los frenos divergen con el tiempo. La alternativa que se
-- descartó era inventar una decisión y un SKU falsos para que la protección entrara en el
-- molde actual, que es acomodar el dato al esquema.
--
-- `tipo` es NOT NULL con default para que las 125 operaciones existentes queden clasificadas
-- sin ambigüedad, y para que una operación nueva no pueda nacer sin tipo.

-- `legacy_alter_table` cambia qué hace el RENAME con las tablas que referencian a ésta. Con el
-- comportamiento moderno, renombrar reescribe las claves foráneas de `identidad_operacion_pasos`
-- para que apunten a `identidad_operaciones_old`, y al soltar esa tabla las 459 filas hijas
-- quedan apuntando a nada (lo detectó `foreign_key_check` antes de llegar a producción). Con el
-- modo legacy las referencias quedan escritas contra el nombre `identidad_operaciones`, que es
-- justamente el que vuelve a existir al final de esta migración.
PRAGMA legacy_alter_table = ON;

ALTER TABLE identidad_operaciones RENAME TO identidad_operaciones_old;
DROP INDEX IF EXISTS idx_identidad_operaciones_pendientes;

CREATE TABLE identidad_operaciones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  operation_id TEXT NOT NULL UNIQUE,
  tipo TEXT NOT NULL DEFAULT 'correccion_sku' CHECK (tipo IN ('correccion_sku', 'proteccion_woo')),
  caso_id INTEGER NOT NULL REFERENCES identidad_casos(id),
  -- Nullables sólo para `proteccion_woo`; la corrección de SKU los sigue exigiendo en código.
  decision_id INTEGER REFERENCES identidad_decisiones(id),
  producto_id INTEGER REFERENCES productos_fusion(id),
  ml_key TEXT NOT NULL,
  sku_anterior TEXT,
  sku_objetivo TEXT,
  stock_objetivo INTEGER NOT NULL,
  estado TEXT NOT NULL DEFAULT 'shadow' CHECK (estado IN ('shadow', 'pendiente', 'procesando', 'verificando', 'completada', 'fallida', 'intervencion', 'bloqueada_impacto')),
  paso_actual TEXT NOT NULL DEFAULT 'zero',
  intentos INTEGER NOT NULL DEFAULT 0,
  proximo_intento_en TEXT,
  ultimo_error TEXT,
  impacto_hermanas INTEGER NOT NULL DEFAULT 0,
  impacto_confirmado INTEGER NOT NULL DEFAULT 0,
  iniciada_en TEXT NOT NULL,
  claim_hasta TEXT,
  actualizada_en TEXT NOT NULL,
  completada_en TEXT,
  sin_cero INTEGER NOT NULL DEFAULT 0,
  -- Invariante del tipo: una corrección sin decisión ni SKU objetivo sería una escritura
  -- remota sin nadie que la haya pedido, que es exactamente lo que la saga existe para evitar.
  CHECK (tipo <> 'correccion_sku' OR (decision_id IS NOT NULL AND sku_objetivo IS NOT NULL AND producto_id IS NOT NULL))
);

INSERT INTO identidad_operaciones
  (id, operation_id, tipo, caso_id, decision_id, producto_id, ml_key, sku_anterior, sku_objetivo,
   stock_objetivo, estado, paso_actual, intentos, proximo_intento_en, ultimo_error,
   impacto_hermanas, impacto_confirmado, iniciada_en, claim_hasta, actualizada_en, completada_en, sin_cero)
SELECT id, operation_id, 'correccion_sku', caso_id, decision_id, producto_id, ml_key, sku_anterior, sku_objetivo,
   stock_objetivo, estado, paso_actual, intentos, proximo_intento_en, ultimo_error,
   impacto_hermanas, impacto_confirmado, iniciada_en, claim_hasta, actualizada_en, completada_en, sin_cero
FROM identidad_operaciones_old;

DROP TABLE identidad_operaciones_old;

CREATE INDEX IF NOT EXISTS idx_identidad_operaciones_pendientes
  ON identidad_operaciones(estado, proximo_intento_en, id);
CREATE INDEX IF NOT EXISTS idx_identidad_operaciones_tipo
  ON identidad_operaciones(tipo, estado);

PRAGMA legacy_alter_table = OFF;
