-- Cadencia adaptativa del scan completo de ML, gobernada por evidencia de cobertura del
-- webhook `items` y no por calendario.
--
-- El scan corría fijo cada 15 minutos y era la única forma de enterarse de un cambio en ML.
-- Con el webhook de `items` proyectando, la mayoría de los cambios llegan en segundos y el
-- scan pasa a ser red de reconciliación. Pero relajar su cadencia sólo se justifica si el
-- webhook DEMUESTRA que cubre: cada vez que el scan encuentra un cambio que ningún webhook
-- anunció, la cobertura falló y hay que volver atrás.
CREATE TABLE IF NOT EXISTS ml_scan_ramp (
  id                INTEGER PRIMARY KEY CHECK (id = 1),
  intervalo_min     INTEGER NOT NULL DEFAULT 15,
  frescura_min      INTEGER NOT NULL DEFAULT 60,
  corridas_limpias  INTEGER NOT NULL DEFAULT 0,
  congelado         INTEGER NOT NULL DEFAULT 0 CHECK (congelado IN (0,1)),
  motivo            TEXT,
  ultimo_scan_en    TEXT,
  ultimo_cambio_en  TEXT,
  actualizado_en    TEXT NOT NULL
);
INSERT OR IGNORE INTO ml_scan_ramp (id, actualizado_en) VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ','now'));

-- Huella de identidad/stock por clave, tomada al final de cada scan. Comparar la huella nueva
-- contra la anterior es lo que permite saber QUÉ cambió sin diffear en el camino caliente de
-- un scan que recorre 6894 filas.
CREATE TABLE IF NOT EXISTS ml_scan_huella (
  clave      TEXT PRIMARY KEY,
  huella     TEXT NOT NULL,
  visto_en   TEXT NOT NULL
);
