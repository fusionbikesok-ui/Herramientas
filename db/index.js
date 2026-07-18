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
  // Store de sesiones (better-sqlite3-session-store crea su propia tabla 'sessions' al iniciar)

  return db;
}
