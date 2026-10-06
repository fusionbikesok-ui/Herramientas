-- Sistema de incidentes operativos: registro persistente de fallos de integración (ML/Woo)
-- para que un administrador no dependa de mirar logs de PM2 en vivo. Ver lib/incidentes.js.
--
-- clave_dedupe = `${integracion}|${proceso}|${tipo_error}`. El índice único es PARCIAL
-- (solo estado='activo'): un solo incidente activo por clave a la vez, pero se permiten
-- múltiples episodios históricos resueltos con la misma clave (reincidencias reales).
CREATE TABLE IF NOT EXISTS incidentes_operativos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  integracion TEXT NOT NULL,
  proceso TEXT NOT NULL,
  tipo_error TEXT NOT NULL,
  clave_dedupe TEXT NOT NULL,
  severidad TEXT NOT NULL,
  estado TEXT NOT NULL,
  mensaje_tecnico TEXT,
  mensaje_humano TEXT NOT NULL,
  contexto_json TEXT,
  contador_repeticiones INTEGER NOT NULL DEFAULT 1,
  primera_deteccion_en TEXT NOT NULL,
  ultima_deteccion_en TEXT NOT NULL,
  ultima_recuperacion_en TEXT,
  resuelto_en TEXT,
  creado_en TEXT NOT NULL,
  actualizado_en TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_incidentes_dedupe_activo
  ON incidentes_operativos(clave_dedupe) WHERE estado = 'activo';
CREATE INDEX IF NOT EXISTS idx_incidentes_estado_fecha ON incidentes_operativos(estado, ultima_deteccion_en DESC);
CREATE INDEX IF NOT EXISTS idx_incidentes_integracion ON incidentes_operativos(integracion, proceso);
