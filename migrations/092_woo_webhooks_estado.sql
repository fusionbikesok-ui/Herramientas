-- Estado de los webhooks de WooCommerce.
--
-- Woo desactiva un webhook por su cuenta tras varias entregas fallidas, y lo hace en silencio:
-- deja de mandar eventos y nada avisa. Al implementar esto (2026-09-06) se encontró que
-- `order.updated` ya estaba `disabled` en producción, sin que nadie lo supiera.
--
-- Se guarda el estado observado y desde cuándo, para poder distinguir "se cayó recién" de
-- "lleva días caído", que es lo que decide si hubo pérdida de eventos.
CREATE TABLE IF NOT EXISTS woo_webhooks_estado (
  id INTEGER PRIMARY KEY,
  topic TEXT NOT NULL,
  status TEXT NOT NULL,
  delivery_url TEXT,
  -- Sólo interesan los nuestros: la tienda tiene webhooks de terceros que no administramos y
  -- cuyo estado no es asunto de esta herramienta.
  propio INTEGER NOT NULL DEFAULT 0,
  visto_en TEXT NOT NULL,
  status_desde TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_woo_webhooks_status ON woo_webhooks_estado(propio, status);
