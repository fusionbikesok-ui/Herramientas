-- E1 T3 · corte C1: ciclo de vida de la copia de sombra sobre integration_events.
--
-- Por qué acá y no en una tabla nueva (decisión de José, 2026-09-16, al revisar el diseño de T3):
-- el recibo que la sombra necesitaba ya existe. registrarWebhookMl y registrarWebhookWooProducto
-- (lib/workerIntegrationJobs.js) persisten ANTES del ACK, en una transacción, con canal, tópico,
-- recurso normalizado, fingerprint, delivery id, tiempos, correlación, dedupe y estado. Una tabla
-- paralela habría duplicado esa identidad y duplicado las escrituras por aviso —hoy ~1.400 por día—
-- en la base que atiende producción. Acá sólo se agrega el ciclo de vida de la copia.
--
-- Las columnas son nulables a propósito: un evento anterior a T3, o un aviso que nunca se intenta
-- copiar, las deja en NULL. Ninguna lleva CHECK porque SQLite no puede agregar restricciones a una
-- tabla existente sin reconstruirla, y reconstruir una tabla caliente de producción no vale el
-- riesgo. Los valores válidos los impone el módulo de sombra (corte C2) y los prueba su test:
--   shadow_status: pending | queued | attempting | copied | discarded | excluded | abandoned
--   shadow_reason: unsupported_topic | foreign_account | queue_full | platform_timeout |
--                  platform_unavailable | invalid_resource | process_stopped | response_not_finished
--
-- Las columnas se agregan desde db/index.js (PRAGMA table_info + ALTER de las que falten) para que
-- una aplicación parcial se complete sola. Este archivo crea los índices, que son idempotentes.

-- Señales activas: lo que el watchdog y la métrica de cola miran.
CREATE INDEX IF NOT EXISTS idx_integration_events_sombra_activa
  ON integration_events(shadow_status, received_at)
  WHERE shadow_status IN ('pending', 'queued', 'attempting');

-- Purga de 400 días: sólo alcanza filas con la sombra terminada y el trabajo legacy cerrado, para no
-- truncar el historial de un evento en curso. Es la primera retención sobre esta tabla.
CREATE INDEX IF NOT EXISTS idx_integration_events_sombra_purga
  ON integration_events(received_at)
  WHERE shadow_status IN ('copied', 'discarded', 'excluded', 'abandoned');

-- Descartes por plataforma caída todavía sin importar: el contador durable que E1-PGDOWN-01 exige
-- fuera de PostgreSQL, y que se importa con auditoría cuando PostgreSQL vuelve.
CREATE INDEX IF NOT EXISTS idx_integration_events_sombra_import
  ON integration_events(received_at)
  WHERE shadow_status = 'discarded' AND shadow_imported_at IS NULL;
