import express from 'express';
import { parseCategorias } from '../lib/modelos/producto.js';
import { setStockWcDelta, buscarEnCache } from '../lib/wooStock.js';
import { looksLikeGtin, subirGtinAWoo, persistirGtinConfirmado } from '../lib/gtinWoo.js';
import { requireAdmin } from '../lib/auth.js';

export { looksLikeGtin as looksLikeEan } from '../lib/gtinWoo.js';

// Binding local para usos internos en este archivo (líneas 492, 587).
// El re-export ESM arriba NO crea un binding local: looksLikeEan no estaría definido
// sin esta línea en los call sites internos.
const looksLikeEan = looksLikeGtin;

const now = () => new Date().toISOString();

// Umbral de "alcance grande" (decisión de producto): por encima de esto el frontend
// muestra un aviso antes de abrir la sesión. Solo informativo, nunca bloquea.
export const UMBRAL_ALCANCE_GRANDE = 300;

// Umbrales de la Fase 0 / Tarea 2 (freno por sobrante). Un FALTANTE nunca frena el
// ajuste (bajar stock es la acción segura); un SOBRANTE grande sí, porque publicar
// stock que quizás no existe es la acción riesgosa (ver nota de diseño en el plan).
export const UMBRAL_VALOR_DIFERENCIA = 100000;
export const UMBRAL_PORCENTAJE_SOBRANTE = 0.5;

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
  // Fase 0 — Tarea 4: medición de ritmo. `iniciado_en` se aproxima a `creado_en` (todavía
  // no distinguimos "creada" de "empezada a contar de verdad"); `segundos_activos` e
  // `items_contados` se completan recién al confirmar (ver /sesiones/:id/confirmar).
  try { db.exec('ALTER TABLE inventario_sesiones ADD COLUMN iniciado_en TEXT'); } catch (_) {}
  try { db.exec('ALTER TABLE inventario_sesiones ADD COLUMN segundos_activos INTEGER'); } catch (_) {}
  try { db.exec('ALTER TABLE inventario_sesiones ADD COLUMN items_contados INTEGER'); } catch (_) {}
  // Fase 2 — Ubicaciones: alcance alternativo por ubicación (barrido completo), en vez de
  // categoria/marca. Mutuamente excluyente con categorias/marcas (ver POST /sesiones).
  try { db.exec('ALTER TABLE inventario_sesiones ADD COLUMN ubicacion_id INTEGER'); } catch (_) {}
  db.prepare('CREATE INDEX IF NOT EXISTS idx_inv_sesiones_estado ON inventario_sesiones(estado)').run();

  // Fase 2 — Ubicaciones (Ruptura 3): muchos-a-muchos porque un SKU puede tener overflow
  // (unidades en más de un lugar). `estado`: 'bootstrap' (recién creada, todavía no
  // recorrida entera) | 'mapeada' (José la marcó como completa) — solo una ubicación
  // 'mapeada' habilita el cierre en cero automático (ver cerrarEnCero).
  db.prepare(`CREATE TABLE IF NOT EXISTS ubicaciones (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    zona      TEXT NOT NULL,
    estante   TEXT NOT NULL,
    estado    TEXT NOT NULL DEFAULT 'bootstrap',
    activa    INTEGER NOT NULL DEFAULT 1,
    creado_en TEXT NOT NULL
  )`).run();
  db.prepare('CREATE UNIQUE INDEX IF NOT EXISTS idx_ubicaciones_zona_estante ON ubicaciones(zona, estante)').run();

  db.prepare(`CREATE TABLE IF NOT EXISTS producto_ubicacion (
    sku            TEXT NOT NULL,
    ubicacion_id   INTEGER NOT NULL,
    principal      INTEGER NOT NULL DEFAULT 0,
    confirmado_en  TEXT NOT NULL,
    confirmado_por TEXT,
    PRIMARY KEY (sku, ubicacion_id)
  )`).run();
  db.prepare('CREATE INDEX IF NOT EXISTS idx_producto_ubicacion_ubicacion ON producto_ubicacion(ubicacion_id)').run();

  // Fase 4 — Planificador de ciclos. Sembrado SOLO desde inventario_conteos de sesiones que
  // llegaron a confirmada/confirmada_con_errores (Ruptura 9 del plan) — nunca desde
  // inventario_sesion_alcance, que infla la cobertura con SKUs todavía no contados de
  // verdad. Ver el hook al final de POST /sesiones/:id/confirmar.
  db.prepare(`CREATE TABLE IF NOT EXISTS sku_ultimo_conteo (
    sku                TEXT PRIMARY KEY,
    contado_en         TEXT NOT NULL,
    sesion_id          INTEGER,
    por_omision        INTEGER NOT NULL DEFAULT 0,
    diferencia_ultima  INTEGER
  )`).run();

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
    ad_hoc              INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (sesion_id, sku)
  )`).run();
  // migrations/018_inventario_sesion_alcance_ad_hoc.sql — distingue la fila congelada al
  // abrir la sesión (ad_hoc=0, nunca se borra mientras la sesión esté abierta) de la creada
  // al vuelo por /escanear o /asociar para un SKU fuera del alcance original (ad_hoc=1, se
  // borra si ningún conteo vivo sigue referenciando ese SKU). No usar fuera_de_alcance del
  // ítem para esa decisión: dos EANs asociados al mismo SKU ad hoc pueden divergir en esa
  // bandera entre sí sin que eso cambie si la fila de alcance es o no borrable.
  try { db.exec('ALTER TABLE inventario_sesion_alcance ADD COLUMN ad_hoc INTEGER NOT NULL DEFAULT 0'); } catch (_) {}
}

// ─── Router ───────────────────────────────────────────────────────────────────

export function inventarioRouter(db, wooCfg) {
  ensureTables(db);
  const router = express.Router();

  // Base de catálogo contable: mismo criterio en opciones, preview, snapshot y
  // pendientes — así el preview coincide exactamente con lo que se abre después.
  // no_contable=1 (Fase 0, Tarea 1: servicios, cargos, gift cards) queda afuera del
  // universo elegible para una sesión de inventario físico.
  const SQL_CATALOGO_CONTABLE =
    "SELECT sku, nombre, stock, categorias_json, marca FROM catalogo_cache WHERE COALESCE(sku,'')<>'' AND COALESCE(tipo,'')<>'variable' AND COALESCE(no_contable,0)=0";

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

  // ─── Ubicaciones (Fase 2) ─────────────────────────────────────────────────────
  // Zona+estante, para el alcance por ubicación (barrido completo, ver POST /sesiones)
  // y para la captura durante el conteo (ver capturarUbicacion).

  router.get('/ubicaciones', (req, res) => {
    const rows = db.prepare(`
      SELECT u.*, COUNT(pu.sku) AS skus_registrados
      FROM ubicaciones u
      LEFT JOIN producto_ubicacion pu ON pu.ubicacion_id = u.id
      WHERE u.activa = 1
      GROUP BY u.id
      ORDER BY u.zona, u.estante
    `).all();
    res.json({ ok: true, ubicaciones: rows });
  });

  router.post('/ubicaciones', requireAdmin, (req, res) => {
    const zona = String(req.body?.zona || '').trim();
    const estante = String(req.body?.estante || '').trim();
    if (!zona || !estante) {
      return res.status(400).json({ ok: false, error: 'zona y estante son requeridos' });
    }
    try {
      const info = db.prepare(
        'INSERT INTO ubicaciones (zona, estante, estado, activa, creado_en) VALUES (?,?,\'bootstrap\',1,?)'
      ).run(zona, estante, now());
      const ubicacion = db.prepare('SELECT * FROM ubicaciones WHERE id=?').get(info.lastInsertRowid);
      res.json({ ok: true, ubicacion });
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) {
        return res.status(409).json({ ok: false, error: `Ya existe la ubicación ${zona} / ${estante}.` });
      }
      throw e;
    }
  });

  // Marca una ubicación como recorrida y completa: recién ahí el cierre en cero masivo
  // de una sesión sobre esta ubicación deja de estar bloqueado (Ruptura 3/6 del plan).
  // Es una decisión explícita de José/Joaco, nunca automática.
  router.post('/ubicaciones/:id/mapear', requireAdmin, (req, res) => {
    const info = db.prepare("UPDATE ubicaciones SET estado='mapeada' WHERE id=? AND activa=1").run(req.params.id);
    if (!info.changes) return res.status(404).json({ ok: false, error: 'Ubicación no encontrada' });
    res.json({ ok: true, ubicacion: db.prepare('SELECT * FROM ubicaciones WHERE id=?').get(req.params.id) });
  });

  // ─── No contables (Fase 0, Tarea 1) ──────────────────────────────────────────
  // Productos que NO son mercadería física real (servicios, cargos, gift cards):
  // stock absurdo (>500, típico de "stock infinito" cargado a mano) o sin marca
  // (típico de servicios/cargos). Nunca es una decisión silenciosa ni definitiva:
  // José confirma cada uno a mano y puede revertirlo después.
  router.get('/no-contables/sugerencias', (req, res) => {
    const rows = db.prepare(`
      SELECT id_woo, sku, nombre, stock, marca
      FROM catalogo_cache
      WHERE COALESCE(no_contable,0)=0
        AND (stock > 500 OR COALESCE(marca,'')='')
      ORDER BY nombre COLLATE NOCASE
    `).all();
    res.json({ ok: true, sugerencias: rows });
  });

  function parseIdsWoo(valor) {
    const crudo = Array.isArray(valor) ? valor : [];
    return [...new Set(crudo.map(v => parseInt(v, 10)).filter(Number.isInteger))];
  }

  router.post('/no-contables', requireAdmin, (req, res) => {
    const ids = parseIdsWoo(req.body?.ids_woo);
    if (!ids.length) {
      return res.status(400).json({ ok: false, error: 'Indicá `ids_woo` (array no vacío).' });
    }
    const marcar = db.prepare('UPDATE catalogo_cache SET no_contable=1 WHERE id_woo=?');
    const tx = db.transaction(lista => {
      let n = 0;
      for (const id of lista) n += marcar.run(id).changes;
      return n;
    });
    const marcados = tx(ids);
    res.json({ ok: true, marcados });
  });

  function revertirNoContables(req, res) {
    const ids = parseIdsWoo(req.body?.ids_woo);
    if (!ids.length) {
      return res.status(400).json({ ok: false, error: 'Indicá `ids_woo` (array no vacío).' });
    }
    const desmarcar = db.prepare('UPDATE catalogo_cache SET no_contable=0 WHERE id_woo=?');
    const tx = db.transaction(lista => {
      let n = 0;
      for (const id of lista) n += desmarcar.run(id).changes;
      return n;
    });
    const revertidos = tx(ids);
    res.json({ ok: true, revertidos });
  }
  router.delete('/no-contables', requireAdmin, revertirNoContables);
  router.post('/no-contables/revertir', requireAdmin, revertirNoContables);

  // ─── Stock negativo (Fase 0, Tarea 3) ────────────────────────────────────────
  // Las filas las escribe routes/woo.js#refrescarCatalogo en cada barrido de catálogo;
  // acá solo se leen las alertas abiertas (resuelto_en IS NULL).
  router.get('/negativos', (req, res) => {
    const rows = db.prepare(`
      SELECT a.id, a.sku, a.stock AS stock_detectado, a.detectado_en,
             c.nombre, c.marca, c.stock AS stock_actual
      FROM stock_negativo_alertas a
      LEFT JOIN catalogo_cache c ON c.sku = a.sku
      WHERE a.resuelto_en IS NULL
      ORDER BY a.detectado_en
    `).all();
    res.json({ ok: true, alertas: rows });
  });

  router.get('/sesion-activa', (req, res) => {
    const usuario = req.user?.username;
    const sesion = db.prepare(
      "SELECT * FROM inventario_sesiones WHERE usuario=? AND estado='abierta' ORDER BY id DESC LIMIT 1"
    ).get(usuario);
    res.json({ ok: true, sesion: sesionOut(sesion) });
  });

  // SKUs asociados a una ubicación (Fase 2), intersecados con el catálogo contable —
  // un SKU dado de baja o marcado no_contable no debe seguir "ocupando" la ubicación.
  function skusDeUbicacion(ubicacionId) {
    if (!ubicacionId) return new Set();
    const skusContables = new Set(catalogoContable().map(p => p.sku));
    const rows = db.prepare('SELECT sku FROM producto_ubicacion WHERE ubicacion_id=?').all(ubicacionId);
    return new Set(rows.map(r => r.sku).filter(sku => skusContables.has(sku)));
  }

  // SKUs que entran en un alcance dado con la semántica OR — SOLO para anti-solape.
  // `ubicacionId` se UNE (no reemplaza) al resultado de categorias/marcas: en la práctica
  // un alcance real es uno u otro (ver POST /sesiones, son mutuamente excluyentes), pero
  // la función acepta ambos para no tener dos caminos de anti-solape distintos.
  function skusDeAlcanceOr(categorias, marcas, ubicacionId) {
    const catalogo = db.prepare("SELECT sku, categorias_json, marca FROM catalogo_cache WHERE COALESCE(sku,'')<>''").all();
    const set = new Set(
      catalogo
        .filter(p => productoEnAlcanceOr(parseCategorias(p.categorias_json), p.marca, categorias, marcas))
        .map(p => p.sku)
    );
    for (const sku of skusDeUbicacion(ubicacionId)) set.add(sku);
    return set;
  }

  // Dos alcances se solapan si existe AL MENOS UN producto real que entra en ambos —
  // no alcanza con comparar categoría-con-categoría/marca-con-marca de forma literal,
  // porque una sesión "categoria=Cascos" y otra "marca=Bell" pueden compartir productos
  // (ej. "Casco Bell") sin que ningún campo coincida literalmente entre las dos. Mismo
  // criterio aplica a ubicación: una sesión por ubicación y otra por marca pueden compartir
  // SKUs sin que ningún campo coincida literalmente.
  // Semántica OR intencional (conservadora): se mantiene sin cambios.
  function sesionesSolapan(a, b) {
    // Fase 2 (hallazgo del revisor): una ubicación recién creada, todavía sin ningún SKU
    // asociado (bootstrap), da skusDeUbicacion vacío — el chequeo por SKU de abajo no
    // detectaría que dos personas abrieron sesión sobre la MISMA ubicación física. El
    // solape por ubicación se decide por el id, no solo por los SKUs que ya tiene.
    if (a.ubicacion_id != null && a.ubicacion_id === b.ubicacion_id) return true;
    const skusA = skusDeAlcanceOr(a.categorias, a.marcas, a.ubicacion_id);
    if (!skusA.size) return false;
    for (const sku of skusDeAlcanceOr(b.categorias, b.marcas, b.ubicacion_id)) {
      if (skusA.has(sku)) return true;
    }
    return false;
  }

  const insertAlcance = db.prepare(`INSERT OR IGNORE INTO inventario_sesion_alcance
    (sesion_id, sku, nombre, marca, categoria_principal, stock_inicial, bloque, ad_hoc) VALUES (?,?,?,?,?,?,?,?)`);

  // Congela el alcance de la sesión (qué SKUs y en qué bloque). Se llama al crear
  // la sesión; también de forma perezosa al leer una sesión abierta creada antes
  // de esta versión (o migrada desde el esquema string), para no romperlas.
  function congelarAlcance(sesionId, categorias, marcas, ubicacionId) {
    const enAlcance = ubicacionId
      ? (() => { const set = skusDeUbicacion(ubicacionId); return catalogoContable().filter(p => set.has(p.sku)); })()
      : catalogoContable().filter(p => productoEnAlcance(parseCategorias(p.categorias_json), p.marca, categorias, marcas));
    const escribir = db.transaction(filas => {
      for (const p of filas) {
        const stock = p.stock || 0;
        insertAlcance.run(
          sesionId, p.sku, p.nombre, p.marca,
          parseCategorias(p.categorias_json)[0] || null,
          stock, stock > 0 ? 'con_stock' : 'sin_stock', 0
        );
      }
    });
    escribir(enAlcance);
    return enAlcance.length;
  }

  // Fase 2 — captura durante el conteo: si la sesión tiene una ubicación activa, todo SKU
  // escaneado (o asociado) se asocia solo, sin trabajo extra del operario. INSERT OR IGNORE
  // porque re-escanear el mismo SKU en la misma ubicación no debe pisar `confirmado_en`
  // original ni fallar por la PK compuesta.
  const insertProductoUbicacion = db.prepare(`INSERT OR IGNORE INTO producto_ubicacion
    (sku, ubicacion_id, principal, confirmado_en, confirmado_por) VALUES (?,?,0,?,?)`);
  function capturarUbicacion(ubicacionId, sku, usuario) {
    insertProductoUbicacion.run(sku, ubicacionId, now(), usuario || null);
  }

  // Fase 4 — siembra sku_ultimo_conteo al cerrar una sesión (confirmada o
  // confirmada_con_errores: un reintento vuelve a llamar esto, es idempotente). Ruptura 9:
  // se siembra desde inventario_conteos (lo que REALMENTE se contó), nunca desde
  // inventario_sesion_alcance (lo que quedaba pendiente). El WHERE del UPDATE solo
  // pisa si este conteo es MÁS RECIENTE que el que ya había — protege contra un reintento
  // tardío de una sesión vieja pisando un conteo más nuevo de otra sesión sobre el mismo SKU.
  const upsertUltimoConteo = db.prepare(`
    INSERT INTO sku_ultimo_conteo (sku, contado_en, sesion_id, por_omision, diferencia_ultima)
    VALUES (?,?,?,?,?)
    ON CONFLICT(sku) DO UPDATE SET
      contado_en=excluded.contado_en, sesion_id=excluded.sesion_id,
      por_omision=excluded.por_omision, diferencia_ultima=excluded.diferencia_ultima
    WHERE excluded.contado_en > sku_ultimo_conteo.contado_en
  `);
  function sembrarUltimoConteo(sesionId) {
    const conteos = db.prepare(
      'SELECT sku, actualizado_en, confirmado_por_omision FROM inventario_conteos WHERE sesion_id=? AND sku IS NOT NULL'
    ).all(sesionId);
    const diferencias = new Map(
      db.prepare('SELECT sku, diferencia FROM inventario_diferencias WHERE sesion_id=?').all(sesionId)
        .map(d => [d.sku, d.diferencia])
    );
    const tx = db.transaction((filas) => {
      for (const c of filas) {
        upsertUltimoConteo.run(c.sku, c.actualizado_en, sesionId, c.confirmado_por_omision ? 1 : 0, diferencias.get(c.sku) ?? null);
      }
    });
    tx(conteos);
  }

  function asegurarAlcance(sesion) {
    const n = db.prepare('SELECT COUNT(*) n FROM inventario_sesion_alcance WHERE sesion_id=?').get(sesion.id).n;
    if (n === 0) congelarAlcance(sesion.id, parseLista(sesion.categorias), parseLista(sesion.marcas), sesion.ubicacion_id);
  }

  router.post('/sesiones', (req, res) => {
    const usuario = req.user?.username;
    // Acepta el formato nuevo (arrays) y el viejo (string suelto) por compatibilidad.
    const categorias = parseLista(req.body?.categorias ?? req.body?.categoria);
    const marcas = parseLista(req.body?.marcas ?? req.body?.marca);
    const ubicacionId = req.body?.ubicacion_id != null ? parseInt(req.body.ubicacion_id, 10) : null;

    // Fase 2: ubicación es un tipo de alcance alternativo (barrido completo de un lugar
    // físico), no una tercera dimensión que se combine con categoria/marca — mezclarlas
    // exigiría definir semántica AND/OR nueva que el plan no especifica todavía (queda
    // para el planificador de ciclos, Fase 4). Por ahora es uno u otro.
    if (ubicacionId != null && (categorias.length || marcas.length)) {
      return res.status(400).json({ ok: false, error: 'Elegí categoría/marca O ubicación, no ambas.' });
    }
    if (ubicacionId == null && !categorias.length && !marcas.length) {
      return res.status(400).json({ ok: false, error: 'Elegí categoría, marca o ubicación para el alcance.' });
    }
    if (ubicacionId != null) {
      const ubicacion = db.prepare('SELECT * FROM ubicaciones WHERE id=?').get(ubicacionId);
      if (!ubicacion || !ubicacion.activa) {
        return res.status(400).json({ ok: false, error: 'Esa ubicación no existe o está inactiva.' });
      }
    }

    const propia = db.prepare("SELECT id FROM inventario_sesiones WHERE usuario=? AND estado='abierta'").get(usuario);
    if (propia) {
      return res.status(409).json({ ok: false, error: 'Ya tenés una sesión abierta. Retomala o descartala antes de crear otra.' });
    }

    // El chequeo de solapamiento incluye ambos estados: 'abierta' (en curso) y
    // 'confirmada_con_errores' (falló el ajuste, sigue siendo reintentable después).
    // Una sesión en confirmada_con_errores aún puede reintentarse, así que bloquea
    // que otro usuario cuente el mismo alcance (el reintento pisaría stock_inicial viejo).
    const abiertas = db.prepare("SELECT usuario, categorias, marcas, ubicacion_id FROM inventario_sesiones WHERE estado IN ('abierta','confirmada_con_errores')").all();
    const nueva = { categorias, marcas, ubicacion_id: ubicacionId };
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

    const creadoEn = now();
    const id = db.prepare(
      "INSERT INTO inventario_sesiones (usuario, categorias, marcas, ubicacion_id, estado, creado_en, iniciado_en) VALUES (?,?,?,?,'abierta',?,?)"
    ).run(usuario, JSON.stringify(categorias), JSON.stringify(marcas), ubicacionId, creadoEn, creadoEn).lastInsertRowid;
    congelarAlcance(id, categorias, marcas, ubicacionId);
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
    let enAlcance = sku
      ? db.prepare('SELECT bloque FROM inventario_sesion_alcance WHERE sesion_id=? AND sku=?').get(sesion.id, sku)
      : null;
    let fueraDeAlcance = sku && !enAlcance ? 1 : 0;

    // Hallazgo #1: Si el ítem es REAL (SKU existe) pero NO está en el alcance original,
    // inserta una fila ahora en inventario_sesion_alcance con el stock actual congelado.
    // Esto evita que setStockWcDelta falle con "stockInicial requerido" al confirmar.
    // Lee el stock desde catalogo_cache (misma fuente que congelarAlcance al abrir sesión).
    if (fueraDeAlcance && sku && !codigoDesconocido) {
      const prod = db.prepare(
        'SELECT nombre, marca, categorias_json, stock FROM catalogo_cache WHERE sku=? AND COALESCE(tipo,\'\')<>\'variable\' LIMIT 1'
      ).get(sku);
      if (prod) {
        const stock = prod.stock || 0;
        const bloque = stock > 0 ? 'con_stock' : 'sin_stock';
        insertAlcance.run(
          sesion.id, sku, prod.nombre, prod.marca,
          parseCategorias(prod.categorias_json)[0] || null,
          stock, bloque, 1
        );
        // Re-leer enAlcance después del insert, para que bloque no quede null en el conteo.
        enAlcance = db.prepare('SELECT bloque FROM inventario_sesion_alcance WHERE sesion_id=? AND sku=?').get(sesion.id, sku);
      }
    }

    // Dedup por SKU, no por el código literal escaneado (fix 2026-08-25): un mismo
    // producto puede tener más de un código que resuelve al mismo SKU (su GTIN de fábrica
    // Y una etiqueta de SKU impresa por la herramienta de Etiquetas, ver Fase 1). Buscar
    // solo por `ean` dejaba crear DOS filas para el mismo producto físico si se lo
    // escaneaba una vez por cada código — y en /confirmar cada fila dispara su propio
    // setStockWcDelta con el MISMO stock_inicial congelado: la segunda escritura relee el
    // stock ya modificado por la primera y aplica el delta de nuevo sobre eso, pisando el
    // ajuste real (ver docs/api-contrato.md). Cuando el SKU ya se resolvió, "¿ya lo conté?"
    // se responde por SKU; si el código sigue sin resolver (código desconocido, sku=null)
    // no hay SKU contra el que deduplicar y se sigue usando el código literal, igual que antes.
    const existente = sku
      ? db.prepare('SELECT * FROM inventario_conteos WHERE sesion_id=? AND sku=?').get(sesion.id, sku)
      : db.prepare('SELECT * FROM inventario_conteos WHERE sesion_id=? AND ean=?').get(sesion.id, ean);
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
    if (sku && sesion.ubicacion_id) capturarUbicacion(sesion.ubicacion_id, sku, req.user?.username);
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
    let alcance = db.prepare('SELECT bloque FROM inventario_sesion_alcance WHERE sesion_id=? AND sku=?').get(sesion.id, sku);

    // Si el SKU no estaba en el alcance original (fue un código desconocido), necesitamos
    // congelar su stock inicial — igual que hace /escanear al detectar un producto fuera de
    // alcance (líneas 776-791). Sin esta fila, /confirmar no tiene stock_inicial y
    // setStockWcDelta falla con "stockInicial requerido".
    // Pero PRIMERO confirmamos que el ítem existe en la sesión (guard fail-closed abajo):
    // insertar alcance antes del UPDATE crearía filas huérfanas si el EAN no existe.
    let prodParaAlcance = null;
    if (!alcance) {
      prodParaAlcance = db.prepare(
        "SELECT nombre, marca, categorias_json, stock FROM catalogo_cache WHERE sku=? AND COALESCE(tipo,'') <> 'variable' AND COALESCE(no_contable,0) = 0 LIMIT 1"
      ).get(sku);
      // SKU variable o no contable: no se puede congelar stock — fallar temprano con
      // mensaje claro es mejor que dejar pasar y que /confirmar falle con "stockInicial requerido".
      if (!prodParaAlcance) {
        return res.status(400).json({
          ok: false,
          error: `El SKU "${sku}" es un producto variable o no contable y no puede ajustarse por conteo`,
        });
      }
    }

    // El SKU ya se validó contra el catálogo más arriba, así que el ítem deja de
    // ser un "código desconocido" y pasa a ser un conteo real.
    const cambio = db.prepare('UPDATE inventario_conteos SET sku=?, bloque=?, fuera_de_alcance=?, codigo_desconocido=0, actualizado_en=? WHERE sesion_id=? AND ean=?')
      .run(sku, alcance?.bloque || null, alcance ? 0 : 1, now(), sesion.id, ean);
    if (cambio.changes === 0) {
      return res.status(404).json({ ok: false, error: 'No hay ningún ítem escaneado con ese EAN en esta sesión' });
    }

    // El ítem existe: ahora sí es seguro congelar el alcance si todavía no estaba.
    if (!alcance && prodParaAlcance) {
      const stock = prodParaAlcance.stock || 0;
      const bloque = stock > 0 ? 'con_stock' : 'sin_stock';
      insertAlcance.run(
        sesion.id, sku, prodParaAlcance.nombre, prodParaAlcance.marca,
        parseCategorias(prodParaAlcance.categorias_json)[0] || null,
        stock, bloque, 1
      );
      alcance = db.prepare('SELECT bloque FROM inventario_sesion_alcance WHERE sesion_id=? AND sku=?').get(sesion.id, sku);
      // Si el bloque cambió respecto del que usamos en el UPDATE, corregirlo ahora.
      if (alcance?.bloque) {
        db.prepare('UPDATE inventario_conteos SET bloque=? WHERE sesion_id=? AND ean=?')
          .run(alcance.bloque, sesion.id, ean);
      }
    }
    if (sesion.ubicacion_id) capturarUbicacion(sesion.ubicacion_id, sku, req.user?.username);

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

    // Leer el item antes de borrarlo para saber su SKU.
    const item = db.prepare('SELECT sku FROM inventario_conteos WHERE id=? AND sesion_id=?').get(req.params.itemId, sesion.id);

    db.prepare('DELETE FROM inventario_conteos WHERE id=? AND sesion_id=?').run(req.params.itemId, sesion.id);

    // Borrar también la fila de inventario_sesion_alcance del SKU, pero SOLO si esa fila es
    // ad_hoc=1 (la creó /escanear o /asociar al vuelo, no estaba en el alcance congelado al
    // abrir la sesión) y ningún otro ítem vivo sigue referenciando el mismo SKU (dos EANs →
    // mismo SKU ad hoc). No decidir por item.fuera_de_alcance: esa bandera puede divergir
    // entre dos EANs del mismo SKU ad hoc (el segundo /asociar la deja en 0 al encontrar la
    // fila que ya creó el primero) sin que eso cambie si la fila de alcance es borrable, y
    // recalcularla contra el catálogo en vivo rompe la invariante de alcance CONGELADO en
    // sesiones por ubicación o cuando el catálogo cambió después de abrir la sesión.
    if (item && item.sku) {
      db.prepare(`
        DELETE FROM inventario_sesion_alcance WHERE sesion_id=? AND sku=? AND ad_hoc=1
          AND NOT EXISTS (SELECT 1 FROM inventario_conteos WHERE sesion_id=? AND sku=?)
      `).run(sesion.id, item.sku, sesion.id, item.sku);
    }

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

    let aCerrarTodos = todos
      ? pendientesDeSesion(sesion.id, 'sin_stock').map(r => r.sku)
      : pedidos;

    // Fase 2 (Rupturas 3 y 6): en una sesión por ubicación, el cierre en cero automático
    // solo es seguro si la ubicación ya está mapeada Y el SKU no tiene overflow (unidades
    // registradas en OTRA ubicación además de esta) ni queda sin ubicación registrada.
    // Se filtra, no se bloquea toda la operación: el resto del barrido sigue funcionando.
    let excluidosPorUbicacion = [];
    if (sesion.ubicacion_id) {
      const ubicacion = db.prepare('SELECT * FROM ubicaciones WHERE id=?').get(sesion.ubicacion_id);
      if (!ubicacion || ubicacion.estado !== 'mapeada') {
        return res.status(400).json({
          ok: false,
          error: 'Esta ubicación todavía no está marcada como mapeada: el cierre en cero automático no es seguro hasta que la hayas recorrido entera.',
        });
      }
      const seguros = [];
      for (const sku of aCerrarTodos) {
        const ubicacionesDelSku = db.prepare('SELECT ubicacion_id FROM producto_ubicacion WHERE sku=?').all(sku).map(r => r.ubicacion_id);
        if (!ubicacionesDelSku.length || ubicacionesDelSku.some(id => id !== sesion.ubicacion_id)) {
          excluidosPorUbicacion.push(sku);
        } else {
          seguros.push(sku);
        }
      }
      aCerrarTodos = seguros;
    }

    res.json({
      ok: true,
      ...cerrarEnCero(sesion.id, aCerrarTodos, 'sin_stock', todos ? aCerrarTodos : null),
      ...(excluidosPorUbicacion.length ? { excluidos_por_ubicacion: excluidosPorUbicacion } : {}),
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
    if (sesion.estado !== 'abierta' && sesion.estado !== 'confirmada_con_errores') {
      return res.status(400).json({ ok: false, error: 'La sesión no puede descartarse en su estado actual' });
    }
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

    const insertDiferencia = db.prepare(`INSERT INTO inventario_diferencias
      (sesion_id, sku, cantidad_esperada, cantidad_contada, diferencia, valor_diferencia,
       tipo, requiere_revision, stock_inicial_usado, creado_en)
      VALUES (?,?,?,?,?,?,?,?,?,?)`);
    const diferenciaSobrantePendiente = db.prepare(`
      SELECT id, valor_diferencia FROM inventario_diferencias
      WHERE sesion_id=? AND sku=? AND tipo='sobrante' AND requiere_revision=1 AND revisado_en IS NULL
    `);

    // Solo se procesan los ítems que TODAVÍA no se ajustaron con éxito — así un reintento
    // nunca vuelve a tocar (ni a arriesgar) los que ya se confirmaron bien en un intento anterior.
    const pendientesDeAjustar = todos.filter(i => !i.ajustado_en);
    let ajustados = 0, fallidos = 0;
    const errores = [];
    const ventasDuranteConteo = [];
    for (const item of pendientesDeAjustar) {
      try {
        // Lee el stock_inicial de la sesión (congelado al crear la sesión).
        const alcance = db.prepare(
          'SELECT stock_inicial FROM inventario_sesion_alcance WHERE sesion_id=? AND sku=?'
        ).get(sesion.id, item.sku);
        const stockInicial = alcance?.stock_inicial;

        // Ya está frenado por una diferencia anterior sin resolver (reintento de una sesión
        // confirmada_con_errores): no recalcular ni insertar de nuevo, sigue esperando la
        // aprobación/rechazo de José vía /diferencias/:id.
        const pendiente = (stockInicial !== null && stockInicial !== undefined)
          ? diferenciaSobrantePendiente.get(sesion.id, item.sku)
          : null;
        if (pendiente) {
          fallidos++;
          errores.push({
            sku: item.sku,
            error: `Sobrante grande ($${pendiente.valor_diferencia}): requiere confirmación manual antes de publicar stock nuevo`,
          });
          continue;
        }

        // Fase 0 — Tarea 2: registrar la diferencia ANTES de decidir si se ajusta, para
        // poder frenar el sobrante. Un faltante (contó menos) SIEMPRE se ajusta — bajar
        // stock es la acción segura y evita dejar el producto publicado con stock fantasma.
        // Un sobrante grande NO se ajusta acá: espera aprobación explícita.
        let frenarSobrante = false;
        if (stockInicial !== null && stockInicial !== undefined) {
          const diferencia = item.cantidad - stockInicial;
          if (diferencia !== 0) {
            const prod = buscarEnCache(db, item.sku);
            const precio = prod?.precio || 0;
            const valorDiferencia = Math.abs(diferencia) * precio;
            const tipo = diferencia < 0 ? 'faltante' : 'sobrante';
            let requiereRevision = 0;
            if (tipo === 'faltante') {
              requiereRevision = valorDiferencia > UMBRAL_VALOR_DIFERENCIA ? 1 : 0;
            } else if (valorDiferencia > UMBRAL_VALOR_DIFERENCIA
                || Math.abs(diferencia) > stockInicial * UMBRAL_PORCENTAJE_SOBRANTE) {
              requiereRevision = 1;
              frenarSobrante = true;
            }
            insertDiferencia.run(
              sesion.id, item.sku, stockInicial, item.cantidad, diferencia, valorDiferencia,
              tipo, requiereRevision, stockInicial, now()
            );
            if (frenarSobrante) {
              fallidos++;
              errores.push({
                sku: item.sku,
                error: `Sobrante grande ($${valorDiferencia}): requiere confirmación manual antes de publicar stock nuevo`,
              });
              continue;
            }
          }
        }

        // Ajusta por delta contra el stock que se leyó al inicio del conteo.
        // Si hubo venta durante el conteo, lo registra para visibilidad en la respuesta.
        const resultado = await setStockWcDelta(wooCfg, db, item.sku, item.cantidad, stockInicial);
        if (resultado.huboVentaDurante) {
          ventasDuranteConteo.push({
            sku: item.sku,
            stock_al_abrir_sesion: stockInicial,
            stock_al_confirmar: resultado.stockLive,
            stock_final: resultado.stockFinal,
          });
        }

        db.prepare('UPDATE inventario_conteos SET ajustado_en=? WHERE id=?').run(now(), item.id);
        ajustados++;
      } catch (e) {
        fallidos++;
        errores.push({ sku: item.sku, error: e.message });
      }
    }

    const quedanFallidos = db.prepare('SELECT COUNT(*) n FROM inventario_conteos WHERE sesion_id=? AND ajustado_en IS NULL').get(sesion.id).n;
    const estadoFinal = quedanFallidos > 0 ? 'confirmada_con_errores' : 'confirmada';
    const confirmadoEn = now();
    // Fase 0 — Tarea 4 (medición de ritmo): items_contados excluye los cerrados en cero por
    // omisión (mismo criterio ya usado para no inflar cobertura con conteos falsos).
    // segundos_activos guarda el dato CRUDO siempre (confirmado_en - creado_en); la
    // exclusión de sesiones de más de 3h es solo al calcular el ritmo (GET /ritmo), no acá.
    const itemsContados = db.prepare(
      'SELECT COUNT(*) n FROM inventario_conteos WHERE sesion_id=? AND confirmado_por_omision=0'
    ).get(sesion.id).n;
    const segundosActivos = Math.max(0, Math.round((new Date(confirmadoEn) - new Date(sesion.creado_en)) / 1000));
    // confirmado_por queda con el último que confirmó/reintentó (no acumula historial de reintentos previos).
    db.prepare(`UPDATE inventario_sesiones
      SET estado=?, confirmado_en=?, confirmado_por=?, items_contados=?, segundos_activos=?
      WHERE id=? AND estado='confirmando'`)
      .run(estadoFinal, confirmadoEn, req.user?.username || null, itemsContados, segundosActivos, sesion.id);

    sembrarUltimoConteo(sesion.id);

    const respuesta = { ok: true, ajustados, fallidos, errores };
    if (ventasDuranteConteo.length > 0) {
      respuesta.ventasDuranteConteo = ventasDuranteConteo;
    }
    res.json(respuesta);
  });

  // ─── Diferencias (Fase 0, Tarea 2) — freno por sobrante ──────────────────────
  router.get('/diferencias/pendientes', (req, res) => {
    const rows = db.prepare(`
      SELECT d.*, c.nombre, c.marca
      FROM inventario_diferencias d
      LEFT JOIN catalogo_cache c ON c.sku = d.sku
      WHERE d.requiere_revision=1 AND d.revisado_en IS NULL AND d.tipo='sobrante'
      ORDER BY d.creado_en
    `).all();
    res.json({ ok: true, pendientes: rows });
  });

  router.post('/diferencias/:id/aprobar', requireAdmin, async (req, res) => {
    const fila = db.prepare('SELECT * FROM inventario_diferencias WHERE id=?').get(req.params.id);
    if (!fila) return res.status(404).json({ ok: false, error: 'Diferencia no encontrada' });
    if (fila.revisado_en) return res.status(400).json({ ok: false, error: 'Esta diferencia ya fue revisada' });
    if (fila.tipo !== 'sobrante') {
      return res.status(400).json({ ok: false, error: 'Solo los sobrantes requieren aprobación; los faltantes ya se ajustaron automáticamente al confirmar la sesión' });
    }
    try {
      // Reconstruye el mismo llamado que se hubiera hecho al confirmar, con los datos
      // que quedaron congelados en la fila (sesion_id, sku, cantidad_contada, stock_inicial_usado).
      const resultado = await setStockWcDelta(wooCfg, db, fila.sku, fila.cantidad_contada, fila.stock_inicial_usado);
      db.prepare('UPDATE inventario_diferencias SET revisado_en=?, revisado_por=? WHERE id=?')
        .run(now(), req.user?.username || null, fila.id);
      // El conteo original queda ajustado — un reintento de /confirmar de esa sesión ya no
      // lo vuelve a tocar.
      db.prepare(`UPDATE inventario_conteos SET ajustado_en=?
        WHERE sesion_id=? AND sku=? AND ajustado_en IS NULL`)
        .run(now(), fila.sesion_id, fila.sku);
      res.json({ ok: true, resultado });
    } catch (e) {
      // Fail-closed, igual criterio que el resto del módulo: si el ajuste real a Woo falla,
      // NO se marca revisado_en — queda pendiente para reintentar la aprobación.
      res.status(502).json({ ok: false, error: e.message });
    }
  });

  router.post('/diferencias/:id/rechazar', requireAdmin, (req, res) => {
    const fila = db.prepare('SELECT * FROM inventario_diferencias WHERE id=?').get(req.params.id);
    if (!fila) return res.status(404).json({ ok: false, error: 'Diferencia no encontrada' });
    if (fila.revisado_en) return res.status(400).json({ ok: false, error: 'Esta diferencia ya fue revisada' });
    if (fila.tipo !== 'sobrante') {
      return res.status(400).json({ ok: false, error: 'Solo los sobrantes requieren aprobación; los faltantes ya se ajustaron automáticamente al confirmar la sesión' });
    }
    // José decidió que el conteo estuvo mal: marca revisado en la diferencia y borra el conteo
    // original. Esto cierra la decisión de rechazar — un reintento de /confirmar ya no vuelve a
    // levantarlo porque la fila no existirá en inventario_conteos.
    //
    // AND ajustado_en IS NULL es crítico acá (mismo guard que ya usa /aprobar arriba): si dos
    // EANs distintos mapean al mismo SKU en esta sesión (UNIQUE(sesion_id, ean) permite dos
    // filas), un confirm previo puede haber ajustado la primera con éxito a Woo y frenado la
    // segunda como sobrante. Sin este filtro, el DELETE por sesion_id+sku borra AMBAS filas de
    // un golpe — incluida la que ya se escribió en Woo — y no queda ningún rastro en la base de
    // que esa escritura ocurrió. Con el filtro, solo se borra la fila sin ajustar; la que ya
    // se aplicó a Woo permanece intacta.
    db.prepare('UPDATE inventario_diferencias SET revisado_en=?, revisado_por=? WHERE id=?')
      .run(now(), req.user?.username || null, fila.id);
    db.prepare('DELETE FROM inventario_conteos WHERE sesion_id=? AND sku=? AND ajustado_en IS NULL')
      .run(fila.sesion_id, fila.sku);
    res.json({ ok: true });
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

  // ─── Ritmo (Fase 0, Tarea 4) ──────────────────────────────────────────────────
  // Duración máxima (segundos) para que una sesión cuente en el cálculo de ritmo —
  // por encima probablemente quedó abierta sin actividad continua (mismo umbral que
  // se usa para decidir qué segundos_activos son confiables).
  const RITMO_MAX_SEGUNDOS = 3 * 60 * 60;
  const RITMO_MIN_SESIONES = 3;
  const RITMO_ESTIMADO_FALLBACK = 20;

  // Percentil 25 por interpolación lineal (método PERCENTILE.INC de Excel/numpy
  // "linear"): estándar y determinista, sin depender de una librería de stats para
  // un solo cálculo.
  function percentil25(valores) {
    const ordenado = [...valores].sort((a, b) => a - b);
    const n = ordenado.length;
    if (!n) return null;
    const rango = 0.25 * (n - 1);
    const piso = Math.floor(rango), techo = Math.ceil(rango);
    if (piso === techo) return ordenado[piso];
    return ordenado[piso] + (ordenado[techo] - ordenado[piso]) * (rango - piso);
  }

  function calcularRitmo(usuario) {
    const sesiones = db.prepare(`
      SELECT items_contados, segundos_activos
      FROM inventario_sesiones
      WHERE usuario=? AND estado IN ('confirmada','confirmada_con_errores')
      ORDER BY confirmado_en DESC LIMIT 5
    `).all(usuario);

    const validas = sesiones
      .filter(s => s.segundos_activos != null && s.segundos_activos > 0 && s.segundos_activos <= RITMO_MAX_SEGUNDOS
        && s.items_contados != null)
      .map(s => (s.items_contados / s.segundos_activos) * 3600);

    if (validas.length < RITMO_MIN_SESIONES) {
      return { ritmo: RITMO_ESTIMADO_FALLBACK, estimado: true, muestras: validas.length };
    }
    return { ritmo: percentil25(validas), estimado: false, muestras: validas.length };
  }

  router.get('/ritmo', (req, res) => {
    const usuario = String(req.query?.usuario || '').trim();
    if (!usuario) return res.status(400).json({ ok: false, error: 'Falta `usuario`' });
    res.json({ ok: true, ...calcularRitmo(usuario) });
  });

  // ─── Fase 4 — Planificador de ciclos ──────────────────────────────────────────
  // Tope duro del plan: ningún SKU debería pasar más de 20 días sin contar.
  const TOPE_DIAS_SIN_CONTAR = 20;
  const MS_POR_DIA = 24 * 60 * 60 * 1000;

  function diasSinContarPorSku() {
    const ultimos = new Map(
      db.prepare('SELECT sku, contado_en FROM sku_ultimo_conteo').all().map(r => [r.sku, r.contado_en])
    );
    const ahora = Date.now();
    // Infinity representa "nunca contado" — se ordena siempre primero, sin necesidad de
    // un sentinel numérico mágico que alguien podría confundir con un valor real.
    return (sku) => {
      const c = ultimos.get(sku);
      return c ? (ahora - new Date(c).getTime()) / MS_POR_DIA : Infinity;
    };
  }

  // Propone UNA sesión para hoy: si hay al menos una ubicación mapeada (régimen real),
  // la más urgente (mayor días-sin-contar entre sus SKUs) gana — barrido completo, cierre
  // en cero habilitado por las reglas de Fase 2. Si no hay ninguna mapeada todavía
  // (Ruptura 6, ciclo 0), propone bootstrap por categoría: la que tenga más SKUs nunca
  // contados, cierre en cero deshabilitado (una sesión por categoría no es un barrido de
  // ubicación, no cumple la Regla 1 de Fase 2 — el propio endpoint de cierre ya lo bloquea).
  router.get('/plan-hoy', (req, res) => {
    const usuario = req.user?.username;
    const diasSinContar = diasSinContarPorSku();
    const contables = catalogoContable();

    const ubicacionesMapeadas = db.prepare("SELECT * FROM ubicaciones WHERE estado='mapeada' AND activa=1").all();
    // Hallazgo del revisor: producto_ubicacion puede tener SKUs descontinuados o marcados
    // no_contable (nada los poda al día de hoy). Sin filtrar contra el catálogo contable,
    // un SKU muerto con dias_sin_contar=Infinity fijaba la urgencia de su ubicación para
    // siempre, aunque el resto de sus productos reales estuviera al día.
    const skusContablesSet = new Set(contables.map(p => p.sku));
    let propuesta = null;
    let mejorUrgencia = -Infinity;
    for (const u of ubicacionesMapeadas) {
      const skusU = db.prepare('SELECT sku FROM producto_ubicacion WHERE ubicacion_id=?').all(u.id)
        .map(r => r.sku).filter(sku => skusContablesSet.has(sku));
      if (!skusU.length) continue;
      const urgencia = skusU.reduce((max, sku) => Math.max(max, diasSinContar(sku)), -Infinity);
      if (urgencia > mejorUrgencia) {
        mejorUrgencia = urgencia;
        propuesta = {
          tipo: 'ubicacion', ubicacion_id: u.id, zona: u.zona, estante: u.estante,
          productos: skusU.length,
          dias_sin_contar_max: Number.isFinite(urgencia) ? Math.round(urgencia) : null,
          cierre_en_cero_habilitado: true,
        };
      }
    }

    if (!propuesta) {
      const porCategoria = new Map();
      for (const p of contables) {
        const cat = (parseCategorias(p.categorias_json)[0]) || '(sin categoría)';
        const d = diasSinContar(p.sku);
        const acc = porCategoria.get(cat) || { categoria: cat, nunca_contados: 0, dias_max: 0, total: 0 };
        acc.total++;
        if (!Number.isFinite(d)) acc.nunca_contados++; else acc.dias_max = Math.max(acc.dias_max, d);
        porCategoria.set(cat, acc);
      }
      const top = [...porCategoria.values()]
        .sort((a, b) => (b.nunca_contados - a.nunca_contados) || (b.dias_max - a.dias_max))[0];
      if (top) {
        propuesta = {
          tipo: 'categoria_bootstrap', categoria: top.categoria,
          productos: top.total, nunca_contados: top.nunca_contados,
          dias_sin_contar_max: Math.round(top.dias_max),
          cierre_en_cero_habilitado: false,
        };
      }
    }

    const ritmo = usuario ? calcularRitmo(usuario) : { ritmo: RITMO_ESTIMADO_FALLBACK, estimado: true, muestras: 0 };
    if (propuesta) {
      // Dimensiona a ≤2h con el ritmo del usuario (percentil 25 de sus últimas sesiones).
      propuesta.capacidad_estimada_2h = Math.max(1, Math.floor(ritmo.ritmo * 2));
      propuesta.queda_afuera = Math.max(0, propuesta.productos - propuesta.capacidad_estimada_2h);
    }

    const conConteo = contables.filter(p => Number.isFinite(diasSinContar(p.sku))).length;
    const vencidos = contables.filter(p => diasSinContar(p.sku) > TOPE_DIAS_SIN_CONTAR).length;

    res.json({
      ok: true,
      propuesta,
      ritmo,
      cobertura: {
        total_contable: contables.length,
        con_conteo_registrado: conConteo,
        porcentaje: contables.length ? Math.round((conConteo / contables.length) * 1000) / 10 : 0,
        vencidos_20_dias: vencidos,
      },
      ubicaciones: {
        mapeadas: ubicacionesMapeadas.length,
        totales: db.prepare('SELECT COUNT(*) n FROM ubicaciones WHERE activa=1').get().n,
      },
    });
  });

  // Lista puntual de los SKUs más urgentes (mayor días-sin-contar), para "apagar
  // incendios" sin abrir un barrido completo. Ruptura 5: es solo informativo — contar uno
  // de estos SKUs se hace desde una sesión normal (categoría/marca/ubicación); este
  // endpoint no crea sesiones ni habilita cierre en cero, es una lista de prioridades.
  router.get('/dirigido', (req, res) => {
    const limite = Math.min(parseInt(req.query?.limit, 10) || 20, 200);
    const diasSinContar = diasSinContarPorSku();
    const filas = catalogoContable().map(p => {
      const d = diasSinContar(p.sku);
      return {
        sku: p.sku, nombre: p.nombre, stock: p.stock,
        dias_sin_contar: Number.isFinite(d) ? Math.round(d) : null,
        nunca_contado: !Number.isFinite(d),
      };
    });
    filas.sort((a, b) => {
      const diasA = a.dias_sin_contar == null ? Infinity : a.dias_sin_contar;
      const diasB = b.dias_sin_contar == null ? Infinity : b.dias_sin_contar;
      return diasB - diasA;
    });
    res.json({ ok: true, dirigido: filas.slice(0, limite) });
  });

  return router;
}
