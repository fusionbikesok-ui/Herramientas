-- Qué cambió en una publicación de ML, campo por campo.
--
-- Hasta ahora se registraba QUE llegó un aviso (`integration_events`) pero no QUÉ cambió, así
-- que preguntas operativas básicas no tenían respuesta: ¿con qué frecuencia ML nos cambia un
-- precio por su cuenta? ¿cuántas veces nos pausa una publicación y por qué? ¿alguien edita el
-- SELLER_SKU a mano en ML, por fuera de la herramienta? ¿el stock se mueve sin que haya venta?
--
-- Esa última pregunta dejó de ser teórica el 2026-09-05: dos publicaciones que comparten un
-- `user_product` se pisan la cantidad mutuamente, y el único síntoma era un bucle de
-- reconciliación que nadie miraba.
--
-- Es captura, no acción: nadie decide nada con esta tabla todavía.
CREATE TABLE IF NOT EXISTS ml_cambios_observados (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  clave         TEXT NOT NULL,
  item_id       TEXT NOT NULL,
  campo         TEXT NOT NULL,
  antes         TEXT,
  despues       TEXT,
  origen        TEXT NOT NULL CHECK (origen IN ('webhook','scan')),
  detectado_en  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ml_cambios_clave ON ml_cambios_observados(clave, detectado_en);
CREATE INDEX IF NOT EXISTS idx_ml_cambios_campo ON ml_cambios_observados(campo, detectado_en);
