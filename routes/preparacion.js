import fs from 'fs';
import path from 'path';
import express from 'express';
import multer from 'multer';
import sharp from 'sharp';
import heicConvert from 'heic-convert';
import { wooFetch } from './woo.js';
import { mlFetch } from '../lib/mlClient.js';
import { skuDesdeMl } from '../lib/mlMapeo.js';
import { guardarArchivo, rutaAbsoluta, estaDentroDeUploads } from '../utils/storage.js';
import {
  normalizarEnvio, resolverPerfil, requisitosFoto, fotosFaltantes, esEnvioLocal,
} from '../lib/preparacion.js';
import { normalizarPedidoWc, normalizarOrdenMl } from '../lib/modelos/ordenVenta.js';
import { productoDesdeFilaCatalogo } from '../lib/modelos/producto.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

const now = () => new Date().toISOString();

// Perfiles de foto soportados (validación de los endpoints de perfiles por categoría y por SKU).
const PERFILES_VALIDOS = ['bici', 'kit_transmision', 'sellado'];

// ─── Tablas (idempotente, patrón de routes/pedidos.js) ───────────────────────

function ensureTables(db) {
  db.prepare(`CREATE TABLE IF NOT EXISTS preparaciones (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    canal           TEXT NOT NULL,
    clave           TEXT NOT NULL UNIQUE,
    wc_order_id     INTEGER,
    ml_order_id     TEXT,
    numero_pedido   TEXT,
    comprador       TEXT,
    etiqueta_lista  INTEGER NOT NULL DEFAULT 0,
    estado          TEXT NOT NULL DEFAULT 'en_preparacion',
    notas           TEXT,
    preparado_por   TEXT,
    creado_en       TEXT NOT NULL,
    completado_en   TEXT
  )`).run();

  db.prepare(`CREATE TABLE IF NOT EXISTS preparacion_items (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    preparacion_id     INTEGER NOT NULL,
    line_item_id       INTEGER,
    product_id         INTEGER,
    variation_id       INTEGER,
    sku                TEXT,
    nombre             TEXT,
    categoria          TEXT,
    perfil             TEXT NOT NULL DEFAULT 'sellado',
    cantidad_esperada  INTEGER NOT NULL DEFAULT 1,
    cantidad_escaneada INTEGER NOT NULL DEFAULT 0,
    confirmado_manual  INTEGER NOT NULL DEFAULT 0,
    estado_embalaje    TEXT,
    despacho           TEXT NOT NULL DEFAULT 'local',
    despacho_motivo    TEXT,
    estado_item        TEXT NOT NULL DEFAULT 'pendiente'
  )`).run();

  db.prepare(`CREATE TABLE IF NOT EXISTS preparacion_fotos (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    preparacion_id INTEGER NOT NULL,
    item_id        INTEGER,
    tipo           TEXT NOT NULL,
    url            TEXT NOT NULL,
    nombre_archivo TEXT,
    creado_en      TEXT NOT NULL
  )`).run();

  db.prepare(`CREATE TABLE IF NOT EXISTS preparacion_perfiles (
    categoria       TEXT PRIMARY KEY,
    perfil          TEXT NOT NULL,
    requisitos_json TEXT,
    actualizado_en  TEXT NOT NULL
  )`).run();

  // Overrides por SKU exacto: tienen prioridad sobre las reglas por categoria.
  // Arranca vacia a proposito (el operario la completa caso por caso, sin seed).
  db.prepare(`CREATE TABLE IF NOT EXISTS preparacion_perfiles_sku (
    sku             TEXT PRIMARY KEY,
    perfil          TEXT NOT NULL,
    requisitos_json TEXT,
    actualizado_en  TEXT NOT NULL
  )`).run();

  // Seed de perfiles por defecto (el usuario los edita desde la UI)
  const seed = db.prepare(
    'INSERT OR IGNORE INTO preparacion_perfiles (categoria, perfil, requisitos_json, actualizado_en) VALUES (?,?,NULL,?)'
  );
  seed.run('BICICLETAS', 'bici', now());
  seed.run('TRANSMISIONES', 'kit_transmision', now());

  db.prepare(`CREATE TABLE IF NOT EXISTS pedidos_cache (
    clave           TEXT PRIMARY KEY,
    canal           TEXT NOT NULL,
    wc_order_id     INTEGER,
    ml_order_id     TEXT,
    numero_pedido   TEXT,
    comprador       TEXT,
    fecha           TEXT,
    estado_envio    TEXT NOT NULL,
    estado_wc       TEXT,
    espejo_ml       INTEGER NOT NULL DEFAULT 0,
    logistic_type   TEXT,
    substatus       TEXT,
    items_json      TEXT NOT NULL,
    actualizado_en  TEXT NOT NULL
  )`).run();
  db.prepare('CREATE INDEX IF NOT EXISTS idx_pedidos_cache_estado ON pedidos_cache(estado_envio)').run();

  db.prepare(`CREATE TABLE IF NOT EXISTS preparacion_vistas (
    preparacion_id INTEGER NOT NULL,
    usuario        TEXT NOT NULL,
    visto_en       TEXT NOT NULL,
    PRIMARY KEY (preparacion_id, usuario)
  )`).run();

  db.prepare(`CREATE TABLE IF NOT EXISTS preparacion_eventos (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    preparacion_id INTEGER NOT NULL,
    item_id        INTEGER,
    tipo           TEXT NOT NULL,
    usuario        TEXT,
    detalle_json   TEXT NOT NULL,
    creado_en      TEXT NOT NULL
  )`).run();
  db.prepare('CREATE INDEX IF NOT EXISTS idx_preparacion_eventos_prep ON preparacion_eventos(preparacion_id, id)').run();

  // borrado_en: soft-delete de fotos (columna nueva, agregada con try/catch porque SQLite
  // no tiene "ADD COLUMN IF NOT EXISTS" — falla con "duplicate column" si ya existe, y eso
  // es justamente lo esperado en cada arranque salvo el primero).
  try {
    db.prepare('ALTER TABLE preparacion_fotos ADD COLUMN borrado_en TEXT').run();
  } catch (e) {
    if (!/duplicate column/i.test(e.message)) console.error('ensureTables borrado_en:', e.message);
  }

  // woo_paso2_pendiente: marca un pedido web que llegó a 'completed' en Woo (paso 1 del
  // seguimiento) pero cuyo paso 2 (status final enviadoandreani) todavía no se confirmó —
  // permite que reintentarColgadosTracking lo encuentre sin volver a escanear Woo.
  try {
    db.prepare('ALTER TABLE preparaciones ADD COLUMN woo_paso2_pendiente INTEGER NOT NULL DEFAULT 0').run();
  } catch (e) {
    if (!/duplicate column/i.test(e.message)) console.error('ensureTables woo_paso2_pendiente:', e.message);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Perfil de un ítem, por orden de prioridad:
//   1) override por SKU exacto (preparacion_perfiles_sku),
//   2) override por categoría (preparacion_perfiles, match por substring, la regla más larga gana),
//   3) heurística por nombre (resolverPerfil, sin cambios).
function perfilParaItem(db, { sku, categoria, nombre }) {
  const skuNorm = String(sku || '').trim().toUpperCase();
  if (skuNorm) {
    const reglaSku = db.prepare('SELECT perfil FROM preparacion_perfiles_sku WHERE sku=?').get(skuNorm);
    if (reglaSku) return reglaSku.perfil;
  }
  const cats = String(categoria || '').toUpperCase();
  if (cats) {
    const reglas = db.prepare('SELECT categoria, perfil FROM preparacion_perfiles ORDER BY LENGTH(categoria) DESC').all();
    for (const r of reglas) {
      if (cats.includes(r.categoria.toUpperCase())) return r.perfil;
    }
  }
  return resolverPerfil({ categorias: categoria, nombre });
}

// Requisitos de foto de un ítem, respetando requisitos_json custom: primero por SKU
// exacto, después por categoría, y al final el default del perfil.
function requisitosParaItem(db, item) {
  const skuNorm = String(item.sku || '').trim().toUpperCase();
  if (skuNorm) {
    const reglaSku = db.prepare('SELECT requisitos_json FROM preparacion_perfiles_sku WHERE sku=?').get(skuNorm);
    // El override por SKU es la regla más específica: si existe la fila, cortocircuita
    // el bloque de categoría (igual que perfilParaItem). Si no cortara, un SKU con
    // perfil forzado a kit_transmision heredaría los requisitos_json de la categoría
    // (otro perfil, ej. sellado) y el ítem se podría completar con la foto incorrecta.
    if (reglaSku) {
      if (reglaSku.requisitos_json) {
        try {
          const custom = JSON.parse(reglaSku.requisitos_json);
          const slots = custom[item.estado_embalaje || 'default'] || custom.default;
          if (Array.isArray(slots) && slots.length) return slots;
        } catch (_) { /* JSON inválido: cae a la heurística base del perfil ya resuelto */ }
      }
      // Sin requisitos_json propios (o inválidos): heurística base del perfil ya
      // resuelto por SKU, sin pasar por la categoría.
      return requisitosFoto(item.perfil, item.estado_embalaje);
    }
  }
  const cats = String(item.categoria || '').toUpperCase();
  if (cats) {
    const reglas = db.prepare(
      'SELECT categoria, requisitos_json FROM preparacion_perfiles WHERE requisitos_json IS NOT NULL ORDER BY LENGTH(categoria) DESC'
    ).all();
    for (const r of reglas) {
      if (!cats.includes(r.categoria.toUpperCase())) continue;
      try {
        const custom = JSON.parse(r.requisitos_json);
        const slots = custom[item.estado_embalaje || 'default'] || custom.default;
        if (Array.isArray(slots) && slots.length) return slots;
      } catch (_) { /* JSON inválido: cae al default */ }
    }
  }
  return requisitosFoto(item.perfil, item.estado_embalaje);
}

// Crea (o completa) una preparación con el snapshot de sus ítems.
// Idempotente por clave: si ya existe con ítems, devuelve el id existente.
export function crearPreparacion(db, { canal, wcOrderId = null, mlOrderId = null, numeroPedido, comprador, items = [] }) {
  ensureTables(db);
  const clave = canal === 'web' ? `web:${wcOrderId}` : `ml:${mlOrderId}`;

  const existente = db.prepare('SELECT id FROM preparaciones WHERE clave=?').get(clave);
  let prepId = existente?.id;

  const tx = db.transaction(() => {
    if (!prepId) {
      prepId = db.prepare(`INSERT INTO preparaciones
        (canal, clave, wc_order_id, ml_order_id, numero_pedido, comprador, estado, creado_en)
        VALUES (?,?,?,?,?,?, 'en_preparacion', ?)`)
        .run(canal, clave, wcOrderId, mlOrderId, numeroPedido || null, comprador || null, now()).lastInsertRowid;
    }
    const tieneItems = db.prepare('SELECT 1 FROM preparacion_items WHERE preparacion_id=? LIMIT 1').get(prepId);
    if (tieneItems) return;

    const ins = db.prepare(`INSERT INTO preparacion_items
      (preparacion_id, line_item_id, product_id, variation_id, sku, nombre, categoria, perfil, cantidad_esperada)
      VALUES (?,?,?,?,?,?,?,?,?)`);
    for (const it of items) {
      const perfil = perfilParaItem(db, { sku: it.sku, categoria: it.categoria, nombre: it.nombre });
      ins.run(prepId, it.line_item_id || null, it.product_id || null, it.variation_id || null,
        it.sku || '', it.nombre || '', it.categoria || '', perfil,
        Math.max(1, parseInt(it.cantidad) || 1));
    }
  });
  tx();
  return prepId;
}

export function registrarEvento(db, { preparacionId, itemId = null, tipo, usuario, detalle }) {
  // Fail-open a propósito: el historial de "Actividad" es auxiliar, nunca debe poder
  // frenar la acción real (escanear, subir foto, etc.) que el operario está haciendo.
  try {
    db.prepare(`
      INSERT INTO preparacion_eventos (preparacion_id, item_id, tipo, usuario, detalle_json, creado_en)
      VALUES (?,?,?,?,?,?)
    `).run(preparacionId, itemId, tipo, usuario ?? null, JSON.stringify(detalle ?? {}), now());
  } catch (e) {
    console.error('registrarEvento: no se pudo registrar', tipo, e.message);
  }
}

// Purga del disco y de la tabla las fotos con soft-delete de más de 60 días.
// Devuelve la cantidad purgada (para logging del cron).
export function purgarFotosBorradas(db) {
  const limite = new Date(Date.now() - 60 * 24 * 3600 * 1000).toISOString();
  const vencidas = db.prepare('SELECT id, url FROM preparacion_fotos WHERE borrado_en IS NOT NULL AND borrado_en < ?').all(limite);
  let purgadas = 0;
  for (const f of vencidas) {
    // Contención (defensa en profundidad): si la ruta resuelta cae fuera de uploads/,
    // no borramos nada y dejamos la fila para revisión manual.
    const abs = path.resolve(rutaAbsoluta(f.url));
    if (!estaDentroDeUploads(abs)) {
      console.error('purgarFotosBorradas: url fuera de uploads/, se omite (revisión manual):', f.id, f.url);
      continue;
    }
    try {
      fs.unlinkSync(abs);
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.error('purgarFotosBorradas: error al borrar archivo, se borra igual la fila:', f.id, f.url, err.message);
      }
    }
    db.prepare('DELETE FROM preparacion_fotos WHERE id=?').run(f.id);
    purgadas++;
  }
  return purgadas;
}

// Parsea detalle_json de forma defensiva: la Actividad es auxiliar y nunca debe poder
// bloquear la apertura del pedido por un JSON corrupto o NULL en un evento viejo.
function mapearEvento(e) {
  let parsed = null;
  try { parsed = JSON.parse(e.detalle_json); } catch (_) { /* detalle_json inválido */ }
  // JSON.parse('null') no lanza excepción y devuelve `null` (no un objeto), así que el
  // catch de arriba no lo agarra: hay que chequear el tipo del resultado también.
  const detalle = (parsed && typeof parsed === 'object') ? parsed : {};
  return { ...e, detalle };
}

// Reintenta el paso 2 (status final) de cada pedido "colgado" (paso 1 ya confirmado en
// Woo, paso 2 pendiente). Fail-open por ítem: si uno vuelve a fallar, sigue con el resto
// y lo deja para la corrida siguiente del cron. Devuelve cuántos se resolvieron.
export async function reintentarColgadosTracking(db, cfg) {
  const pendientes = db.prepare('SELECT * FROM preparaciones WHERE woo_paso2_pendiente=1').all();
  let resueltos = 0;
  for (const prep of pendientes) {
    try {
      await wooFetch(cfg.woo, `/orders/${prep.wc_order_id}`, 'put', { status: cfg.enviadoAndreaniStatus || 'enviadoandreani' });
      db.prepare("UPDATE preparaciones SET estado='completada', completado_en=?, woo_paso2_pendiente=0 WHERE id=?")
        .run(new Date().toISOString(), prep.id);
      registrarEvento(db, { preparacionId: prep.id, itemId: null, tipo: 'tracking_recuperado', usuario: null, detalle: {} });
      resueltos++;
    } catch (e) {
      console.error(`reintentarColgadosTracking: sigue colgado wc_order_id=${prep.wc_order_id}:`, e.message);
    }
  }
  return resueltos;
}

function getPrep(db, id) {
  return db.prepare('SELECT * FROM preparaciones WHERE id=?').get(parseInt(id));
}

// Busca en preparacion_eventos quién subió una foto, mirando el evento 'foto_subida'
// que quedó registrado con ese foto_id en su detalle_json. Fail-open a propósito (igual
// que registrarEvento): si json_extract fallara (JSON1 no disponible, detalle_json
// corrupto en un evento viejo) o no hubiera evento previo (foto preexistente al ciclo de
// instrumentación), devuelve null y nunca lanza — el borrado de la foto no debe romperse
// por esto.
function usuarioQueSubio(db, fotoId, preparacionId) {
  try {
    const evento = db.prepare(
      "SELECT usuario FROM preparacion_eventos WHERE tipo='foto_subida' AND preparacion_id=? AND json_extract(detalle_json,'$.foto_id')=? ORDER BY id DESC LIMIT 1"
    ).get(preparacionId, fotoId);
    return evento?.usuario ?? null;
  } catch (e) {
    console.error('usuarioQueSubio: no se pudo consultar', e.message);
    return null;
  }
}

// ─── Router ───────────────────────────────────────────────────────────────────

export function preparacionRouter(db, cfg) {
  ensureTables(db);
  const router = express.Router();
  const andreaniStatus = cfg?.andreaniStatus || 'lpaandreani';
  const enviadoAndreaniStatus = cfg?.enviadoAndreaniStatus || 'enviadoandreani';
  const TRACKING_META_KEY = '_andreani_tracking';

  // ── Pendientes: lee de pedidos_cache (sincronizada por cron cada 5 min) ──
  router.get('/pendientes', (req, res) => {
    try {
      const rows = db.prepare("SELECT * FROM pedidos_cache WHERE estado_envio='pendiente' ORDER BY fecha ASC").all();
      const data = rows.map(row => {
        const prep = db.prepare('SELECT id, estado, etiqueta_lista FROM preparaciones WHERE clave=?').get(row.clave);
        const items = JSON.parse(row.items_json);
        if (row.canal === 'web') {
          return {
            canal: 'web',
            espejo_ml: !!row.espejo_ml,
            wc_order_id: row.wc_order_id,
            numero_pedido: row.numero_pedido,
            comprador: row.comprador,
            fecha: row.fecha,
            estado_wc: row.estado_wc,
            items,
            preparacion_id: prep?.id || null,
            estado_preparacion: prep?.estado || null,
            etiqueta_lista: prep?.etiqueta_lista || 0,
          };
        }
        return {
          canal: 'ml',
          ml_order_id: row.ml_order_id,
          wc_order_id: row.wc_order_id,
          numero_pedido: row.numero_pedido,
          comprador: row.comprador,
          fecha: row.fecha,
          logistic_type: row.logistic_type,
          substatus: row.substatus,
          items,
          preparacion_id: prep?.id || null,
          estado_preparacion: prep?.estado || null,
        };
      });
      const ultimoLog = db.prepare(
        "SELECT creado_en, estado, error FROM sync_log WHERE direccion='pedidos_cache' ORDER BY id DESC LIMIT 1"
      ).get();
      res.json({
        ok: true,
        data,
        actualizado_en: ultimoLog?.creado_en || null,
        sync_error: ultimoLog?.estado === 'error' ? ultimoLog.error : null,
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ── Estados de pedido vistos en WC (respaldo para confirmar el slug) ──
  router.get('/estados-wc', async (req, res) => {
    try {
      const resp = await wooFetch(cfg.woo, '/orders?per_page=100');
      const conteo = {};
      for (const o of resp.data || []) conteo[o.status] = (conteo[o.status] || 0) + 1;
      res.json({ ok: true, data: conteo, configurado: andreaniStatus });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ── Etiquetas Andreani: una fila por pedido web pendiente ──
  router.get('/etiquetas', async (req, res) => {
    try {
      const resp = await wooFetch(cfg.woo, `/orders?status=${encodeURIComponent(andreaniStatus)}&per_page=100`);
      const filas = (resp.data || []).map(order => {
        const prep = db.prepare('SELECT id, etiqueta_lista, estado FROM preparaciones WHERE clave=?').get(`web:${order.id}`);
        return {
          wc_order_id: order.id,
          envio: normalizarEnvio(order),
          etiqueta_lista: prep?.etiqueta_lista || 0,
          preparacion_id: prep?.id || null,
          estado_preparacion: prep?.estado || null,
        };
      });
      res.json({ ok: true, data: filas });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // Marca/desmarca "etiqueta lista"; crea la preparación mínima si no existía
  // (las etiquetas suelen hacerse antes de empezar a embalar).
  router.post('/etiquetas/:wcOrderId/lista', (req, res) => {
    const wcOrderId = parseInt(req.params.wcOrderId);
    if (!wcOrderId) return res.status(400).json({ ok: false, error: 'wcOrderId inválido' });
    const { lista = true, numero_pedido, comprador } = req.body || {};
    const clave = `web:${wcOrderId}`;
    db.prepare(`INSERT INTO preparaciones (canal, clave, wc_order_id, numero_pedido, comprador, etiqueta_lista, estado, creado_en)
      VALUES ('web', ?, ?, ?, ?, ?, 'en_preparacion', ?)
      ON CONFLICT(clave) DO UPDATE SET etiqueta_lista=excluded.etiqueta_lista`)
      .run(clave, wcOrderId, numero_pedido || String(wcOrderId), comprador || null, lista ? 1 : 0, now());
    res.json({ ok: true, etiqueta_lista: lista ? 1 : 0 });
  });

  // ── Seguimientos: pedidos web con etiqueta ya lista, esperando tracking ──
  // Incluye además "colgados": pedidos en 'completed' con el tracking ya cargado
  // pero que nunca llegaron a enviadoandreani (p.ej. si el 2º PUT falló), para
  // poder reintentar sin reenviar el mail al cliente.
  router.get('/seguimientos', async (req, res) => {
    try {
      const resp = await wooFetch(cfg.woo, `/orders?status=${encodeURIComponent(andreaniStatus)}&per_page=100`);
      const filas = (resp.data || [])
        .map(order => {
          const prep = db.prepare('SELECT id, etiqueta_lista, estado FROM preparaciones WHERE clave=?').get(`web:${order.id}`);
          return prep && prep.etiqueta_lista
            ? { wc_order_id: order.id, envio: normalizarEnvio(order), preparacion_id: prep.id, estado_preparacion: prep.estado, colgado: false }
            : null;
        })
        .filter(Boolean);

      // Colgados en 'completed' con tracking cargado (sin llegar a enviadoandreani)
      const compResp = await wooFetch(cfg.woo, '/orders?status=completed&per_page=100');
      for (const order of compResp.data || []) {
        const meta = (order.meta_data || []).find(m => m.key === TRACKING_META_KEY && String(m.value || '').trim());
        if (!meta) continue;
        const prep = db.prepare('SELECT id, estado FROM preparaciones WHERE clave=?').get(`web:${order.id}`);
        filas.push({
          wc_order_id: order.id,
          envio: normalizarEnvio(order),
          preparacion_id: prep?.id || null,
          estado_preparacion: prep?.estado || null,
          colgado: true,
          tracking: String(meta.value).trim(),
        });
      }

      res.json({ ok: true, data: filas });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ── Cargar tracking: guarda meta + avanza status lpaandreani → completed → enviadoandreani ──
  router.post('/seguimientos/:wcOrderId', async (req, res) => {
    const wcOrderId = parseInt(req.params.wcOrderId);
    if (!wcOrderId) return res.status(400).json({ ok: false, error: 'wcOrderId inválido' });
    const tracking = String(req.body?.tracking || '').trim();
    if (!tracking) return res.status(400).json({ ok: false, error: 'tracking requerido' });

    try {
      const actual = await wooFetch(cfg.woo, `/orders/${wcOrderId}`);
      const statusActual = actual.data?.status;
      const metaExistente = (actual.data.meta_data || []).find(m => m.key === TRACKING_META_KEY);
      const trackingGuardado = String(metaExistente?.value || '').trim();

      // Fail-closed: solo se acepta desde el estado de origen (lpaandreani) o
      // desde un pedido "colgado" en 'completed' que ya tenga guardado EXACTAMENTE
      // el mismo tracking (reintento). Si está 'completed' con un tracking distinto
      // no se pisa: haría un PUT1 que reenvía el mail nativo al cliente. Corregir un
      // tracking erróneo sería un flujo aparte, hoy hacemos fail-closed.
      const enOrigen = statusActual === andreaniStatus;
      const colgadoCompletado = statusActual === 'completed' && trackingGuardado === tracking;
      if (!enOrigen && !colgadoCompletado) {
        return res.status(409).json({
          ok: false,
          error: `el pedido está en estado '${statusActual}', no se puede cargar el seguimiento`,
        });
      }

      const metaEntry = metaExistente
        ? { id: metaExistente.id, key: TRACKING_META_KEY, value: tracking }
        : { key: TRACKING_META_KEY, value: tracking };

      // Paso 1: guarda el tracking y pasa a 'completed' (dispara el mail nativo de WooCommerce).
      // Se saltea cuando el pedido ya está en 'completed' con el mismo tracking (reintento):
      // así no se reenvía el mail al cliente.
      const yaCompletadoMismoTracking = statusActual === 'completed' && trackingGuardado === tracking;
      if (!yaCompletadoMismoTracking) {
        await wooFetch(cfg.woo, `/orders/${wcOrderId}`, 'put', {
          status: 'completed',
          meta_data: [metaEntry],
        });
      }
      // Registro local ANTES del paso 2: si el paso 2 falla, igual queda constancia de
      // que el pedido llegó a 'completed' con tracking guardado — sin esto, la única
      // fuente de verdad sería Woo (y solo se detectaría escaneando status=completed).
      db.prepare(`INSERT INTO preparaciones (canal, clave, wc_order_id, etiqueta_lista, estado, creado_en, woo_paso2_pendiente)
        VALUES ('web', ?, ?, 1, 'en_preparacion', ?, 1)
        ON CONFLICT(clave) DO UPDATE SET woo_paso2_pendiente=1`)
        .run(`web:${wcOrderId}`, wcOrderId, now());

      // Paso 2: estado final custom, en una segunda escritura separada. Si falla, no se
      // relanza — queda "colgado" (woo_paso2_pendiente=1) para que reintentarColgadosTracking
      // (cron) o un reintento manual del operario lo resuelvan después.
      try {
        await wooFetch(cfg.woo, `/orders/${wcOrderId}`, 'put', { status: enviadoAndreaniStatus });
      } catch (e) {
        const prep = db.prepare('SELECT id FROM preparaciones WHERE clave=?').get(`web:${wcOrderId}`);
        if (prep) {
          registrarEvento(db, {
            preparacionId: prep.id, itemId: null, tipo: 'tracking_colgado', usuario: req.user?.username,
            detalle: { error: e.message },
          });
        }
        return res.status(502).json({
          ok: false, colgado: true,
          error: 'el tracking se guardó pero no se pudo marcar como enviado (se reintentará solo)',
        });
      }

      db.prepare(`UPDATE preparaciones SET estado='completada', completado_en=?, woo_paso2_pendiente=0 WHERE clave=?`)
        .run(now(), `web:${wcOrderId}`);

      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ── Lookup de solo lectura: tracking actual + si es corregible ──
  router.get('/seguimientos/:wcOrderId/tracking-actual', async (req, res) => {
    const wcOrderId = parseInt(req.params.wcOrderId);
    if (!wcOrderId) return res.status(400).json({ ok: false, error: 'wcOrderId inválido' });
    try {
      const actual = await wooFetch(cfg.woo, `/orders/${wcOrderId}`);
      const status = actual.data?.status;
      const meta = (actual.data.meta_data || []).find(m => m.key === TRACKING_META_KEY);
      const trackingActual = String(meta?.value || '').trim();
      const corregible = (status === 'completed' || status === enviadoAndreaniStatus) && !!trackingActual;
      res.json({ ok: true, status, tracking_actual: trackingActual, corregible });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ── Corregir un tracking ya cargado, sin reenviar el mail nativo (solo meta_data) ──
  router.post('/seguimientos/:wcOrderId/corregir-tracking', async (req, res) => {
    const wcOrderId = parseInt(req.params.wcOrderId);
    if (!wcOrderId) return res.status(400).json({ ok: false, error: 'wcOrderId inválido' });
    const trackingNuevo = String(req.body?.tracking || '').trim();
    if (!trackingNuevo) return res.status(400).json({ ok: false, error: 'tracking requerido' });

    try {
      const actual = await wooFetch(cfg.woo, `/orders/${wcOrderId}`);
      const status = actual.data?.status;
      if (status !== 'completed' && status !== enviadoAndreaniStatus) {
        return res.status(409).json({ ok: false, error: `el pedido está en estado '${status}', no se puede corregir` });
      }
      const metaExistente = (actual.data.meta_data || []).find(m => m.key === TRACKING_META_KEY);
      const trackingAnterior = String(metaExistente?.value || '').trim();
      if (!trackingAnterior) {
        return res.status(409).json({ ok: false, error: 'no hay tracking cargado para corregir — usá el flujo normal de seguimientos' });
      }

      if (trackingNuevo === trackingAnterior) {
        return res.json({ ok: true, tracking_anterior: trackingAnterior, tracking_nuevo: trackingNuevo });
      }

      await wooFetch(cfg.woo, `/orders/${wcOrderId}`, 'put', {
        meta_data: [{ id: metaExistente.id, key: TRACKING_META_KEY, value: trackingNuevo }],
      });

      const prep = db.prepare('SELECT id FROM preparaciones WHERE clave=?').get(`web:${wcOrderId}`);
      if (prep) {
        registrarEvento(db, {
          preparacionId: prep.id, itemId: null, tipo: 'tracking_corregido', usuario: req.user?.username,
          detalle: { tracking_anterior: trackingAnterior, tracking_nuevo: trackingNuevo },
        });
      }

      res.json({ ok: true, tracking_anterior: trackingAnterior, tracking_nuevo: trackingNuevo });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ── Iniciar preparación (snapshot de ítems desde WC o ML) ──
  router.post('/iniciar', async (req, res) => {
    const { canal, id } = req.body || {};
    try {
      if (canal === 'web') {
        const resp = await wooFetch(cfg.woo, `/orders/${id}`);
        const p = armarPendienteWeb(db, resp.data);
        const prepId = crearPreparacion(db, {
          canal: 'web', wcOrderId: resp.data.id,
          numeroPedido: String(resp.data.number || resp.data.id),
          comprador: `${resp.data.billing?.first_name || ''} ${resp.data.billing?.last_name || ''}`.trim(),
          items: p.items,
        });
        return res.json({ ok: true, id: prepId });
      }
      if (canal === 'ml') {
        const resp = await mlFetch(db, cfg.ml, 'get', `/orders/${id}`);
        if (resp.status !== 200) throw new Error(`ML order ${resp.status}`);
        const orden = resp.data;
        const items = itemsDesdeOrdenMl(db, orden);
        const vinculo = db.prepare('SELECT wc_order_id FROM ordenes_ml_wc_pedidos WHERE ml_order_id=?').get(String(orden.id));
        const prepId = crearPreparacion(db, {
          canal: 'ml', mlOrderId: String(orden.id), wcOrderId: vinculo?.wc_order_id || null,
          numeroPedido: String(orden.id),
          comprador: orden.buyer?.nickname || 'Comprador ML',
          items,
        });
        return res.json({ ok: true, id: prepId });
      }
      res.status(400).json({ ok: false, error: 'canal inválido' });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ── Historial ──
  router.get('/historial', (req, res) => {
    const preparadas = db.prepare(`
      SELECT p.*,
        (SELECT COUNT(*) FROM preparacion_items WHERE preparacion_id=p.id) AS total_items,
        (SELECT COUNT(*) FROM preparacion_fotos WHERE preparacion_id=p.id AND borrado_en IS NULL) AS total_fotos
      FROM preparaciones p
      WHERE p.estado IN ('completada','pendiente_deposito')
      ORDER BY COALESCE(p.completado_en, p.creado_en) DESC LIMIT 200
    `).all();

    const sinPreparar = db.prepare(`
      SELECT * FROM pedidos_cache pc
      WHERE pc.estado_envio='enviado'
        AND NOT EXISTS (SELECT 1 FROM preparaciones p WHERE p.clave = pc.clave)
      ORDER BY pc.fecha DESC LIMIT 200
    `).all().map(row => ({
      id: null,
      canal: row.canal,
      clave: row.clave,
      wc_order_id: row.wc_order_id,
      ml_order_id: row.ml_order_id,
      numero_pedido: row.numero_pedido,
      comprador: row.comprador,
      estado: 'enviado_sin_preparar',
      creado_en: row.fecha,
      completado_en: null,
      total_items: JSON.parse(row.items_json).length,
      total_fotos: 0,
    }));

    res.json({ ok: true, data: [...preparadas, ...sinPreparar] });
  });

  // ── Estado del sync de pedidos_cache (para el aviso de frescura en el frontend) ──
  router.get('/pedidos-cache/estado', (req, res) => {
    const ultimoLog = db.prepare(
      "SELECT creado_en, estado, error FROM sync_log WHERE direccion='pedidos_cache' ORDER BY id DESC LIMIT 1"
    ).get();
    res.json({
      ok: true,
      actualizado_en: ultimoLog?.creado_en || null,
      ultimo_error: ultimoLog?.estado === 'error' ? ultimoLog.error : null,
    });
  });

  // ── Perfiles de foto por categoría ──
  router.get('/perfiles', (req, res) => {
    const rows = db.prepare('SELECT * FROM preparacion_perfiles ORDER BY categoria').all();
    res.json({ ok: true, data: rows });
  });

  router.put('/perfiles/:categoria', (req, res) => {
    const categoria = String(req.params.categoria || '').trim().toUpperCase();
    const { perfil, requisitos_json = null } = req.body || {};
    if (!categoria || !PERFILES_VALIDOS.includes(perfil)) {
      return res.status(400).json({ ok: false, error: 'categoria y perfil válidos requeridos' });
    }
    db.prepare(`INSERT INTO preparacion_perfiles (categoria, perfil, requisitos_json, actualizado_en)
      VALUES (?,?,?,?)
      ON CONFLICT(categoria) DO UPDATE SET perfil=excluded.perfil, requisitos_json=excluded.requisitos_json, actualizado_en=excluded.actualizado_en`)
      .run(categoria, perfil, requisitos_json ? JSON.stringify(requisitos_json) : null, now());
    res.json({ ok: true });
  });

  router.delete('/perfiles/:categoria', (req, res) => {
    db.prepare('DELETE FROM preparacion_perfiles WHERE categoria=?').run(String(req.params.categoria || '').trim().toUpperCase());
    res.json({ ok: true });
  });

  // ── Perfiles de foto por SKU exacto (prioridad sobre los de categoría) ──
  router.get('/perfiles-sku', (req, res) => {
    const rows = db.prepare('SELECT * FROM preparacion_perfiles_sku ORDER BY sku').all();
    res.json({ ok: true, data: rows });
  });

  router.put('/perfiles-sku/:sku', (req, res) => {
    const sku = String(req.params.sku || '').trim().toUpperCase();
    const { perfil, requisitos_json = null } = req.body || {};
    if (!sku || !PERFILES_VALIDOS.includes(perfil)) {
      return res.status(400).json({ ok: false, error: 'sku y perfil válidos requeridos' });
    }
    db.prepare(`INSERT INTO preparacion_perfiles_sku (sku, perfil, requisitos_json, actualizado_en)
      VALUES (?,?,?,?)
      ON CONFLICT(sku) DO UPDATE SET perfil=excluded.perfil, requisitos_json=excluded.requisitos_json, actualizado_en=excluded.actualizado_en`)
      .run(sku, perfil, requisitos_json ? JSON.stringify(requisitos_json) : null, now());
    res.json({ ok: true });
  });

  router.delete('/perfiles-sku/:sku', (req, res) => {
    db.prepare('DELETE FROM preparacion_perfiles_sku WHERE sku=?').run(String(req.params.sku || '').trim().toUpperCase());
    res.json({ ok: true });
  });

  // ── Detalle ──
  router.get('/:id', (req, res) => {
    const prep = getPrep(db, req.params.id);
    if (!prep) return res.status(404).json({ ok: false, error: 'no encontrada' });
    const items = db.prepare('SELECT * FROM preparacion_items WHERE preparacion_id=? ORDER BY id').all(prep.id);
    const fotos = db.prepare('SELECT * FROM preparacion_fotos WHERE preparacion_id=? AND borrado_en IS NULL ORDER BY id').all(prep.id);
    const eventos = db.prepare('SELECT * FROM preparacion_eventos WHERE preparacion_id=? ORDER BY id DESC').all(prep.id)
      .map(mapearEvento);
    const data = {
      ...prep,
      items: items.map(it => ({
        ...it,
        requisitos_foto: requisitosParaItem(db, it),
        fotos: fotos.filter(f => f.item_id === it.id),
      })),
      fotos_generales: fotos.filter(f => !f.item_id),
      eventos,
    };
    res.json({ ok: true, data });
  });

  // ── Eventos de actividad (refresco liviano, sin re-traer items/fotos) ──
  // Query param opcional `desde=<id>`: si viene y es un entero válido, solo trae eventos
  // con id>desde (para que el frontend haga polling incremental en vez de repetir todo
  // el historial cada 15s). Sin `desde` (o inválido), se mantiene el comportamiento
  // actual: todo el historial.
  router.get('/:id/eventos', (req, res) => {
    const prep = getPrep(db, req.params.id);
    if (!prep) return res.status(404).json({ ok: false, error: 'no encontrada' });
    const desde = parseInt(req.query.desde, 10);
    const eventos = (Number.isInteger(desde)
      ? db.prepare('SELECT * FROM preparacion_eventos WHERE preparacion_id=? AND id>? ORDER BY id DESC').all(prep.id, desde)
      : db.prepare('SELECT * FROM preparacion_eventos WHERE preparacion_id=? ORDER BY id DESC').all(prep.id)
    ).map(mapearEvento);
    res.json({ ok: true, eventos });
  });

  // ── Heartbeat de presencia: "estoy viendo esta preparación ahora" ──
  // No bloquea nada — solo informa quién más la está viendo, para que los operarios
  // coordinen entre sí si se están por pisar. Sin limpieza explícita de filas viejas:
  // solo se consideran "activos" los últimos 30s, así que una fila vieja deja de contar
  // sola sin que haga falta borrarla (se sobreescribe con el próximo heartbeat de ese
  // mismo usuario, gracias a la PRIMARY KEY compuesta).
  router.post('/:id/heartbeat', (req, res) => {
    const prep = getPrep(db, req.params.id);
    if (!prep) return res.status(404).json({ ok: false, error: 'no encontrada' });
    const usuario = req.user?.username;
    const ahora = now();

    db.prepare(`
      INSERT INTO preparacion_vistas (preparacion_id, usuario, visto_en) VALUES (?,?,?)
      ON CONFLICT(preparacion_id, usuario) DO UPDATE SET visto_en=excluded.visto_en
    `).run(prep.id, usuario, ahora);

    const hace30s = new Date(Date.now() - 30000).toISOString();
    const otros = db.prepare(
      'SELECT usuario, visto_en FROM preparacion_vistas WHERE preparacion_id=? AND usuario<>? AND visto_en > ?'
    ).all(prep.id, usuario, hace30s);

    const ultimoEvento = db.prepare('SELECT MAX(id) AS m FROM preparacion_eventos WHERE preparacion_id=?').get(prep.id);
    res.json({ ok: true, otros, ultimo_evento_id: ultimoEvento.m || 0 });
  });

  // ── Escanear código ──
  router.post('/:id/escanear', (req, res) => {
    const prep = getPrep(db, req.params.id);
    if (!prep) return res.status(404).json({ ok: false, error: 'no encontrada' });
    if (prep.estado === 'completada') return res.status(400).json({ ok: false, error: 'ya completada' });

    const codigo = String(req.body?.codigo || '').trim().toUpperCase();
    if (!codigo) return res.status(400).json({ ok: false, error: 'codigo requerido' });

    const items = db.prepare(
      "SELECT * FROM preparacion_items WHERE preparacion_id=? AND UPPER(TRIM(sku))=? AND estado_item <> 'exento'"
    ).all(prep.id, codigo);

    if (!items.length) return res.json({ ok: true, resultado: 'no_coincide', codigo });

    const item = items.find(i => i.cantidad_escaneada < i.cantidad_esperada);
    if (!item) return res.json({ ok: true, resultado: 'sobrante', codigo });

    const nuevaCant = item.cantidad_escaneada + 1;
    const verificado = nuevaCant >= item.cantidad_esperada;
    db.prepare('UPDATE preparacion_items SET cantidad_escaneada=?, estado_item=? WHERE id=?')
      .run(nuevaCant, verificado ? 'verificado' : 'pendiente', item.id);

    const origen = ['camara', 'lector_teclado'].includes(req.body?.origen) ? req.body.origen : 'lector_teclado';
    registrarEvento(db, {
      preparacionId: prep.id, itemId: item.id, tipo: 'escaneo', usuario: req.user?.username,
      detalle: { sku: item.sku, nombre: item.nombre, cantidad_nueva: nuevaCant, cantidad_esperada: item.cantidad_esperada, origen },
    });

    res.json({ ok: true, resultado: 'match', item: db.prepare('SELECT * FROM preparacion_items WHERE id=?').get(item.id) });
  });

  // ── Confirmar sin código ──
  router.post('/:id/item/:itemId/confirmar-manual', (req, res) => {
    const prep = getPrep(db, req.params.id);
    if (!prep) return res.status(404).json({ ok: false, error: 'no encontrada' });
    const item = db.prepare('SELECT * FROM preparacion_items WHERE id=? AND preparacion_id=?').get(parseInt(req.params.itemId), prep.id);
    if (!item) return res.status(404).json({ ok: false, error: 'ítem no encontrado' });

    // Si ya estaba verificado antes de esta llamada, es un no-op (doble tap /
    // re-confirmación): no pasó nada nuevo que auditar, igual que "sobrante" en /escanear.
    const yaVerificado = item.estado_item === 'verificado';

    db.prepare("UPDATE preparacion_items SET confirmado_manual=1, estado_item='verificado', cantidad_escaneada=cantidad_esperada WHERE id=?")
      .run(item.id);
    if (!yaVerificado) {
      registrarEvento(db, {
        preparacionId: prep.id, itemId: item.id, tipo: 'escaneo', usuario: req.user?.username,
        detalle: { sku: item.sku, nombre: item.nombre, cantidad_nueva: item.cantidad_esperada, cantidad_esperada: item.cantidad_esperada, origen: 'manual' },
      });
    }
    res.json({ ok: true, item: db.prepare('SELECT * FROM preparacion_items WHERE id=?').get(item.id) });
  });

  // ── Estado de embalaje (solo bicis) ──
  router.post('/:id/item/:itemId/embalaje', (req, res) => {
    const prep = getPrep(db, req.params.id);
    if (!prep) return res.status(404).json({ ok: false, error: 'no encontrada' });
    const item = db.prepare('SELECT * FROM preparacion_items WHERE id=? AND preparacion_id=?').get(parseInt(req.params.itemId), prep.id);
    if (!item) return res.status(404).json({ ok: false, error: 'ítem no encontrado' });
    if (item.perfil !== 'bici') return res.status(400).json({ ok: false, error: 'solo aplica a bicicletas' });

    const { estado_embalaje } = req.body || {};
    if (!['sellada', 'abierta', 're_embalada'].includes(estado_embalaje)) {
      return res.status(400).json({ ok: false, error: 'estado_embalaje inválido' });
    }
    const valorAnterior = item.estado_embalaje;
    db.prepare('UPDATE preparacion_items SET estado_embalaje=? WHERE id=?').run(estado_embalaje, item.id);
    registrarEvento(db, {
      preparacionId: prep.id, itemId: item.id, tipo: 'embalaje', usuario: req.user?.username,
      detalle: { sku: item.sku, nombre: item.nombre, valor_anterior: valorAnterior, valor_nuevo: estado_embalaje },
    });
    const actualizado = db.prepare('SELECT * FROM preparacion_items WHERE id=?').get(item.id);
    res.json({ ok: true, item: actualizado, requisitos_foto: requisitosParaItem(db, actualizado) });
  });

  // ── Despacho desde depósito ──
  router.post('/:id/item/:itemId/despacho', (req, res) => {
    const prep = getPrep(db, req.params.id);
    if (!prep) return res.status(404).json({ ok: false, error: 'no encontrada' });
    const item = db.prepare('SELECT * FROM preparacion_items WHERE id=? AND preparacion_id=?').get(parseInt(req.params.itemId), prep.id);
    if (!item) return res.status(404).json({ ok: false, error: 'ítem no encontrado' });

    const { modo, motivo = null } = req.body || {};
    if (!['local', 'deposito_relajado', 'deposito_delegado'].includes(modo)) {
      return res.status(400).json({ ok: false, error: 'modo inválido' });
    }

    let estadoItem = item.estado_item;
    if (modo === 'deposito_relajado') estadoItem = 'exento';
    else if (item.estado_item === 'exento') estadoItem = 'pendiente'; // revertir exención

    const valorAnterior = item.despacho;
    db.prepare('UPDATE preparacion_items SET despacho=?, despacho_motivo=?, estado_item=? WHERE id=?')
      .run(modo, motivo, estadoItem, item.id);
    registrarEvento(db, {
      preparacionId: prep.id, itemId: item.id, tipo: 'despacho', usuario: req.user?.username,
      detalle: { sku: item.sku, nombre: item.nombre, valor_anterior: valorAnterior, valor_nuevo: modo },
    });
    res.json({ ok: true, item: db.prepare('SELECT * FROM preparacion_items WHERE id=?').get(item.id) });
  });

  // ── Fotos ──
  // Envolvemos el multer manualmente para capturar sus errores (p.ej. archivo
  // que supera el límite de tamaño) y responder JSON claro. Sin esto, el
  // MulterError se propaga a next() y, al no haber error-handler global que
  // devuelva JSON, Express contesta una página HTML 500 que el frontend no
  // puede parsear (síntoma: "No se pudo subir la foto: error").
  router.post('/:id/foto', (req, res, next) => {
    upload.single('archivo')(req, res, (err) => {
      if (err) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(400).json({ ok: false, error: 'la foto es muy pesada (máx 15MB), probá con menor calidad o resolución' });
        }
        return res.status(400).json({ ok: false, error: 'no se pudo subir el archivo' });
      }
      next();
    });
  }, async (req, res) => {
    const prep = getPrep(db, req.params.id);
    if (!prep) return res.status(404).json({ ok: false, error: 'no encontrada' });
    if (!req.file) return res.status(400).json({ ok: false, error: 'archivo requerido' });

    // Detección de HEIC/HEIF: los iPhone al compartir mandan el .heic con mimetype
    // vacío o application/octet-stream (no arranca con image/). Si dejáramos que el
    // guard cortara solo por mimetype, el fix de HEIC nunca se activaría. Por eso
    // detectamos también por extensión del nombre y lo aceptamos.
    const nombre = (req.file.originalname || '').toLowerCase();
    const esHeic = req.file.mimetype === 'image/heic' || req.file.mimetype === 'image/heif'
      || nombre.endsWith('.heic') || nombre.endsWith('.heif');
    if (!req.file.mimetype?.startsWith('image/') && !esHeic) {
      return res.status(400).json({ ok: false, error: 'solo imágenes' });
    }

    const { item_id = null, tipo = 'extra' } = req.body || {};

    // Convertir siempre a JPEG (auto-rota por EXIF): resuelve HEIC de iPhone que no
    // se ven en la mayoría de navegadores, y las fotos rotadas. Si sharp no puede
    // procesar el buffer (corrupto o no es imagen real) → 400, no guardamos basura.
    let jpegBuffer;
    try {
      // El sharp/libvips prebuilt de este VPS no trae decoder HEIC/HEIF (excluido por
      // la licencia HEVC). Las fotos reales de iPhone llegan como HEIC y sharp explota.
      // Fallback en JS puro: decodificamos HEIC/HEIF a JPEG con heic-convert ANTES de
      // pasarlo a sharp, que mantiene la auto-rotación EXIF y el resto del pipeline.
      // esHeic ya se calculó arriba (para el guard); acá solo lo usamos.
      const entrada = esHeic
        ? await heicConvert({ buffer: req.file.buffer, format: 'JPEG', quality: 0.92 })
        : req.file.buffer;
      jpegBuffer = await sharp(entrada).rotate().jpeg().toBuffer();
    } catch {
      return res.status(400).json({ ok: false, error: 'no se pudo procesar la imagen' });
    }

    const baseName = req.file.originalname.replace(/\.[^.]+$/, '') || 'foto';
    const saved = guardarArchivo({
      buffer: jpegBuffer,
      originalname: `${baseName}.jpg`,
      mimetype: 'image/jpeg',
      importador: 'preparacion',
      numeroPedido: prep.numero_pedido || prep.clave,
    });
    const fotoId = db.prepare(
      'INSERT INTO preparacion_fotos (preparacion_id, item_id, tipo, url, nombre_archivo, creado_en) VALUES (?,?,?,?,?,?)'
    ).run(prep.id, item_id ? parseInt(item_id) : null, tipo, saved.url, saved.filename, now()).lastInsertRowid;

    const itemRef = item_id ? db.prepare('SELECT sku, nombre FROM preparacion_items WHERE id=?').get(parseInt(item_id)) : null;
    registrarEvento(db, {
      preparacionId: prep.id, itemId: item_id ? parseInt(item_id) : null, tipo: 'foto_subida', usuario: req.user?.username,
      detalle: { sku: itemRef?.sku ?? null, nombre: itemRef?.nombre ?? null, tipo_foto: tipo, nombre_archivo: saved.filename, foto_id: fotoId },
    });

    res.json({ ok: true, foto: db.prepare('SELECT * FROM preparacion_fotos WHERE id=?').get(fotoId) });
  });

  router.delete('/:id/foto/:fotoId', (req, res) => {
    const prep = getPrep(db, req.params.id);
    if (!prep) return res.status(404).json({ ok: false, error: 'no encontrada' });
    const fotoId = parseInt(req.params.fotoId);
    const foto = db.prepare('SELECT * FROM preparacion_fotos WHERE id=? AND preparacion_id=? AND borrado_en IS NULL').get(fotoId, prep.id);
    if (!foto) return res.json({ ok: true, borradas: 0 });

    db.prepare('UPDATE preparacion_fotos SET borrado_en=? WHERE id=?').run(now(), fotoId);

    const itemRef = foto.item_id ? db.prepare('SELECT sku, nombre FROM preparacion_items WHERE id=?').get(foto.item_id) : null;
    // subida_por: no hay columna dedicada en preparacion_fotos para quién la subió
    // (fuera de alcance de este ciclo agregarla) — se recupera del propio evento
    // foto_subida que Task 3 ya registra, buscando por foto_id en su detalle_json.
    // Puede venir null si la foto es preexistente a esta instrumentación (no hay evento
    // foto_subida previo) o ante cualquier fallo de la consulta (fail-open, ver helper);
    // el frontend no debe imprimir literalmente "null" en ese caso.
    const subidaPor = usuarioQueSubio(db, fotoId, prep.id);
    registrarEvento(db, {
      preparacionId: prep.id, itemId: foto.item_id, tipo: 'foto_borrada', usuario: req.user?.username,
      detalle: { sku: itemRef?.sku ?? null, nombre: itemRef?.nombre ?? null, tipo_foto: foto.tipo, nombre_archivo: foto.nombre_archivo, foto_id: fotoId, subida_por: subidaPor },
    });
    res.json({ ok: true, borradas: 1 });
  });

  // ── Completar ──
  router.post('/:id/completar', (req, res) => {
    const prep = getPrep(db, req.params.id);
    if (!prep) return res.status(404).json({ ok: false, error: 'no encontrada' });
    if (prep.estado === 'completada') return res.status(400).json({ ok: false, error: 'ya completada' });

    const items = db.prepare('SELECT * FROM preparacion_items WHERE preparacion_id=?').all(prep.id);
    const fotos = db.prepare('SELECT * FROM preparacion_fotos WHERE preparacion_id=? AND borrado_en IS NULL').all(prep.id);

    const faltantes = [];
    const delegadosPendientes = [];

    for (const it of items) {
      if (it.estado_item === 'exento') continue;

      if (it.estado_item !== 'verificado') {
        if (it.despacho === 'deposito_delegado') {
          delegadosPendientes.push({ item_id: it.id, sku: it.sku, nombre: it.nombre });
        } else {
          faltantes.push({ item_id: it.id, sku: it.sku, nombre: it.nombre, motivo: 'sin_verificar' });
        }
        continue;
      }

      const req_ = requisitosParaItem(db, it);
      const faltan = fotosFaltantes(req_, fotos.filter(f => f.item_id === it.id));
      if (faltan.length) {
        faltantes.push({ item_id: it.id, sku: it.sku, nombre: it.nombre, motivo: 'fotos', faltan });
      }
    }

    if (faltantes.length) {
      return res.status(400).json({ ok: false, error: 'preparación incompleta', faltantes });
    }

    if (delegadosPendientes.length) {
      db.prepare("UPDATE preparaciones SET estado='pendiente_deposito' WHERE id=?").run(prep.id);
      return res.json({ ok: true, estado: 'pendiente_deposito', pendientes_deposito: delegadosPendientes });
    }

    db.prepare("UPDATE preparaciones SET estado='completada', completado_en=?, preparado_por=? WHERE id=?")
      .run(now(), req.user?.username || null, prep.id);
    registrarEvento(db, {
      preparacionId: prep.id, itemId: null, tipo: 'completado', usuario: req.user?.username, detalle: {},
    });
    res.json({ ok: true, estado: 'completada' });
  });

  return router;
}

// ─── Helpers de fuentes (WC / ML) ────────────────────────────────────────────

// Un pedido WC → entrada de la cola de pendientes con ítems enriquecidos.
function armarPendienteWeb(db, order) {
  const ov = normalizarPedidoWc(order);
  const items = ov.items.map(it => {
    const idWoo = it.variation_id_wc || it.product_id;
    const fila = db.prepare('SELECT sku, categorias_json FROM catalogo_cache WHERE id_woo=?').get(idWoo) || {};
    const producto = productoDesdeFilaCatalogo(fila);
    return {
      line_item_id: it.line_item_id,
      product_id: it.product_id,
      variation_id: it.variation_id_wc,
      sku: it.sku || producto.sku || '',
      nombre: it.nombre,
      categoria: producto.categorias.join(' | '),
      cantidad: it.cantidad,
    };
  });
  const prep = db.prepare('SELECT id, estado, etiqueta_lista FROM preparaciones WHERE clave=?').get(`web:${order.id}`);
  return {
    canal: 'web',
    espejo_ml: ov.espejo_ml,
    wc_order_id: order.id,
    numero_pedido: ov.numero,
    comprador: `${ov.comprador.nombre} ${ov.comprador.apellido}`.trim(),
    fecha: ov.fecha,
    estado_wc: ov.estado,
    items,
    preparacion_id: prep?.id || null,
    estado_preparacion: prep?.estado || null,
    etiqueta_lista: prep?.etiqueta_lista || 0,
  };
}

// Ítems de una orden ML mapeados a SKU/categoría de WC (best effort).
function itemsDesdeOrdenMl(db, orden) {
  const ov = normalizarOrdenMl(orden);
  return ov.items.map(it => {
    const sku = skuDesdeMl(db, it.item_id_ml, it.variation_id_ml) || it.seller_sku || '';
    let categoria = '';
    let productId = null;
    if (sku) {
      const fila = db.prepare('SELECT id_woo, categorias_json FROM catalogo_cache WHERE sku=?').get(sku);
      if (fila) {
        productId = fila.id_woo;
        categoria = productoDesdeFilaCatalogo(fila).categorias.join(' | ');
      }
    }
    return {
      line_item_id: null,
      product_id: productId,
      variation_id: null,
      sku,
      nombre: it.nombre,
      categoria,
      cantidad: it.cantidad,
    };
  });
}

// Órdenes ML pagas cuyo envío está listo y lo despacha el local.
// Devuelve { pendientes, confiable }: `confiable` indica si esta corrida vio el listado
// completo (paginación agotada sin errores) y sin fallos de /shipments/:id.
// Cuando confiable=false, el caller NO debe usar el resultado para podar (solo para
// alimentar/actualizar filas existentes), porque puede faltar un pedido real todavía
// ready_to_ship que simplemente no se pudo confirmar esta vez.
async function pendientesMl(db, mlCfg) {
  if (!mlCfg?.clientId || !mlCfg?.userId) return { pendientes: [], confiable: false };
  const desde = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
  const limite = 50;

  // Paginación real (mismo patrón que syncMlToWc/procesarCancelacionesMl en sync.js):
  // con el volumen actual (~34 pendientes ML en 30 días) la primera página ya viene llena
  // seguido, así que quedarse con una sola página marcaba `confiable=false` casi siempre y
  // la poda nunca corría. Se agota la paginación hasta la última página incompleta.
  let offset = 0;
  let hayMas = true;
  let resultados = [];
  // Fail-closed: si una página después de la primera falla, se corta la paginación (no se
  // reintenta indefinidamente) y se marca el listado como no confiable -> el caller no poda
  // con un resultado parcial. Si falla la primera página, se aborta con throw como antes
  // (no hay nada útil que devolver).
  let paginacionCortada = false;
  while (hayMas) {
    const resp = await mlFetch(db, mlCfg, 'get',
      `/orders/search?seller=${mlCfg.userId}&order.status=paid&sort=date_desc&order.date_created.from=${encodeURIComponent(desde)}&offset=${offset}&limit=${limite}`);
    if (resp.status !== 200) {
      if (offset === 0) throw new Error(`ML orders ${resp.status}`);
      paginacionCortada = true;
      break;
    }
    const pagina = resp.data.results || [];
    resultados = resultados.concat(pagina);
    hayMas = pagina.length === limite;
    offset += pagina.length;
  }
  const truncado = paginacionCortada;

  let fallosShipment = 0;
  const out = [];
  for (const orden of resultados) {
    const shipmentId = orden.shipping?.id;
    if (!shipmentId) continue;

    // Saltar las ya completadas sin gastar un GET de shipment. No cuenta como fallo (la
    // preparación ya está confirmada del lado local) y esas filas se excluyen de la poda
    // por separado en syncPedidosCache, no dependen de aparecer acá.
    const prep = db.prepare('SELECT id, estado FROM preparaciones WHERE clave=?').get(`ml:${orden.id}`);
    if (prep?.estado === 'completada') continue;

    const shipResp = await mlFetch(db, mlCfg, 'get', `/shipments/${shipmentId}`);
    if (shipResp.status !== 200) {
      fallosShipment++;
      continue;
    }
    const envio = shipResp.data;
    if (envio.status !== 'ready_to_ship') continue;
    if (!esEnvioLocal(envio.logistic_type)) continue;

    const ov = normalizarOrdenMl(orden);
    const vinculo = db.prepare('SELECT wc_order_id FROM ordenes_ml_wc_pedidos WHERE ml_order_id=?').get(ov.ml_order_id);
    out.push({
      canal: 'ml',
      ml_order_id: ov.ml_order_id,
      wc_order_id: vinculo?.wc_order_id || null,
      numero_pedido: ov.numero,
      comprador: ov.comprador.nickname || 'Comprador ML',
      fecha: ov.fecha,
      logistic_type: envio.logistic_type,
      substatus: envio.substatus || null,
      items: itemsDesdeOrdenMl(db, orden),
      preparacion_id: prep?.id || null,
      estado_preparacion: prep?.estado || null,
    });
  }

  const confiable = !truncado && fallosShipment === 0;
  if (!confiable && fallosShipment > 0) {
    console.warn(`pendientesMl: ${fallosShipment} fallo(s) de /shipments al listar pendientes ML`);
  }
  return { pendientes: out, confiable };
}

// ─── Caché local de pedidos (para GET /pendientes y GET /historial) ──────────

// Candado para evitar corridas concurrentes de syncPedidosCache (cron + disparo manual
// se pisarían y duplicarían llamadas a Woo/ML). Mismo patrón que _wcToMlEnCurso en sync.js.
let _pedidosCacheEnCurso = false;

function logSyncPedidos(db, estado, error) {
  db.prepare(`
    INSERT INTO sync_log (direccion, clave, sku, cant_anterior, cant_nueva, estado, error, intentos, creado_en, actualizado_en)
    VALUES ('pedidos_cache', NULL, NULL, NULL, NULL, ?, ?, 0, ?, ?)
  `).run(estado, error ?? null, now(), now());
}

function upsertPedidoCache(db, row) {
  db.prepare(`
    INSERT INTO pedidos_cache
      (clave, canal, wc_order_id, ml_order_id, numero_pedido, comprador, fecha,
       estado_envio, estado_wc, espejo_ml, logistic_type, substatus, items_json, actualizado_en)
    VALUES (@clave, @canal, @wc_order_id, @ml_order_id, @numero_pedido, @comprador, @fecha,
       @estado_envio, @estado_wc, @espejo_ml, @logistic_type, @substatus, @items_json, @actualizado_en)
    ON CONFLICT(clave) DO UPDATE SET
      numero_pedido=excluded.numero_pedido, comprador=excluded.comprador, fecha=excluded.fecha,
      estado_envio=excluded.estado_envio, estado_wc=excluded.estado_wc, espejo_ml=excluded.espejo_ml,
      logistic_type=excluded.logistic_type, substatus=excluded.substatus,
      items_json=excluded.items_json, actualizado_en=excluded.actualizado_en
  `).run(row);
}

// Un pedido WC (de cualquiera de los 3 estados relevantes) → fila de pedidos_cache.
function filaWebDesdeOrder(db, order, estadoEnvio) {
  const pend = armarPendienteWeb(db, order); // reusa el enriquecido de ítems/comprador ya existente
  return {
    clave: `web:${order.id}`,
    canal: 'web',
    wc_order_id: order.id,
    ml_order_id: null,
    numero_pedido: pend.numero_pedido,
    comprador: pend.comprador,
    fecha: pend.fecha,
    estado_envio: estadoEnvio,
    estado_wc: pend.estado_wc,
    espejo_ml: pend.espejo_ml ? 1 : 0,
    logistic_type: null,
    substatus: null,
    items_json: JSON.stringify(pend.items),
    actualizado_en: now(),
  };
}

export async function syncPedidosCache(db, cfg) {
  ensureTables(db);
  if (_pedidosCacheEnCurso) return;
  _pedidosCacheEnCurso = true;
  try {
    const andreaniStatus = cfg?.andreaniStatus || 'lpaandreani';
    const enviadoAndreaniStatus = cfg?.enviadoAndreaniStatus || 'enviadoandreani';

    // WooCommerce: 3 llamadas, una por estado relevante (mismo endpoint /orders que ya
    // usaban /pendientes, /etiquetas y /seguimientos por separado — acá se hace una sola
    // vez para las 3, en una única función/único cron).
    // Secuencial (no Promise.all): si la primera llamada no resuelve nunca (WC caído,
    // hang de red), no queremos disparar las otras dos en paralelo igual.
    // Los "enviados" (completed/enviadoandreani) se acotan a los últimos 60 días — si no,
    // el historial crece sin límite. Los "pendientes" (lpaandreani) no se acotan: un
    // pedido pendiente de preparar sigue siendo relevante sin importar hace cuánto se
    // generó, hasta que se procese.
    const hace60Dias = new Date(Date.now() - 60 * 24 * 3600 * 1000).toISOString();
    const wcPend = await wooFetch(cfg.woo, `/orders?status=${encodeURIComponent(andreaniStatus)}&per_page=100`);
    const wcCompleted = await wooFetch(cfg.woo, `/orders?status=completed&after=${encodeURIComponent(hace60Dias)}&per_page=100`);
    const wcEnviado = await wooFetch(cfg.woo, `/orders?status=${encodeURIComponent(enviadoAndreaniStatus)}&after=${encodeURIComponent(hace60Dias)}&per_page=100`);

    const tx = db.transaction(() => {
      for (const order of wcPend.data || []) upsertPedidoCache(db, filaWebDesdeOrder(db, order, 'pendiente'));
      for (const order of wcCompleted.data || []) upsertPedidoCache(db, filaWebDesdeOrder(db, order, 'enviado'));
      for (const order of wcEnviado.data || []) upsertPedidoCache(db, filaWebDesdeOrder(db, order, 'enviado'));
      // Limpieza: el sync solo hace upsert, nunca borra — sin esto, una fila "enviado" que
      // ya cayó fuera de la ventana de 60 días quedaría para siempre en la caché.
      db.prepare("DELETE FROM pedidos_cache WHERE estado_envio='enviado' AND fecha < ?").run(hace60Dias);
    });
    tx();

    // MercadoLibre: reusa pendientesMl (ya filtra paid+ready_to_ship+local) para pendientes.
    // Los "enviados" de ML quedan fuera de este alcance (no hay filtro de shipped simple
    // sin otro GET por shipment; el historial de enviados ML se cubre desde el lado Woo,
    // que ya refleja el pedido cuando se cargó el tracking en el tab Seguimientos).
    try {
      // Misma ventana de 30 días que usa pendientesMl para consultar /orders/search: la poda
      // de abajo solo puede confiar en la ausencia de una fila si esa fila estaba dentro del
      // rango que la consulta a ML pudo haber visto.
      const desdeMl = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
      const { pendientes: mlPend, confiable: mlConfiable } = await pendientesMl(db, cfg.ml);
      const clavesVigentesMl = new Set(mlPend.map((p) => `ml:${p.ml_order_id}`));
      const txMl = db.transaction(() => {
        for (const p of mlPend) {
          upsertPedidoCache(db, {
            clave: `ml:${p.ml_order_id}`,
            canal: 'ml',
            wc_order_id: p.wc_order_id,
            ml_order_id: p.ml_order_id,
            numero_pedido: p.numero_pedido,
            comprador: p.comprador,
            fecha: p.fecha,
            estado_envio: 'pendiente',
            estado_wc: null,
            espejo_ml: 0,
            logistic_type: p.logistic_type,
            substatus: p.substatus,
            items_json: JSON.stringify(p.items),
            actualizado_en: now(),
          });
        }
        // Poda: un pedido ML que dejó de estar ready_to_ship (se despachó) simplemente
        // desaparece del resultado de pendientesMl, pero el upsert de arriba nunca lo toca
        // -> quedaría huérfano para siempre como "pendiente" (mismo bug ya visto en
        // catalogo_cache/refrescarCatalogo). Fail-closed: solo podamos si pendientesMl marcó
        // el listado como confiable (paginación agotada sin fallos y sin fallos de
        // /shipments/:id); si no es confiable, dejamos los pendientes viejos tal cual esta
        // corrida (falso positivo temporal) en vez de arriesgar borrar de golpe un pedido
        // real que no se pudo confirmar. Además, solo se poda dentro de la ventana de 30
        // días que pendientesMl pudo confirmar: un pedido ML pagado hace más de 30 días que
        // sigue genuinamente ready_to_ship (envío demorado, etc.) queda fuera del alcance de
        // esta poda -- ni se confirma ni se descarta, se deja como está.
        if (mlConfiable) {
          const filasViejas = db.prepare(
            "SELECT pc.clave AS clave, p.estado AS estado_prep " +
            "FROM pedidos_cache pc " +
            "LEFT JOIN preparaciones p ON p.clave = pc.clave " +
            "WHERE pc.canal='ml' AND pc.estado_envio='pendiente' AND pc.fecha >= ?"
          ).all(desdeMl);
          const borrar = db.prepare('DELETE FROM pedidos_cache WHERE clave=?');
          for (const r of filasViejas) {
            // Una preparación ya completada nunca se vuelve a refetchear en pendientesMl
            // (optimización de cuota) -> nunca va a aparecer en clavesVigentesMl aunque el
            // despacho real siga sin confirmarse. No es candidata a poda por ausencia; solo
            // se poda lo que se confirmó activamente que ya no es ready_to_ship.
            if (r.estado_prep === 'completada') continue;
            if (!clavesVigentesMl.has(r.clave)) borrar.run(r.clave);
          }
        } else {
          console.warn('syncPedidosCache: listado ML no confiable esta corrida (truncado o fallos de shipment), se omite la poda');
        }
      });
      txMl();
    } catch (eMl) {
      // ML tolerante a fallas (igual que hoy en GET /pendientes): no aborta el sync de Woo.
      logSyncPedidos(db, 'error', `ML: ${eMl.message}`);
      return;
    }

    logSyncPedidos(db, 'ok', null);
  } catch (e) {
    logSyncPedidos(db, 'error', e.message);
    throw e;
  } finally {
    _pedidosCacheEnCurso = false;
  }
}
