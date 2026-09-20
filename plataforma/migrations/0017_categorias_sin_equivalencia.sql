-- 0017 — una categoría del canal puede quedar decidida como «sin equivalencia» en el árbol propio.
--
-- `taxonomy_channel_map.sin_equivalencia` NO sirve para esto: dice «este NODO no tiene equivalente en el
-- canal» (id_externo NULL, node_id obligatorio). Lo que falta es lo opuesto: «esta CATEGORÍA del canal no
-- equivale a ningún nodo». Es el caso de los baldes de ML (`Otros Repuestos`, `Productos no categorizados`):
-- no significan una categoría sino «no sé», y mapearlos a un nodo sería inventar información que ML no dio.
--
-- Tiene que quedar en la base y con el MOTIVO escrito: sin esto, «no está mapeada» significa a la vez «todavía
-- no se decidió» y «se decidió que no», y en tres meses nadie puede distinguirlas sin abrir el repo.
--
-- Forward-only como todo `catalog`: no se borra, se cierra con `vigente_hasta`; un cambio de motivo cierra la
-- fila y abre otra. Una sola decisión vigente por categoría.
SET lock_timeout = '5s';
CREATE TABLE catalog.channel_category_sin_equivalencia (
  id                 uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id         uuid NOT NULL REFERENCES core.companies(id) ON DELETE RESTRICT,
  channel_account_id uuid NOT NULL REFERENCES core.channel_accounts(id) ON DELETE RESTRICT,
  canal              text NOT NULL CHECK (canal IN ('mercadolibre', 'woocommerce')),
  id_externo         text NOT NULL CHECK (length(id_externo) > 0),
  motivo             text NOT NULL CHECK (length(btrim(motivo)) > 0),
  decidido_por       text NOT NULL CHECK (length(btrim(decidido_por)) > 0),
  decidido_en        timestamptz NOT NULL DEFAULT now(),
  vigente_hasta      timestamptz
);
CREATE UNIQUE INDEX channel_category_sin_equivalencia_un_vigente
  ON catalog.channel_category_sin_equivalencia (channel_account_id, id_externo)
  WHERE vigente_hasta IS NULL;
