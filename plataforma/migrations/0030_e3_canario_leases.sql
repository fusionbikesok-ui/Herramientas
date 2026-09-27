-- 0030 — E3 segunda opinión: leases por ejecución y fencing token.
-- Patrón: compare-and-swap con token de fencing para que un lease vencido no pueda
-- sobrescribir el resultado de quien lo reemplazó (Martin Kleppmann, "How to do distributed locking").
SET lock_timeout = '5s';

DO $$
DECLARE v_conname text;
BEGIN
  SELECT conname INTO v_conname
    FROM pg_constraint
   WHERE conrelid = 'catalog.e3_canario_casos'::regclass
     AND contype = 'c'
     AND pg_get_constraintdef(oid) LIKE '%estado%pendiente%parked%';
  IF v_conname IS NULL THEN
    RAISE EXCEPTION '0030: no se encontró el CHECK de estado de catalog.e3_canario_casos';
  END IF;
  EXECUTE format('ALTER TABLE catalog.e3_canario_casos DROP CONSTRAINT %I', v_conname);
END $$;

ALTER TABLE catalog.e3_canario_casos
  ADD COLUMN fencing_token bigint NOT NULL DEFAULT 0,
  ADD CONSTRAINT e3_canario_casos_fencing_token_check CHECK (fencing_token >= 0),
  ADD CONSTRAINT e3_canario_casos_estado_check CHECK (estado IN
    ('pendiente','en_proceso','vinculado','bandeja','intervention','parked','ya_resuelto'));

CREATE INDEX e3_canario_casos_leases_vivos
  ON catalog.e3_canario_casos (corrida_id, tomado_hasta)
  WHERE tomado_por IS NOT NULL AND tomado_hasta IS NOT NULL;
