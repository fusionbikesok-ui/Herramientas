-- Migración 112: Convertir estado 'error' a 'error_historico'
-- P0.1 (rows de historia): cualquier 'error' de la implementación previa (GET→PATCH→UPDATE sin
-- verificación) es de historia ambigua — puede representar un PATCH que sí llegó a aplicarse.
-- Se convierte a 'error_historico' (estado terminal de solo lectura) en vez de 'operacion_incierta'
-- para evitar que filas antiguas contaminen la cola de conciliación viva. Se conserva error_wc
-- como evidencia. Verificado en data/fusion.sqlite el 2026-09-21: 0 filas en 'error' en producción
-- hoy — esta migración es no-op ahí.

UPDATE recepcion_items SET estado_item='error_historico' WHERE estado_item='error';
