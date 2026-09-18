-- E1 T4 · 2026-09-18: marca de "objeto oculto en B2".
-- Verificado contra B2 real: la credencial de escritura PUEDE hacer un DELETE, porque en B2 el permiso de
-- escritura incluye ocultar. En un bucket con versionado eso no destruye nada —la versión retenida sigue ahí y
-- se recupera pidiéndola por su id— pero un cliente normal recibe 404, así que la evidencia deja de estar a la
-- vista. No se puede prevenir con permisos: se detecta. La vuelta diaria marca acá lo que encuentra oculto, la
-- ruta interna lo expone y el vigilante del legado lo convierte en alerta.
ALTER TABLE informes.entregas
  ADD COLUMN oculto_en timestamptz,
  ADD COLUMN oculto_version_retenida text;

CREATE INDEX entregas_ocultas ON informes.entregas (fecha) WHERE oculto_en IS NOT NULL;
