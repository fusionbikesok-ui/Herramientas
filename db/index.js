import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function openDb(dbPath) {
  const dir = path.dirname(dbPath);
  if (dir !== '.' && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const db = new Database(dbPath);
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  db.exec(schema);
  // Incremental migrations — safe to run every startup
  try { db.exec('ALTER TABLE catalogo_cache ADD COLUMN categorias_json TEXT'); } catch (_) {}
  try { db.exec('ALTER TABLE catalogo_cache ADD COLUMN img TEXT'); } catch (_) {}
  try { db.exec('ALTER TABLE catalogo_cache ADD COLUMN precio REAL'); } catch (_) {}
  // Precio de LISTA de Woo (regular_price), separado del vigente (precio, que puede ser
  // sale_price si el producto está en oferta). El contado de una venta ML se calcula
  // siempre sobre LISTA (decisión del usuario, 2026-08-03) — ver precioContado() en
  // routes/sync.js. Queda NULL hasta el próximo refresco de catálogo tras desplegar esto.
  try { db.exec('ALTER TABLE catalogo_cache ADD COLUMN regular_price REAL'); } catch (_) {}
  // Atributos estructurados de la variación WC (color/talle) — evita re-parsear el nombre en el matcher.
  try { db.exec('ALTER TABLE catalogo_cache ADD COLUMN atributos_json TEXT'); } catch (_) {}
  try { db.exec('ALTER TABLE catalogo_cache ADD COLUMN marca TEXT'); } catch (_) {}
  // Código universal (GTIN/EAN/UPC) del producto — campo nativo de Woo global_unique_id.
  try { db.exec('ALTER TABLE catalogo_cache ADD COLUMN gtin TEXT'); } catch (_) {}
  // Consulta de Precios ── puente EAN→SKU (el EAN no vive en Woo); aprende de a uno.
  try { db.exec(`CREATE TABLE IF NOT EXISTS ean_sku (
    ean TEXT PRIMARY KEY,
    sku TEXT NOT NULL,
    actualizado_en TEXT NOT NULL
  )`); } catch (_) {}
  try { db.exec('ALTER TABLE recepciones ADD COLUMN confirmado_en TEXT'); } catch (_) {}
  try { db.exec(`CREATE TABLE IF NOT EXISTS skus_config_ml (
    sku TEXT PRIMARY KEY,
    nombre TEXT,
    modo TEXT NOT NULL DEFAULT 'reserva',
    reserva INTEGER NOT NULL DEFAULT 0,
    actualizado_en TEXT NOT NULL
  )`); } catch (_) {}
  try { db.exec(`CREATE TABLE IF NOT EXISTS ordenes_ml_wc_pedidos (
    ml_order_id TEXT PRIMARY KEY,
    wc_order_id INTEGER NOT NULL,
    comprador_json TEXT,
    creado_en TEXT NOT NULL
  )`); } catch (_) {}
  try { db.exec('ALTER TABLE ordenes_ml_wc_pedidos ADD COLUMN cancelado_en TEXT'); } catch (_) {}
  try { db.exec('ALTER TABLE ordenes_ml_wc_pedidos ADD COLUMN retenido_en TEXT'); } catch (_) {}
  try { db.exec(`CREATE TABLE IF NOT EXISTS ml_publicaciones_cache (
    clave TEXT PRIMARY KEY,
    item_id TEXT NOT NULL,
    variation_id TEXT,
    titulo TEXT,
    status TEXT,
    es_variante INTEGER NOT NULL DEFAULT 0,
    color TEXT,
    talle TEXT,
    seller_sku TEXT,
    variations_texto TEXT,
    actualizado_en TEXT NOT NULL
  )`); } catch (_) {}
  try { db.exec('ALTER TABLE ml_publicaciones_cache ADD COLUMN sub_status TEXT'); } catch (_) {}
  try { db.exec('ALTER TABLE ml_publicaciones_cache ADD COLUMN thumbnail TEXT'); } catch (_) {}
  try { db.exec('ALTER TABLE ml_publicaciones_cache ADD COLUMN permalink TEXT'); } catch (_) {}
  try { db.exec('ALTER TABLE ml_publicaciones_cache ADD COLUMN catalogo INTEGER'); } catch (_) {}

  // Precio y stock de ML cacheados en el mismo barrido del matcher (el multiget ya trae el
  // item completo). Habilitan el listado de vínculos sospechosos como query local, sin una
  // llamada a la API por publicación. precio_actualizado_en permite mostrar la antigüedad
  // del dato en la UI en vez de fingir que es en vivo.
  try { db.exec('ALTER TABLE ml_publicaciones_cache ADD COLUMN precio REAL'); } catch (_) {}
  try { db.exec('ALTER TABLE ml_publicaciones_cache ADD COLUMN available_quantity INTEGER'); } catch (_) {}
  try { db.exec('ALTER TABLE ml_publicaciones_cache ADD COLUMN precio_actualizado_en TEXT'); } catch (_) {}

  // Publicaciones que recuperaron stock pero la reactivación automática NO reactivó porque
  // el neto de ML quedaría por debajo del precio de contado. Se limpia sola: cuando el precio
  // pasa el chequeo, se reactiva y se borra la fila.
  try { db.exec(`CREATE TABLE IF NOT EXISTS ml_reactivacion_frenada (
    clave TEXT PRIMARY KEY,
    sku TEXT,
    motivo TEXT,
    neto REAL,
    precio_contado REAL,
    deficit_pct REAL,
    detectado_en TEXT NOT NULL
  )`); } catch (_) {}

  // Descartes de vínculos sospechosos ("revisado OK"). Guarda el VALOR descartado, no solo la
  // clave: si el dato cambia (ej. el precio de ML se mueve otra vez), el sospechoso reaparece.
  // PK compuesta porque una publicación puede tener una señal descartada y otra vigente.
  try { db.exec(`CREATE TABLE IF NOT EXISTS ml_vinculos_revisados (
    clave TEXT NOT NULL,
    senal TEXT NOT NULL,
    valor_revisado TEXT,
    revisado_por TEXT,
    revisado_en TEXT NOT NULL,
    PRIMARY KEY (clave, senal)
  )`); } catch (_) {}

  // Auditoría de precios ML: neto (precio − comisión − envío) vs precio web por publicación.
  try { db.exec(`CREATE TABLE IF NOT EXISTS ml_precio_auditoria (
    clave TEXT PRIMARY KEY,
    item_id TEXT NOT NULL,
    titulo TEXT,
    sku TEXT,
    precio_ml REAL,
    sale_fee REAL,
    envio REAL,
    neto REAL,
    precio_web REAL,
    deficit_pct REAL,
    estado TEXT,
    actualizado_en TEXT NOT NULL
  )`); } catch (_) {}

  // Errores de sync descartados a mano (no accionables: sin stock real, pausa manual, etc.)
  try { db.exec(`CREATE TABLE IF NOT EXISTS errores_descartados (
    clave TEXT PRIMARY KEY,
    motivo TEXT,
    creado_en TEXT NOT NULL
  )`); } catch (_) {}

  // Cobertura ── productos WC marcados a mano como "solo local" (no deben publicarse en ML)
  try { db.exec(`CREATE TABLE IF NOT EXISTS cobertura_exclusiones (
    id_woo INTEGER PRIMARY KEY,
    sku TEXT,
    nombre TEXT,
    motivo TEXT NOT NULL DEFAULT 'solo_local',
    creado_en TEXT NOT NULL
  )`); } catch (_) {}

  // Gestor de usuarios ── cuentas + permisos por herramienta
  try { db.exec(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    pass_hash TEXT NOT NULL,
    is_admin INTEGER NOT NULL DEFAULT 0,
    activo INTEGER NOT NULL DEFAULT 1,
    email TEXT,
    creado_en TEXT NOT NULL,
    actualizado_en TEXT NOT NULL
  )`); } catch (_) {}
  // Migración: agregar email a users si existe sin esa columna
  try { db.exec('ALTER TABLE users ADD COLUMN email TEXT'); } catch (_) {}
  // Tokens de reset de contraseña (un solo uso, expiran en 1h)
  try { db.exec(`CREATE TABLE IF NOT EXISTS password_reset_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    token TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    used INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`); } catch (_) {}
  try { db.exec(`CREATE TABLE IF NOT EXISTS user_permisos (
    user_id INTEGER NOT NULL,
    herramienta TEXT NOT NULL,
    nivel TEXT NOT NULL DEFAULT 'write',
    PRIMARY KEY (user_id, herramienta),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`); } catch (_) {}
  // Matcher: push automático de SKU a ML — fallos por publicación (backoff exponencial,
  // ver migrations/002_ml_sku_push_fallos.sql y lib/matcherPush.js).
  try { db.exec(`CREATE TABLE IF NOT EXISTS ml_sku_push_fallos (
    clave              TEXT PRIMARY KEY,
    sku                TEXT NOT NULL,
    intentos           INTEGER NOT NULL DEFAULT 0,
    ultimo_error       TEXT,
    ultimo_status      INTEGER,
    proximo_intento_en TEXT,
    actualizado_en     TEXT NOT NULL
  )`); } catch (_) {}

  // Caché persistente de comisión/envío de ML (ver migrations/004_ml_precios_cache.sql y
  // lib/mlPrecios.js) — evita repetir listing_prices/shipping_options/free que dan siempre
  // el mismo valor dentro de la ventana de vigencia (7 días, aplicado en código).
  try { db.exec(`CREATE TABLE IF NOT EXISTS ml_precios_cache (
    clave          TEXT PRIMARY KEY,
    valor          REAL NOT NULL,
    actualizado_en TEXT NOT NULL
  )`); } catch (_) {}

  // Último status conocido de cada envío ML (ver migrations/006_ml_shipment_estado.sql y
  // routes/preparacion.js#pendientesMl) — un envío en estado terminal (shipped/delivered/
  // cancelled) no vuelve nunca a ready_to_ship, así que dejamos de repreguntar su GET
  // /shipments/:id en cada corrida mientras el cacheo sea reciente (< 7 días).
  try { db.exec(`CREATE TABLE IF NOT EXISTS ml_shipment_estado (
    shipment_id    TEXT PRIMARY KEY,
    status         TEXT NOT NULL,
    logistic_type  TEXT,
    actualizado_en TEXT NOT NULL
  )`); } catch (_) {}

  // Insumos con los que se tomó la decisión de frenar una reactivación por precio (ver
  // migrations/005_reactivacion_frenada_insumos.sql): permiten re-evaluar localmente sin
  // pegarle a ML cuando ninguno de los dos precios cambió desde que se detectó la frenada.
  try { db.exec('ALTER TABLE ml_reactivacion_frenada ADD COLUMN precio_ml_evaluado REAL'); } catch (_) {}
  try { db.exec('ALTER TABLE ml_reactivacion_frenada ADD COLUMN precio_web_evaluado REAL'); } catch (_) {}

  // Store de sesiones (better-sqlite3-session-store crea su propia tabla 'sessions' al iniciar)

  // Cobertura accionable (migrations/007_cobertura_cola.sql) — ver ese archivo para el porqué
  // de qué SÍ y qué NO tiene tabla propia (vinculado/descartado reutilizan tablas existentes).
  try { db.exec(`CREATE TABLE IF NOT EXISTS cobertura_hay_que_publicar (
    id_woo INTEGER PRIMARY KEY,
    sku TEXT,
    nombre TEXT,
    marca TEXT,
    valor REAL,
    tachado INTEGER NOT NULL DEFAULT 0,
    creado_en TEXT NOT NULL
  )`); } catch (_) {}
  try { db.exec(`CREATE TABLE IF NOT EXISTS cobertura_salteados (
    id_woo INTEGER PRIMARY KEY,
    marca TEXT,
    creado_en TEXT NOT NULL
  )`); } catch (_) {}
  try { db.exec(`CREATE TABLE IF NOT EXISTS cobertura_sesion (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    marca_actual TEXT,
    actualizado_en TEXT NOT NULL
  )`); } catch (_) {}
  try { db.exec(`CREATE TABLE IF NOT EXISTS cobertura_marcados_correcto (
    clave TEXT PRIMARY KEY,
    seccion TEXT NOT NULL,
    marcado_en TEXT NOT NULL
  )`); } catch (_) {}

  // migrations/008_decisiones_origen.sql — distingue decisiones de Cobertura vs Matcher ML→WC.
  try { db.exec('ALTER TABLE sku_matcher_decisiones ADD COLUMN origen TEXT'); } catch (_) {}

  return db;
}
