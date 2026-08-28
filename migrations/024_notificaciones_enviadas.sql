-- Hito 7: Log de notificaciones enviadas.
--
-- Registra cada intento de envío de notificación push — permite tracking,
-- reintentos en caso de fallo, y deduplicación (ej. no reenviar "incidente nuevo"
-- dos veces para el mismo incidente).
--
-- Campos:
-- - device_token_id: dispositivo al que se intentó enviar (permite asociar con el token actual)
-- - tipo: categoría de notificación ('nuevo', 'reaviso', 'resuelto', etc.)
-- - incidente_id: referencia al incidente que generó esta notificación (nullable,
--   para futuros tipos de notificación no ligadas a incidentes)
-- - estado: 'enviado' (éxito en el proveedor), 'fallido' (error al intentar), 'pendiente' (en cola)
-- - intentos: número de reintentos ejecutados (para backoff creciente)
-- - error: mensaje de error si estado='fallido', null si enviado
-- - creado_en: timestamp de creación del registro
--
-- Índices:
-- - Deduplicación: UNIQUE en (device_token_id, tipo, incidente_id) con filtro tipo!='reaviso'
--   → evita dos notificaciones 'nuevo' para el mismo incidente
--   → permite múltiples 'reaviso' (que son excepciones intencionales)
-- - Búsqueda de pendientes/fallidos para reintentos: device_token_id, estado, creado_en
CREATE TABLE IF NOT EXISTS notificaciones_enviadas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_token_id INTEGER NOT NULL REFERENCES device_tokens(id) ON DELETE CASCADE,
  tipo TEXT NOT NULL,
  incidente_id INTEGER REFERENCES incidentes_operativos(id) ON DELETE SET NULL,
  estado TEXT NOT NULL CHECK(estado IN ('pendiente', 'enviado', 'fallido')),
  intentos INTEGER NOT NULL DEFAULT 1,
  error TEXT,
  creado_en TEXT NOT NULL
);

-- Deduplicación: previene 'nuevo'/'resuelto' duplicadas para el mismo incidente
-- (excepción: 'reaviso' se permite repetir)
CREATE UNIQUE INDEX IF NOT EXISTS idx_notificaciones_dedupe
  ON notificaciones_enviadas(device_token_id, tipo, incidente_id)
  WHERE tipo IN ('nuevo', 'resuelto');

-- Búsqueda rápida de notificaciones pendientes/fallidas para reintentos
CREATE INDEX IF NOT EXISTS idx_notificaciones_pendientes
  ON notificaciones_enviadas(device_token_id, estado, creado_en)
  WHERE estado IN ('pendiente', 'fallido');
