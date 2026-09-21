-- 0019 — casos que cuelgan de un MODELO (`identity_cases.model_id`), para la clasificación en el árbol (D23–D25).
--
-- Por qué el caso cuelga del modelo y NO de «una» de sus publicaciones. `identity_cases` exige un objeto
-- (variant_id o representation_id) y su unicidad es (representation_id, tipo, …). Un desacuerdo de categorías es
-- del MODELO, no de una publicación. Colgarlo de una publicación elegida (la de menor id, por ejemplo) rompe la
-- idempotencia justo en su camino de recuperación: si esa publicación se archiva y la corrida siguiente lo
-- «reabre desde otra», para el índice es OTRA representación, no hay conflicto, y queda un segundo caso abierto
-- para el mismo modelo. Por eso el objeto nuevo es `model_id`, con su propio índice único parcial. Si alguien la
-- quiere «simplificar» colgándolo de una representación, esta es la razón por la que no se puede.
--
-- Esto es lo que pedía el comentario final de la 0015: los tipos de caso de taxonomía se agregan «con su objeto
-- pensado y con el código que los abre en el mismo cambio». Los tres tipos nuevos:
--   categoria_en_desacuerdo         (D23) los canales ponen el modelo en nodos distintos que no son padre e hijo:
--                                   el modelo queda SIN primaria hasta que una persona decida.
--   categoria_sin_mapeo             ninguna categoría del modelo llega al árbol (`detalle.razon` = `sin_categoria`
--                                   o `categoria_no_mapeada`: el arreglo es distinto en cada caso).
--   categoria_persona_contradicha   (D24) el canal cambió contra una clasificación de origen `persona`. Nada lo abre
--                                   todavía: se declara ahora para no migrar de nuevo cuando la ingestión lo necesite.
--
-- `ADD COLUMN ... NULL` sin default es sólo metadata: no reescribe la tabla.
SET lock_timeout = '5s';

ALTER TABLE catalog.identity_cases
  ADD COLUMN model_id uuid REFERENCES catalog.product_models(id) ON DELETE RESTRICT;

-- Antes de reemplazar el CHECK se comprueba que lo que ya hay lo cumple (un CHECK que no valida es una bomba a plazo).
DO $$
DECLARE malas bigint;
BEGIN
  SELECT count(*) INTO malas FROM catalog.identity_cases
   WHERE tipo NOT IN ('sku_pendiente', 'omitida_revisar', 'sku_inexistente_en_woo', 'woo_sin_sku',
                      'woo_sku_duplicado', 'woo_sku_no_canonico', 'decision_en_conflicto', 'identidad_legado',
                      'user_product_divergente', 'atributo_divergente');
  IF malas > 0 THEN RAISE EXCEPTION 'identity_cases tiene % filas con un tipo que el CHECK nuevo rechaza', malas; END IF;
END;
$$;

ALTER TABLE catalog.identity_cases DROP CONSTRAINT identity_cases_tipo_check;
ALTER TABLE catalog.identity_cases ADD CONSTRAINT identity_cases_tipo_check CHECK (tipo IN (
  'sku_pendiente', 'omitida_revisar', 'sku_inexistente_en_woo', 'woo_sin_sku',
  'woo_sku_duplicado', 'woo_sku_no_canonico', 'decision_en_conflicto', 'identidad_legado',
  'user_product_divergente', 'atributo_divergente',
  'categoria_en_desacuerdo', 'categoria_sin_mapeo', 'categoria_persona_contradicha'));

ALTER TABLE catalog.identity_cases DROP CONSTRAINT identity_cases_objeto_check;
ALTER TABLE catalog.identity_cases ADD CONSTRAINT identity_cases_objeto_check
  CHECK (variant_id IS NOT NULL OR representation_id IS NOT NULL OR model_id IS NOT NULL);

-- Un caso abierto por modelo y tipo. Cerrado, puede volver a abrirse.
CREATE UNIQUE INDEX identity_cases_un_abierto_modelo
  ON catalog.identity_cases (model_id, tipo) WHERE cerrado_en IS NULL AND model_id IS NOT NULL;

-- Mismo criterio que 0018: `product_models` no tiene UNIQUE (company_id, id) para una FK compuesta.
CREATE FUNCTION catalog.identity_cases_modelo_misma_empresa() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.model_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM catalog.product_models WHERE id = NEW.model_id AND company_id = NEW.company_id) THEN
    RAISE EXCEPTION 'el modelo % no es de la empresa %', NEW.model_id, NEW.company_id;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER identity_cases_modelo_misma_empresa BEFORE INSERT OR UPDATE OF model_id, company_id ON catalog.identity_cases
  FOR EACH ROW EXECUTE FUNCTION catalog.identity_cases_modelo_misma_empresa();
