-- Etiquetas en Preparación (spec 2026-10-15-etiquetas-preparacion-design.md).
-- Las columnas nuevas de `preparaciones` (etiqueta_cargada_en, etiqueta_origen, envio_confirmado_en, envio_descartado_*), los índices, los triggers
-- de despacho_controles y los backfills viven en lib/etiquetasPreparacion.js: esa tabla la crea ensureTables y puede no existir todavía al abrir la base.

-- «PDF bajado», NO «impresa»: registro de cada descarga de etiqueta ML desde la herramienta.
CREATE TABLE IF NOT EXISTS etiquetas_ml_descargas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  clave TEXT NOT NULL,
  shipment_id TEXT NOT NULL,
  usuario TEXT,
  descargado_en TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_etiquetas_ml_descargas_clave ON etiquetas_ml_descargas(clave, descargado_en);
