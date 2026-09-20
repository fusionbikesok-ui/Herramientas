-- E2 T2 · tarea 1: dónde vive lo que el canal ya nos dio y el proyector de T1 descartaba (atributos,
-- imágenes, precio, stock, GTIN). Diseño: docs/superpowers/specs/2026-09-20-e2-tramo2-atributos-imagenes-design.md.
--
-- Tres decisiones que no se deben "simplificar":
--   1. Lo comercial va en la REPRESENTACIÓN, no en la variante: una variante puede estar en Woo y en ML a
--      la vez (2.093 lo están) y con columnas en la variante cada canal pisaría el precio del otro.
--   2. La procedencia es `representation_id`, no `canal`: un canal puede tener varias publicaciones del
--      mismo modelo. El canal se obtiene por join.
--   3. `vigente_hasta` en vez de borrar: `plataforma_app` no tiene DELETE en `catalog`.
--
-- Las columnas nuevas son nullable y sin default: las filas que ya existen no las tienen.
-- Los GRANT no hacen falta: 0013 dejó ALTER DEFAULT PRIVILEGES en `catalog` (SELECT, INSERT, UPDATE).
SET lock_timeout = '5s';

ALTER TABLE catalog.external_representations
  ADD COLUMN atributos_crudos jsonb,
  ADD COLUMN comercial_crudo  jsonb,
  ADD COLUMN capturado_en     timestamptz,
  ADD COLUMN precio           numeric(12,2),
  ADD COLUMN moneda           text,
  ADD COLUMN stock_canal      integer,
  ADD COLUMN gtin             text;  -- evidencia, nunca autoridad: no casa identidades

CREATE TABLE catalog.model_attributes (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  model_id           uuid NOT NULL REFERENCES catalog.product_models(id) ON DELETE RESTRICT,
  representation_id  uuid NOT NULL REFERENCES catalog.external_representations(id) ON DELETE RESTRICT,
  nombre_normalizado text NOT NULL CHECK (length(nombre_normalizado) > 0),
  valor              text NOT NULL,
  observado_en       timestamptz NOT NULL,
  vigente_hasta      timestamptz,  -- NULL = vigente; con fecha = el canal dejó de afirmarlo
  CONSTRAINT model_attributes_un_valor UNIQUE (representation_id, nombre_normalizado, valor)
);
CREATE INDEX model_attributes_modelo ON catalog.model_attributes (model_id);
-- La consulta de aceptación ("qué cubiertas Maxxis tengo publicadas") busca por nombre y valor.
CREATE INDEX model_attributes_nombre_valor ON catalog.model_attributes (nombre_normalizado, valor);

CREATE TABLE catalog.model_images (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  model_id          uuid NOT NULL REFERENCES catalog.product_models(id) ON DELETE RESTRICT,
  representation_id uuid NOT NULL REFERENCES catalog.external_representations(id) ON DELETE RESTRICT,
  url               text NOT NULL CHECK (length(url) > 0),
  orden             integer,
  observado_en      timestamptz NOT NULL,
  vigente_hasta     timestamptz,
  CONSTRAINT model_images_una_url UNIQUE (representation_id, url)
);
CREATE INDEX model_images_modelo ON catalog.model_images (model_id);

-- Ampliar el CHECK de `tipo`: antes se comprueba que lo que ya hay lo cumple (un CHECK que no valida es
-- una bomba a plazo), y se reemplaza con los nueve valores de 0013 más el nuevo.
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
  'user_product_divergente',
  -- Dos canales afirman valores distintos para el mismo atributo de un modelo. Cuelga de la representación
  -- que introduce el valor. Se revisa, nunca se fusiona sola.
  'atributo_divergente'));
