ALTER TABLE catalog.identity_cases DROP CONSTRAINT identity_cases_tipo_check;
ALTER TABLE catalog.identity_cases ADD CONSTRAINT identity_cases_tipo_check CHECK (tipo IN (
  'sku_pendiente', 'omitida_revisar', 'sku_inexistente_en_woo', 'woo_sin_sku', 'woo_sku_duplicado',
  'woo_sku_no_canonico', 'decision_en_conflicto', 'identidad_legado', 'user_product_divergente',
  'atributo_divergente', 'categoria_en_desacuerdo', 'categoria_sin_mapeo', 'categoria_persona_contradicha',
  'sku_cambiado', 'formato_cambiado'));

CREATE TABLE catalog.identity_commands (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  case_id uuid NOT NULL REFERENCES catalog.identity_cases(id),
  tipo text NOT NULL CHECK (tipo IN ('pausar_publicacion')),
  estado text NOT NULL DEFAULT 'parked' CHECK (estado IN ('parked')),
  motivo text NOT NULL,
  creado_en timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX identity_commands_un_case_tipo ON catalog.identity_commands (case_id, tipo);

