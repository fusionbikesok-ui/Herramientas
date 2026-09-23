ALTER TABLE recepcion_altas_woo ADD COLUMN recepcion_id INTEGER REFERENCES recepciones(id);
ALTER TABLE recepcion_altas_woo ADD COLUMN recepcion_item_id INTEGER REFERENCES recepcion_items(id);

CREATE INDEX IF NOT EXISTS recepcion_altas_woo_recepcion_idx ON recepcion_altas_woo(recepcion_id);
CREATE INDEX IF NOT EXISTS recepcion_altas_woo_item_idx ON recepcion_altas_woo(recepcion_item_id);
