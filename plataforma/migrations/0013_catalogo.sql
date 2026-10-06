-- E2 T1 · tarea 1: el catálogo canónico (modelos, variantes vendibles, representaciones por canal,
-- la evidencia del matcher y los casos abiertos), más las tablas que el bootstrap y las copias necesitan.
--
-- Tres reglas mandan sobre el diseño de acá:
--   1. Ninguna identidad por nombre ni por GTIN. Lo que no se puede decidir es un caso, no un descarte.
--   2. Forward-only: nada se borra. Una baja en el canal es `archivado_en` con motivo.
--   3. Toda clave natural incluye la cuenta del canal, aunque hoy haya una sola por canal: el día que
--      entre una segunda tienda Woo, dos productos con el id local 1234 no tienen que chocar.
--
-- `lock_timeout` acotado porque los dos ALTER de abajo tocan tablas activas en producción: antes de
-- esperar un bloqueo indefinido y frenar al worker, la migración falla y se reintenta en otro momento.
SET lock_timeout = '5s';

CREATE SCHEMA catalog;
GRANT USAGE ON SCHEMA catalog TO plataforma_app;

-- ───────────────────────────── el producto como concepto ─────────────────────────────
-- Un modelo nunca se vende: se vende una de sus variantes. Por eso no tiene precio ni stock.
CREATE TABLE catalog.product_models (
  id                 uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id         uuid NOT NULL REFERENCES core.companies(id) ON DELETE RESTRICT,
  channel_account_id uuid NOT NULL REFERENCES core.channel_accounts(id) ON DELETE RESTRICT,
  origen             text NOT NULL CHECK (origen IN ('woo_padre', 'woo_simple', 'ml_familia', 'ml_clasico', 'ml_simple')),
  -- Para `ml_familia`, el id de la familia de ML. NO es el user_product_id: ése identifica una variante
  -- (cada variación del modelo viejo tiene el suyo, y dos publicaciones pueden compartirlo). Verificado el
  -- 2026-09-18 sobre las 6.969 filas de la cache del legado.
  clave_origen       text NOT NULL CHECK (length(clave_origen) > 0),
  titulo             text NOT NULL,
  observado_en       timestamptz NOT NULL DEFAULT now(),
  archivado_en       timestamptz,
  motivo_archivo     text,
  version            integer NOT NULL DEFAULT 1 CHECK (version > 0),
  creado_en          timestamptz NOT NULL DEFAULT now(),
  -- El archivo lleva motivo siempre: una baja sin causa es exactamente lo que no queremos.
  CONSTRAINT product_models_archivo_check CHECK ((archivado_en IS NULL) = (motivo_archivo IS NULL)),
  CONSTRAINT product_models_un_clave UNIQUE (channel_account_id, origen, clave_origen)
);
CREATE INDEX product_models_empresa ON catalog.product_models (company_id, origen);

-- ───────────────────────────── lo que se vende ─────────────────────────────
-- `sku` nulo = pendiente de decidir, que es un estado legítimo y no un error. `company_id` está acá
-- porque la unicidad del SKU es por empresa: dos empresas pueden tener su propio FB-123.
CREATE TABLE catalog.sellable_variants (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id     uuid NOT NULL REFERENCES core.companies(id) ON DELETE RESTRICT,
  model_id       uuid NOT NULL REFERENCES catalog.product_models(id) ON DELETE RESTRICT,
  -- El canónico es FB-{ID_WOO}: sólo dígitos después del prefijo, y al menos uno.
  sku            text CHECK (sku ~ '^FB-[0-9]+$'),
  archivado_en   timestamptz,
  motivo_archivo text,
  version        integer NOT NULL DEFAULT 1 CHECK (version > 0),
  creado_en      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sellable_variants_archivo_check CHECK ((archivado_en IS NULL) = (motivo_archivo IS NULL))
);
-- Único cuando no es nulo, y por empresa. Un UNIQUE común dejaría pasar dos FB-123 de empresas
-- distintas o, al revés, trataría cada pendiente como un valor repetido.
CREATE UNIQUE INDEX sellable_variants_un_sku
  ON catalog.sellable_variants (company_id, sku) WHERE sku IS NOT NULL;
CREATE INDEX sellable_variants_modelo ON catalog.sellable_variants (model_id);
CREATE INDEX sellable_variants_pendientes
  ON catalog.sellable_variants (company_id) WHERE sku IS NULL AND archivado_en IS NULL;

-- El SKU se pone una vez y no se cambia más: es la identidad con la que el resto del programa
-- (stock, precios, publicación) va a referirse a esta variante. Resolver un pendiente sí se permite.
CREATE OR REPLACE FUNCTION catalog.sku_inmutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.sku IS NOT NULL AND NEW.sku IS DISTINCT FROM OLD.sku THEN
    RAISE EXCEPTION 'el sku de una variante es inmutable: % no puede pasar a %', OLD.sku, COALESCE(NEW.sku, 'NULL');
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER sellable_variants_sku_inmutable
  BEFORE UPDATE OF sku ON catalog.sellable_variants
  FOR EACH ROW EXECUTE FUNCTION catalog.sku_inmutable();

-- ───────────────────────────── cada aparición en un canal ─────────────────────────────
-- `contenedor` es lo que agrupa y no se vende (el padre de Woo, el ítem clásico de ML con variaciones);
-- apunta a un modelo. `vendible` es lo que se compra; apunta a una variante.
CREATE TABLE catalog.external_representations (
  id                    uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id            uuid NOT NULL REFERENCES core.companies(id) ON DELETE RESTRICT,
  channel_account_id    uuid NOT NULL REFERENCES core.channel_accounts(id) ON DELETE RESTRICT,
  canal                 text NOT NULL CHECK (canal IN ('mercadolibre', 'woocommerce')),
  recurso               text NOT NULL CHECK (length(recurso) > 0),
  -- No nula, '' cuando no hay variación: un UNIQUE con NULL admite duplicados, y ahí se nos escapaba
  -- exactamente el caso que más se repite (el ítem sin variaciones cargado dos veces).
  variacion_normalizada text NOT NULL DEFAULT '',
  tipo                  text NOT NULL CHECK (tipo IN ('contenedor', 'vendible')),
  model_id              uuid REFERENCES catalog.product_models(id) ON DELETE RESTRICT,
  variant_id            uuid REFERENCES catalog.sellable_variants(id) ON DELETE RESTRICT,
  sku_observado         text,                 -- lo que dice el canal, tal cual, aunque esté mal
  user_product_id       text,                 -- ML: el producto que se vende. Pista de variante, no identidad
  estado_remoto         text,
  version_remota        text,
  omitida_por_decision  boolean NOT NULL DEFAULT false,
  sweep_run_id          uuid,                 -- de qué corrida o mensaje vino esta observación
  observado_en          timestamptz NOT NULL DEFAULT now(),
  archivado_en          timestamptz,
  motivo_archivo        text,
  creado_en             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT external_representations_archivo_check CHECK ((archivado_en IS NULL) = (motivo_archivo IS NULL)),
  -- Lo que el diseño pide que la base garantice sola: un contenedor jamás cuelga de una variante.
  -- El nombre no repite "tipo_check": ése lo toma PostgreSQL solo para el CHECK inline de la columna.
  CONSTRAINT external_representations_colgadura_check CHECK (
    (tipo = 'contenedor' AND model_id IS NOT NULL AND variant_id IS NULL AND NOT omitida_por_decision)
    -- Un vendible omitido por decisión del matcher no tiene variante (§5.2 del diseño): existe en el canal,
    -- pero alguien decidió que no es un producto nuestro que se venda. Cualquier otro vendible sí la tiene.
    OR (tipo = 'vendible' AND (variant_id IS NOT NULL) <> omitida_por_decision)),
  CONSTRAINT external_representations_un_aparicion
    UNIQUE (channel_account_id, recurso, variacion_normalizada)
);
CREATE INDEX external_representations_variante ON catalog.external_representations (variant_id);
CREATE INDEX external_representations_modelo ON catalog.external_representations (model_id);
CREATE INDEX external_representations_user_product
  ON catalog.external_representations (channel_account_id, user_product_id) WHERE user_product_id IS NOT NULL;

-- ───────────────────────────── la evidencia del legado ─────────────────────────────
-- Append-only: una decisión no se edita, se cierra y entra la siguiente. Así queda el historial de
-- quién decidió qué y cuándo, que es lo que hace auditable al catálogo.
CREATE TABLE catalog.matcher_decisions (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id            uuid NOT NULL REFERENCES core.companies(id) ON DELETE RESTRICT,
  channel_account_id    uuid NOT NULL REFERENCES core.channel_accounts(id) ON DELETE RESTRICT,
  canal                 text NOT NULL CHECK (canal IN ('mercadolibre', 'woocommerce')),
  recurso               text NOT NULL CHECK (length(recurso) > 0),
  variacion_normalizada text NOT NULL DEFAULT '',
  sku                   text,
  accion                text NOT NULL CHECK (accion IN ('confirmar', 'asignar', 'omitir', 'revocar')),
  -- 'sistema' es la autoasignación por SKU y la corrección de Guardia: decisiones automáticas que
  -- igual son decisiones, con su motivo (José, 2026-09-18).
  origen                text NOT NULL CHECK (origen IN ('copia', 'evento')),
  actor                 text NOT NULL CHECK (actor IN ('persona', 'sistema')),
  motivo                text,
  confirmado_por        text,
  actualizado_en_legado timestamptz,
  copy_id               uuid,
  vigente_desde         timestamptz NOT NULL DEFAULT now(),
  vigente_hasta         timestamptz,
  motivo_cierre         text,
  creado_en             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT matcher_decisions_cierre_check CHECK ((vigente_hasta IS NULL) = (motivo_cierre IS NULL))
);
-- Una sola decisión vigente por clave: es la regla que hace que "lo vigente" sea una lectura y no un cálculo.
CREATE UNIQUE INDEX matcher_decisions_un_vigente
  ON catalog.matcher_decisions (channel_account_id, recurso, variacion_normalizada)
  WHERE vigente_hasta IS NULL;
CREATE INDEX matcher_decisions_sku ON catalog.matcher_decisions (company_id, sku) WHERE sku IS NOT NULL;

-- ───────────────────────────── lo que falta decidir ─────────────────────────────
CREATE TABLE catalog.identity_cases (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id      uuid NOT NULL REFERENCES core.companies(id) ON DELETE RESTRICT,
  tipo            text NOT NULL CHECK (tipo IN (
                    'sku_pendiente', 'omitida_revisar', 'sku_inexistente_en_woo', 'woo_sin_sku',
                    'woo_sku_duplicado', 'woo_sku_no_canonico', 'decision_en_conflicto', 'identidad_legado',
                    -- Dos publicaciones de ML con el mismo user_product_id (ML dice que venden lo mismo) que
                    -- el matcher no vincula a la misma variante. Pista, no identidad: se revisa, no se fusiona.
                    'user_product_divergente')),
  prioridad       text NOT NULL DEFAULT 'normal' CHECK (prioridad IN ('baja', 'normal', 'urgente')),
  variant_id      uuid REFERENCES catalog.sellable_variants(id) ON DELETE RESTRICT,
  representation_id uuid REFERENCES catalog.external_representations(id) ON DELETE RESTRICT,
  detalle         jsonb NOT NULL DEFAULT '{}'::jsonb,
  abierto_en      timestamptz NOT NULL DEFAULT now(),
  cerrado_en      timestamptz,
  motivo_cierre   text,
  CONSTRAINT identity_cases_cierre_check CHECK ((cerrado_en IS NULL) = (motivo_cierre IS NULL)),
  -- Todo caso apunta a algo concreto: sin objeto no hay nada que revisar.
  CONSTRAINT identity_cases_objeto_check CHECK (variant_id IS NOT NULL OR representation_id IS NOT NULL)
);
-- Un caso abierto por objeto y tipo. Cerrado, puede volver a abrirse: el problema puede reaparecer.
CREATE UNIQUE INDEX identity_cases_un_abierto_variante
  ON catalog.identity_cases (variant_id, tipo) WHERE cerrado_en IS NULL AND variant_id IS NOT NULL;
-- El caso del legado entra en la clave: el legado admite varios casos abiertos por publicación (uno por dirección),
-- y con (representación, tipo) solos colapsaban en uno, y resolver uno cerraba el del otro (revisión de la
-- implementación). Para los casos propios del catálogo, caso_legado no existe y la clave queda como antes.
CREATE UNIQUE INDEX identity_cases_un_abierto_representacion
  ON catalog.identity_cases (representation_id, tipo, (COALESCE(detalle->>'caso_legado', '')))
  WHERE cerrado_en IS NULL AND representation_id IS NOT NULL;
CREATE INDEX identity_cases_abiertos
  ON catalog.identity_cases (company_id, tipo, prioridad) WHERE cerrado_en IS NULL;

-- ───────────────────────────── checkpoint del bootstrap ─────────────────────────────
-- Una corrida por cuenta y tópico, con la página ya confirmada en disco: si el proceso se muere en la
-- página 30, el que arranca sigue en la 30 y no vuelve a leer 30 páginas de la API de ML.
CREATE TABLE catalog.bootstrap_runs (
  id                 uuid PRIMARY KEY DEFAULT uuidv7(),
  channel_account_id uuid NOT NULL REFERENCES core.channel_accounts(id) ON DELETE RESTRICT,
  topic              text NOT NULL CHECK (topic IN ('ml.items', 'woo.products')),
  estado             text NOT NULL DEFAULT 'pendiente'
                       CHECK (estado IN ('pendiente', 'corriendo', 'pausada', 'terminada', 'abortada')),
  pagina_confirmada  integer NOT NULL DEFAULT 0 CHECK (pagina_confirmada >= 0),
  cursor             text,
  encolados          integer NOT NULL DEFAULT 0 CHECK (encolados >= 0),
  leidos             integer NOT NULL DEFAULT 0 CHECK (leidos >= 0),
  lease_token        uuid,
  lease_until        timestamptz,
  worker_id          text,
  error_detail       text,
  arrancada_en       timestamptz NOT NULL DEFAULT now(),
  terminada_en       timestamptz,
  CONSTRAINT bootstrap_runs_lease_check CHECK (
    (estado = 'corriendo') = (lease_token IS NOT NULL AND lease_until IS NOT NULL AND worker_id IS NOT NULL)),
  CONSTRAINT bootstrap_runs_un_corriente UNIQUE (channel_account_id, topic)
);

-- ───────────────────────────── copias en tandas ─────────────────────────────
-- Una tanda intermedia no permite distinguir "ausente" de "todavía no llegó". Por eso los lotes van a
-- staging y sólo el confirmar, con conteo y hash, cierra vigencias.
CREATE TABLE catalog.copias (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id     uuid NOT NULL REFERENCES core.companies(id) ON DELETE RESTRICT,
  tipo           text NOT NULL CHECK (tipo IN ('matcher', 'identidad')),
  total_esperado integer NOT NULL CHECK (total_esperado >= 0),
  hash_esperado  text NOT NULL CHECK (length(hash_esperado) > 0),
  corte          timestamptz NOT NULL DEFAULT now(),
  estado         text NOT NULL DEFAULT 'abierta' CHECK (estado IN ('abierta', 'confirmada', 'abortada')),
  error_detail   text,
  -- Lo que hizo la confirmación (abiertas, cerradas, sin cambios…). Una copia diaria que cambia algo quiere
  -- decir que un evento se perdió en el camino: es la conciliación, y la lee el reporte diario.
  resultado      jsonb,
  abierta_en     timestamptz NOT NULL DEFAULT now(),
  confirmada_en  timestamptz,
  CONSTRAINT copias_confirmada_check CHECK ((estado = 'confirmada') = (confirmada_en IS NOT NULL))
);
CREATE TABLE catalog.copias_lotes (
  copy_id    uuid NOT NULL REFERENCES catalog.copias(id) ON DELETE RESTRICT,
  numero     integer NOT NULL CHECK (numero > 0),
  filas      jsonb NOT NULL,
  recibido_en timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (copy_id, numero)
);

-- Eventos del matcher ya aplicados. La outbox del legado reintenta con una firma nueva cada vez, así que el
-- nonce no alcanza para deduplicar: un evento reintentado se reconoce por su id y no se aplica dos veces.
CREATE TABLE catalog.eventos_recibidos (
  evento_id   text PRIMARY KEY CHECK (length(evento_id) > 0),
  recibido_en timestamptz NOT NULL DEFAULT now()
);

-- ───────────────────────────── orígenes nuevos ─────────────────────────────
-- Los dos CHECK que hay que ampliar están sobre tablas activas. Antes de tocarlos se comprueba que
-- ninguna fila existente viole el nuevo, porque un CHECK que no valida es una bomba a plazo.
DO $$
DECLARE malas bigint;
BEGIN
  SELECT count(*) INTO malas FROM integrations.inbox_messages
   WHERE source NOT IN ('webhook_copy', 'sweep', 'signal_reread', 'bootstrap');
  IF malas > 0 THEN RAISE EXCEPTION 'inbox_messages tiene % filas con un source que el CHECK nuevo rechaza', malas; END IF;

  SELECT count(*) INTO malas FROM integrations.reconciliation_signals
   WHERE source NOT IN ('webhook_copy', 'ml_missed_feed', 'payload_expired');
  IF malas > 0 THEN RAISE EXCEPTION 'reconciliation_signals tiene % filas con un source que el CHECK nuevo rechaza', malas; END IF;
END;
$$;

-- `signal_reread` ya existe y tiene 1.230 filas en producción: se conserva. Un CHECK nuevo que se
-- olvide de un valor en uso no "limpia" nada, deja la tabla entera inconsistente con su restricción.
ALTER TABLE integrations.inbox_messages DROP CONSTRAINT inbox_messages_source_check;
ALTER TABLE integrations.inbox_messages ADD CONSTRAINT inbox_messages_source_check
  CHECK (source IN ('webhook_copy', 'sweep', 'signal_reread', 'bootstrap'));

ALTER TABLE integrations.reconciliation_signals DROP CONSTRAINT reconciliation_signals_source_check;
ALTER TABLE integrations.reconciliation_signals ADD CONSTRAINT reconciliation_signals_source_check
  CHECK (source IN ('webhook_copy', 'ml_missed_feed', 'payload_expired'));

-- ───────────────────────────── permisos ─────────────────────────────
-- La app lee, inserta y actualiza. No borra: una baja es `archivado_en`, y un caso resuelto es
-- `cerrado_en`. Que no tenga DELETE es lo que hace que "forward-only" no dependa de la disciplina.
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA catalog TO plataforma_app;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA catalog TO plataforma_app;
ALTER DEFAULT PRIVILEGES FOR ROLE plataforma_migrador IN SCHEMA catalog
  GRANT SELECT, INSERT, UPDATE ON TABLES TO plataforma_app;
ALTER DEFAULT PRIVILEGES FOR ROLE plataforma_migrador IN SCHEMA catalog
  GRANT USAGE ON SEQUENCES TO plataforma_app;
