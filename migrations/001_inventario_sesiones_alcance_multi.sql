-- 001_inventario_sesiones_alcance_multi.sql
--
-- inventario_sesiones: alcance de una sola categoría/marca (TEXT string) →
-- selección múltiple (TEXT con JSON array).
--   categoria TEXT  → categorias TEXT  ('Cascos' → '["Cascos"]', NULL/'' → '[]')
--   marca     TEXT  → marcas     TEXT  ('Bell'   → '["Bell"]',   NULL/'' → '[]')
--
-- sqlite no soporta ALTER COLUMN, así que se usa el patrón crear-copiar-renombrar.
-- Backfill: envuelve el valor existente en un array de un elemento, sin romper
-- sesiones ya abiertas (id/estado/creado_en/confirmado_en se preservan).
--
-- Aplicación: este proyecto no usa un runner de migraciones ni PRAGMA user_version;
-- todas las migraciones son idempotentes y corren al arrancar (db/index.js y
-- ensureTables de cada router). El equivalente exacto de este archivo lo ejecuta
-- migrarSesionesAlcanceMulti() en routes/inventario.js, guardado por
-- PRAGMA table_info (solo corre si todavía existe la columna vieja `categoria`).
-- Este .sql queda como registro auditable y para aplicarlo a mano si hiciera falta.

BEGIN;

CREATE TABLE inventario_sesiones_mig (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  usuario        TEXT NOT NULL,
  categorias     TEXT NOT NULL DEFAULT '[]',
  marcas         TEXT NOT NULL DEFAULT '[]',
  estado         TEXT NOT NULL DEFAULT 'abierta',
  creado_en      TEXT NOT NULL,
  confirmado_en  TEXT
);

INSERT INTO inventario_sesiones_mig (id, usuario, categorias, marcas, estado, creado_en, confirmado_en)
  SELECT id, usuario,
         CASE WHEN COALESCE(categoria,'')='' THEN '[]' ELSE json_array(categoria) END,
         CASE WHEN COALESCE(marca,'')='' THEN '[]' ELSE json_array(marca) END,
         estado, creado_en, confirmado_en
  FROM inventario_sesiones;

DROP TABLE inventario_sesiones;
ALTER TABLE inventario_sesiones_mig RENAME TO inventario_sesiones;
CREATE INDEX IF NOT EXISTS idx_inv_sesiones_estado ON inventario_sesiones(estado);

-- Bloque congelado + auditoría de cierre por omisión + hallazgo fuera de alcance.
ALTER TABLE inventario_conteos ADD COLUMN bloque TEXT;
ALTER TABLE inventario_conteos ADD COLUMN fuera_de_alcance INTEGER NOT NULL DEFAULT 0;
ALTER TABLE inventario_conteos ADD COLUMN confirmado_por_omision INTEGER NOT NULL DEFAULT 0;
-- Código escaneado que no existe en catalogo_cache (distinto de fuera_de_alcance).
ALTER TABLE inventario_conteos ADD COLUMN codigo_desconocido INTEGER NOT NULL DEFAULT 0;

-- Snapshot del alcance congelado al abrir la sesión (qué SKU entra y en qué bloque).
CREATE TABLE IF NOT EXISTS inventario_sesion_alcance (
  sesion_id           INTEGER NOT NULL,
  sku                 TEXT NOT NULL,
  nombre              TEXT,
  marca               TEXT,
  categoria_principal TEXT,
  stock_inicial       INTEGER NOT NULL DEFAULT 0,
  bloque              TEXT NOT NULL,
  PRIMARY KEY (sesion_id, sku)
);

COMMIT;
