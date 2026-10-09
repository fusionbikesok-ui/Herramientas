-- "No sincronizar" variante (b): pausar la publicación en ML como operación durable. Tabla propia y aditiva:
-- identidad_operaciones exige caso y decisión de SKU, y reconstruirla (y su CHECK de pasos) no aporta nada a una
-- acción de un solo paso. Respeta los mismos frenos que la saga (modo, escrituras habilitadas, canario, lote).
CREATE TABLE IF NOT EXISTS identidad_pausas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  operation_id TEXT NOT NULL UNIQUE,
  ml_key TEXT NOT NULL,
  item_id TEXT NOT NULL,
  motivo TEXT NOT NULL,
  estado TEXT NOT NULL DEFAULT 'shadow' CHECK (estado IN ('shadow','pendiente','procesando','completada','fallida','cancelada')),
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
CREATE INDEX IF NOT EXISTS idx_identidad_pausas_estado ON identidad_pausas(estado, proximo_intento_en);
CREATE INDEX IF NOT EXISTS idx_identidad_pausas_clave ON identidad_pausas(ml_key, id);
