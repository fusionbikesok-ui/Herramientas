-- 0025 — E3 corte 3, tarea 3: el auto-SKU puede APLICAR (canario o E3_AUTO_SKU). hash_payload_ml ya existe
-- desde 0020:38; acá se reemplaza el CHECK sin nombre de 0020:45 que hoy prohíbe auto_sku+aplicar, por uno
-- que además exige hash_payload_ml cuando efecto='aplicar' con origen='auto_sku' (evidencia de qué se releyó).
--
-- Esta migración es la "parte 2" que originalmente se agregó a mano, sin commitear, al final de
-- 0023_e3_canario.sql en el árbol de producción — se separó a un número propio porque 0023 ya estaba
-- aplicada en producción con 21 migraciones (editar una migración ya numerada hace que lo que se aplica
-- dependa del árbol desde donde se corra). No se enciende ni se aplica hasta que E1 esté aceptada (PM-187):
-- el CHECK nuevo sólo cambia qué se permite insertar, no inserta nada por sí solo ni depende de ninguna
-- variable de entorno — el gate real es que nada en el código todavía escribe efecto='aplicar' con
-- origen='auto_sku' hasta que ese trabajo de E3 se habilite explícitamente.
SET lock_timeout = '5s';
DO $$
DECLARE v_conname text; v_encontrados int;
BEGIN
  -- Hallazgo de la segunda opinión de Codex (2026-09-25): el filtro por ILIKE es amplio a propósito para no
  -- depender de un formato exacto de pg_get_constraintdef entre versiones de Postgres, pero por eso mismo
  -- podría matchear más de un CHECK. SELECT normal no lo detecta (toma cualquiera); se cuenta primero y se
  -- aborta si no da EXACTAMENTE uno, en vez de arriesgar borrar (o dejar de borrar) el CHECK equivocado.
  SELECT count(*) INTO v_encontrados
    FROM pg_constraint
   WHERE conrelid = 'catalog.identity_decisions'::regclass
     AND contype = 'c'
     AND pg_get_constraintdef(oid) ILIKE '%auto_sku%sombra%';
  IF v_encontrados = 0 THEN
    RAISE EXCEPTION '0025: no se encontró el CHECK de 0020:45 (origen<>auto_sku OR efecto=sombra) en catalog.identity_decisions; revisar antes de continuar';
  ELSIF v_encontrados > 1 THEN
    RAISE EXCEPTION '0025: % CHECK distintos matchean el patrón auto_sku/sombra en catalog.identity_decisions; ambiguo, revisar a mano antes de continuar', v_encontrados;
  END IF;
  SELECT conname INTO STRICT v_conname
    FROM pg_constraint
   WHERE conrelid = 'catalog.identity_decisions'::regclass
     AND contype = 'c'
     AND pg_get_constraintdef(oid) ILIKE '%auto_sku%sombra%';
  EXECUTE format('ALTER TABLE catalog.identity_decisions DROP CONSTRAINT %I', v_conname);
END $$;
ALTER TABLE catalog.identity_decisions ADD CONSTRAINT auto_sku_aplicar_con_hash
  CHECK (origen <> 'auto_sku' OR efecto = 'sombra' OR (efecto = 'aplicar' AND hash_payload_ml IS NOT NULL));
