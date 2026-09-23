CREATE TABLE IF NOT EXISTS recepcion_conciliaciones_stock (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  recepcion_item_id INTEGER NOT NULL REFERENCES recepcion_items(id) ON DELETE CASCADE,
  tipo TEXT NOT NULL CHECK (tipo IN ('conciliar_incierta', 'resolver_conflicto')),
  decision TEXT CHECK (decision IN ('aceptar_woo', 'reintentar')),
  motivo TEXT,
  stock_leido INTEGER,
  estado_resultante TEXT NOT NULL,
  actor TEXT NOT NULL,
  creado_en TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS recepcion_conciliaciones_stock_item_idx ON recepcion_conciliaciones_stock(recepcion_item_id);
CREATE INDEX IF NOT EXISTS recepcion_conciliaciones_stock_creado_idx ON recepcion_conciliaciones_stock(creado_en);
