-- Preparación: confirmar envío vs. facturación cuando difieren + mostrar la nota del
-- pedido (plan de Preparación, Fases 2 y 3, 2026-08-26).
--
-- direccion_confirmada_fuente/_por/_en (preparaciones): cuando envío y facturación de un
-- pedido difieren de verdad (direccionesDifieren() en lib/preparacion.js), POST /iniciar
-- frena con 409 hasta que el operario elige cuál usar. La elección se guarda acá para no
-- volver a preguntar en la misma preparación, y GET /etiquetas + /seguimientos la usan en
-- vez de la regla automática de normalizarEnvio (envío si tiene address_1, si no
-- facturación).
--
-- customer_note (pedidos_cache): antes solo se veía en la pestaña Etiquetas Andreani (que
-- la pide en vivo a Woo). Se cachea acá para que GET /pendientes la muestre sin ida y
-- vuelta extra a Woo. ML no expone un campo equivalente en su API de orders (confirmado
-- contra un pedido real el 2026-08-26) — queda '' para esas filas.
ALTER TABLE preparaciones ADD COLUMN direccion_confirmada_fuente TEXT;
ALTER TABLE preparaciones ADD COLUMN direccion_confirmada_por TEXT;
ALTER TABLE preparaciones ADD COLUMN direccion_confirmada_en TEXT;
ALTER TABLE pedidos_cache ADD COLUMN customer_note TEXT NOT NULL DEFAULT '';
