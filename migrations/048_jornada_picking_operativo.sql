-- E1: estados operativos, zonas, ayuda física, mesa y auditoría.
-- La aplicación de esta migración queda a cargo del runner de base; las rutas
-- mantienen ensureTablesJornada para instalaciones legacy que aún no la ejecutaron.
-- Las columnas se agregan de forma inspeccionada por el runner de db/index.js y
-- también por ensureTablesJornada(). Este archivo queda compuesto únicamente por
-- DDL reanudable para no fallar si el proceso se interrumpe después de una columna.

CREATE TABLE IF NOT EXISTS warehouse_pick_zones (
  id INTEGER PRIMARY KEY AUTOINCREMENT, nombre TEXT NOT NULL UNIQUE,
  activa INTEGER NOT NULL DEFAULT 1, verificada INTEGER NOT NULL DEFAULT 0,
  creado_por TEXT NOT NULL, creado_en TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS pick_wave_helpers (
  id INTEGER PRIMARY KEY AUTOINCREMENT, pick_wave_id INTEGER NOT NULL, zona_id INTEGER NOT NULL,
  ayudante TEXT NOT NULL, solicitado_por TEXT NOT NULL, estado TEXT NOT NULL DEFAULT 'solicitada',
  pedido_en_mesa_por TEXT, pedido_en_mesa_en TEXT, operation_id TEXT NOT NULL UNIQUE,
  creado_en TEXT NOT NULL, actualizado_en TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS pick_wave_assignments (
  id INTEGER PRIMARY KEY AUTOINCREMENT, pick_wave_id INTEGER NOT NULL, pedido_clave TEXT NOT NULL,
  sku TEXT NOT NULL, cantidad INTEGER NOT NULL CHECK(cantidad > 0), zona_id INTEGER,
  asignado_por TEXT NOT NULL, operation_id TEXT NOT NULL UNIQUE, creado_en TEXT NOT NULL,
  expected_version INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS pick_wave_shortages (
  id INTEGER PRIMARY KEY AUTOINCREMENT, pick_wave_id INTEGER NOT NULL, pedido_clave TEXT NOT NULL,
  sku TEXT NOT NULL, motivo TEXT NOT NULL, nota TEXT, registrado_por TEXT NOT NULL,
  operation_id TEXT NOT NULL UNIQUE, creado_en TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS pick_wave_returns (
  id INTEGER PRIMARY KEY AUTOINCREMENT, pick_wave_id INTEGER NOT NULL,
  pedido_clave TEXT NOT NULL, sku TEXT NOT NULL, zona_id INTEGER,
  estado TEXT NOT NULL DEFAULT 'pendiente', operation_id TEXT NOT NULL UNIQUE,
  creado_por TEXT NOT NULL, creado_en TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS operational_day_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, operational_day_id INTEGER NOT NULL, pick_wave_id INTEGER,
  tipo TEXT NOT NULL, usuario TEXT NOT NULL, operation_id TEXT NOT NULL UNIQUE,
  antes_json TEXT, despues_json TEXT, detalle_json TEXT NOT NULL, creado_en TEXT NOT NULL
);
