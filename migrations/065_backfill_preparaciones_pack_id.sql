-- Completa packs existentes desde la cache sin modificar el estado operativo.
UPDATE preparaciones
SET pack_id = COALESCE(NULLIF((SELECT pc.pack_id FROM pedidos_cache pc WHERE pc.clave = preparaciones.clave), ''), pack_id)
WHERE canal = 'ml'
  AND EXISTS (SELECT 1 FROM pedidos_cache pc WHERE pc.clave = preparaciones.clave AND NULLIF(pc.pack_id, '') IS NOT NULL);
