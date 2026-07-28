import express from 'express';
import { parseCategorias } from '../lib/modelos/producto.js';
import { setStockWc } from '../lib/wooStock.js';

const now = () => new Date().toISOString();

// Umbral de "alcance grande" (decisión de producto): por encima de esto el frontend
// muestra un aviso antes de abrir la sesión. Solo informativo, nunca bloquea.
export const UMBRAL_ALCANCE_GRANDE = 300;

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

// ─── Alcance ─────────────────────────────────────────────────────────────────

// Normaliza cualquier forma de selección (array, string legado, null) a un array
// de strings sin duplicados ni vacíos. Tolera el formato viejo (columna string)
// para no romper sesiones abiertas antes de la migración a arrays.
export function parseLista(valor) {
  const crudo = Array.isArray(valor)
    ? valor
    : (valor == null ? [] : (() => {
      const s = String(valor).trim();
      if (!s) return [];
      if (s.startsWith('[')) {
        try {
          const a = JSON.parse(s);
          return Array.isArray(a) ? a : [];
        } catch (_) { return []; }
      }
      return [s];
    })());
  const limpio = crudo.map(v => String(v ?? '').trim()).filter(Boolean);
  return [...new Set(limpio)];
}

/**
 * ¿Este producto entra en el alcance elegido por el usuario para SU sesión?
 *
 * Semántica: OR **dentro** de cada dimensión (cualquiera de las categorías
 * elegidas / cualquiera de las marcas elegidas) y AND **entre** dimensiones
 * cuando ambas tienen selección: si elijo categoría "Cascos" Y marca "Bell",
 * quiero solo cascos Bell — no cualquier casco ni cualquier producto Bell.
 *
 * Esta es la función que define los `pendientes` de una sesión. NO se usa para
 * detectar solape entre sesiones de distintos usuarios (ver `productoEnAlcanceOr`).
 */
export function productoEnAlcance(prodCategorias, prodMarca, categoriasSel, marcasSel) {
  const cats = parseLista(categoriasSel);
  const marcas = parseLista(marcasSel);
  if (!cats.length && !marcas.length) return false;
  const prodCats = Array.isArray(prodCategorias) ? prodCategorias : parseCategorias(prodCategorias);
  const matchCat = cats.some(c => prodCats.includes(c));
  const matchMarca = marcas.some(m => prodMarca === m);
  if (cats.length && marcas.length) return matchCat && matchMarca;
  return cats.length ? matchCat : matchMarca;
}

/**
 * Variante OR — INTENCIONAL y distinta de `productoEnAlcance`: se usa SOLO para
 * detectar solape entre sesiones de distintos usuarios. Para el anti-solape
 * queremos ser conservadores: si una sesión declaró "Cascos" y otra "Bell", un
 * "Casco Bell" cae potencialmente en las dos y hay que bloquear. Achicar esto a
 * AND permitiría que dos personas cuenten el mismo producto físico. NO TOCAR.
 */
export function productoEnAlcanceOr(prodCategorias, prodMarca, categoriasSel, marcasSel) {
  const cats = parseLista(categoriasSel);
  const marcas = parseLista(marcasSel);
  const prodCats = Array.isArray(prodCategorias) ? prodCategorias : parseCategorias(prodCategorias);
  const matchCat = cats.some(c => prodCats.includes(c));
  const matchMarca = marcas.some(m => prodMarca === m);
  return matchCat || matchMarca;
}

// ─── Tablas + migración ──────────────────────────────────────────────────────

function tieneColumna(db, tabla, columna) {
  return db.prepare(`PRAGMA table_info(${tabla})`).all().some(c => c.name === columna);
}

/**
 * Migración 001: inventario_sesiones.categoria/marca (TEXT string) →
 * categorias/marcas (TEXT con JSON array). Backfill envolviendo el valor viejo
 * en un array de un elemento (`"Cascos"` → `["Cascos"]`, null/'' → `[]`).
 * sqlite no soporta ALTER COLUMN, así que se rebuildea la tabla (patrón
 * crear-copiar-renombrar). Idempotente: solo corre si existe la columna vieja.
 * Ver migrations/001_inventario_sesiones_alcance_multi.sql
 */
export function migrarSesionesAlcanceMulti(db) {
  if (!tieneColumna(db, 'inventario_sesiones', 'categoria')) return false;
  db.exec(`
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
  `);
  return true;
}

export function ensureTables(db) {
  db.prepare(`CREATE TABLE IF NOT EXISTS inventario_sesiones (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    usuario        TEXT NOT NULL,
    categorias     TEXT NOT NULL DEFAULT '[]',
    marcas         TEXT NOT NULL DEFAULT '[]',
    estado         TEXT NOT NULL DEFAULT 'abierta',
    creado_en      TEXT NOT NULL,
    confirmado_en  TEXT
  )`).run();
  migrarSesionesAlcanceMulti(db);
  db.prepare('CREATE INDEX IF NOT EXISTS idx_inv_sesiones_estado ON inventario_sesiones(estado)').run();

  db.prepare(`CREATE TABLE IF NOT EXISTS inventario_conteos (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    sesion_id      INTEGER NOT NULL,
    ean            TEXT NOT NULL,
    sku            TEXT,
    cantidad       INTEGER NOT NULL DEFAULT 0,
    bloque         TEXT,
    fuera_de_alcance INTEGER NOT NULL DEFAULT 0,
    confirmado_por_omision INTEGER NOT NULL DEFAULT 0,
    ajustado_en    TEXT,
    actualizado_en TEXT NOT NULL,
    UNIQUE(sesion_id, ean)
  )`).run();
  // Migraciones incrementales (tablas ya creadas por versiones anteriores)
  try { db.exec('ALTER TABLE inventario_conteos ADD COLUMN bloque TEXT'); } catch (_) {}
  try { db.exec('ALTER TABLE inventario_conteos ADD COLUMN fuera_de_alcance INTEGER NOT NULL DEFAULT 0'); } catch (_) {}
  try { db.exec('ALTER TABLE inventario_conteos ADD COLUMN confirmado_por_omision INTEGER NOT NULL DEFAULT 0'); } catch (_) {}

  // Snapshot del alcance CONGELADO al abrir la sesión: qué SKUs entran y en qué
  // bloque (con_stock / sin_stock). Se congela acá y no se recalcula, para que un
  // ítem no salte de bloque a mitad del conteo si el stock cambia por otra vía.
  db.prepare(`CREATE TABLE IF NOT EXISTS inventario_sesion_alcance (
    sesion_id           INTEGER NOT NULL,
    sku                 TEXT NOT NULL,
    nombre              TEXT,
    marca               TEXT,
    categoria_principal TEXT,
    stock_inicial       INTEGER NOT NULL DEFAULT 0,
    bloque              TEXT NOT NULL,
    PRIMARY KEY (sesion_id, sku)
  )`).run();
}

// ─── Router ───────────────────────────────────────────────────────────────────

export function inventarioRouter(db, wooCfg) {
  ensureTables(db);
  const router = express.Router();

  // Base de catálogo contable: mismo criterio en opciones, preview, snapshot y
  // pendientes — así el preview coincide exactamente con lo que se abre después.
  const SQL_CATALOGO_CONTABLE =
    "SELECT sku, nombre, stock, categorias_json, marca FROM catalogo_cache WHERE COALESCE(sku,'')<>'' AND COALESCE(tipo,'')<>'variable'";

  const catalogoContable = () => db.prepare(SQL_CATALOGO_CONTABLE).all();

  function sesionOut(sesion) {
    if (!sesion) return null;
    return { ...sesion, categorias: parseLista(sesion.categorias), marcas: parseLista(sesion.marcas) };
  }

  router.get('/alcance-opciones', (req, res) => {
    const rows = catalogoContable();
    const categorias = new Map();
    const marcas = new Map();
    for (const r of rows) {
      for (const c of parseCategorias(r.categorias_json)) {
        if (c) categorias.set(c, (categorias.get(c) || 0) + 1);
      }
      if (r.marca) marcas.set(r.marca, (marcas.get(r.marca) || 0) + 1);
    }
    const aLista = m => [...m.entries()]
      .map(([nombre, productos]) => ({ nombre, productos }))
      .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
    res.json({ ok: true, categorias: aLista(categorias), marcas: aLista(marcas) });
  });

  // Preview del alcance ANTES de abrir la sesión. Usa productoEnAlcance() — la
  // misma función que arma los pendientes — así lo que se muestra acá es
  // exactamente lo que se va a contar.
  router.post('/alcance-preview', (req, res) => {
    const categorias = parseLista(req.body?.categorias ?? req.body?.categoria);
    const marcas = parseLista(req.body?.marcas ?? req.body?.marca);
    if (!categorias.length && !marcas.length) {
      return res.json({
        ok: true, categorias, marcas, productos: 0, unidades_esperadas: 0,
        con_stock: { productos: 0, unidades: 0 }, sin_stock: { productos: 0 },
        umbral: UMBRAL_ALCANCE_GRANDE, supera_umbral: false,
      });
    }
    const enAlcance = catalogoContable()
      .filter(p => productoEnAlcance(parseCategorias(p.categorias_json), p.marca, categorias, marcas));
    const conStock = enAlcance.filter(p => (p.stock || 0) > 0);
    const unidades = conStock.reduce((a, p) => a + (p.stock || 0), 0);
    res.json({
      ok: true,
      categorias, marcas,
      productos: enAlcance.length,
      unidades_esperadas: unidades,
      con_stock: { productos: conStock.length, unidades },
      sin_stock: { productos: enAlcance.length - conStock.length },
      umbral: UMBRAL_ALCANCE_GRANDE,
      supera_umbral: enAlcance.length > UMBRAL_ALCANCE_GRANDE,
    });
  });

  router.get('/sesion-activa', (req, res) => {
    const usuario = req.user?.username;
    const sesion = db.prepare(
      "SELECT * FROM inventario_sesiones WHERE usuario=? AND estado='abierta' ORDER BY id DESC LIMIT 1"
    ).get(usuario);
    res.json({ ok: true, sesion: sesionOut(sesion) });
  });

  // SKUs que entran en un alcance dado con la semántica OR — SOLO para anti-solape.
  function skusDeAlcanceOr(categorias, marcas) {
    const catalogo = db.prepare("SELECT sku, categorias_json, marca FROM catalogo_cache WHERE COALESCE(sku,'')<>''").all();
    return new Set(
      catalogo
        .filter(p => productoEnAlcanceOr(parseCategorias(p.categorias_json), p.marca, categorias, marcas))
        .map(p => p.sku)
    );
  }

  // Dos alcances se solapan si existe AL MENOS UN producto real que entra en ambos —
  // no alcanza con comparar categoría-con-categoría/marca-con-marca de forma literal,
  // porque una sesión "categoria=Cascos" y otra "marca=Bell" pueden compartir productos
  // (ej. "Casco Bell") sin que ningún campo coincida literalmente entre las dos.
  // Semántica OR intencional (conservadora): se mantiene sin cambios.
  function sesionesSolapan(a, b) {
    const skusA = skusDeAlcanceOr(a.categorias, a.marcas);
    if (!skusA.size) return false;
    for (const sku of skusDeAlcanceOr(b.categorias, b.marcas)) {
      if (skusA.has(sku)) return true;
    }
    return false;
  }

  const insertAlcance = db.prepare(`INSERT OR IGNORE INTO inventario_sesion_alcance
    (sesion_id, sku, nombre, marca, categoria_principal, stock_inicial, bloque) VALUES (?,?,?,?,?,?,?)`);

  // Congela el alcance de la sesión (qué SKUs y en qué bloque). Se llama al crear
  // la sesión; también de forma perezosa al leer una sesión abierta creada antes
  // de esta versión (o migrada desde el esquema string), para no romperlas.
  function congelarAlcance(sesionId, categorias, marcas) {
    const enAlcance = catalogoContable()
      .filter(p => productoEnAlcance(parseCategorias(p.categorias_json), p.marca, categorias, marcas));
    const escribir = db.transaction(filas => {
      for (const p of filas) {
        const stock = p.stock || 0;
        insertAlcance.run(
          sesionId, p.sku, p.nombre, p.marca,
          parseCategorias(p.categorias_json)[0] || null,
          stock, stock > 0 ? 'con_stock' : 'sin_stock'
        );
      }
    });
    escribir(enAlcance);
    return enAlcance.length;
  }

  function asegurarAlcance(sesion) {
    const n = db.prepare('SELECT COUNT(*) n FROM inventario_sesion_alcance WHERE sesion_id=?').get(sesion.id).n;
    if (n === 0) congelarAlcance(sesion.id, parseLista(sesion.categorias), parseLista(sesion.marcas));
  }

  router.post('/sesiones', (req, res) => {
    const usuario = req.user?.username;
    // Acepta el formato nuevo (arrays) y el viejo (string suelto) por compatibilidad.
    const categorias = parseLista(req.body?.categorias ?? req.body?.categoria);
    const marcas = parseLista(req.body?.marcas ?? req.body?.marca);
    if (!categorias.length && !marcas.length) {
      return res.status(400).json({ ok: false, error: 'Elegí categoría y/o marca para el alcance.' });
    }

    const propia = db.prepare("SELECT id FROM inventario_sesiones WHERE usuario=? AND estado='abierta'").get(usuario);
    if (propia) {
      return res.status(409).json({ ok: false, error: 'Ya tenés una sesión abierta. Retomala o descartala antes de crear otra.' });
    }

    const abiertas = db.prepare("SELECT usuario, categorias, marcas FROM inventario_sesiones WHERE estado='abierta'").all();
    const nueva = { categorias, marcas };
    const choque = abiertas.find(s => sesionesSolapan(s, nueva));
    if (choque) {
      return res.status(409).json({
        ok: false,
        error: `El alcance se cruza con la sesión de ${choque.usuario}.`,
        ocupada_por: choque.usuario,
        categorias: parseLista(choque.categorias),
        marcas: parseLista(choque.marcas),
      });
    }

    const id = db.prepare(
      "INSERT INTO inventario_sesiones (usuario, categorias, marcas, estado, creado_en) VALUES (?,?,?,'abierta',?)"
    ).run(usuario, JSON.stringify(categorias), JSON.stringify(marcas), now()).lastInsertRowid;
    congelarAlcance(id, categorias, marcas);
    const sesion = db.prepare('SELECT * FROM inventario_sesiones WHERE id=?').get(id);
    res.json({ ok: true, sesion: sesionOut(sesion) });
  });

  function getSesion(id, usuario) {
    const sesion = db.prepare('SELECT * FROM inventario_sesiones WHERE id=?').get(id);
    if (!sesion || sesion.usuario !== usuario) return null;
    return sesion;
  }

  router.get('/sesiones/:id', (req, res) => {
    const sesion = getSesion(req.params.id, req.user?.username);
    if (!sesion) return res.status(404).json({ ok: false, error: 'Sesión no encontrada' });
    asegurarAlcance(sesion);

    const conteos = db.prepare('SELECT * FROM inventario_conteos WHERE sesion_id=? ORDER BY id').all(sesion.id);
    const items = conteos.map(c => {
      const prod = c.sku ? db.prepare('SELECT stock, nombre FROM catalogo_cache WHERE sku=?').get(c.sku) : null;
      return {
        id: c.id, ean: c.ean, sku: c.sku, cantidad: c.cantidad,
        nombre: prod?.nombre || null,
        stock_woo: prod ? prod.stock : null,
        diferencia: prod ? c.cantidad - prod.stock : null,
        bloque: c.bloque || null,
        fuera_de_alcance: !!c.fuera_de_alcance,
        confirmado_por_omision: !!c.confirmado_por_omision,
      };
    });

    const skusContados = new Set(items.map(i => i.sku).filter(Boolean));
    // Orden: primero con stock, después por categoría → marca → nombre. El bloque
    // viene congelado del snapshot, no se recalcula contra el stock actual.
    const pendientes = db.prepare(`
      SELECT a.sku, a.nombre, a.bloque, a.stock_inicial, a.marca, a.categoria_principal, c.stock AS stock_actual
      FROM inventario_sesion_alcance a
      LEFT JOIN catalogo_cache c ON c.sku = a.sku
      WHERE a.sesion_id = ?
      ORDER BY CASE a.bloque WHEN 'con_stock' THEN 0 ELSE 1 END,
               COALESCE(a.categoria_principal,'') COLLATE NOCASE,
               COALESCE(a.marca,'') COLLATE NOCASE,
               COALESCE(a.nombre,'') COLLATE NOCASE
    `).all(sesion.id)
      .filter(p => !skusContados.has(p.sku))
      .map(p => ({
        sku: p.sku,
        nombre: p.nombre,
        bloque: p.bloque,
        marca: p.marca,
        categoria_principal: p.categoria_principal,
        stock_inicial: p.stock_inicial,
        stock_woo: p.stock_actual ?? p.stock_inicial,
      }));

    res.json({
      ok: true,
      sesion: sesionOut(sesion),
      items,
      pendientes,
      resumen: {
        pendientes_con_stock: pendientes.filter(p => p.bloque === 'con_stock').length,
        pendientes_sin_stock: pendientes.filter(p => p.bloque === 'sin_stock').length,
        fuera_de_alcance: items.filter(i => i.fuera_de_alcance).length,
      },
    });
  });

  router.post('/sesiones/:id/escanear', (req, res) => {
    const sesion = getSesion(req.params.id, req.user?.username);
    if (!sesion) return res.status(404).json({ ok: false, error: 'Sesión no encontrada' });
    if (sesion.estado !== 'abierta') return res.status(400).json({ ok: false, error: 'La sesión no está abierta' });
    asegurarAlcance(sesion);

    const codigo = String(req.body?.codigo || '').trim();
    if (!codigo) return res.status(400).json({ ok: false, error: 'Código requerido' });

    let ean, sku;
    if (looksLikeEan(codigo)) {
      ean = codigo;
      const catalogado = db.prepare('SELECT sku FROM catalogo_cache WHERE gtin=?').get(ean)
        || db.prepare('SELECT sku FROM ean_sku WHERE ean=?').get(ean);
      sku = catalogado?.sku || null;
    } else {
      ean = codigo; // se guarda igual como "código leído" aunque sea SKU, para tener una clave única por fila
      sku = codigo;
    }

    // Hallazgo fuera de alcance: se registra y se avisa, pero NO se descarta el
    // escaneo ni se bloquea el flujo (y no cambia nada de la escritura a Woo).
    // Se congela al momento del escaneo, igual que el bloque.
    const enAlcance = sku
      ? db.prepare('SELECT bloque FROM inventario_sesion_alcance WHERE sesion_id=? AND sku=?').get(sesion.id, sku)
      : null;
    const fueraDeAlcance = sku && !enAlcance ? 1 : 0;

    const existente = db.prepare('SELECT * FROM inventario_conteos WHERE sesion_id=? AND ean=?').get(sesion.id, ean);
    let itemId;
    if (existente) {
      db.prepare('UPDATE inventario_conteos SET cantidad=cantidad+1, actualizado_en=? WHERE id=?').run(now(), existente.id);
      itemId = existente.id;
    } else {
      itemId = db.prepare(
        'INSERT INTO inventario_conteos (sesion_id, ean, sku, cantidad, bloque, fuera_de_alcance, actualizado_en) VALUES (?,?,?,1,?,?,?)'
      ).run(sesion.id, ean, sku, enAlcance?.bloque || null, fueraDeAlcance, now()).lastInsertRowid;
    }
    const item = db.prepare('SELECT * FROM inventario_conteos WHERE id=?').get(itemId);
    res.json({
      ok: true,
      item: { ...item, sin_asociar: !item.sku, fuera_de_alcance: !!item.fuera_de_alcance },
    });
  });

  router.post('/sesiones/:id/asociar', (req, res) => {
    const sesion = getSesion(req.params.id, req.user?.username);
    if (!sesion) return res.status(404).json({ ok: false, error: 'Sesión no encontrada' });
    if (sesion.estado !== 'abierta') return res.status(400).json({ ok: false, error: 'La sesión no está abierta' });

    const ean = String(req.body?.ean || '').trim();
    const sku = String(req.body?.sku || '').trim();
    const prod = db.prepare("SELECT sku FROM catalogo_cache WHERE sku=?").get(sku);
    if (!prod) return res.status(400).json({ ok: false, error: `SKU "${sku}" no está en el catálogo` });

    // Fail-closed: si no hay ningún ítem escaneado con ese EAN en esta sesión, no
    // sembramos ean_sku ni hacemos nada — "enseñar EAN sin ítem" es otro caso de uso,
    // no el de asociar dentro de un conteo. Chequeamos con el UPDATE mismo (.changes)
    // para evitar una carrera entre el SELECT previo y el UPDATE.
    const alcance = db.prepare('SELECT bloque FROM inventario_sesion_alcance WHERE sesion_id=? AND sku=?').get(sesion.id, sku);
    const cambio = db.prepare('UPDATE inventario_conteos SET sku=?, bloque=?, fuera_de_alcance=?, actualizado_en=? WHERE sesion_id=? AND ean=?')
      .run(sku, alcance?.bloque || null, alcance ? 0 : 1, now(), sesion.id, ean);
    if (cambio.changes === 0) {
      return res.status(404).json({ ok: false, error: 'No hay ningún ítem escaneado con ese EAN en esta sesión' });
    }

    db.prepare(`
      INSERT INTO ean_sku (ean, sku, actualizado_en) VALUES (?,?,?)
      ON CONFLICT(ean) DO UPDATE SET sku=excluded.sku, actualizado_en=excluded.actualizado_en
    `).run(ean, sku, now());

    const item = db.prepare('SELECT * FROM inventario_conteos WHERE sesion_id=? AND ean=?').get(sesion.id, ean);
    res.json({ ok: true, item: { ...item, fuera_de_alcance: !!item.fuera_de_alcance } });
  });

  router.delete('/sesiones/:id/items/:itemId', (req, res) => {
    const sesion = getSesion(req.params.id, req.user?.username);
    if (!sesion) return res.status(404).json({ ok: false, error: 'Sesión no encontrada' });
    if (sesion.estado !== 'abierta') return res.status(400).json({ ok: false, error: 'La sesión no está abierta' });
    db.prepare('DELETE FROM inventario_conteos WHERE id=? AND sesion_id=?').run(req.params.itemId, sesion.id);
    res.json({ ok: true });
  });

  router.patch('/sesiones/:id/items/:itemId', (req, res) => {
    const sesion = getSesion(req.params.id, req.user?.username);
    if (!sesion) return res.status(404).json({ ok: false, error: 'Sesión no encontrada' });
    if (sesion.estado !== 'abierta') return res.status(400).json({ ok: false, error: 'La sesión no está abierta' });

    const cantidad = parseInt(req.body?.cantidad, 10);
    if (!Number.isInteger(cantidad) || cantidad < 0) {
      return res.status(400).json({ ok: false, error: 'Cantidad inválida' });
    }

    // Editar a mano una cantidad deja de ser "confirmado por omisión" (auditoría).
    const cambio = db.prepare('UPDATE inventario_conteos SET cantidad=?, confirmado_por_omision=0, actualizado_en=? WHERE id=? AND sesion_id=?')
      .run(cantidad, now(), req.params.itemId, sesion.id);
    if (cambio.changes === 0) return res.status(404).json({ ok: false, error: 'Ítem no encontrado en esta sesión' });

    const item = db.prepare('SELECT * FROM inventario_conteos WHERE id=?').get(req.params.itemId);
    res.json({ ok: true, item });
  });

  /**
   * Cierre en bloque (o por lista) de los pendientes SIN STOCK como cantidad 0.
   * Decisión de producto: NO es automático — se pregunta al cerrar la sesión y el
   * usuario elige ítem por ítem o todo el bloque. Los ítems creados acá quedan
   * marcados con confirmado_por_omision=1 para auditoría.
   *
   * No toca la lógica atómica de /confirmar: esto solo crea filas de conteo en 0;
   * el ajuste a Woo lo sigue haciendo /confirmar con su claim atómico intacto.
   */
  router.post('/sesiones/:id/cerrar-sin-stock', (req, res) => {
    const sesion = getSesion(req.params.id, req.user?.username);
    if (!sesion) return res.status(404).json({ ok: false, error: 'Sesión no encontrada' });
    if (sesion.estado !== 'abierta') return res.status(400).json({ ok: false, error: 'La sesión no está abierta' });
    asegurarAlcance(sesion);

    const pedidos = parseLista(req.body?.skus);
    const todos = req.body?.todos === true || (!pedidos.length && req.body?.todos !== false);

    const candidatos = db.prepare(`
      SELECT a.sku FROM inventario_sesion_alcance a
      WHERE a.sesion_id=? AND a.bloque='sin_stock'
        AND a.sku NOT IN (SELECT COALESCE(sku,'') FROM inventario_conteos WHERE sesion_id=?)
    `).all(sesion.id, sesion.id).map(r => r.sku);

    const aCerrar = todos ? candidatos : candidatos.filter(s => pedidos.includes(s));

    const insertar = db.prepare(`INSERT OR IGNORE INTO inventario_conteos
      (sesion_id, ean, sku, cantidad, bloque, fuera_de_alcance, confirmado_por_omision, actualizado_en)
      VALUES (?,?,?,0,'sin_stock',0,1,?)`);
    const tx = db.transaction(skus => {
      let n = 0;
      for (const sku of skus) n += insertar.run(sesion.id, sku, sku, now()).changes;
      return n;
    });
    const cerrados = tx(aCerrar);

    res.json({ ok: true, cerrados, skus: aCerrar });
  });

  router.post('/sesiones/:id/descartar', (req, res) => {
    const sesion = getSesion(req.params.id, req.user?.username);
    if (!sesion) return res.status(404).json({ ok: false, error: 'Sesión no encontrada' });
    if (sesion.estado !== 'abierta') return res.status(400).json({ ok: false, error: 'La sesión no está abierta' });
    db.prepare("UPDATE inventario_sesiones SET estado='descartada' WHERE id=?").run(sesion.id);
    res.json({ ok: true });
  });

  // Ajuste de stock REAL en WooCommerce: fail-closed por ítem — si un PATCH falla,
  // no aborta el resto (el operario ya contó todo físicamente; mejor ajustar lo que
  // se pueda y reportar lo que falló, que perder todo el trabajo de conteo). La
  // sesión completa se bloquea ANTES de tocar Woo (409) si hay ítems sin asociar,
  // porque sin SKU no hay a qué producto ajustarle el stock.
  router.post('/sesiones/:id/confirmar', async (req, res) => {
    const sesion = getSesion(req.params.id, req.user?.username);
    if (!sesion) return res.status(404).json({ ok: false, error: 'Sesión no encontrada' });
    if (sesion.estado !== 'abierta' && sesion.estado !== 'confirmada_con_errores') {
      return res.status(400).json({ ok: false, error: 'La sesión no admite confirmar/reintentar en su estado actual' });
    }

    const todos = db.prepare('SELECT * FROM inventario_conteos WHERE sesion_id=?').all(sesion.id);
    const sinAsociar = todos.filter(i => !i.sku);
    if (sinAsociar.length) {
      return res.status(409).json({ ok: false, error: 'Hay ítems sin asociar a un SKU. Asocialos antes de confirmar.', sin_asociar: sinAsociar.length });
    }

    // Reclamo atómico desde CUALQUIERA de los dos estados de origen válidos — evita que
    // dos /confirmar simultáneos (primer confirm o reintento) se pisen.
    const claim = db.prepare(
      "UPDATE inventario_sesiones SET estado='confirmando' WHERE id=? AND estado IN ('abierta','confirmada_con_errores')"
    ).run(sesion.id);
    if (claim.changes === 0) {
      return res.status(409).json({ ok: false, error: 'La sesión ya se está confirmando o no admite reintento ahora' });
    }

    // Solo se procesan los ítems que TODAVÍA no se ajustaron con éxito — así un reintento
    // nunca vuelve a tocar (ni a arriesgar) los que ya se confirmaron bien en un intento anterior.
    const pendientesDeAjustar = todos.filter(i => !i.ajustado_en);
    let ajustados = 0, fallidos = 0;
    const errores = [];
    for (const item of pendientesDeAjustar) {
      try {
        await setStockWc(wooCfg, db, item.sku, item.cantidad);
        db.prepare('UPDATE inventario_conteos SET ajustado_en=? WHERE id=?').run(now(), item.id);
        ajustados++;
      } catch (e) {
        fallidos++;
        errores.push({ sku: item.sku, error: e.message });
      }
    }

    const quedanFallidos = db.prepare('SELECT COUNT(*) n FROM inventario_conteos WHERE sesion_id=? AND ajustado_en IS NULL').get(sesion.id).n;
    const estadoFinal = quedanFallidos > 0 ? 'confirmada_con_errores' : 'confirmada';
    db.prepare("UPDATE inventario_sesiones SET estado=?, confirmado_en=? WHERE id=? AND estado='confirmando'")
      .run(estadoFinal, now(), sesion.id);

    res.json({ ok: true, ajustados, fallidos, errores });
  });

  router.get('/sesiones', (req, res) => {
    const usuario = req.user?.username;
    const rows = db.prepare(
      "SELECT * FROM inventario_sesiones WHERE usuario=? AND estado IN ('confirmada','confirmada_con_errores','descartada') ORDER BY COALESCE(confirmado_en,creado_en) DESC LIMIT 100"
    ).all(usuario);
    res.json({ ok: true, data: rows.map(sesionOut) });
  });

  return router;
}
