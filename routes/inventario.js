import express from 'express';
import { parseCategorias } from '../lib/modelos/producto.js';
import { getStockLiveWc, setStockWcDelta, buscarEnCache } from '../lib/wooStock.js';
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
 * Define los `pendientes` de una sesión y, desde el 2026-09-10, también el conjunto que se
 * compara para detectar solape entre sesiones (ver `skusDeAlcance`): dos sesiones chocan
 * cuando los productos que realmente van a contar se pisan.
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
 * Variante OR. Fue la regla del anti-solape hasta el 2026-09-10 y ya no se usa: bloqueaba por
 * productos que ninguna de las dos sesiones iba a contar (ver `skusDeAlcance`). Se conserva
 * exportada porque el caso que la justificaba sigue siendo el que hay que no romper: una
 * sesión "Cascos" y otra "Bell" comparten el "Casco Bell" y tienen que chocar — con alcances
 * reales también chocan, porque ese producto está en los dos conjuntos.
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
  // Fase 2 — Ubicaciones: sola define el alcance (barrido completo de la zona); combinada
  // con categoria/marca indica dónde está parado el operario, para mapear lo que escanea.
  // Fueron mutuamente excluyentes hasta el 2026-09-10: con esa regla el mapeo nunca se llenó
  // (0 de 33 sesiones con ubicación) porque en la tienda se cuenta por marca.
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

  try {
    db.prepare(`CREATE TABLE IF NOT EXISTS stock_movements (
      id INTEGER PRIMARY KEY AUTOINCREMENT, sku TEXT NOT NULL, cantidad INTEGER NOT NULL CHECK(cantidad <> 0),
      tipo TEXT NOT NULL CHECK(tipo IN ('entrada','salida','transferencia')), origen_id INTEGER,
      destino_id INTEGER, motivo TEXT NOT NULL, idempotencia TEXT NOT NULL UNIQUE,
      usuario TEXT, creado_en TEXT NOT NULL, FOREIGN KEY(origen_id) REFERENCES ubicaciones(id),
      FOREIGN KEY(destino_id) REFERENCES ubicaciones(id)
    )`).run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_stock_movements_sku ON stock_movements(sku, creado_en)').run();
    db.prepare('CREATE UNIQUE INDEX IF NOT EXISTS uq_stock_movements_idempotencia ON stock_movements(idempotencia)').run();
    db.prepare(`CREATE TABLE IF NOT EXISTS stock_rollout_skus (
      sku TEXT PRIMARY KEY, habilitado INTEGER NOT NULL DEFAULT 0,
      habilitado_por TEXT, habilitado_en TEXT
    )`).run();
  } catch (_) {}

  // ── Ronda sugerida: qué contar ahora ──────────────────────────────────────
  //
  // El universo real no es el catálogo entero (5.168 SKUs) sino lo que tiene stock: al
  // 2026-09-10 eran 1.605, de los cuales 1.213 (76%) nunca se habían contado. Sin una
  // sugerencia, elegir qué contar es una decisión diaria que nadie quiere tomar y termina
  // contándose siempre lo mismo.
  //
  // La unidad es marca, o marca+categoría cuando la marca no entra en una ronda. Es la forma
  // en que se cuenta en la tienda y además coincide con cómo está acomodado el local
  // (Shimano tiene 73 zapatillas juntas y 60 de transmisión juntas). El alcance de sesión ya
  // combina marca y categoría con Y (`productoEnAlcance`), así que la sugerencia se puede
  // iniciar tal cual, sin tocar el modelo.
  //
  // Prioridad: primero lo que nunca se contó, después lo más viejo. Un grupo que dio
  // diferencias la última vez sube, porque es donde el stock se desvía.
  router.get('/ronda-sugerida', (req, res) => {
    const objetivo = Math.min(Math.max(parseInt(req.query.objetivo, 10) || 160, 10), 500);
    const hoy = new Date().toISOString().slice(0, 10);

    // Todos los contables, no sólo los que tienen stock: la sesión va a incluir también los
    // que figuran en cero, y confirmar que un cero es cero es justamente donde aparece el
    // stock invisible. Se informan los dos números para que la sugerencia no prometa 60 y el
    // operario se encuentre con 152.
    // Misma definición de "contable" que usa el alcance de la sesión (SQL_CATALOGO_CONTABLE):
    // excluye los productos `variable`, que son los padres de variaciones y no se cuentan.
    // Si acá se usara otro filtro, la sugerencia prometería un número y la sesión traería otro.
    const ultimos = new Map(db.prepare('SELECT sku, contado_en, diferencia_ultima FROM sku_ultimo_conteo').all()
      .map(u => [u.sku, u]));
    const productos = catalogoContable().map(c => ({
      ...c,
      contado_en: ultimos.get(c.sku)?.contado_en || null,
      diferencia_ultima: ultimos.get(c.sku)?.diferencia_ultima || null,
    }));

    const grupos = new Map();
    const sumar = (clave, marca, categoria, p) => {
      if (!grupos.has(clave)) {
        grupos.set(clave, { marca, categoria, skus: 0, con_stock: 0, nunca: 0, nunca_con_stock: 0, mas_viejo: null, con_diferencia: 0 });
      }
      const g = grupos.get(clave);
      const tieneStock = (p.stock || 0) > 0;
      g.skus++;
      if (tieneStock) g.con_stock++;
      if (!p.contado_en) { g.nunca++; if (tieneStock) g.nunca_con_stock++; }
      else if (!g.mas_viejo || p.contado_en < g.mas_viejo) g.mas_viejo = p.contado_en;
      if (p.diferencia_ultima) g.con_diferencia++;
    };

    // Marcas grandes: se cortan por categoría para que una ronda entre en un día. El corte usa
    // la categoría principal, pero el alcance de la sesión matchea CUALQUIER categoría del
    // producto, así que el grupo se cuenta con esa misma regla y los números coinciden.
    const conStockPorMarca = new Map();
    for (const p of productos) {
      if ((p.stock || 0) <= 0) continue;
      const marca = p.marca || '(sin marca)';
      conStockPorMarca.set(marca, (conStockPorMarca.get(marca) || 0) + 1);
    }
    const catsDe = (p) => parseCategorias(p.categorias_json);
    const grandes = new Set([...conStockPorMarca].filter(([, n]) => n > objetivo).map(([m]) => m));
    for (const p of productos) {
      const marca = p.marca || '(sin marca)';
      if (!grandes.has(marca)) { sumar(marca, marca, null, p); continue; }
      // En una marca grande el producto entra en cada categoría suya que sea candidata:
      // así el conteo del grupo coincide con lo que la sesión va a traer.
      const cats = catsDe(p);
      if (!cats.length) { sumar(marca + '\u0000(sin categoría)', marca, '(sin categoría)', p); continue; }
      for (const c of cats) sumar(marca + '\u0000' + c, marca, c, p);
    }

    // Ordena por PROPORCIÓN sin contar, no por cantidad absoluta. Un grupo con 86 nuevos de
    // 134 obliga a recontar 48 que ya estaban al día: ese tiempo no avanza la cobertura.
    // Uno de 60 sobre 60 rinde el 100%. Entre dos con la misma proporción gana el más grande,
    // que cubre más de una sentada; después, el más viejo, y las diferencias previas
    // desempatan porque ahí es donde el stock se desvía.
    // Se mide sobre lo que tiene stock: es lo que existe en el local y lo que la cobertura
    // realmente persigue. Un grupo entero en cero no aporta cobertura aunque nunca se haya
    // contado.
    const rinde = (g) => (g.con_stock ? g.nunca_con_stock / g.con_stock : 0);
    const orden = [...grupos.values()].filter(g => g.con_stock > 0).sort((a, b) => {
      if (rinde(b) !== rinde(a)) return rinde(b) - rinde(a);
      if (b.nunca_con_stock !== a.nunca_con_stock) return b.nunca_con_stock - a.nunca_con_stock;
      const va = a.mas_viejo || '', vb = b.mas_viejo || '';
      if (va !== vb) return va < vb ? -1 : 1;
      return b.con_diferencia - a.con_diferencia;
    });

    const motivo = (g) => (g.nunca_con_stock === g.con_stock ? 'nunca se contó'
      : g.nunca_con_stock ? `${g.nunca_con_stock} sin contar nunca`
      : g.mas_viejo ? `sin contar desde ${g.mas_viejo.slice(0, 10)}` : 'pendiente');

    const conMotivo = (g) => ({ ...g, motivo: motivo(g) });
    const contadosHoy = db.prepare('SELECT COUNT(*) AS n FROM sku_ultimo_conteo WHERE substr(contado_en,1,10)=?').get(hoy).n;

    return res.json({
      ok: true,
      objetivo,
      contados_hoy: contadosHoy,
      universo: productos.filter(p => (p.stock || 0) > 0).length,
      nunca_contados: productos.filter(p => (p.stock || 0) > 0 && !p.contado_en).length,
      sugerencia: orden.length ? conMotivo(orden[0]) : null,
      siguientes: orden.slice(1, 5).map(conMotivo),
    });
  });

  router.get('/ubicaciones-stock', (_req, res) => {
    const rows = db.prepare(`SELECT u.*, COUNT(pu.sku) AS skus_registrados
      FROM ubicaciones u LEFT JOIN producto_ubicacion pu ON pu.ubicacion_id=u.id
      WHERE u.activa=1 GROUP BY u.id ORDER BY u.zona, u.estante`).all();
    res.json({ ok: true, data: rows });
  });

  router.get('/movimientos-stock', (req, res) => {
    const sku = String(req.query?.sku || '').trim();
    if (!sku) return res.status(400).json({ ok: false, error: 'sku requerido' });
    const rows = db.prepare(`SELECT m.*, o.zona AS origen_zona, o.estante AS origen_estante,
      d.zona AS destino_zona, d.estante AS destino_estante
      FROM stock_movements m LEFT JOIN ubicaciones o ON o.id=m.origen_id
      LEFT JOIN ubicaciones d ON d.id=m.destino_id WHERE m.sku=? ORDER BY m.id DESC LIMIT 200`).all(sku);
    const balances = db.prepare(`SELECT l.id, l.zona, l.estante, COALESCE(SUM(CASE
      WHEN m.destino_id=l.id THEN m.cantidad WHEN m.origen_id=l.id THEN -m.cantidad ELSE 0 END),0) AS cantidad
      FROM ubicaciones l LEFT JOIN stock_movements m ON m.sku=? WHERE l.activa=1 GROUP BY l.id ORDER BY l.zona, l.estante`).all(sku);
    res.json({ ok: true, sku, balances, data: rows });
  });

  router.post('/movimientos-stock/transferir', (req, res) => {
    const sku = String(req.body?.sku || '').trim();
    const cantidad = Number.parseInt(req.body?.cantidad, 10);
    const origen = Number.parseInt(req.body?.origen_id, 10);
    const destino = Number.parseInt(req.body?.destino_id, 10);
    const idempotencia = String(req.get('Idempotency-Key') || req.body?.idempotencia || '').trim();
    if (!sku || !Number.isInteger(cantidad) || cantidad <= 0 || !Number.isInteger(origen) || !Number.isInteger(destino) || origen === destino || !idempotencia) {
      return res.status(400).json({ ok: false, error: 'sku, cantidad, origen_id, destino_id e idempotencia válidos son obligatorios' });
    }
    let result;
    try { result = db.transaction(() => {
      const previo = db.prepare('SELECT * FROM stock_movements WHERE idempotencia=?').get(idempotencia);
      if (previo) return { repetido: true, movimiento: previo };
      if (!db.prepare('SELECT 1 FROM stock_rollout_skus WHERE sku=? AND habilitado=1').get(sku)) {
        throw Object.assign(new Error('SKU no habilitado para movimientos nuevos'), { code: 'ROLLOUT_NOT_ENABLED' });
      }
      if (!db.prepare('SELECT 1 FROM ubicaciones WHERE id=? AND activa=1').get(origen) || !db.prepare('SELECT 1 FROM ubicaciones WHERE id=? AND activa=1').get(destino)) throw Object.assign(new Error('ubicación inexistente'), { code: 'LOCATION_NOT_FOUND' });
      const balance = db.prepare(`SELECT COALESCE(SUM(CASE WHEN destino_id=? THEN cantidad WHEN origen_id=? THEN -cantidad ELSE 0 END),0) AS cantidad FROM stock_movements WHERE sku=?`).get(origen, origen, sku).cantidad;
      if (balance < cantidad) throw Object.assign(new Error('stock insuficiente en origen'), { code: 'INSUFFICIENT_STOCK' });
      const ts = new Date().toISOString();
      const info = db.prepare(`INSERT INTO stock_movements (sku,cantidad,tipo,origen_id,destino_id,motivo,idempotencia,usuario,creado_en)
        VALUES (?,?,'transferencia',?,?,? ,?,?,?)`).run(sku, cantidad, origen, destino, String(req.body?.motivo || 'transferencia autorizada'), idempotencia, req.user?.username || null, ts);
      return { repetido: false, movimiento: db.prepare('SELECT * FROM stock_movements WHERE id=?').get(info.lastInsertRowid) };
    })();
      res.status(result.repetido ? 200 : 201).json({ ok: true, ...result });
    } catch (error) {
      if (error?.code === 'ROLLOUT_NOT_ENABLED') return res.status(409).json({ ok: false, code: error.code, error: error.message });
      if (error?.code === 'INSUFFICIENT_STOCK') return res.status(409).json({ ok: false, code: error.code, error: error.message });
      if (error?.code === 'LOCATION_NOT_FOUND') return res.status(404).json({ ok: false, code: error.code, error: error.message });
      throw error;
    }
  });

  router.post('/movimientos-stock/habilitar', requireAdmin, (req, res) => {
    const sku = String(req.body?.sku || '').trim();
    if (!sku) return res.status(400).json({ ok: false, error: 'sku requerido' });
    db.prepare(`INSERT INTO stock_rollout_skus (sku, habilitado, habilitado_por, habilitado_en)
      VALUES (?,1,?,?) ON CONFLICT(sku) DO UPDATE SET habilitado=1, habilitado_por=excluded.habilitado_por, habilitado_en=excluded.habilitado_en`)
      .run(sku, req.user?.username || null, now());
    res.json({ ok: true, sku, habilitado: true });
  });

  // E5: consulta rápida, solo lectura. Las ubicaciones no relevadas no se inventan:
  // físico/entrante quedan explícitamente sin línea base hasta E6/E9.
  router.get('/consulta-rapida', (req, res) => {
    const q = String(req.query?.q || '').trim();
    if (q.length < 2) return res.status(400).json({ ok: false, error: 'q debe tener al menos 2 caracteres' });
    const limit = Math.min(Math.max(Number.parseInt(req.query?.limit || '50', 10) || 50, 1), 100);
    const term = `%${q.toLowerCase()}%`;
    const tienePreparaciones = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='preparacion_items'").get();
    const comprometidoSql = tienePreparaciones
      ? `(SELECT COUNT(*) FROM preparacion_items pi JOIN preparaciones p ON p.id=pi.preparacion_id
          WHERE pi.sku=c.sku AND p.estado NOT IN ('completada','despachada_sin_verificar','cerrada_sin_evidencia'))`
      : '0';
    const rows = db.prepare(`SELECT c.id_woo, c.sku, c.gtin, c.nombre, c.marca, c.stock AS disponible_comercial,
        c.actualizado_en AS woo_actualizado_en,
        (SELECT SUM(s.cantidad_ml) FROM ml_stock_estado s WHERE s.sku=c.sku) AS stock_ml,
        (SELECT MAX(s.actualizado_en) FROM ml_stock_estado s WHERE s.sku=c.sku) AS ml_actualizado_en,
        ${comprometidoSql} AS comprometido
      FROM catalogo_cache c
      WHERE lower(COALESCE(c.sku,'')) LIKE ? OR lower(COALESCE(c.gtin,'')) LIKE ? OR lower(COALESCE(c.nombre,'')) LIKE ?
      ORDER BY CASE WHEN lower(COALESCE(c.sku,'')) = lower(?) THEN 0 ELSE 1 END, c.nombre
      LIMIT ?`).all(term, term, term, q, limit);
    // Dónde está cada producto y cuántas unidades se vieron en cada lugar.
    //
    // Es una FOTO FECHADA, no stock en vivo: sale del último conteo hecho en esa ubicación.
    // Se eligió así a propósito. Un libro de movimientos daría cantidades exactas, pero
    // exige que alguien asiente cada traslado del depósito al salón — y eso, hoy, no pasa
    // (usuario, 2026-09-10). Un número exacto que nadie mantiene miente con más confianza
    // que una foto que dice cuándo se sacó. Por eso siempre viaja `visto_en`: quien la lee
    // decide cuánto confiarle.
    const ubicacionesDe = db.prepare(`
      SELECT u.id, u.zona, u.estante, pu.principal, pu.confirmado_en AS visto_en,
        (SELECT t.cantidad FROM inventario_conteos t
           JOIN inventario_sesiones ses ON ses.id = t.sesion_id
          WHERE t.sku = pu.sku AND ses.ubicacion_id = u.id
          ORDER BY t.actualizado_en DESC LIMIT 1) AS unidades_vistas
      FROM producto_ubicacion pu JOIN ubicaciones u ON u.id = pu.ubicacion_id
      WHERE pu.sku = ? AND u.activa = 1
      ORDER BY pu.principal DESC, pu.confirmado_en DESC`);

    res.json({ ok: true, actualizado_en: new Date().toISOString(), data: rows.map(row => ({
      ...row, fisico_conocido: null, no_disponible: null, entrante: null,
      stock_publicado_woo: row.disponible_comercial,
      ubicaciones: ubicacionesDe.all(row.sku),
      frescura: { woo: row.woo_actualizado_en, ml: row.ml_actualizado_en },
    })) });
  });

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
             (SELECT c.stock FROM catalogo_cache c WHERE c.sku=a.sku LIMIT 1) AS stock_actual,
             (SELECT c.img FROM catalogo_cache c WHERE c.sku=a.sku LIMIT 1) AS img
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
        img: p.img || null,
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
      case 'sin_asociar': {
        // Si el código SÍ existe pero está cargado en el producto padre, decirlo con nombre y
        // apellido: "no está asociado" mandaría a buscar un código que en realidad ya existe.
        // Se resuelve en cada lectura y no en una columna nueva porque son pocas filas y así
        // el mensaje sigue siendo correcto aunque el catálogo cambie después.
        // Por GTIN o por SKU: al padre se puede llegar escaneando su código de barras o
        // tipeando/leyendo su SKU, y los dos caminos merecen el mismo mensaje.
        const padre = db.prepare(
          `SELECT sku, nombre FROM catalogo_cache
           WHERE (gtin=? OR sku=?) AND (COALESCE(tipo,'')='variable' OR no_contable=1) LIMIT 1`
        ).get(item.ean, item.ean);
        if (padre) {
          return `El código "${item.ean}" está cargado en el producto padre (${padre.sku}), que no tiene stock propio. Elegí la variante que tenés en la mano.`;
        }
        return `El código "${item.ean}" todavía no está asociado a un SKU.`;
      }
      case 'fuera_de_alcance':
        return 'Este producto está fuera del alcance de la sesión. Se cuenta igual, revisalo al cerrar.';
      default:
        return null;
    }
  }

  function itemOut(item) {
    // `nombre` e `img` se resuelven acá porque la confirmación de lectura los necesita: lo
    // primero que tiene que decir después de un escaneo es QUÉ producto entró. Sin el nombre
    // mostraba el SKU dos veces, que no le confirma nada a quien está mirando el estante.
    const prod = item.sku
      ? db.prepare('SELECT nombre, img FROM catalogo_cache WHERE sku=? LIMIT 1').get(item.sku)
      : null;
    return {
      ...item,
      nombre: prod?.nombre || null,
      img: prod?.img || null,
      sin_asociar: !item.sku,
      fuera_de_alcance: !!item.fuera_de_alcance,
      codigo_desconocido: !!item.codigo_desconocido,
      estado_codigo: estadoDeCodigo(item),
      // El aviso viaja CON el ítem, no sólo suelto en la respuesta del escaneo: la
      // confirmación de lectura y la ficha lo necesitan, y así el contrato es el mismo que el
      // de GET /sesiones/:id, que ya lo incluía por ítem.
      aviso: avisoDeCodigo(item),
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

  // SKUs que una sesión con ese alcance va a contar realmente — el MISMO criterio que
  // congelarAlcance: `productoEnAlcance` (Y entre categoría y marca) sobre el catálogo
  // contable. Es lo que se compara para detectar solape.
  //
  // Antes esto usaba la semántica O (`productoEnAlcanceOr`) sobre el catálogo entero, con el
  // argumento de ser conservador. El resultado era bloquear por productos que NINGUNA de las
  // dos sesiones iba a tocar: el 2026-09-10 una ronda Shimano·TRANSMISIÓN quedó frenada por
  // una sesión CASCOS·Giro a causa de FB-2419, FB-4751 y FB-5530 — repuestos Shimano
  // categorizados en CASCOS. Con la regla Y ninguna de las dos sesiones los cuenta (no son
  // TRANSMISIÓN, no son Giro), así que no hay nada que proteger y el bloqueo era falso.
  // Comparar los alcances reales no afloja la protección: si dos sesiones van a tocar el
  // mismo SKU, ese SKU está en los dos conjuntos y el choque se detecta igual — incluido el
  // caso que motivó el O (una sesión por categoría y otra por marca que comparten un
  // producto, ej. "Casco Bell" entre categoria=Cascos y marca=Bell).
  //
  // `ubicacionId` sólo aporta SKUs cuando define el alcance, o sea cuando no hay categoría ni
  // marca. Si las hay, la ubicación es el lugar donde se cuenta y no debería bloquear a otra
  // persona que cuenta otra marca en el mismo estante.
  function skusDeAlcance(categorias, marcas, ubicacionId) {
    // parseLista y no `.length`: acá los alcances llegan desde la base como JSON ('[]' mide
    // 2 y sería un falso "tiene categorías"), y desde el request como array.
    const cats = parseLista(categorias);
    const mrcs = parseLista(marcas);
    if (ubicacionId != null && !cats.length && !mrcs.length) return skusDeUbicacion(ubicacionId);
    return new Set(
      catalogoContable()
        .filter(p => productoEnAlcance(parseCategorias(p.categorias_json), p.marca, cats, mrcs))
        .map(p => p.sku)
    );
  }

  // Dos alcances se solapan si existe AL MENOS UN producto real que entra en ambos —
  // no alcanza con comparar categoría-con-categoría/marca-con-marca de forma literal,
  // porque una sesión "categoria=Cascos" y otra "marca=Bell" pueden compartir productos
  // (ej. "Casco Bell") sin que ningún campo coincida literalmente entre las dos. Mismo
  // criterio aplica a ubicación: una sesión por ubicación y otra por marca pueden compartir
  // SKUs sin que ningún campo coincida literalmente.
  function sesionesSolapan(a, b) {
    // Fase 2 (hallazgo del revisor): una ubicación recién creada, todavía sin ningún SKU
    // asociado (bootstrap), da skusDeUbicacion vacío — el chequeo por SKU de abajo no
    // detectaría que dos personas abrieron sesión sobre la MISMA ubicación física. El
    // solape por ubicación se decide por el id, no solo por los SKUs que ya tiene.
    // Sólo cuando la ubicación ES el alcance: dos barridos completos del mismo estante se
    // pisan, pero contar Giro y contar Bell parados en el mismo estante, no.
    const alcanceEsUbicacion = (x) => x.ubicacion_id != null && !parseLista(x.categorias).length && !parseLista(x.marcas).length;
    if (a.ubicacion_id != null && a.ubicacion_id === b.ubicacion_id
        && alcanceEsUbicacion(a) && alcanceEsUbicacion(b)) return true;
    const skusA = skusDeAlcance(a.categorias, a.marcas, a.ubicacion_id);
    if (!skusA.size) return false;
    for (const sku of skusDeAlcance(b.categorias, b.marcas, b.ubicacion_id)) {
      if (skusA.has(sku)) return true;
    }
    return false;
  }

  // Los productos que provocan el choque, para poder mostrarlos en el 409. Mismo criterio
  // que sesionesSolapan, sólo que en vez de cortar en el primero los junta.
  function productosDelCruce(a, b, limite = 5) {
    const skusA = skusDeAlcance(a.categorias, a.marcas, a.ubicacion_id);
    const comunes = [...skusDeAlcance(b.categorias, b.marcas, b.ubicacion_id)].filter(sku => skusA.has(sku));
    if (!comunes.length) return { total: 0, ejemplos: [] };
    const marcadores = comunes.slice(0, limite).map(() => '?').join(',');
    const ejemplos = db.prepare(
      `SELECT sku, nombre, marca, categorias_json, stock FROM catalogo_cache WHERE sku IN (${marcadores})`
    ).all(...comunes.slice(0, limite)).map(p => ({
      sku: p.sku, nombre: p.nombre, marca: p.marca, stock: p.stock,
      categoria: parseCategorias(p.categorias_json)[0] || null,
    }));
    return { total: comunes.length, ejemplos };
  }

  const insertAlcance = db.prepare(`INSERT OR IGNORE INTO inventario_sesion_alcance
    (sesion_id, sku, nombre, marca, categoria_principal, stock_inicial, bloque, ad_hoc) VALUES (?,?,?,?,?,?,?,?)`);

  // Congela el alcance de la sesión (qué SKUs y en qué bloque). Se llama al crear
  // la sesión; también de forma perezosa al leer una sesión abierta creada antes
  // de esta versión (o migrada desde el esquema string), para no romperlas.
  // Cuando hay categoría o marca, la ubicación NO define el alcance: sólo dice dónde está
  // parado el operario, para que lo que escanee quede mapeado ahí (ver capturarUbicacion).
  // La ubicación sola sigue significando barrido completo de esa zona, como antes.
  //
  // Antes las dos cosas eran mutuamente excluyentes y el mapeo nunca se llenó: al 2026-09-10
  // había 0 de 33 sesiones con ubicación y 0 productos mapeados, porque en la tienda se
  // cuenta por marca y elegir ubicación obligaba a abandonar esa forma de contar.
  function congelarAlcance(sesionId, categorias, marcas, ubicacionId) {
    const porCatalogo = categorias.length || marcas.length;
    const enAlcance = (ubicacionId && !porCatalogo)
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
    // Se pueden combinar: la categoría/marca dice QUÉ se cuenta y la ubicación DÓNDE se está
    // parado, para que el mapeo se llene con el conteo que ya se hace.
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
    const abiertas = db.prepare("SELECT id, usuario, categorias, marcas, ubicacion_id, estado FROM inventario_sesiones WHERE estado IN ('abierta','confirmada_con_errores')").all();
    const nueva = { categorias, marcas, ubicacion_id: ubicacionId };
    const choque = abiertas.find(s => sesionesSolapan(s, nueva));
    if (choque) {
      // Los SKUs concretos del cruce. Sin esto el 409 dice "se cruza" y no hay forma de
      // saber por qué: el 2026-09-10 una ronda Shimano·TRANSMISIÓN quedó frenada por una
      // sesión de CASCOS·Giro a causa de 3 repuestos Shimano mal categorizados en CASCOS,
      // y hubo que salir a buscarlo a la base.
      const productos = productosDelCruce(choque, nueva);
      return res.status(409).json({
        ok: false,
        error: `El alcance se cruza con la sesión de ${choque.usuario}.`,
        productos_en_comun: productos.total,
        ejemplos: productos.ejemplos,
        ocupada_por: choque.usuario,
        ocupada_por_sesion_id: choque.id,
        ocupada_por_estado: choque.estado,
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
    const sesion = req.user?.is_admin
      ? db.prepare('SELECT * FROM inventario_sesiones WHERE id=?').get(req.params.id)
      : getSesion(req.params.id, req.user?.username);
    if (!sesion) return res.status(404).json({ ok: false, error: 'Sesión no encontrada' });
    asegurarAlcance(sesion);

    // LEFT JOIN en una sola consulta: esta pantalla se refresca después de cada
    // escaneo, no conviene compilar y correr un SELECT por ítem contado.
    // Resolución determinista (subselect LIMIT 1) para evitar duplicar ítems si
    // hay SKU homónimos en catalogo_cache.
    // `img`, `marca` y la categoría viajan para que la pantalla pueda dibujar UNA sola lista
    // ordenada por producto: contar algo no lo mueve de lugar, y para eso la fila contada
    // necesita las mismas claves de orden que la pendiente. La foto existe para el 99% del
    // catálogo (4.560 de 4.588) y hasta ahora no se usaba en ninguna pantalla de conteo.
    const conteos = db.prepare(`
      SELECT t.*,
             (SELECT sku FROM catalogo_cache WHERE sku = t.sku LIMIT 1) AS prod_sku,
             (SELECT stock FROM catalogo_cache WHERE sku = t.sku LIMIT 1) AS prod_stock,
             (SELECT nombre FROM catalogo_cache WHERE sku = t.sku LIMIT 1) AS prod_nombre,
             (SELECT img FROM catalogo_cache WHERE sku = t.sku LIMIT 1) AS prod_img,
             (SELECT marca FROM catalogo_cache WHERE sku = t.sku LIMIT 1) AS prod_marca,
             (SELECT categoria_principal FROM inventario_sesion_alcance
               WHERE sesion_id = t.sesion_id AND sku = t.sku LIMIT 1) AS prod_categoria
      FROM inventario_conteos t
      WHERE t.sesion_id = ?
      ORDER BY t.id
    `).all(sesion.id);
    const items = conteos.map(c => {
      const enCatalogo = c.prod_sku != null;
      return {
        id: c.id, ean: c.ean, sku: c.sku, cantidad: c.cantidad,
        nombre: c.prod_nombre || null,
        img: c.prod_img || null,
        marca: c.prod_marca || null,
        categoria_principal: c.prod_categoria || null,
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

    // CONTEO A CIEGAS (decisión del usuario, 2026-09-11). Mientras la sesión está abierta, un
    // producto que todavía no se contó viaja SIN su cantidad esperada: ni `stock_inicial`, ni
    // `stock_actual`, ni `bloque` — el bloque con_stock/sin_stock delata el número igual de
    // bien que el número mismo. La práctica de cycle counting detecta 20-30% más diferencias
    // sin ese anclaje. El gate de /confirmar sigue mirando el bloque del lado del servidor: lo
    // que cambia es qué sale por la API, no qué sabe el sistema.
    //
    // Con la sesión cerrada se manda todo: ahí ya no hay conteo que anclar y lo que se está
    // haciendo es auditar lo que pasó.
    const abierta = sesion.estado === 'abierta';
    // Ojo con el ORDEN, no sólo con los campos: `pendientesDeSesion` ordena `con_stock`
    // primero, así que la lista delata el bloque aunque el bloque no viaje. A ciegas se
    // reordena por categoría → marca → nombre, que es cómo está acomodado el local.
    const sinAnclaje = (a, b) =>
      String(a.categoria_principal || '').localeCompare(String(b.categoria_principal || ''), 'es')
      || String(a.marca || '').localeCompare(String(b.marca || ''), 'es')
      || String(a.nombre || '').localeCompare(String(b.nombre || ''), 'es');
    const pendientesOut = abierta
      ? pendientes
        // Los nombres con guion bajo son la convención del linter para "descartado a
        // propósito": esta desestructuración existe sólo para sacar esos cuatro campos.
        .map(({ stock_inicial: _si, stock_actual: _sa, stock_woo: _sw, bloque: _b, ...resto }) => resto)
        .sort(sinAnclaje)
      : pendientes;

    res.json({
      ok: true,
      sesion: sesionOut(sesion),
      items,
      pendientes: pendientesOut,
      resumen: abierta
        ? {
          pendientes: pendientes.length,
          fuera_de_alcance: items.filter(i => i.fuera_de_alcance).length,
          codigos_desconocidos: items.filter(i => i.codigo_desconocido).length,
        }
        : {
          pendientes: pendientes.length,
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
    // Guarda el SKU del padre cuando el código estaba cargado ahí, sólo para poder explicarlo.
    let skuEnPadre = null;
    if (looksLikeEan(codigo)) {
      ean = codigo;
      const catalogado = db.prepare('SELECT sku FROM catalogo_cache WHERE gtin=?').get(ean)
        || db.prepare('SELECT sku FROM ean_sku WHERE ean=?').get(ean);
      sku = catalogado?.sku || null;
    } else {
      ean = codigo; // se guarda igual como "código leído" aunque sea SKU, para tener una clave única por fila
      sku = codigo;
    }

    // Un código cargado en el producto PADRE (`tipo='variable'`) no se cuenta contra el padre.
    // Un padre no tiene stock propio —lo tienen sus variantes— así que el alcance ad hoc lo
    // excluye y la fila quedaría sin `stock_inicial`: el error recién aparecería al CERRAR la
    // sesión, con «stockInicial requerido», cuando ya es tarde y el operario no está.
    //
    // Caso real (sesión 34, 2026-09-11): la Caja Pedalera Un300 tiene el código en el padre y
    // el stock en tres variantes, que además YA estaban contadas — esa lectura era la misma
    // unidad contada dos veces. `/asociar` ya rechazaba un SKU variable con un mensaje claro;
    // esto cierra la misma puerta en el otro camino de entrada.
    //
    // Se deja como "sin asociar" en vez de rechazarlo: el producto es real y el operario lo
    // tiene en la mano. La pantalla abre el buscador para que elija la variante correcta, y de
    // paso el código queda bien cargado para la próxima.
    if (sku) {
      const prodResuelto = db.prepare(
        "SELECT tipo, no_contable FROM catalogo_cache WHERE sku=? LIMIT 1"
      ).get(sku);
      if (prodResuelto && (String(prodResuelto.tipo || '') === 'variable' || prodResuelto.no_contable)) {
        skuEnPadre = sku;
        sku = null;
      }
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
    //
    // FUSIÓN (2026-09-11). Antes esto era un UPDATE directo del sku sobre la fila del EAN, sin
    // mirar si la sesión YA tenía una fila con ese mismo SKU. `/escanear` deduplica por SKU
    // desde el 2026-08-25, pero ese dedup no puede actuar cuando el código todavía no resuelve:
    // el escaneo crea una fila con sku=null y es este endpoint el que le pone el SKU después.
    // Resultado real (sesión 33, casco Giro FB-67121, 2026-09-08): a las 14:42 se contó a mano
    // por SKU (cantidad 2) y a las 14:56 se escaneó su EAN sin asociar; al asociarlo quedaron
    // DOS filas del mismo producto, cada una con su propia diferencia, y el stock se publicó en
    // 0 teniendo las 3 unidades. Ahora, si ya hay una fila con ese SKU, se le suma la cantidad
    // y la fila del EAN se elimina: un producto, una fila.
    const filaEan = db.prepare('SELECT * FROM inventario_conteos WHERE sesion_id=? AND ean=?').get(sesion.id, ean);
    if (!filaEan) {
      return res.status(404).json({ ok: false, error: 'No hay ningún ítem escaneado con ese EAN en esta sesión' });
    }
    // `ajustado_en IS NULL` en la gemela: una fila que ya se escribió a Woo no se toca — sumarle
    // acá haría que un reintento de /confirmar aplique de nuevo un delta ya aplicado.
    const gemela = db.prepare(
      'SELECT * FROM inventario_conteos WHERE sesion_id=? AND sku=? AND id<>? AND ajustado_en IS NULL'
    ).get(sesion.id, sku, filaEan.id);
    // Id de la fila que queda viva: la gemela si hubo fusión, si no la del propio EAN. Todo lo
    // que sigue (corrección de bloque, respuesta) se resuelve por id y no por `ean`, porque
    // después de fundir esa fila ya no existe.
    const filaFinalId = gemela ? gemela.id : filaEan.id;
    if (gemela) {
      db.transaction(() => {
        db.prepare('UPDATE inventario_conteos SET cantidad=cantidad+?, confirmado_por_omision=0, actualizado_en=? WHERE id=?')
          .run(filaEan.cantidad || 0, now(), gemela.id);
        db.prepare('DELETE FROM inventario_conteos WHERE id=?').run(filaEan.id);
      })();
    } else {
      db.prepare('UPDATE inventario_conteos SET sku=?, bloque=?, fuera_de_alcance=?, codigo_desconocido=0, actualizado_en=? WHERE id=?')
        .run(sku, alcance?.bloque || null, alcance ? 0 : 1, now(), filaEan.id);
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
        db.prepare('UPDATE inventario_conteos SET bloque=? WHERE id=?').run(alcance.bloque, filaFinalId);
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

    const item = db.prepare('SELECT * FROM inventario_conteos WHERE id=?').get(filaFinalId);
    res.json({ ok: true, item: itemOut(item), fusionado: Boolean(gemela), codigo });
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
    // TEMPORAL (pedido explícito del usuario, 2026-08-27): sin scope por usuario —
    // cualquier usuario puede descartar la sesión de cualquier otro. Antes esto estaba
    // atado a getSesion(id, usuario) y una sesión 'confirmada_con_errores' de OTRO
    // usuario que chocaba de alcance con una nueva no tenía forma de destrabarse salvo
    // logueado como ese usuario. Revertir a getSesion(id, req.user?.username) cuando
    // se resuelva el flujo de verdad (permitir reintentar/descartar sesiones ajenas
    // trabadas sin compartir credenciales).
    const sesion = db.prepare('SELECT * FROM inventario_sesiones WHERE id=?').get(req.params.id);
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
    const sesion = req.user?.is_admin
      ? db.prepare('SELECT * FROM inventario_sesiones WHERE id=?').get(req.params.id)
      : getSesion(req.params.id, req.user?.username);
    if (!sesion) return res.status(404).json({ ok: false, error: 'Sesión no encontrada' });
    // Una sesión ya confirmada responde OK en vez de 400: desde que el admin puede resolver
    // las diferencias desde su pantalla (2026-09-10), la sesión puede cerrarse sola mientras
    // quien contaba todavía tiene abierta la vista con el botón "Confirmar". Ese reintento no
    // es un error del operario —el trabajo está hecho— y no toca nada: es idempotente.
    if (sesion.estado === 'confirmada') {
      return res.json({ ok: true, ya_confirmada: true, ajustados: 0, fallidos: 0, sesion: sesionOut(sesion) });
    }
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
            if (frenarSobrante && !req.user?.is_admin) {
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
        if (req.user?.is_admin) {
          db.prepare(`UPDATE inventario_diferencias
            SET revisado_en=COALESCE(revisado_en,?), revisado_por=COALESCE(revisado_por,?)
            WHERE sesion_id=? AND sku=? AND tipo='sobrante' AND requiere_revision=1 AND revisado_en IS NULL`)
            .run(now(), req.user.username || null, sesion.id, item.sku);
        }
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
  // Una diferencia pendiente puede estar en dos situaciones muy distintas, y la pantalla
  // tiene que poder separarlas (2026-09-10): al día de hoy, 5 de los 8 sobrantes pendientes
  // YA tienen su conteo ajustado (`ajustado_en`) y el stock de Woo ya coincide con lo contado
  // — alguien lo aplicó después (típicamente con "Confirmar ajuste como administrador", que
  // ajusta pero no marca la diferencia como revisada) y quedó el aviso colgado. Autorizar uno
  // de esos no duplica stock, porque setStockWcDelta corta cuando el stock live subió respecto
  // del inicial, pero devuelve un 502 incomprensible para quien lo aprieta.
  router.get('/diferencias/pendientes', (req, res) => {
    const rows = db.prepare(`
      SELECT d.*, c.nombre, c.marca, c.stock AS stock_actual,
             (SELECT t.ajustado_en FROM inventario_conteos t
               WHERE t.sesion_id=d.sesion_id AND t.sku=d.sku ORDER BY t.id DESC LIMIT 1) AS ajustado_en
      FROM inventario_diferencias d
      LEFT JOIN catalogo_cache c ON c.sku = d.sku
      WHERE d.requiere_revision=1 AND d.revisado_en IS NULL AND d.tipo='sobrante'
        AND d.id = (
          SELECT MAX(dup.id) FROM inventario_diferencias dup
          WHERE dup.sesion_id=d.sesion_id AND dup.sku=d.sku
            AND dup.tipo='sobrante' AND dup.requiere_revision=1 AND dup.revisado_en IS NULL
        )
      ORDER BY d.creado_en
    `).all();
    res.json({ ok: true, pendientes: rows.map(r => ({ ...r, ya_aplicado: !!r.ajustado_en })) });
  });

  // Diferencias de UNA sesión, para que el historial deje de ser sólo lectura. Hasta ahora las
  // diferencias sólo se veían agregadas en la tarjeta de auditoría del inicio, sin poder
  // atribuirlas a la ronda que las produjo: las 10 últimas sesiones acumulan 139 diferencias
  // por $29 M y no había forma de preguntar "¿qué pasó en la sesión de Shimano?".
  router.get('/sesiones/:id/diferencias', (req, res) => {
    const sesion = req.user?.is_admin
      ? db.prepare('SELECT id FROM inventario_sesiones WHERE id=?').get(req.params.id)
      : getSesion(req.params.id, req.user?.username);
    if (!sesion) return res.status(404).json({ ok: false, error: 'Sesión no encontrada' });
    const filas = db.prepare(`
      SELECT d.id, d.sku, d.tipo, d.cantidad_esperada, d.cantidad_contada, d.diferencia,
             d.valor_diferencia, d.requiere_revision, d.revisado_en, d.revisado_por, d.creado_en,
             c.nombre, c.marca, c.img, c.stock AS stock_actual
      FROM inventario_diferencias d
      LEFT JOIN catalogo_cache c ON c.sku = d.sku
      WHERE d.sesion_id = ?
      ORDER BY d.valor_diferencia DESC
    `).all(sesion.id);
    res.json({
      ok: true,
      diferencias: filas,
      total_valor: filas.reduce((a, f) => a + Number(f.valor_diferencia || 0), 0),
      faltantes: filas.filter(f => f.tipo === 'faltante').length,
      sobrantes: filas.filter(f => f.tipo === 'sobrante').length,
    });
  });

  // Faltantes que se aplicaron solos: el stock se mandó a cero sin que nadie lo autorizara.
  //
  // Es a propósito (decisión del usuario, 2026-09-10): frenarlos agregaría una cola de
  // aprobaciones diaria. Pero quedan a la vista para auditar, porque el riesgo es real y
  // conocido: hay movimiento entre depósito y salón que nadie asienta, así que un producto
  // contado en un lugar y guardado en el otro se publica en cero y deja de venderse. Al
  // 2026-09-10 eran 77 casos por $138.311.232, de los cuales 48 el propio sistema los había
  // marcado `requiere_revision=1` y se aplicaron igual.
  //
  // Se ordenan por valor: lo que duele es la bici de millones, no el casco suelto.
  router.get('/diferencias/aplicadas', (req, res) => {
    const dias = Math.min(Math.max(parseInt(req.query.dias, 10) || 30, 1), 365);
    const desde = new Date(Date.now() - dias * 24 * 3600 * 1000).toISOString();
    const rows = db.prepare(`
      SELECT d.id, d.sesion_id, d.sku, d.cantidad_esperada, d.cantidad_contada, d.diferencia,
             d.valor_diferencia, d.requiere_revision, d.creado_en,
             c.nombre, c.marca, c.stock AS stock_actual,
             s.usuario, s.confirmado_en
      FROM inventario_diferencias d
      LEFT JOIN catalogo_cache c ON c.sku = d.sku
      LEFT JOIN inventario_sesiones s ON s.id = d.sesion_id
      WHERE d.tipo='faltante' AND d.creado_en >= ?
      ORDER BY d.valor_diferencia DESC
      LIMIT 200
    `).all(desde);
    const total = rows.reduce((a, r) => a + Number(r.valor_diferencia || 0), 0);
    // `en_cero` se separa del total porque no es lo mismo un conteo parcial (contó 3 de 10,
    // el resto puede estar en otro estante) que un producto que no apareció en ningún lado.
    const enCero = rows.filter(r => Number(r.cantidad_contada) === 0).length;
    res.json({ ok: true, dias, total_valor: total, cantidad: rows.length, en_cero: enCero, aplicadas: rows });
  });

  // Una sesión cae en 'confirmada_con_errores' cuando al confirmar quedó al menos un ítem
  // sin ajustar — típicamente frenado por un sobrante grande que espera aprobación. Resolver
  // esa diferencia (aprobar o rechazar) puede sacar el último bloqueo, pero antes nadie
  // recalculaba el estado: la sesión quedaba trabada en 'confirmada_con_errores' con 0 ítems
  // sin ajustar, y como el anti-solape de POST /sesiones incluye ese estado, bloqueaba para
  // siempre cualquier alcance que se cruzara (incidente ZAPATILLAS, sesión 21, 2026-08-27).
  // Mismo criterio que usa /confirmar: sin conteos pendientes de ajuste, la sesión está cerrada.
  function recomputarEstadoSesion(sesionId) {
    const sesion = db.prepare('SELECT estado FROM inventario_sesiones WHERE id=?').get(sesionId);
    if (!sesion || sesion.estado !== 'confirmada_con_errores') return;
    const quedanFallidos = db.prepare(
      'SELECT COUNT(*) n FROM inventario_conteos WHERE sesion_id=? AND ajustado_en IS NULL'
    ).get(sesionId).n;
    if (quedanFallidos > 0) return;
    db.prepare("UPDATE inventario_sesiones SET estado='confirmada' WHERE id=? AND estado='confirmada_con_errores'")
      .run(sesionId);
  }

  // TEMPORAL (pedido explícito del usuario, 2026-08-27): sin requireAdmin mientras termina
  // el ciclo de conteo en curso — sacar el requireAdmin de estas dos rutas apenas termine.
  router.post('/diferencias/:id/aprobar', requireAdmin, async (req, res) => {
    const fila = db.prepare('SELECT * FROM inventario_diferencias WHERE id=?').get(req.params.id);
    if (!fila) return res.status(404).json({ ok: false, error: 'Diferencia no encontrada' });
    if (fila.revisado_en) return res.status(400).json({ ok: false, error: 'Esta diferencia ya fue revisada' });
    if (fila.tipo !== 'sobrante') {
      return res.status(400).json({ ok: false, error: 'Solo los sobrantes requieren aprobación; los faltantes ya se ajustaron automáticamente al confirmar la sesión' });
    }
    // Si el conteo de esa sesión ya se ajustó, el stock de Woo ya refleja lo contado y no hay
    // nada que aplicar: autorizar acá sólo cierra el aviso. Volver a llamar a setStockWcDelta
    // no duplicaría el stock (corta con "el stock aumentó durante el conteo"), pero le
    // devolvería un 502 a quien aprieta el botón por un trabajo que ya está hecho.
    const yaAjustado = db.prepare(`SELECT ajustado_en FROM inventario_conteos
      WHERE sesion_id=? AND sku=? ORDER BY id DESC LIMIT 1`).get(fila.sesion_id, fila.sku)?.ajustado_en;
    if (yaAjustado) {
      db.prepare('UPDATE inventario_diferencias SET revisado_en=?, revisado_por=? WHERE id=?')
        .run(now(), req.user?.username || null, fila.id);
      recomputarEstadoSesion(fila.sesion_id);
      return res.json({ ok: true, ya_aplicado: true, ajustado_en: yaAjustado });
    }

    try {
      // Si el stock actual ya coincide con el conteo físico, el aumento vino de una
      // operación externa durante la sesión (recepción, ajuste, etc.). La autorización
      // valida esa conciliación y debe cerrar el caso SIN otro PUT, que duplicaría stock.
      const stockLive = await getStockLiveWc(wooCfg, db, fila.sku);
      if (stockLive === fila.cantidad_contada) {
        const ts = now();
        db.transaction(() => {
          db.prepare(`UPDATE inventario_diferencias
            SET revisado_en=?, revisado_por=?
            WHERE sesion_id=? AND sku=? AND tipo='sobrante' AND requiere_revision=1 AND revisado_en IS NULL`)
            .run(ts, req.user?.username || null, fila.sesion_id, fila.sku);
          db.prepare(`UPDATE inventario_conteos SET ajustado_en=?
            WHERE sesion_id=? AND sku=? AND ajustado_en IS NULL`)
            .run(ts, fila.sesion_id, fila.sku);
        })();
        recomputarEstadoSesion(fila.sesion_id);
        return res.json({ ok: true, ya_conciliado: true, stock_live: stockLive });
      }
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
      recomputarEstadoSesion(fila.sesion_id);
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
    // Antes no se recomputaba acá, con el argumento de que rechazar cierra la sesión vía
    // /confirmar y así se preserva la confirmación explícita del usuario. Ese argumento sólo
    // valía cuando la misma persona que contaba reintentaba /confirmar. Desde que existe la
    // pantalla de autorización (2026-09-10), quien resuelve es el admin desde otra vista y
    // nunca pasa por /confirmar: la sesión quedaba con 0 conteos sin ajustar pero seguía en
    // 'confirmada_con_errores', o sea seguía bloqueando el anti-solape de cualquier alcance
    // que se cruzara — exactamente el problema que la pantalla venía a resolver.
    // recomputarEstadoSesion sólo promueve cuando no queda nada sin ajustar, así que no
    // adelanta ningún cierre: si algo sigue pendiente, la sesión no se mueve.
    recomputarEstadoSesion(fila.sesion_id);
    res.json({ ok: true });
  });

  router.get('/sesiones', (req, res) => {
    const usuario = req.user?.username;
    const esAdmin = !!req.user?.is_admin;
    // Una sola consulta agregada (LEFT JOIN + COUNT condicional) en vez de un COUNT
    // por sesión en un loop: para 'descartada' el conteo de fallidos no aplica (0),
    // porque esas sesiones nunca llegaron a intentar el ajuste en Woo.
    const rows = db.prepare(`
      SELECT s.*, COUNT(CASE WHEN s.estado <> 'descartada' AND t.id IS NOT NULL AND t.ajustado_en IS NULL THEN 1 END) AS fallidos
      FROM inventario_sesiones s
      LEFT JOIN inventario_conteos t ON t.sesion_id = s.id AND s.estado <> 'descartada'
      WHERE ${esAdmin ? "s.estado IN ('abierta','confirmando','confirmada','confirmada_con_errores','descartada')" : "s.usuario=? AND s.estado IN ('confirmada','confirmada_con_errores','descartada')"}
      GROUP BY s.id
      ORDER BY COALESCE(s.confirmado_en, s.creado_en) DESC LIMIT 100
    `).all(...(esAdmin ? [] : [usuario]));
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
