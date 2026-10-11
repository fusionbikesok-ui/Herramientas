-- Fase D (revisión): una pausa cuyo impacto (hermanas activas) cambió entre la solicitud y el worker no se pausa:
-- queda en `bloqueada_impacto` hasta una confirmación humana. SQLite no permite cambiar un CHECK: se reconstruye la
-- tabla (crear nueva, copiar, renombrar) conservando columnas, ids e índices.
CREATE TABLE identidad_pausas_nueva (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  operation_id TEXT NOT NULL UNIQUE,
  ml_key TEXT NOT NULL,
  item_id TEXT NOT NULL,
  motivo TEXT NOT NULL,
  estado TEXT NOT NULL DEFAULT 'shadow' CHECK (estado IN ('shadow','pendiente','procesando','completada','fallida','cancelada','bloqueada_impacto')),
  impacto_hermanas INTEGER NOT NULL DEFAULT 0,
  impacto_confirmado INTEGER NOT NULL DEFAULT 0,
  intentos INTEGER NOT NULL DEFAULT 0,
  proximo_intento_en TEXT,
  claim_hasta TEXT,
  ultimo_error TEXT,
  creada_por TEXT NOT NULL,
  creada_en TEXT NOT NULL,
  actualizada_en TEXT NOT NULL,
  completada_en TEXT
);
INSERT INTO identidad_pausas_nueva (id,operation_id,ml_key,item_id,motivo,estado,impacto_hermanas,impacto_confirmado,intentos,
  proximo_intento_en,claim_hasta,ultimo_error,creada_por,creada_en,actualizada_en,completada_en)
  SELECT id,operation_id,ml_key,item_id,motivo,estado,impacto_hermanas,impacto_confirmado,intentos,
  proximo_intento_en,claim_hasta,ultimo_error,creada_por,creada_en,actualizada_en,completada_en FROM identidad_pausas;
DROP TABLE identidad_pausas;
ALTER TABLE identidad_pausas_nueva RENAME TO identidad_pausas;
CREATE INDEX IF NOT EXISTS idx_identidad_pausas_estado ON identidad_pausas(estado, proximo_intento_en);
CREATE INDEX IF NOT EXISTS idx_identidad_pausas_clave ON identidad_pausas(ml_key, id);
