-- Fase E-3 (spec 2026-10-11-fase-e-webhooks-design.md, "Recuperación y medición"): control MEDIDO. Tres métricas por separado.
--
-- 1) Entregas fallidas: cada ronda horaria de ML `missed_feeds` deja una fila por tópico con lo enumerado y lo reinyectado
--    (la alerta diaria suma estas filas).
CREATE TABLE IF NOT EXISTS missed_feeds_corridas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  inicio TEXT NOT NULL,
  fin TEXT NOT NULL,
  topic TEXT NOT NULL,
  enumerados INTEGER NOT NULL DEFAULT 0,   -- avisos distintos (por _id) que ML listó como no entregados
  nuevos INTEGER NOT NULL DEFAULT 0,       -- recibos que NO teníamos y se reinyectaron al flujo durable
  duplicados INTEGER NOT NULL DEFAULT 0,   -- ya teníamos el recibo (idempotente: no se vuelve a procesar)
  excluidos INTEGER NOT NULL DEFAULT 0,    -- de otra cuenta, sin _id o con recurso ilegible
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_missed_feeds_corridas_fin ON missed_feeds_corridas(fin);

-- 3) Diferencias del barrido: cada corrida de un barrido (stock WC→ML, reconciliación de stock ML, refresco ML) registra cuántas
--    claves revisó, cuántas encontró distintas y cuántas de esas NO tuvieron un job cerrado en la ventana previa ("sin evento").
CREATE TABLE IF NOT EXISTS barrido_corridas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  proceso TEXT NOT NULL,
  inicio TEXT NOT NULL,
  fin TEXT NOT NULL,
  revisados INTEGER NOT NULL DEFAULT 0,
  diferencias INTEGER NOT NULL DEFAULT 0,
  diferencias_sin_evento INTEGER NOT NULL DEFAULT 0,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_barrido_corridas_proceso_fin ON barrido_corridas(proceso, fin);

-- Estado por barrido de la regla "umbral 2 días seguidos → vuelve a su frecuencia anterior". En E-3 solo se REGISTRA (`revertir`);
-- ninguna frecuencia se baja ni se sube: queda preparado para E-5.
CREATE TABLE IF NOT EXISTS barrido_estado (
  proceso TEXT PRIMARY KEY,
  dias_sobre_umbral INTEGER NOT NULL DEFAULT 0,
  ultimo_dia TEXT,
  revertir INTEGER NOT NULL DEFAULT 0,
  actualizado_en TEXT NOT NULL
);
