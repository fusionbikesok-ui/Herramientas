-- 0023 — E3 corte 3: canario del auto-SKU. Parte 1: observación de formato (D4, spec §6).
SET lock_timeout = '5s';
CREATE TABLE catalog.format_observations (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  channel_account_id uuid NOT NULL REFERENCES core.channel_accounts(id) ON DELETE RESTRICT,
  recurso text NOT NULL,
  hash_estructura text NOT NULL,
  estructura jsonb NOT NULL,
  -- Columnas propias por spec §4 (no sólo el jsonb de estructura): permiten filtrar/leer sin parsear jsonb.
  version_remota text,
  variaciones jsonb,
  cantidad_pack text,
  listing_type text,
  catalog_listing boolean,
  seller_sku text,
  origen text NOT NULL CHECK (origen IN ('barrido','relectura')),
  observado_en timestamptz NOT NULL DEFAULT now());
CREATE INDEX format_observations_ultima ON catalog.format_observations (channel_account_id, recurso, observado_en DESC, id DESC);
