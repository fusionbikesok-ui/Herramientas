import express from 'express';
import { parseCategorias } from '../lib/modelos/producto.js';
import { setStockWc } from '../lib/wooStock.js';
import { subirGtinAWoo, persistirGtinConfirmado } from '../lib/gtinWoo.js';

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

// Selección que llega por query string: array repetido (?marcas=a&marcas=b) o un
// solo valor con separador `|` (el que usa el frontend) o coma.
export function parseSeleccionQuery(valor) {
  if (Array.isArray(valor)) return parseLista(valor.flatMap(v => String(v).split(/[|,]/)));
  if (valor == null) return [];
  return parseLista(String(valor).split(/[|,]/));
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
  // En transacción: si el rebuild falla a mitad (ej. una fila legada que viola una
  // constraint nueva), se revierte entero y la tabla original queda intacta.
  db.transaction(() => db.exec(`
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
  `))();
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
  // Migración 002: quién confirmó/reintentó el ajuste (historial de sesiones cerradas).
  try { db.exec('ALTER TABLE inventario_sesiones ADD COLUMN confirmado_por TEXT'); } catch (_) {}
  db.prepare('CREATE INDEX IF NOT EXISTS idx_inv_sesiones_estado ON inventario_sesiones(estado)').run();

  db.prepare(`CREATE TABLE IF NOT EXISTS inventario_conteos (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    sesion_id      INTEGER NOT NULL,
    ean            TEXT NOT NULL,
    sku            TEXT,
    cantidad       INTEGER NOT NULL DEFAULT 0,
    bloque         TEXT,
    fuera_de_alcance INTEGER NOT NULL DEFAULT 0,
    codigo_desconocido INTEGER NOT NULL DEFAULT 0,
    confirmado_por_omision INTEGER NOT NULL DEFAULT 0,
    ajustado_en    TEXT,
    actualizado_en TEXT NOT NULL,
    UNIQUE(sesion_id, ean)
  )`).run();
  // Migraciones incrementales (tablas ya creadas por versiones anteriores)
  try { db.exec('ALTER TABLE inventario_conteos ADD COLUMN bloque TEXT'); } catch (_) {}
  try { db.exec('ALTER TABLE inventario_conteos ADD COLUMN fuera_de_alcance INTEGER NOT NULL DEFAULT 0'); } catch (_) {}
  try { db.exec('ALTER TABLE inventario_conteos ADD COLUMN confirmado_por_omision INTEGER NOT NULL DEFAULT 0'); } catch (_) {}
  try { db.exec('ALTER TABLE inventario_conteos ADD COLUMN codigo_desconocido INTEGER NOT NULL DEFAULT 0'); } catch (_) {}

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

  // Fuente única de verdad para "pendiente": pertenece al snapshot de la sesión y no
  // existe todavía un conteo con ese SKU. La pantalla, los cierres en cero y el gate de
  // confirmación deben consultar exactamente este mismo universo.
  function pendientesDeSesion(sesionId, bloque = null) {
    return db.prepare(`
      SELECT a.sku, a.nombre, a.bloque, a.stock_inicial, a.marca,
             a.categoria_principal,
             (SELECT c.stock FROM catalogo_cache c WHERE c.sku=a.sku LIMIT 1) AS stock_actual
      FROM inventario_sesion_alcance a
      WHERE a.sesion_id=?
        AND NOT EXISTS (
          SELECT 1 FROM inventario_conteos t
          WHERE t.sesion_id=a.sesion_id AND t.sku=a.sku
        )
      ORDER BY CASE a.bloque WHEN 'con_stock' THEN 0 ELSE 1 END,
               COALESCE(a.categoria_principal,'') COLLATE NOCASE,
               COALESCE(a.marca,'') COLLATE NOCASE,
               COALESCE(a.nombre,'') COLLATE NOCASE
    `).all(sesionId)
      .filter(p => bloque == null || p.bloque === bloque)
      .map(p => ({
        sku: p.sku,
        nombre: p.nombre,
        bloque: p.bloque,
        marca: p.marca,
        categoria_principal: p.categoria_principal,
        stock_inicial: p.stock_inicial,
        stock_woo: p.stock_actual ?? p.stock_inicial,
      }));
  }

  // Estado del código escaneado, para que el frontend muestre el aviso correcto:
  //   ok               → producto real dentro del alcance
  //   fuera_de_alcance → producto real, pero fuera del alcance elegido (solo aviso)
  //   desconocido      → el código no existe en el catálogo (no hay stock que ajustar)
  //   sin_asociar      → EAN válido todavía no vinculado a un SKU
  function estadoDeCodigo(item) {
    if (item.codigo_desconocido) return 'desconocido';
    if (!item.sku) return 'sin_asociar';
    return item.fuera_de_alcance ? 'fuera_de_alcance' : 'ok';
  }

  function avisoDeCodigo(item) {
    switch (estadoDeCodigo(item)) {
      case 'desconocido':
        return `El código "${item.ean}" no está en el catálogo. Asocialo a un SKU real o borralo antes de confirmar.`;
      case 'sin_asociar':
        return `El código "${item.ean}" todavía no está asociado a un SKU.`;
      case 'fuera_de_alcance':
        return 'Este producto está fuera del alcance de la sesión. Se cuenta igual, revisalo al cerrar.';
      default:
        return null;
    }
  }

  function itemOut(item) {
    return {
      ...item,
      sin_asociar: !item.sku,
      fuera_de_alcance: !!item.fuera_de_alcance,
      codigo_desconocido: !!item.codigo_desconocido,
      estado_codigo: estadoDeCodigo(item),
    };
  }

  function sesionOut(sesion) {
    if (!sesion) return null;
    return { ...sesion, categorias: parseLista(sesion.categorias), marcas: parseLista(sesion.marcas) };
  }

  // Conteo CONDICIONADO a la selección actual: cuántos productos quedarían si se
  // agregara esta opción a lo ya elegido en la OTRA dimensión. Reusa
  // productoEnAlcance() (AND entre dimensiones), así un chip de marca que no
  // intersecta con las categorías elegidas queda en 0 → el frontend lo deshabilita
  // (nunca lo oculta). Sin selección en la otra dimensión el resultado es el
  // conteo global de esa opción, igual que antes.
  router.get('/alcance-opciones', (req, res) => {
    const catsSel = parseSeleccionQuery(req.query?.categorias);
    const marcasSel = parseSeleccionQuery(req.query?.marcas);
    const rows = catalogoContable().map(r => ({ cats: parseCategorias(r.categorias_json), marca: r.marca }));

    const categorias = new Map();
    const marcas = new Map();
    // Una sola pasada por el catálogo (se llama en cada toggle de chip). Equivale a
    // productoEnAlcance(cats, marca, [opcion], selDeLaOtraDimension) para cada opción:
    // con la otra dimensión vacía es el conteo global; con selección, manda el AND,
    // y ahí el producto solo suma si además pasa el filtro de la otra dimensión.
    const pasaMarcas = r => !marcasSel.length || productoEnAlcance(r.cats, r.marca, [], marcasSel);
    const pasaCategorias = r => !catsSel.length || productoEnAlcance(r.cats, r.marca, catsSel, []);
    for (const r of rows) {
      const sumaCat = pasaMarcas(r);
      for (const c of r.cats) {
        if (!c) continue;
        categorias.set(c, (categorias.get(c) || 0) + (sumaCat ? 1 : 0));
      }
      if (r.marca) {
        marcas.set(r.marca, (marcas.get(r.marca) || 0) + (pasaCategorias(r) ? 1 : 0));
      }
    }

    const aLista = m => [...m.entries()]
      .map(([nombre, productos]) => ({ nombre, productos }))
      .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
    res.json({
      ok: true,
      categorias: aLista(categorias),
      marcas: aLista(marcas),
      seleccion: { categorias: catsSel, marcas: marcasSel },
    });
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

    // LEFT JOIN en una sola consulta: esta pantalla se refresca después de cada
    // escaneo, no conviene compilar y correr un SELECT por ítem contado.
    // Resolución determinista (subselect LIMIT 1) para evitar duplicar ítems si
    // hay SKU homónimos en catalogo_cache.
    const conteos = db.prepare(`
      SELECT t.*,
             (SELECT sku FROM catalogo_cache WHERE sku = t.sku LIMIT 1) AS prod_sku,
             (SELECT stock FROM catalogo_cache WHERE sku = t.sku LIMIT 1) AS prod_stock,
             (SELECT nombre FROM catalogo_cache WHERE sku = t.sku LIMIT 1) AS prod_nombre
      FROM inventario_conteos t
      WHERE t.sesion_id = ?
      ORDER BY t.id
    `).all(sesion.id);
    const items = conteos.map(c => {
      const enCatalogo = c.prod_sku != null;
      return {
        id: c.id, ean: c.ean, sku: c.sku, cantidad: c.cantidad,
        nombre: c.prod_nombre || null,
        stock_woo: enCatalogo ? c.prod_stock : null,
        diferencia: enCatalogo ? c.cantidad - c.prod_stock : null,
        bloque: c.bloque || null,
        fuera_de_alcance: !!c.fuera_de_alcance,
        codigo_desconocido: !!c.codigo_desconocido,
        estado_codigo: estadoDeCodigo(c),
        confirmado_por_omision: !!c.confirmado_por_omision,
        aviso: avisoDeCodigo(c),
        ajustado: !!c.ajustado_en,
        ajustado_en: c.ajustado_en || null,
      };
    });

    // Orden: primero con stock, después por categoría → marca → nombre. El bloque
    // viene congelado del snapshot, no se recalcula contra el stock actual.
    const pendientes = pendientesDeSesion(sesion.id);

    res.json({
      ok: true,
      sesion: sesionOut(sesion),
      items,
      pendientes,
      resumen: {
        pendientes_con_stock: pendientes.filter(p => p.bloque === 'con_stock').length,
        pendientes_sin_stock: pendientes.filter(p => p.bloque === 'sin_stock').length,
        fuera_de_alcance: items.filter(i => i.fuera_de_alcance).length,
        codigos_desconocidos: items.filter(i => i.codigo_desconocido).length,
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

    // Código que NO existe en el catálogo: es un caso distinto de "fuera de alcance".
    // Fuera de alcance = producto REAL que no entra en el alcance elegido (solo aviso).
    // Desconocido = no hay producto al que ajustarle stock, así que se guarda con
    // sku=null y cae en el flujo fail-closed que ya existe para EAN no reconocido:
    // /confirmar corta con 409 hasta que se asocie a un SKU real o se borre el ítem.
    const codigoDesconocido = sku && !db.prepare('SELECT 1 FROM catalogo_cache WHERE sku=?').get(sku) ? 1 : 0;
    if (codigoDesconocido) sku = null;

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
      // Volver a escanear una fila que se había cerrado en 0 por omisión la
      // convierte en un conteo real: deja de estar "confirmada por omisión".
      db.prepare('UPDATE inventario_conteos SET cantidad=cantidad+1, confirmado_por_omision=0, actualizado_en=? WHERE id=?')
        .run(now(), existente.id);
      itemId = existente.id;
    } else {
      itemId = db.prepare(
        'INSERT INTO inventario_conteos (sesion_id, ean, sku, cantidad, bloque, fuera_de_alcance, codigo_desconocido, actualizado_en) VALUES (?,?,?,1,?,?,?,?)'
      ).run(sesion.id, ean, sku, enAlcance?.bloque || null, fueraDeAlcance, codigoDesconocido, now()).lastInsertRowid;
    }
    const item = db.prepare('SELECT * FROM inventario_conteos WHERE id=?').get(itemId);
    res.json({ ok: true, item: itemOut(item), aviso: avisoDeCodigo(item) });
  });

  // Subida del código a Woo al asociar (spec 2026-08-21-subir-ean-a-woo-design.md).
  // Excepción DELIBERADA al fail-closed del resto del sistema: si Woo rechaza o no
  // responde, la asociación LOCAL se hace igual y el conteo sigue (estado 'fallo').
  // El trabajo físico del operario no se descarta por un error de Woo. El ajuste de
  // stock (confirmar sesión) sigue siendo fail-closed como siempre, no se toca acá.
  router.post('/sesiones/:id/asociar', async (req, res) => {
    const sesion = getSesion(req.params.id, req.user?.username);
    if (!sesion) return res.status(404).json({ ok: false, error: 'Sesión no encontrada' });
    if (sesion.estado !== 'abierta') return res.status(400).json({ ok: false, error: 'La sesión no está abierta' });

    const ean = String(req.body?.ean || '').trim();
    const sku = String(req.body?.sku || '').trim();
    const pisarCodigo = req.body?.pisar_codigo === true;
    if (!sku) return res.status(400).json({ ok: false, error: 'Falta el SKU' });
    // `sku <> ''` y LIMIT 1, mismo criterio que routes/codigos.js:61. El índice de sku NO es
    // único: con el body vacío esta consulta podía matchear cualquier fila sin SKU.
    const fila = db.prepare("SELECT * FROM catalogo_cache WHERE sku=? AND sku <> '' LIMIT 1").get(sku);
    if (!fila) return res.status(400).json({ ok: false, error: `SKU "${sku}" no está en el catálogo` });
    // Cuántos productos comparten ese SKU. Ya pasó en producción que tres productos de WC
    // tuvieran el mismo (incidente 2026-07-25): elegir uno arbitrario acá significaba
    // escribirle el código de barras al producto equivocado. Con ambigüedad no se sube nada.
    const homonimos = db.prepare("SELECT COUNT(*) n FROM catalogo_cache WHERE sku=? AND sku <> ''").get(sku).n;

    // Fail-closed: si no hay ningún ítem escaneado con ese EAN en esta sesión, no
    // sembramos ean_sku ni hacemos nada — "enseñar EAN sin ítem" es otro caso de uso,
    // no el de asociar dentro de un conteo. Chequeamos con el UPDATE mismo (.changes)
    // para evitar una carrera entre el SELECT previo y el UPDATE.
    const alcance = db.prepare('SELECT bloque FROM inventario_sesion_alcance WHERE sesion_id=? AND sku=?').get(sesion.id, sku);
    // El SKU ya se validó contra el catálogo más arriba, así que el ítem deja de
    // ser un "código desconocido" y pasa a ser un conteo real.
    const cambio = db.prepare('UPDATE inventario_conteos SET sku=?, bloque=?, fuera_de_alcance=?, codigo_desconocido=0, actualizado_en=? WHERE sesion_id=? AND ean=?')
      .run(sku, alcance?.bloque || null, alcance ? 0 : 1, now(), sesion.id, ean);
    if (cambio.changes === 0) {
      return res.status(404).json({ ok: false, error: 'No hay ningún ítem escaneado con ese EAN en esta sesión' });
    }

    // Un SKU homónimo sí queda asociado al ítem de esta sesión (el operario ya identificó
    // físicamente el conteo), pero NO se siembra ean_sku: ese mapeo global no puede apuntar
    // arbitrariamente a uno de varios productos. Para cualquier SKU inequívoco, la
    // asociación local se conserva incluso si el código no es GTIN o Woo falla.
    if (homonimos <= 1) {
      db.prepare(`
        INSERT INTO ean_sku (ean, sku, actualizado_en) VALUES (?,?,?)
        ON CONFLICT(ean) DO UPDATE SET sku=excluded.sku, actualizado_en=excluded.actualizado_en
      `).run(ean, sku, now());
    }
    let codigo;
    if (homonimos > 1) {
      codigo = {
        estado: 'fallo', gtin: ean, motivo: 'sku_ambiguo',
        error: `Hay ${homonimos} productos con el SKU ${sku} en el catálogo: no se puede saber a cuál corresponde.`,
      };
    } else if (!looksLikeEan(ean)) {
      codigo = { estado: 'no_valido' };
    } else {
      const gtinActual = String(fila.gtin || '').trim();
      if (!gtinActual) {
        codigo = await subirGtin(fila, ean, sku);
      } else if (gtinActual === ean) {
        codigo = { estado: 'sin_cambio' };
      } else if (!pisarCodigo) {
        codigo = { estado: 'conflicto', gtin: ean, gtin_actual: gtinActual };
      } else {
        codigo = await subirGtin(fila, ean, sku);
      }
    }

    // `motivo` viaja a la respuesta para que la pantalla pueda distinguir un fallo
    // REINTENTABLE (Woo caído, rechazo) de uno que no lo es (un padre variable no lleva
    // código: reintentar el escaneo no va a funcionar nunca).
    async function subirGtin(filaProducto, gtin, skuProducto) {
      const resultado = await subirGtinAWoo(wooCfg, filaProducto, gtin);
      if (!resultado.ok) return { estado: 'fallo', gtin, error: resultado.error, motivo: resultado.motivo || 'woo' };
      persistirGtinConfirmado(db, filaProducto, gtin, skuProducto);
      return { estado: 'subido', gtin };
    }

    const item = db.prepare('SELECT * FROM inventario_conteos WHERE sesion_id=? AND ean=?').get(sesion.id, ean);
    res.json({ ok: true, item: itemOut(item), codigo });
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

  // Inserta filas de conteo en 0 para SKUs del alcance que todavía no se contaron.
  // `bloque` acota a qué mitad del alcance se aplica; devuelve cuántas filas creó.
  function cerrarEnCero(sesionId, skusPedidos, bloque, candidatosPrecalculados = null) {
    const candidatos = candidatosPrecalculados
      || pendientesDeSesion(sesionId, bloque).map(r => r.sku);
    const pedidosSet = new Set(skusPedidos);
    const aCerrar = candidatos.filter(s => pedidosSet.has(s));
    const insertar = db.prepare(`INSERT OR IGNORE INTO inventario_conteos
      (sesion_id, ean, sku, cantidad, bloque, fuera_de_alcance, confirmado_por_omision, actualizado_en)
      VALUES (?,?,?,0,?,0,1,?)`);
    const tx = db.transaction(skus => {
      let n = 0;
      for (const sku of skus) n += insertar.run(sesionId, sku, sku, bloque, now()).changes;
      return n;
    });
    return { cerrados: tx(aCerrar), skus: aCerrar };
  }

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

    // Fail-closed: esto termina escribiendo stock 0 en Woo al confirmar, así que
    // exige intención EXPLÍCITA. Un body vacío o `{skus:[]}` no cierra nada.
    const pedidos = parseLista(req.body?.skus);
    const todos = req.body?.todos === true;
    if (!todos && !pedidos.length) {
      return res.status(400).json({
        ok: false,
        error: 'Indicá `todos: true` o una lista `skus` no vacía para cerrar en 0.',
      });
    }

    const aCerrarTodos = todos
      ? pendientesDeSesion(sesion.id, 'sin_stock').map(r => r.sku)
      : pedidos;
    res.json({
      ok: true,
      ...cerrarEnCero(sesion.id, aCerrarTodos, 'sin_stock', todos ? aCerrarTodos : null),
    });
  });

  // Cierra en 0 productos que SÍ tenían stock ("lo busqué, no había ninguna"). A diferencia
  // de cerrar-sin-stock, acá NO existe `todos:true`: esto termina bajando stock real en Woo,
  // y un botón masivo sería la salida fácil que devuelve el problema que este cambio arregla.
  router.post('/sesiones/:id/cerrar-en-cero', (req, res) => {
    const sesion = getSesion(req.params.id, req.user?.username);
    if (!sesion) return res.status(404).json({ ok: false, error: 'Sesión no encontrada' });
    if (sesion.estado !== 'abierta') return res.status(400).json({ ok: false, error: 'La sesión no está abierta' });
    asegurarAlcance(sesion);

    if (req.body?.todos === true) {
      return res.status(400).json({
        ok: false,
        error: 'Los productos con stock se cierran uno por uno: elegí cuáles pasar a 0.',
      });
    }
    const pedidos = parseLista(req.body?.skus);
    if (!pedidos.length) {
      return res.status(400).json({
        ok: false,
        error: 'Indicá una lista `skus` no vacía. Para productos con stock no existe `todos`.',
      });
    }
    res.json({ ok: true, ...cerrarEnCero(sesion.id, pedidos, 'con_stock') });
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
      // Un "código desconocido" también llega acá con sku=null: no hay producto real
      // al que ajustarle stock, así que se corta antes de tocar Woo (fail-closed).
      const desconocidos = sinAsociar.filter(i => i.codigo_desconocido);
      return res.status(409).json({
        ok: false,
        error: 'Hay ítems sin asociar a un SKU. Asocialos antes de confirmar.',
        sin_asociar: sinAsociar.length,
        codigos_desconocidos: desconocidos.length,
        codigos: desconocidos.map(i => i.ean),
      });
    }

    // El gate se apoya en el alcance congelado: sin filas de alcance daría [] y confirmaría
    // sin gate — fail-OPEN justo en la función que existe para ser fail-closed.
    if (sesion.estado === 'abierta') asegurarAlcance(sesion);

    // Fail-closed contra la sobreventa: un producto CON stock que nunca se contó no tiene
    // fila en inventario_conteos, así que el ajuste de abajo ni lo ve — se queda publicado
    // con el stock que tenía. Si ya no está físicamente, se vende (incidente 2026-08-21).
    // El bloque sin_stock no entra: ya está en 0 en Woo, ajustarlo a 0 es un no-op.
    //
    // Solo aplica al PRIMER confirm. En un reintento (confirmada_con_errores) la sesión ya
    // está cerrada y sus pendientes no se pueden decidir nunca más: bloquearlo no protegería
    // nada —el stock de esos ya quedó sin tocar— y dejaría trabados para siempre los ajustes
    // que fallaron por un error de Woo. La sesión 5 de producción está justo así.
    const pendientesConStock = sesion.estado !== 'abierta'
      ? []
      : pendientesDeSesion(sesion.id, 'con_stock');
    if (pendientesConStock.length) {
      return res.status(409).json({
        ok: false,
        error: 'Quedan productos con stock sin contar. Decidí uno por uno antes de confirmar: '
             + 'pasalos a 0 si no había ninguna, o dejalos pendientes para revisar.',
        pendientes_con_stock: pendientesConStock.length,
        pendientes: pendientesConStock,
      });
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
    // confirmado_por queda con el último que confirmó/reintentó (no acumula historial de reintentos previos).
    db.prepare("UPDATE inventario_sesiones SET estado=?, confirmado_en=?, confirmado_por=? WHERE id=? AND estado='confirmando'")
      .run(estadoFinal, now(), req.user?.username || null, sesion.id);

    res.json({ ok: true, ajustados, fallidos, errores });
  });

  router.get('/sesiones', (req, res) => {
    const usuario = req.user?.username;
    // Una sola consulta agregada (LEFT JOIN + COUNT condicional) en vez de un COUNT
    // por sesión en un loop: para 'descartada' el conteo de fallidos no aplica (0),
    // porque esas sesiones nunca llegaron a intentar el ajuste en Woo.
    const rows = db.prepare(`
      SELECT s.*, COUNT(CASE WHEN s.estado <> 'descartada' AND t.id IS NOT NULL AND t.ajustado_en IS NULL THEN 1 END) AS fallidos
      FROM inventario_sesiones s
      LEFT JOIN inventario_conteos t ON t.sesion_id = s.id AND s.estado <> 'descartada'
      WHERE s.usuario=? AND s.estado IN ('confirmada','confirmada_con_errores','descartada')
      GROUP BY s.id
      ORDER BY COALESCE(s.confirmado_en, s.creado_en) DESC LIMIT 100
    `).all(usuario);
    res.json({ ok: true, data: rows.map(sesionOut) });
  });

  return router;
}
