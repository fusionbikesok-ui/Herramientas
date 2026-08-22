-- Completa pack_id en preparaciones ya existentes usando el snapshot durable de
-- pedidos_cache. 019 y 020 deben haberse aplicado antes: esta migracion no agrega ni
-- recrea columnas y no altera estado, items, fechas ni autoria de una preparacion.
--
-- COALESCE/NULLIF evita borrar un pack ya conocido cuando la cache vieja no tenia dato.
UPDATE preparaciones
SET pack_id = COALESCE(
  NULLIF((SELECT pc.pack_id FROM pedidos_cache pc WHERE pc.clave = preparaciones.clave), ''),
  pack_id
)
WHERE canal = 'ml'
  AND EXISTS (
    SELECT 1 FROM pedidos_cache pc
    WHERE pc.clave = preparaciones.clave
      AND NULLIF(pc.pack_id, '') IS NOT NULL
  );
