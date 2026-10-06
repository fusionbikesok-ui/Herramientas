-- 0018 — facetas de un modelo decididas por NOSOTROS (`catalog.model_facets`).
--
-- Por qué NO es un `model_attributes` más. `model_attributes` cuelga cada valor de una PUBLICACIÓN de un canal
-- (`representation_id NOT NULL`) y su ciclo de vida es «el canal lo afirma / dejó de afirmarlo»:
--   UPDATE catalog.model_attributes m SET vigente_hasta = now()
--    WHERE m.representation_id = $1 AND m.vigente_hasta IS NULL
--      AND NOT EXISTS (SELECT 1 FROM unnest($2::text[], $3::text[]) AS u(n, v)
--                       WHERE u.n = m.nombre_normalizado AND u.v = m.valor)
-- (`persistirExtras`, src/catalogo/aplicar.ts). Esa consulta cierra TODO atributo vigente de la publicación que
-- el canal no repitió en su última lectura, sin mirar el nombre. Un dato derivado por nosotros colgado ahí (por
-- ejemplo «este modelo es infantil») lo cierra la siguiente ingestión, sin ningún error, y además ninguna
-- columna lo distingue de uno observado. Tocar esa consulta para que respete lo derivado es cambiar el camino
-- por el que pasa todo el catálogo. Por eso la faceta vive en una tabla propia, a nivel de MODELO, con el
-- origen y el motivo escritos, que ninguna ingestión toca. Si alguien la quiere «simplificar» metiéndola en
-- `model_attributes`, esta es la razón por la que no se puede.
--
-- Forward-only como todo `catalog`: `plataforma_app` no tiene DELETE. Cambiar el valor cierra la fila
-- (`vigente_hasta`) y abre otra, así queda la historia. Una faceta con un solo valor vigente por modelo.
SET lock_timeout = '5s';
CREATE TABLE catalog.model_facets (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id   uuid NOT NULL REFERENCES core.companies(id) ON DELETE RESTRICT,
  model_id     uuid NOT NULL REFERENCES catalog.product_models(id) ON DELETE RESTRICT,
  faceta       text NOT NULL CHECK (faceta ~ '^[a-z][a-z0-9_]*$'),
  valor        text NOT NULL CHECK (length(btrim(valor)) > 0),
  origen       text NOT NULL CHECK (origen IN ('regla_categoria', 'persona')),
  motivo       text NOT NULL CHECK (length(btrim(motivo)) > 0),
  decidido_por text NOT NULL CHECK (length(btrim(decidido_por)) > 0),
  decidido_en  timestamptz NOT NULL DEFAULT now(),
  vigente_hasta timestamptz
);
CREATE UNIQUE INDEX model_facets_un_vigente
  ON catalog.model_facets (company_id, model_id, faceta) WHERE vigente_hasta IS NULL;
CREATE INDEX model_facets_faceta_valor
  ON catalog.model_facets (company_id, faceta, valor) WHERE vigente_hasta IS NULL;

-- El modelo tiene que ser de la misma empresa: `product_models` no tiene UNIQUE (company_id, id) para una FK
-- compuesta, y una faceta de otra empresa nunca es un dato válido.
CREATE FUNCTION catalog.model_facets_misma_empresa() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM catalog.product_models WHERE id = NEW.model_id AND company_id = NEW.company_id) THEN
    RAISE EXCEPTION 'el modelo % no es de la empresa %', NEW.model_id, NEW.company_id;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER model_facets_misma_empresa BEFORE INSERT ON catalog.model_facets
  FOR EACH ROW EXECUTE FUNCTION catalog.model_facets_misma_empresa();
