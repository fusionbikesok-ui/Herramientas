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

  function coincideAlcance(prodCategorias, prodMarca, categoria, marca) {
    const matchCat = categoria ? prodCategorias.includes(categoria) : false;
    const matchMarca = marca ? prodMarca === marca : false;
    if (categoria && marca) return matchCat || matchMarca;
    if (categoria) return matchCat;
    return matchMarca;
  }

  function solapan(a, b) {
    // Dos alcances se solapan si comparten categoría, o comparten marca, o ambos
    // están definidos y cualquiera de los dos coincide (mismo criterio "OR" que
    // usa coincideAlcance para decidir qué producto entra en cada sesión).
    if (a.categoria && b.categoria && a.categoria === b.categoria) return true;
    if (a.marca && b.marca && a.marca === b.marca) return true;
    return false;
  }

  router.post('/sesiones', (req, res) => {
    const usuario = req.user?.username;
    const categoria = String(req.body?.categoria || '').trim() || null;
    const marca = String(req.body?.marca || '').trim() || null;
    if (!categoria && !marca) {
      return res.status(400).json({ ok: false, error: 'Elegí categoría y/o marca para el alcance.' });
    }

    const propia = db.prepare("SELECT id FROM inventario_sesiones WHERE usuario=? AND estado='abierta'").get(usuario);
    if (propia) {
      return res.status(409).json({ ok: false, error: 'Ya tenés una sesión abierta. Retomala o descartala antes de crear otra.' });
    }

    const abiertas = db.prepare("SELECT usuario, categoria, marca FROM inventario_sesiones WHERE estado='abierta'").all();
    const nueva = { categoria, marca };
    const choque = abiertas.find(s => solapan(s, nueva));
    if (choque) {
      return res.status(409).json({
        ok: false,
        error: `El alcance se cruza con la sesión de ${choque.usuario}.`,
        ocupada_por: choque.usuario,
        categoria: choque.categoria,
        marca: choque.marca,
      });
    }

    const id = db.prepare(
      "INSERT INTO inventario_sesiones (usuario, categoria, marca, estado, creado_en) VALUES (?,?,?,'abierta',?)"
    ).run(usuario, categoria, marca, now()).lastInsertRowid;
    const sesion = db.prepare('SELECT * FROM inventario_sesiones WHERE id=?').get(id);
    res.json({ ok: true, sesion });
  });

  function getSesion(id, usuario) {
    const sesion = db.prepare('SELECT * FROM inventario_sesiones WHERE id=?').get(id);
    if (!sesion || sesion.usuario !== usuario) return null;
    return sesion;
  }

  router.get('/sesiones/:id', (req, res) => {
    const sesion = getSesion(req.params.id, req.user?.username);
    if (!sesion) return res.status(404).json({ ok: false, error: 'Sesión no encontrada' });

    const conteos = db.prepare('SELECT * FROM inventario_conteos WHERE sesion_id=?').all(sesion.id);
    const items = conteos.map(c => {
      const prod = c.sku ? db.prepare('SELECT stock, nombre FROM catalogo_cache WHERE sku=?').get(c.sku) : null;
      return {
        id: c.id, ean: c.ean, sku: c.sku, cantidad: c.cantidad,
        nombre: prod?.nombre || null,
        stock_woo: prod ? prod.stock : null,
        diferencia: prod ? c.cantidad - prod.stock : null,
      };
    });

    const skusContados = new Set(items.map(i => i.sku).filter(Boolean));
    const catalogo = db.prepare("SELECT sku, nombre, stock, categorias_json, marca FROM catalogo_cache WHERE COALESCE(sku,'')<>'' AND tipo<>'variable'").all();
    const pendientes = catalogo
      .filter(p => coincideAlcance(parseCategorias(p.categorias_json), p.marca, sesion.categoria, sesion.marca))
      .filter(p => !skusContados.has(p.sku))
      .map(p => ({ sku: p.sku, nombre: p.nombre, stock_woo: p.stock }));

    res.json({ ok: true, sesion, items, pendientes });
  });

  return router;
}
