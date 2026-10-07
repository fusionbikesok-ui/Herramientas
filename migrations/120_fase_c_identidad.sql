-- Fase C: una sola protección (Identidad). Spec: docs/superpowers/specs/2026-10-07-fase-c-una-proteccion.md
-- Aditiva e idempotente. No cambia ninguna clasificación: `identidad_casos.clasificacion` es TEXT libre (sin CHECK) y
-- los casos que frenan por R4 son los que auditarIdentidadProductos ya abre.

-- Consultas por clave y estado: las hacen la CTE del sync, la retención de pedidos y frenaIdentidad.
CREATE INDEX IF NOT EXISTS idx_identidad_casos_clave_estado ON identidad_casos(ml_key, estado);

-- R1 (José: «son links de pago, descartar»): una clave con decisión `omitir` no se sincroniza, no abre casos y no
-- cuenta como «sin cobertura». Se cierran los casos de Guardia que quedaron abiertos sobre esas claves. Primero el
-- evento (mientras el caso sigue abierto, así la consulta es la misma) y después el cierre.
INSERT INTO guardia_ml_eventos (caso_id, evento, actor, detalle_json, creado_en)
SELECT g.id, 'cerrado_omitida_link_pago', 'migracion:120',
       json_object('motivo', 'omitida_link_pago', 'clave', g.clave, 'estado_previo', g.estado, 'bloqueaba_sync', g.bloquea_sync),
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM guardia_ml_casos g
WHERE g.estado <> 'resuelto'
  AND g.clave IN (SELECT clave FROM sku_matcher_decisiones WHERE accion = 'omitir');

UPDATE guardia_ml_casos
SET estado = 'resuelto', bloquea_sync = 0, expected_version = expected_version + 1,
    resuelto_en = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), actualizado_en = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE estado <> 'resuelto'
  AND clave IN (SELECT clave FROM sku_matcher_decisiones WHERE accion = 'omitir');
