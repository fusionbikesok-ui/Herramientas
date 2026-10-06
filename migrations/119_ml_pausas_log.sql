-- Quién pausó una publicación en ML y desde dónde. Sólo agrega filas: sirve para explicar, en la lista de
-- "Pausadas con stock en Woo", si la pausa fue del vigía, de una persona desde esta app, etc. Una pausa hecha
-- directamente en MercadoLibre no pasa por acá (se reconoce por paused_by_seller sin fila en este log).
CREATE TABLE IF NOT EXISTS ml_pausas_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id TEXT NOT NULL,
  actor TEXT NOT NULL,
  origen TEXT NOT NULL,
  detalle TEXT,
  creado_en TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ml_pausas_log_item ON ml_pausas_log(item_id, id);
