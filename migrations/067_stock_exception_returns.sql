-- E18: recepción y clasificación de devoluciones. Solo estado local; no toca Woo.
ALTER TABLE stock_incidents ADD COLUMN clasificacion TEXT CHECK (clasificacion IS NULL OR clasificacion IN ('disponible','no_disponible','condicionado'));
ALTER TABLE stock_incidents ADD COLUMN recibido_por TEXT;
ALTER TABLE stock_incidents ADD COLUMN recibido_en TEXT;
ALTER TABLE stock_incidents ADD COLUMN producto_estado TEXT;
ALTER TABLE stock_incidents ADD COLUMN inspeccion_task_id INTEGER REFERENCES stock_tasks(id);
ALTER TABLE stock_incidents ADD COLUMN dañado_en TEXT;
