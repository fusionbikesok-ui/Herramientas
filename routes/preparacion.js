import express from 'express';
import multer from 'multer';
import { wooFetch } from './woo.js';
import { mlFetch } from '../lib/mlClient.js';
import { skuDesdeMl } from '../lib/mlMapeo.js';
import { guardarArchivo } from '../utils/storage.js';
import {
  normalizarEnvio, resolverPerfil, requisitosFoto, fotosFaltantes, esEnvioLocal,
} from '../lib/preparacion.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

const now = () => new Date().toISOString();

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

  // Seed de perfiles por defecto (el usuario los edita desde la UI)
  const seed = db.prepare(
    'INSERT OR IGNORE INTO preparacion_perfiles (categoria, perfil, requisitos_json, actualizado_en) VALUES (?,?,NULL,?)'
  );
  seed.run('BICICLETAS', 'bici', now());
  seed.run('TRANSMISIONES', 'kit_transmision', now());
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Perfil de un ítem: primero overrides de preparacion_perfiles (match por
// substring de categoría, la regla más larga gana), después la heurística.
function perfilParaItem(db, { categoria, nombre }) {
  const cats = String(categoria || '').toUpperCase();
  if (cats) {
    const reglas = db.prepare('SELECT categoria, perfil FROM preparacion_perfiles ORDER BY LENGTH(categoria) DESC').all();
    for (const r of reglas) {
      if (cats.includes(r.categoria.toUpperCase())) return r.perfil;
    }
  }
  return resolverPerfil({ categorias: categoria, nombre });
}

// Requisitos de foto de un ítem, respetando requisitos_json custom por categoría.
function requisitosParaItem(db, item) {
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
      const perfil = perfilParaItem(db, { categoria: it.categoria, nombre: it.nombre });
      ins.run(prepId, it.line_item_id || null, it.product_id || null, it.variation_id || null,
        it.sku || '', it.nombre || '', it.categoria || '', perfil,
        Math.max(1, parseInt(it.cantidad) || 1));
    }
  });
  tx();
  return prepId;
}

function getPrep(db, id) {
  return db.prepare('SELECT * FROM preparaciones WHERE id=?').get(parseInt(id));
}

// ─── Router ───────────────────────────────────────────────────────────────────

export function preparacionRouter(db, cfg) {
  ensureTables(db);
  const router = express.Router();
  const andreaniStatus = cfg?.andreaniStatus || 'lpaandreani';

  // ── Pendientes: unión web (WC en lpaandreani) + ML (ready_to_ship local) ──
  router.get('/pendientes', async (req, res) => {
    try {
      const pendientes = [];

      // Web
      const wcResp = await wooFetch(cfg.woo, `/orders?status=${encodeURIComponent(andreaniStatus)}&per_page=100`);
      for (const order of wcResp.data || []) {
        pendientes.push(armarPendienteWeb(db, order));
      }

      // ML (tolerante a fallas: si ML no responde, igual devolvemos web)
      let errorMl = null;
      try {
        const mlPend = await pendientesMl(db, cfg.ml);
        pendientes.push(...mlPend);
      } catch (e) {
        errorMl = e.message;
      }

      res.json({ ok: true, data: pendientes, error_ml: errorMl });
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
    const rows = db.prepare(`
      SELECT p.*,
        (SELECT COUNT(*) FROM preparacion_items WHERE preparacion_id=p.id) AS total_items,
        (SELECT COUNT(*) FROM preparacion_fotos WHERE preparacion_id=p.id) AS total_fotos
      FROM preparaciones p
      WHERE p.estado IN ('completada','pendiente_deposito')
      ORDER BY COALESCE(p.completado_en, p.creado_en) DESC LIMIT 200
    `).all();
    res.json({ ok: true, data: rows });
  });

  // ── Perfiles de foto por categoría ──
  router.get('/perfiles', (req, res) => {
    const rows = db.prepare('SELECT * FROM preparacion_perfiles ORDER BY categoria').all();
    res.json({ ok: true, data: rows });
  });

  router.put('/perfiles/:categoria', (req, res) => {
    const categoria = String(req.params.categoria || '').trim().toUpperCase();
    const { perfil, requisitos_json = null } = req.body || {};
    if (!categoria || !['bici', 'kit_transmision', 'sellado'].includes(perfil)) {
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

  // ── Detalle ──
  router.get('/:id', (req, res) => {
    const prep = getPrep(db, req.params.id);
    if (!prep) return res.status(404).json({ ok: false, error: 'no encontrada' });
    const items = db.prepare('SELECT * FROM preparacion_items WHERE preparacion_id=? ORDER BY id').all(prep.id);
    const fotos = db.prepare('SELECT * FROM preparacion_fotos WHERE preparacion_id=? ORDER BY id').all(prep.id);
    const data = {
      ...prep,
      items: items.map(it => ({
        ...it,
        requisitos_foto: requisitosParaItem(db, it),
        fotos: fotos.filter(f => f.item_id === it.id),
      })),
      fotos_generales: fotos.filter(f => !f.item_id),
    };
    res.json({ ok: true, data });
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

    res.json({ ok: true, resultado: 'match', item: db.prepare('SELECT * FROM preparacion_items WHERE id=?').get(item.id) });
  });

  // ── Confirmar sin código ──
  router.post('/:id/item/:itemId/confirmar-manual', (req, res) => {
    const prep = getPrep(db, req.params.id);
    if (!prep) return res.status(404).json({ ok: false, error: 'no encontrada' });
    const item = db.prepare('SELECT * FROM preparacion_items WHERE id=? AND preparacion_id=?').get(parseInt(req.params.itemId), prep.id);
    if (!item) return res.status(404).json({ ok: false, error: 'ítem no encontrado' });

    db.prepare("UPDATE preparacion_items SET confirmado_manual=1, estado_item='verificado', cantidad_escaneada=cantidad_esperada WHERE id=?")
      .run(item.id);
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
    db.prepare('UPDATE preparacion_items SET estado_embalaje=? WHERE id=?').run(estado_embalaje, item.id);
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

    db.prepare('UPDATE preparacion_items SET despacho=?, despacho_motivo=?, estado_item=? WHERE id=?')
      .run(modo, motivo, estadoItem, item.id);
    res.json({ ok: true, item: db.prepare('SELECT * FROM preparacion_items WHERE id=?').get(item.id) });
  });

  // ── Fotos ──
  router.post('/:id/foto', upload.single('archivo'), (req, res) => {
    const prep = getPrep(db, req.params.id);
    if (!prep) return res.status(404).json({ ok: false, error: 'no encontrada' });
    if (!req.file) return res.status(400).json({ ok: false, error: 'archivo requerido' });
    if (!req.file.mimetype?.startsWith('image/')) return res.status(400).json({ ok: false, error: 'solo imágenes' });

    const { item_id = null, tipo = 'extra' } = req.body || {};
    const saved = guardarArchivo({
      buffer: req.file.buffer,
      originalname: req.file.originalname,
      mimetype: req.file.mimetype,
      importador: 'preparacion',
      numeroPedido: prep.numero_pedido || prep.clave,
    });
    const fotoId = db.prepare(
      'INSERT INTO preparacion_fotos (preparacion_id, item_id, tipo, url, nombre_archivo, creado_en) VALUES (?,?,?,?,?,?)'
    ).run(prep.id, item_id ? parseInt(item_id) : null, tipo, saved.url, saved.filename, now()).lastInsertRowid;

    res.json({ ok: true, foto: db.prepare('SELECT * FROM preparacion_fotos WHERE id=?').get(fotoId) });
  });

  router.delete('/:id/foto/:fotoId', (req, res) => {
    const prep = getPrep(db, req.params.id);
    if (!prep) return res.status(404).json({ ok: false, error: 'no encontrada' });
    const r = db.prepare('DELETE FROM preparacion_fotos WHERE id=? AND preparacion_id=?').run(parseInt(req.params.fotoId), prep.id);
    res.json({ ok: true, borradas: r.changes });
  });

  // ── Completar ──
  router.post('/:id/completar', (req, res) => {
    const prep = getPrep(db, req.params.id);
    if (!prep) return res.status(404).json({ ok: false, error: 'no encontrada' });
    if (prep.estado === 'completada') return res.status(400).json({ ok: false, error: 'ya completada' });

    const items = db.prepare('SELECT * FROM preparacion_items WHERE preparacion_id=?').all(prep.id);
    const fotos = db.prepare('SELECT * FROM preparacion_fotos WHERE preparacion_id=?').all(prep.id);

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
    res.json({ ok: true, estado: 'completada' });
  });

  return router;
}

// ─── Helpers de fuentes (WC / ML) ────────────────────────────────────────────

// Un pedido WC → entrada de la cola de pendientes con ítems enriquecidos.
function armarPendienteWeb(db, order) {
  const esMl = (order.meta_data || []).some(m => m.key === '_ml_order_id');
  const items = (order.line_items || []).map(li => {
    const idWoo = li.variation_id || li.product_id;
    const cache = db.prepare('SELECT sku, categorias_json FROM catalogo_cache WHERE id_woo=?').get(idWoo) || {};
    let categoria = '';
    try { categoria = (JSON.parse(cache.categorias_json || '[]') || []).join(' | '); } catch (_) {}
    return {
      line_item_id: li.id,
      product_id: li.product_id,
      variation_id: li.variation_id || null,
      sku: li.sku || cache.sku || '',
      nombre: li.name,
      categoria,
      cantidad: li.quantity,
    };
  });
  const prep = db.prepare('SELECT id, estado, etiqueta_lista FROM preparaciones WHERE clave=?').get(`web:${order.id}`);
  return {
    canal: 'web',
    espejo_ml: esMl,
    wc_order_id: order.id,
    numero_pedido: String(order.number || order.id),
    comprador: `${order.billing?.first_name || ''} ${order.billing?.last_name || ''}`.trim(),
    fecha: order.date_created,
    estado_wc: order.status,
    items,
    preparacion_id: prep?.id || null,
    estado_preparacion: prep?.estado || null,
    etiqueta_lista: prep?.etiqueta_lista || 0,
  };
}

// Ítems de una orden ML mapeados a SKU/categoría de WC (best effort).
function itemsDesdeOrdenMl(db, orden) {
  return (orden.order_items || []).map(oi => {
    const itemId = String(oi.item?.id || '');
    const varId = oi.item?.variation_id || '';
    const sku = skuDesdeMl(db, itemId, varId) || oi.item?.seller_sku || '';
    let categoria = '';
    let productId = null;
    if (sku) {
      const cache = db.prepare('SELECT id_woo, categorias_json FROM catalogo_cache WHERE sku=?').get(sku);
      if (cache) {
        productId = cache.id_woo;
        try { categoria = (JSON.parse(cache.categorias_json || '[]') || []).join(' | '); } catch (_) {}
      }
    }
    return {
      line_item_id: null,
      product_id: productId,
      variation_id: null,
      sku,
      nombre: oi.item?.title || '',
      categoria,
      cantidad: oi.quantity || 1,
    };
  });
}

// Órdenes ML pagas cuyo envío está listo y lo despacha el local.
async function pendientesMl(db, mlCfg) {
  if (!mlCfg?.clientId || !mlCfg?.userId) return [];
  const desde = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
  const resp = await mlFetch(db, mlCfg, 'get',
    `/orders/search?seller=${mlCfg.userId}&order.status=paid&sort=date_desc&order.date_created.from=${encodeURIComponent(desde)}&limit=50`);
  if (resp.status !== 200) throw new Error(`ML orders ${resp.status}`);

  const out = [];
  for (const orden of resp.data.results || []) {
    const shipmentId = orden.shipping?.id;
    if (!shipmentId) continue;

    // Saltar las ya completadas sin gastar un GET de shipment
    const prep = db.prepare('SELECT id, estado FROM preparaciones WHERE clave=?').get(`ml:${orden.id}`);
    if (prep?.estado === 'completada') continue;

    const shipResp = await mlFetch(db, mlCfg, 'get', `/shipments/${shipmentId}`);
    if (shipResp.status !== 200) continue;
    const envio = shipResp.data;
    if (envio.status !== 'ready_to_ship') continue;
    if (!esEnvioLocal(envio.logistic_type)) continue;

    const vinculo = db.prepare('SELECT wc_order_id FROM ordenes_ml_wc_pedidos WHERE ml_order_id=?').get(String(orden.id));
    out.push({
      canal: 'ml',
      ml_order_id: String(orden.id),
      wc_order_id: vinculo?.wc_order_id || null,
      numero_pedido: String(orden.id),
      comprador: orden.buyer?.nickname || 'Comprador ML',
      fecha: orden.date_created,
      logistic_type: envio.logistic_type,
      substatus: envio.substatus || null,
      items: itemsDesdeOrdenMl(db, orden),
      preparacion_id: prep?.id || null,
      estado_preparacion: prep?.estado || null,
    });
  }
  return out;
}
