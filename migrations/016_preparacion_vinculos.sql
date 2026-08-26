-- Preparación: detección y confirmación de pedidos del mismo comprador (Fase 4,
-- 2026-08-26).
--
-- preparacion_vinculos: cuando un comprador tiene 2+ pedidos sin despachar, se
-- propone unificarlos en un paquete o marcarlos como vinculados (sin tocar
-- WooCommerce — es una nota interna). Los campos:
--   - pedido_a_clave/pedido_b_clave: formato 'web:<id>' o 'ml:<id>' (mismo patrón
--     que preparaciones.clave)
--   - campo_match: 'dni', 'email', 'telefono', 'nombre_direccion' (cuál coincidió)
--   - estado: 'sugerido', 'confirmado_junto', 'confirmado_separado_pero_vinculado',
--     'rechazado' (evoluciona según la decisión del operario)
--   - un_solo_paquete: 1 si estado='confirmado_junto' e irá en una sola caja
--   - decidido_por/decidido_en: quién y cuándo tomó la decisión
--
-- Índice único sobre el par normalizado (siempre ordenado alfabéticamente) para
-- evitar duplicar la misma sugerencia si llegan los pedidos en distinto orden.
CREATE TABLE IF NOT EXISTS preparacion_vinculos (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  pedido_a_clave        TEXT NOT NULL,
  pedido_b_clave        TEXT NOT NULL,
  campo_match           TEXT NOT NULL,
  estado                TEXT NOT NULL DEFAULT 'sugerido',
  un_solo_paquete       INTEGER NOT NULL DEFAULT 0,
  decidido_por          TEXT,
  decidido_en           TEXT,
  creado_en             TEXT NOT NULL,
  UNIQUE (pedido_a_clave, pedido_b_clave)
);

CREATE INDEX IF NOT EXISTS idx_preparacion_vinculos_claves
  ON preparacion_vinculos(pedido_a_clave, pedido_b_clave);
