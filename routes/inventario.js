import express from 'express';
import { parseCategorias } from '../lib/modelos/producto.js';

const now = () => new Date().toISOString();

// ─── Clasificación EAN/SKU por formato + dígito de control GS1 ───────────────
// Portado tal cual de public/inventario/index.html (kindOf/gtinCheckOk actuales).
function gtinCheckOk(code) {
  const n = code.length;
  let sum = 0;
  for (let i = n - 2; i >= 0; i--) {
    const d = code.charCodeAt(i) - 48;
    const mult = ((n - 2 - i) % 2 === 0) ? 3 : 1;
    sum += d * mult;
  }
  const check = (10 - (sum % 10)) % 10;
  return check === (code.charCodeAt(n - 1) - 48);
}

export function looksLikeEan(code) {
  if (!/^[0-9]+$/.test(code)) return false;
  const n = code.length;
  if (n !== 8 && n !== 12 && n !== 13 && n !== 14) return false;
  return gtinCheckOk(code);
}

// ─── Tablas ───────────────────────────────────────────────────────────────────

export function ensureTables(db) {
  db.prepare(`CREATE TABLE IF NOT EXISTS inventario_sesiones (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    usuario        TEXT NOT NULL,
    categoria      TEXT,
    marca          TEXT,
    estado         TEXT NOT NULL DEFAULT 'abierta',
    creado_en      TEXT NOT NULL,
    confirmado_en  TEXT
  )`).run();
  db.prepare('CREATE INDEX IF NOT EXISTS idx_inv_sesiones_estado ON inventario_sesiones(estado)').run();

  db.prepare(`CREATE TABLE IF NOT EXISTS inventario_conteos (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    sesion_id      INTEGER NOT NULL,
    ean            TEXT NOT NULL,
    sku            TEXT,
    cantidad       INTEGER NOT NULL DEFAULT 0,
    actualizado_en TEXT NOT NULL,
    UNIQUE(sesion_id, ean)
  )`).run();
}

// ─── Router ───────────────────────────────────────────────────────────────────

export function inventarioRouter(db, wooCfg) {
  ensureTables(db);
  const router = express.Router();

  router.get('/alcance-opciones', (req, res) => {
    const rows = db.prepare("SELECT categorias_json, marca FROM catalogo_cache WHERE COALESCE(sku,'')<>''").all();
    const categorias = new Set();
    const marcas = new Set();
    for (const r of rows) {
      for (const c of parseCategorias(r.categorias_json)) if (c) categorias.add(c);
      if (r.marca) marcas.add(r.marca);
    }
    res.json({ ok: true, categorias: [...categorias], marcas: [...marcas] });
  });

  router.get('/sesion-activa', (req, res) => {
    const usuario = req.user?.username;
    const sesion = db.prepare(
      "SELECT * FROM inventario_sesiones WHERE usuario=? AND estado='abierta' ORDER BY id DESC LIMIT 1"
    ).get(usuario);
    res.json({ ok: true, sesion: sesion || null });
  });

  return router;
}
