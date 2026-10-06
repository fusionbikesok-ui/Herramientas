-- Métricas de ciclo de sync (Hito 3/4 del plan de confiabilidad operativa): una fila por
-- corrida completa de un ciclo de sync (refresco de catálogo Woo, refresco de publicaciones
-- ML, etc.), compartida entre integraciones. Complementa el estado en memoria de "hay una
-- corrida en curso ahora" que cada módulo ya trackea (no lo reemplaza). Ver routes/woo.js.
CREATE TABLE IF NOT EXISTS metricas_ciclo_sync (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  integracion TEXT NOT NULL,
  proceso TEXT NOT NULL,
  iniciado_en TEXT NOT NULL,
  finalizado_en TEXT,
  duracion_ms INTEGER,
  procesados INTEGER NOT NULL DEFAULT 0,
  fallidos INTEGER NOT NULL DEFAULT 0,
  reintentados INTEGER NOT NULL DEFAULT 0,
  circuito_abierto INTEGER NOT NULL DEFAULT 0,
  creado_en TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_metricas_ciclo_integracion ON metricas_ciclo_sync(integracion, proceso, iniciado_en);
