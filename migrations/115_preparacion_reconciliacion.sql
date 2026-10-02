-- Último intento de verificar el estado remoto de preparaciones abiertas.
-- Una fila por preparación permite priorizar las no intentadas y exponer/reintentar errores
-- sin hacer crecer indefinidamente el historial de eventos operativos.
CREATE TABLE IF NOT EXISTS preparacion_reconciliaciones (
  preparacion_id INTEGER PRIMARY KEY,
  intentado_en   TEXT NOT NULL,
  estado_remoto  TEXT,
  error          TEXT
);

CREATE INDEX IF NOT EXISTS idx_preparacion_reconciliaciones_intento
  ON preparacion_reconciliaciones(intentado_en);
