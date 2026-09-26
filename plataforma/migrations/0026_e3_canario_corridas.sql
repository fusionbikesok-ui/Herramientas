SET lock_timeout = '5s';
CREATE TABLE catalog.e3_canario_corridas (
  id uuid PRIMARY KEY DEFAULT uuidv7(), company_id uuid NOT NULL REFERENCES core.companies(id), dia date NOT NULL,
  estado text NOT NULL DEFAULT 'abierta' CHECK (estado IN ('abierta','cerrada','abortada')),
  congelado_en timestamptz NOT NULL DEFAULT now(), cerrado_en timestamptz, clasificacion jsonb,
  UNIQUE (company_id, dia));
CREATE UNIQUE INDEX e3_canario_una_abierta ON catalog.e3_canario_corridas (company_id) WHERE estado = 'abierta';
CREATE TABLE catalog.e3_canario_casos (
  corrida_id uuid NOT NULL REFERENCES catalog.e3_canario_corridas(id), case_id uuid NOT NULL REFERENCES catalog.identity_cases(id),
  channel_account_id uuid NOT NULL, recurso text NOT NULL, variacion_normalizada text NOT NULL,
  sku_congelado text NOT NULL, variant_id_congelada uuid NOT NULL,
  estado text NOT NULL DEFAULT 'pendiente' CHECK (estado IN ('pendiente','vinculado','bandeja','intervention','parked','ya_resuelto')),
  intentos int NOT NULL DEFAULT 0, detalle jsonb, tomado_por text, tomado_hasta timestamptz,
  PRIMARY KEY (corrida_id, case_id));
