-- Fase E-1b (spec 2026-10-11-fase-e-webhooks-design.md, fila order.woo): SKUs de cada orden Woo, para TODA orden.
-- Se reemplaza solo al cerrar el trabajo `order.woo` verificado, en la misma transacción que el cierre y condicionado a que
-- la generación tomada siga vigente. Sirve para la UNIÓN (conjunto persistido ∪ actual): una orden editada o enviada a la
-- papelera libera el stock de las líneas que ya no están.
CREATE TABLE IF NOT EXISTS woo_orden_skus (
  order_id TEXT PRIMARY KEY,
  skus_json TEXT NOT NULL,
  actualizado_en TEXT NOT NULL
);
