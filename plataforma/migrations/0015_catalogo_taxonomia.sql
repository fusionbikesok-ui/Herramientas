-- E2 T3: la taxonomía propia, las marcas canónicas, las colecciones con vigencia y la composición de
-- packs. Plan: docs/superpowers/plans/2026-09-20-e2-tramo3-taxonomia-colecciones-packs.md.
--
-- Las decisiones que NO se deben "simplificar" al leer esto:
--   1. La jerarquía de los canales es EVIDENCIA, nunca el árbol propio (D1, cerrada por José el
--      2026-09-20). Viven en tablas separadas y se unen sólo por un mapeo explícito y humano.
--   2. La identidad de un nodo es estable e independiente de su nombre, su slug y su lugar en el árbol:
--      `taxonomy_nodes` guarda la identidad y `taxonomy_node_versions` cómo se veía en cada versión. Sin
--      esto, renombrar un rubro rompería todos los mapeos y E12/E13 no podrían publicar lo aprobado.
--   3. Los componentes de un pack son VARIANTES VENDIBLES, no modelos: un modelo no tiene stock ni precio,
--      y un pack se arma con cosas comprables. Elegir el modelo se paga caro en E5.
--   4. Forward-only, como todo `catalog`: nada se borra. `plataforma_app` no tiene DELETE.
--
-- Nada de esto escribe en ningún canal: es sombra entera.
SET lock_timeout = '5s';

-- ───────────────────────── tarea 1: la jerarquía del canal, como evidencia ─────────────────────────
-- Un canal informa su propio árbol (Woo: `id`/`parent`/`slug`/`count`; ML: los códigos MLA…). Se guarda
-- tal cual, por cuenta, y el padre se referencia por su ID REMOTO, no por una FK interna: la importación
-- puede ver un hijo antes que su padre y no debe fallar ni inventar una fila vacía.
CREATE TABLE catalog.channel_categories (
  id                 uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id         uuid NOT NULL REFERENCES core.companies(id) ON DELETE RESTRICT,
  channel_account_id uuid NOT NULL REFERENCES core.channel_accounts(id) ON DELETE RESTRICT,
  canal              text NOT NULL CHECK (canal IN ('mercadolibre', 'woocommerce')),
  id_externo         text NOT NULL CHECK (length(id_externo) > 0),
  parent_externo     text,                    -- NULL = raíz. Woo informa 0; la importación lo normaliza a NULL.
  nombre             text NOT NULL,
  slug               text,
  conteo             integer CHECK (conteo IS NULL OR conteo >= 0),
  capturado_en       timestamptz NOT NULL DEFAULT now(),
  vigente_hasta      timestamptz,             -- con fecha = el canal dejó de informarla. Nunca se borra.
  CONSTRAINT channel_categories_no_autopadre CHECK (parent_externo IS DISTINCT FROM id_externo)
);
-- Una sola fila vigente por categoría del canal. Si desaparece y vuelve, son dos filas y queda la historia.
CREATE UNIQUE INDEX channel_categories_un_vigente
  ON catalog.channel_categories (channel_account_id, id_externo) WHERE vigente_hasta IS NULL;
CREATE INDEX channel_categories_padre
  ON catalog.channel_categories (channel_account_id, parent_externo) WHERE vigente_hasta IS NULL;

-- ───────────────────────── tarea 2: marcas canónicas ─────────────────────────
-- Una marca es una entidad, no un texto libre ni una categoría. `FANTTIK` era una raíz del árbol de Woo y
-- por D2 pasa a ser marca. El nombre normalizado es la clave: 'Shimano', 'SHIMANO' y ' shimano ' son una.
CREATE TABLE catalog.brands (
  id                 uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id         uuid NOT NULL REFERENCES core.companies(id) ON DELETE RESTRICT,
  nombre             text NOT NULL CHECK (length(btrim(nombre)) > 0),
  nombre_normalizado text NOT NULL CHECK (length(nombre_normalizado) > 0),
  archivado_en       timestamptz,
  motivo_archivo     text,
  creado_en          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT brands_archivo_check CHECK ((archivado_en IS NULL) = (motivo_archivo IS NULL)),
  CONSTRAINT brands_un_nombre UNIQUE (company_id, nombre_normalizado)
);

-- Los otros nombres con los que la misma marca aparece en los canales y en el legado. Sin esto, cada
-- variante de escritura sería una marca distinta y las 155 del legado nunca cerrarían con las 204 de ML.
CREATE TABLE catalog.brand_aliases (
  id                  uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id          uuid NOT NULL REFERENCES core.companies(id) ON DELETE RESTRICT,
  brand_id            uuid NOT NULL REFERENCES catalog.brands(id) ON DELETE RESTRICT,
  alias_normalizado   text NOT NULL CHECK (length(alias_normalizado) > 0),
  -- De dónde salió este alias. 'categoria_canal' es el caso de las 15 categorías que son marca mal usada:
  -- queda registrado de dónde vino en vez de perderse en un merge silencioso.
  origen              text NOT NULL CHECK (origen IN ('legado', 'ml_atributo', 'woo_taxonomia', 'categoria_canal', 'persona')),
  creado_en           timestamptz NOT NULL DEFAULT now(),
  -- Un alias no puede apuntar a dos marcas: eso sería una identidad ambigua, justo lo que E2 no permite.
  CONSTRAINT brand_aliases_un_alias UNIQUE (company_id, alias_normalizado)
);
CREATE INDEX brand_aliases_marca ON catalog.brand_aliases (brand_id);

-- A lo sumo una marca por modelo. Nullable: "no sé" es un estado legítimo y no se adivina por el título.
ALTER TABLE catalog.product_models
  ADD COLUMN brand_id uuid REFERENCES catalog.brands(id) ON DELETE RESTRICT;
CREATE INDEX product_models_marca ON catalog.product_models (brand_id) WHERE brand_id IS NOT NULL;

-- ───────────────────────── tarea 2: colecciones con vigencia ─────────────────────────
-- Una colección NO es una rama del árbol: `Hotsale` es una promo con fecha, no un rubro (D2). Vive afuera
-- y la pertenencia es muchos-a-muchos.
CREATE TABLE catalog.collections (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id     uuid NOT NULL REFERENCES core.companies(id) ON DELETE RESTRICT,
  clave          text NOT NULL CHECK (clave ~ '^[a-z0-9][a-z0-9_-]*$'),
  nombre         text NOT NULL CHECK (length(btrim(nombre)) > 0),
  descripcion    text,
  vigente_desde  timestamptz,
  vigente_hasta  timestamptz,
  archivado_en   timestamptz,
  motivo_archivo text,
  creado_en      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT collections_archivo_check CHECK ((archivado_en IS NULL) = (motivo_archivo IS NULL)),
  -- Una vigencia invertida listaría siempre vacío sin que nadie entienda por qué.
  CONSTRAINT collections_vigencia_check CHECK (
    vigente_desde IS NULL OR vigente_hasta IS NULL OR vigente_desde < vigente_hasta),
  CONSTRAINT collections_un_clave UNIQUE (company_id, clave)
);

CREATE TABLE catalog.collection_members (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  collection_id uuid NOT NULL REFERENCES catalog.collections(id) ON DELETE RESTRICT,
  model_id      uuid NOT NULL REFERENCES catalog.product_models(id) ON DELETE RESTRICT,
  origen        text NOT NULL CHECK (origen IN ('categoria_canal', 'persona')),
  agregado_en   timestamptz NOT NULL DEFAULT now(),
  quitado_en    timestamptz,                  -- salir de una colección no borra que estuvo
  motivo_salida text,
  CONSTRAINT collection_members_salida_check CHECK ((quitado_en IS NULL) = (motivo_salida IS NULL))
);
CREATE UNIQUE INDEX collection_members_un_vigente
  ON catalog.collection_members (collection_id, model_id) WHERE quitado_en IS NULL;
CREATE INDEX collection_members_modelo ON catalog.collection_members (model_id) WHERE quitado_en IS NULL;

-- ───────────────────────── tarea 5: el árbol propio, versionado ─────────────────────────
-- Una versión es lo que E12 propone contra algo concreto y E13 publica exactamente. Sin versión, un
-- renombre entre la propuesta y la publicación cambiaría lo publicado sin que nadie lo apruebe.
CREATE TABLE catalog.taxonomy_versions (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id   uuid NOT NULL REFERENCES core.companies(id) ON DELETE RESTRICT,
  numero       integer NOT NULL CHECK (numero > 0),
  estado       text NOT NULL DEFAULT 'borrador' CHECK (estado IN ('borrador', 'vigente', 'reemplazada')),
  notas        text,
  creado_en    timestamptz NOT NULL DEFAULT now(),
  vigente_desde timestamptz,
  vigente_hasta timestamptz,
  CONSTRAINT taxonomy_versions_un_numero UNIQUE (company_id, numero),
  CONSTRAINT taxonomy_versions_vigencia_check CHECK ((estado = 'vigente') = (vigente_desde IS NOT NULL AND vigente_hasta IS NULL))
);
-- Una sola vigente por empresa: "el árbol de hoy" es una lectura, no un cálculo.
CREATE UNIQUE INDEX taxonomy_versions_un_vigente
  ON catalog.taxonomy_versions (company_id) WHERE estado = 'vigente';

-- La IDENTIDAD del nodo. No tiene nombre ni padre: eso cambia por versión y no es lo que identifica.
-- `rubro` separa el árbol de productos del de servicios (D2: SERVICES y Taller no tienen stock ni marca).
CREATE TABLE catalog.taxonomy_nodes (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id   uuid NOT NULL REFERENCES core.companies(id) ON DELETE RESTRICT,
  clave        text NOT NULL CHECK (clave ~ '^[a-z0-9][a-z0-9_-]*$'),
  rubro        text NOT NULL DEFAULT 'producto' CHECK (rubro IN ('producto', 'servicio')),
  creado_en    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT taxonomy_nodes_un_clave UNIQUE (company_id, clave)
);

-- Cómo se veía ese nodo en una versión dada: su nombre, su padre y su orden. Una versión pasada se
-- reconstruye entera leyendo sus filas, sin recalcular nada.
CREATE TABLE catalog.taxonomy_node_versions (
  id         uuid PRIMARY KEY DEFAULT uuidv7(),
  version_id uuid NOT NULL REFERENCES catalog.taxonomy_versions(id) ON DELETE RESTRICT,
  node_id    uuid NOT NULL REFERENCES catalog.taxonomy_nodes(id) ON DELETE RESTRICT,
  -- Un solo padre (decisión 4 del plan). NULL = raíz de esa versión.
  parent_id  uuid REFERENCES catalog.taxonomy_nodes(id) ON DELETE RESTRICT,
  nombre     text NOT NULL CHECK (length(btrim(nombre)) > 0),
  orden      integer NOT NULL DEFAULT 0,
  archivado  boolean NOT NULL DEFAULT false,  -- archivar, no borrar (decisión 6 del plan)
  CONSTRAINT taxonomy_node_versions_no_autopadre CHECK (parent_id IS DISTINCT FROM node_id),
  CONSTRAINT taxonomy_node_versions_un_nodo UNIQUE (version_id, node_id)
);
CREATE INDEX taxonomy_node_versions_padre ON catalog.taxonomy_node_versions (version_id, parent_id);

-- Los ciclos no se pueden expresar como CHECK: se verifican por fila contra el resto de su versión.
-- No se fija profundidad máxima (D4): una reorganización legítima no debe chocar contra el esquema.
CREATE OR REPLACE FUNCTION catalog.taxonomia_sin_ciclos() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE actual uuid := NEW.parent_id; saltos integer := 0;
BEGIN
  -- Serializa las escrituras de esta versión. Sin esto, dos transacciones que hacen A.padre=B y B.padre=A a
  -- la vez ven cada una el estado anterior de la otra, las dos pasan la verificación y queda el ciclo: una
  -- restricción que sólo mira el snapshot propio no es una restricción bajo concurrencia.
  PERFORM 1 FROM catalog.taxonomy_versions WHERE id = NEW.version_id FOR UPDATE;
  WHILE actual IS NOT NULL LOOP
    IF actual = NEW.node_id THEN
      RAISE EXCEPTION 'el nodo % no puede colgar de % : cerraría un ciclo en la versión %',
        NEW.node_id, NEW.parent_id, NEW.version_id;
    END IF;
    saltos := saltos + 1;
    -- Cota de seguridad: si ya hay un ciclo preexistente entre OTRAS filas, el bucle no debe ser infinito.
    IF saltos > 64 THEN RAISE EXCEPTION 'cadena de padres demasiado larga o ya cíclica en la versión %', NEW.version_id; END IF;
    SELECT v.parent_id INTO actual FROM catalog.taxonomy_node_versions v
      WHERE v.version_id = NEW.version_id AND v.node_id = actual;
    -- Un padre SIN fila en esta versión no es un árbol válido: los nodos que cuelgan de él desaparecen de
    -- `leerArbol` (que baja desde las raíces) sin que nada proteste. Antes se aceptaba en silencio.
    IF NOT FOUND THEN
      RAISE EXCEPTION 'el nodo % cuelga de un padre que no existe en la versión %', NEW.node_id, NEW.version_id;
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;
CREATE TRIGGER taxonomy_node_versions_sin_ciclos
  -- `node_id` y `version_id` también: mover una fila de nodo o de versión puede cerrar un ciclo igual que
  -- cambiar el padre, y con `UPDATE OF parent_id` a secas esas dos vías no disparaban nada.
  BEFORE INSERT OR UPDATE OF parent_id, node_id, version_id ON catalog.taxonomy_node_versions
  FOR EACH ROW EXECUTE FUNCTION catalog.taxonomia_sin_ciclos();

-- El mapeo con el canal: por ID REMOTO (nunca por nombre), por canal y por cuenta, y admitiendo
-- explícitamente "sin equivalencia" — que es una decisión tomada, distinta de una fila que falta.
CREATE TABLE catalog.taxonomy_channel_map (
  id                 uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id         uuid NOT NULL REFERENCES core.companies(id) ON DELETE RESTRICT,
  node_id            uuid NOT NULL REFERENCES catalog.taxonomy_nodes(id) ON DELETE RESTRICT,
  channel_account_id uuid NOT NULL REFERENCES core.channel_accounts(id) ON DELETE RESTRICT,
  canal              text NOT NULL CHECK (canal IN ('mercadolibre', 'woocommerce')),
  id_externo         text,
  sin_equivalencia   boolean NOT NULL DEFAULT false,
  decidido_por       text,
  decidido_en        timestamptz NOT NULL DEFAULT now(),
  vigente_hasta      timestamptz,
  CONSTRAINT taxonomy_channel_map_equivalencia_check CHECK ((id_externo IS NULL) = sin_equivalencia),
  CONSTRAINT taxonomy_channel_map_no_vacio CHECK (id_externo IS NULL OR length(id_externo) > 0)
);
CREATE UNIQUE INDEX taxonomy_channel_map_un_vigente
  ON catalog.taxonomy_channel_map (node_id, channel_account_id) WHERE vigente_hasta IS NULL;
-- Dos nodos propios no pueden reclamar la misma categoría del canal: el mapeo dejaría de ser una función.
CREATE UNIQUE INDEX taxonomy_channel_map_un_externo
  ON catalog.taxonomy_channel_map (channel_account_id, id_externo)
  WHERE vigente_hasta IS NULL AND id_externo IS NOT NULL;

-- ───────────────────────── tarea 6: el producto en el árbol ─────────────────────────
-- Exactamente una primaria por modelo cuando está clasificado; las secundarias sin límite. La primaria
-- es la que usan los informes y E13 para publicar; sin una sola, un modelo contaría dos veces por rubro.
CREATE TABLE catalog.model_categories (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id    uuid NOT NULL REFERENCES core.companies(id) ON DELETE RESTRICT,
  model_id      uuid NOT NULL REFERENCES catalog.product_models(id) ON DELETE RESTRICT,
  node_id       uuid NOT NULL REFERENCES catalog.taxonomy_nodes(id) ON DELETE RESTRICT,
  primaria      boolean NOT NULL DEFAULT false,
  origen        text NOT NULL CHECK (origen IN ('mapeo_canal', 'persona')),
  asignado_en   timestamptz NOT NULL DEFAULT now(),
  quitado_en    timestamptz,
  motivo_salida text,
  CONSTRAINT model_categories_salida_check CHECK ((quitado_en IS NULL) = (motivo_salida IS NULL))
);
CREATE UNIQUE INDEX model_categories_un_vigente
  ON catalog.model_categories (model_id, node_id) WHERE quitado_en IS NULL;
CREATE UNIQUE INDEX model_categories_una_primaria
  ON catalog.model_categories (model_id) WHERE quitado_en IS NULL AND primaria;
CREATE INDEX model_categories_nodo ON catalog.model_categories (node_id) WHERE quitado_en IS NULL;

-- ───────────────────────── tarea 7: la composición de un pack ─────────────────────────
-- Un pack es una variante vendible más, con composición. Nace en BORRADOR y sin precio, sin reserva de
-- stock, sin explosión de pedidos y sin publicación: las cuatro cosas quedan diferidas a propósito.
CREATE TABLE catalog.packs (
  variant_id uuid PRIMARY KEY REFERENCES catalog.sellable_variants(id) ON DELETE RESTRICT,
  company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE RESTRICT,
  estado     text NOT NULL DEFAULT 'borrador' CHECK (estado IN ('borrador', 'vigente', 'archivado')),
  nombre     text NOT NULL CHECK (length(btrim(nombre)) > 0),
  notas      text,
  creado_en  timestamptz NOT NULL DEFAULT now()
);

-- Componentes por VARIANTE VENDIBLE (decisión 7 del plan). Con vigencia, para que una venta de ayer
-- pueda reconstruir qué llevaba el pack ayer y no lo que lleva hoy.
CREATE TABLE catalog.pack_components (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  pack_variant_id uuid NOT NULL REFERENCES catalog.packs(variant_id) ON DELETE RESTRICT,
  variant_id      uuid NOT NULL REFERENCES catalog.sellable_variants(id) ON DELETE RESTRICT,
  cantidad        numeric(12,4) NOT NULL CHECK (cantidad > 0),
  unidad          text NOT NULL DEFAULT 'unidad' CHECK (length(unidad) > 0),
  vigente_desde   timestamptz NOT NULL DEFAULT now(),
  vigente_hasta   timestamptz,
  motivo_cierre   text,
  CONSTRAINT pack_components_cierre_check CHECK ((vigente_hasta IS NULL) = (motivo_cierre IS NULL)),
  CONSTRAINT pack_components_no_autocomponente CHECK (pack_variant_id <> variant_id)
);
CREATE UNIQUE INDEX pack_components_un_vigente
  ON catalog.pack_components (pack_variant_id, variant_id) WHERE vigente_hasta IS NULL;
CREATE INDEX pack_components_componente ON catalog.pack_components (variant_id) WHERE vigente_hasta IS NULL;

-- Ni ciclos (un pack que se contiene a sí mismo por una cadena) ni componentes archivados: un pack
-- vendible armado con algo dado de baja es una venta que no se puede cumplir.
CREATE OR REPLACE FUNCTION catalog.pack_componente_valido() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE muerta boolean; cicla boolean;
BEGIN
  -- Mismo motivo que en el árbol: sin lock, dos transacciones que cierran el ciclo desde los dos lados a la
  -- vez pasan las dos. El lock es por pack para no serializar toda la tabla.
  PERFORM pg_advisory_xact_lock(hashtextextended('catalog.pack_components:' || NEW.pack_variant_id::text, 0));
  SELECT archivado_en IS NOT NULL INTO muerta FROM catalog.sellable_variants WHERE id = NEW.variant_id;
  IF muerta THEN
    RAISE EXCEPTION 'la variante % está archivada: no puede ser componente de un pack', NEW.variant_id;
  END IF;
  -- Cierre transitivo hacia abajo desde el componente: si desde él se llega al pack, hay ciclo.
  WITH RECURSIVE baja(id, saltos) AS (
    SELECT NEW.variant_id, 0
    UNION ALL
    SELECT c.variant_id, b.saltos + 1
      FROM baja b
      JOIN catalog.pack_components c ON c.pack_variant_id = b.id AND c.vigente_hasta IS NULL
     WHERE b.saltos < 64
  )
  SELECT EXISTS (SELECT 1 FROM baja WHERE id = NEW.pack_variant_id) INTO cicla;
  IF cicla THEN
    RAISE EXCEPTION 'el componente % cerraría un ciclo en el pack %', NEW.variant_id, NEW.pack_variant_id;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER pack_components_valido
  -- `vigente_hasta` está en la lista porque REABRIR un componente cerrado (poner `vigente_hasta` en NULL) es
  -- la vía por la que se colaba un ciclo sin verificar: el componente inverso pudo agregarse mientras este
  -- estaba cerrado, y al reabrirlo el trigger no se disparaba porque no se tocaba ninguna de las otras dos
  -- columnas. El comentario de arriba promete que no hay segunda vía de escritura: ésta era la segunda vía.
  BEFORE INSERT OR UPDATE OF variant_id, pack_variant_id, vigente_hasta ON catalog.pack_components
  FOR EACH ROW WHEN (NEW.vigente_hasta IS NULL) EXECUTE FUNCTION catalog.pack_componente_valido();

-- ───────────────────────── casos nuevos ─────────────────────────
-- NINGUNO. La primera versión de este tramo reservaba `categoria_sin_mapeo`, `marca_ambigua` y
-- `categoria_en_conflicto` en el CHECK de `identity_cases`. Se sacaron antes de desplegar, por dos razones
-- que aparecieron en la revisión independiente:
--   1. Ningún código los abre. Un tipo de caso declarado y nunca abierto es una promesa falsa: el comentario
--      del código decía «quien importa abre `marca_ambigua`» y nadie lo abría, así que la ambigüedad que el
--      esquema dice prohibir pasaba en silencio.
--   2. Dos de los tres no se pueden ni representar: `identity_cases` exige `variant_id` o
--      `representation_id` (CONSTRAINT identity_cases_objeto_check), y una categoría del canal sin mapear no
--      es ninguna de las dos cosas. Reservar un nombre que la tabla no puede alojar es peor que no tenerlo.
-- Lo que se hace en su lugar: `asegurarMarca` FALLA ante un alias ya tomado por otra marca, en vez de
-- seguir en silencio. Cuando la carga del árbol necesite casos propios de taxonomía, se agregan con su
-- objeto pensado y con el código que los abre en el mismo cambio.
