import express from 'express';
import { wooFetch } from './woo.js';
import { buildWooPath } from '../lib/wooStock.js';

// Lock en memoria por id_woo para serializar el patrón GET→calcular→PATCH.
// Es un solo proceso Node, así que un Map<id_woo, Promise> a nivel de módulo
// alcanza para evitar que dos recepciones concurrentes sobre el mismo producto
// se pisen las escrituras y pierdan stock recibido.
const locksStockPorIdWoo = new Map();

// Aplica el stock de un ítem recibido en WooCommerce (GET stock actual + PATCH suma).
// Resuelve el path correcto para variaciones vía catalogo_cache/buildWooPath.
// Actualiza recepcion_items (stock_previo/stock_nuevo/estado_item='aplicado') y catalogo_cache.
// Lanza si la API de WC falla — el caller marca 'error'.
// Serializado por id_woo: si ya hay una aplicación en curso para ese producto,
// esta espera a que termine antes de hacer su propio GET.
export async function aplicarStockItem(db, cfg, item) {
  const previa = locksStockPorIdWoo.get(item.id_woo) || Promise.resolve();
  // Encadenamos ignorando el resultado (y errores) de la previa: cada llamada
  // maneja su propio éxito/fallo, solo necesitamos la serialización temporal.
  const propia = previa.catch(() => {}).then(() => aplicarStockItemInterno(db, cfg, item));
  locksStockPorIdWoo.set(item.id_woo, propia);
  try {
    return await propia;
  } finally {
    // Liberar el lock solo si nadie encadenó después (evita retener promesas viejas).
    if (locksStockPorIdWoo.get(item.id_woo) === propia) {
      locksStockPorIdWoo.delete(item.id_woo);
    }
  }
}

async function aplicarStockItemInterno(db, cfg, item) {
  const prod = db.prepare('SELECT id_woo, id_padre, tipo FROM catalogo_cache WHERE id_woo=?').get(item.id_woo);
  if (!prod) {
    throw new Error(`No se encontró el producto id_woo=${item.id_woo} en catalogo_cache; no se puede determinar si es variación o simple`);
  }
  const apiPath = buildWooPath(prod);

  const get = await wooFetch(cfg, apiPath);
  const stockRaw = get.data?.stock_quantity;
  const stockActual = Number(stockRaw);
  if (stockRaw === null || stockRaw === undefined || !Number.isFinite(stockActual)) {
    throw new Error(`WooCommerce no devolvió stock_quantity para id_woo=${item.id_woo} (¿manage_stock desactivado?); no se aplica sobre un dato posiblemente desactualizado`);
  }
  const stockNuevo  = stockActual + item.cantidad;

  await wooFetch(cfg, apiPath, 'patch', { stock_quantity: stockNuevo, manage_stock: true });

  const now = new Date().toISOString();
  db.prepare("UPDATE recepcion_items SET stock_previo=?, stock_nuevo=?, estado_item='aplicado', error_wc=NULL WHERE id=?")
    .run(stockActual, stockNuevo, item.id);
  db.prepare('UPDATE catalogo_cache SET stock=?, actualizado_en=? WHERE id_woo=?')
    .run(stockNuevo, now, item.id_woo);

  return { stock_previo: stockActual, stock_nuevo: stockNuevo };
}

// Normaliza número de pedido para matching tolerante:
// "PED 0008-0075B230/X EXPRESS" → "0008-0075B230/X"
// "PED0008-0075B230" → "0008-0075B230"
function normalizarNumeroPedido(num) {
  if (!num) return null;
  return num
    .trim()
    .toUpperCase()
    // Quitar sufijos de servicio al final (EXPRESS, URGENTE, NORMAL, etc.)
    .replace(/\s+(EXPRESS|URGENTE|NORMAL|PRIORITARIO|STANDARD)\s*$/i, '')
    // Quitar prefijos de tipo de documento (PED, OC, OV, ORD, FC, REM, etc.)
    .replace(/^(PEDIDO|PED|ORDEN\s+DE\s+COMPRA|ORDEN|ORD|OC|OV|FACTURA|FAC|FC|REMITO|REM)[.\-\s]*/i, '')
    .trim()
    // Colapsar espacios internos
    .replace(/\s+/g, ' ') || null;
}

export function recepcionesRouter(db, cfg) {
  const router = express.Router();

  // Migraciones
  try { db.prepare('ALTER TABLE recepcion_items ADD COLUMN recibido INTEGER NOT NULL DEFAULT 1').run(); } catch (_) {}
  try { db.prepare('ALTER TABLE recepciones ADD COLUMN solo_documento INTEGER NOT NULL DEFAULT 0').run(); } catch (_) {}
  try { db.prepare('ALTER TABLE recepciones ADD COLUMN numero_pedido_norm TEXT').run(); } catch (_) {}
  try { db.prepare('ALTER TABLE pedidos ADD COLUMN numero_pedido_norm TEXT').run(); } catch (_) {}

  // Migración estados de ítem (recepción confiable, sin pérdidas silenciosas)
  let estadoItemNuevo = false;
  try { db.prepare('ALTER TABLE recepcion_items ADD COLUMN estado_item TEXT').run(); estadoItemNuevo = true; } catch (_) {}
  try { db.prepare('ALTER TABLE recepcion_items ADD COLUMN ficha_json TEXT').run(); } catch (_) {}
  try { db.prepare('ALTER TABLE recepcion_items ADD COLUMN error_wc TEXT').run(); } catch (_) {}
  try { db.prepare('ALTER TABLE recepcion_items ADD COLUMN resuelto_en TEXT').run(); } catch (_) {}

  // Backfill idempotente: corre una sola vez, cuando la columna estado_item recién se crea.
  // Vuelve visibles los históricos perdidos (sin_match) y los fallos WC silenciosos (error).
  if (estadoItemNuevo) {
    const backfill = db.transaction(() => {
      db.prepare(`UPDATE recepcion_items SET estado_item='no_recibido'
        WHERE recibido=0 AND recepcion_id IN (SELECT id FROM recepciones WHERE solo_documento=0)`).run();
      db.prepare(`UPDATE recepcion_items SET estado_item='aplicado'
        WHERE recibido=1 AND id_woo IS NOT NULL AND stock_nuevo IS NOT NULL
        AND recepcion_id IN (SELECT id FROM recepciones WHERE solo_documento=0 AND estado='confirmada')`).run();
      db.prepare(`UPDATE recepcion_items SET estado_item='sin_match'
        WHERE recibido=1 AND id_woo IS NULL
        AND recepcion_id IN (SELECT id FROM recepciones WHERE solo_documento=0 AND estado='confirmada')`).run();
      db.prepare(`UPDATE recepcion_items SET estado_item='error'
        WHERE recibido=1 AND id_woo IS NOT NULL AND stock_nuevo IS NULL
        AND recepcion_id IN (SELECT id FROM recepciones WHERE solo_documento=0 AND estado='confirmada')`).run();
      db.prepare(`UPDATE recepcion_items SET estado_item='pendiente'
        WHERE estado_item IS NULL
        AND recepcion_id IN (SELECT id FROM recepciones WHERE solo_documento=0 AND estado IN ('borrador','procesando'))`).run();
    });
    backfill();
  }

  // Lista historial de recepciones
  router.get('/', (req, res) => {
    const rows = db.prepare(`
      SELECT r.*,
        (SELECT COUNT(*) FROM recepcion_items WHERE recepcion_id = r.id) AS total_items,
        (SELECT COUNT(*) FROM recepcion_documentos WHERE recepcion_id = r.id) AS total_docs,
        (SELECT COUNT(*) FROM recepcion_items WHERE recepcion_id = r.id
           AND estado_item IN ('sin_match','pendiente_creacion','error')) AS pendientes
      FROM recepciones r ORDER BY r.creado_en DESC LIMIT 100
    `).all();
    res.json({ ok: true, data: rows });
  });

  // Detalle de una recepción
  router.get('/:id', (req, res) => {
    const id = parseInt(req.params.id);
    const rec = db.prepare('SELECT * FROM recepciones WHERE id=?').get(id);
    if (!rec) return res.status(404).json({ ok: false, error: 'no encontrada' });
    const docs  = db.prepare('SELECT * FROM recepcion_documentos WHERE recepcion_id=?').all(id);
    const items = db.prepare('SELECT * FROM recepcion_items WHERE recepcion_id=? ORDER BY id').all(id);
    res.json({ ok: true, data: { ...rec, documentos: docs, items } });
  });

  // Guarda una recepción en estado borrador (sin tocar WooCommerce)
  router.post('/', (req, res) => {
    const { proveedor, importador, numero_pedido, fecha, notas, solo_documento = false, documentos = [], items = [] } = req.body || {};
    if (!proveedor) return res.status(400).json({ ok: false, error: 'proveedor requerido' });
    const now = new Date().toISOString();
    // Validar fecha: si viene pero no es YYYY-MM-DD válida, usar fecha actual
    const fechaValida = fecha && /^\d{4}-\d{2}-\d{2}$/.test(fecha) && !isNaN(Date.parse(fecha));
    const fechaDoc = fechaValida ? fecha : now.slice(0, 10);
    const importadorEfectivo = importador || proveedor;

    // Auto-crear o vincular pedido si viene número de pedido
    let pedidoId = null;
    const numPedNorm = normalizarNumeroPedido(numero_pedido);
    if (numPedNorm) {
      const numPedRaw = numero_pedido.trim();
      // Buscar primero por número normalizado (tolerante a prefijos/sufijos)
      let pedido = db.prepare(
        'SELECT id FROM pedidos WHERE numero_pedido_norm=? AND importador=?'
      ).get(numPedNorm, importadorEfectivo);
      if (!pedido) {
        // Crear nuevo pedido con número normalizado como clave de matching
        db.prepare(`INSERT OR IGNORE INTO pedidos (numero_pedido, numero_pedido_norm, importador, proveedor, estado, creado_en)
          VALUES (?,?,?,?,'pendiente',?)`).run(numPedRaw, numPedNorm, importadorEfectivo, proveedor, now);
        pedido = db.prepare(
          'SELECT id FROM pedidos WHERE numero_pedido_norm=? AND importador=?'
        ).get(numPedNorm, importadorEfectivo);
      }
      pedidoId = pedido?.id || null;
    }

    const soloDoc = solo_documento ? 1 : 0;
    const recId = db.prepare(
      'INSERT INTO recepciones (pedido_id,proveedor,importador,numero_pedido,numero_pedido_norm,fecha,notas,solo_documento,estado,creado_en) VALUES (?,?,?,?,?,?,?,?,?,?)'
    ).run(pedidoId, proveedor, importadorEfectivo, numero_pedido?.trim() || null, numPedNorm, fechaDoc, notas || null, soloDoc, 'borrador', now).lastInsertRowid;

    const insDoc  = db.prepare('INSERT INTO recepcion_documentos (recepcion_id,tipo,numero,nombre_archivo,drive_url,creado_en) VALUES (?,?,?,?,?,?)');
    const insItem = db.prepare(`
      INSERT INTO recepcion_items
        (recepcion_id,id_woo,sku,nombre_doc,codigo_proveedor,cantidad,precio_unitario,stock_previo,stock_nuevo,recibido,creado_en)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)
    `);

    const saveAll = db.transaction(() => {
      for (const d of documentos) {
        // Sanitizar file_url: rechazar path traversal
        const fileUrl = d.file_url ? String(d.file_url).replace(/\.\.\//g, '').replace(/\.\.$/g, '') : null;
        insDoc.run(recId, d.tipo || 'otro', d.numero || null, d.nombre_archivo || null, fileUrl, now);
      }
      for (const it of items) {
        const recibido = it.recibido === false || it.recibido === 0 ? 0 : 1;
        // Validar cantidad: debe ser entero positivo
        const cantidad = Math.max(1, parseInt(it.cantidad) || 1);
        insItem.run(recId, it.id_woo || null, it.sku || null, it.nombre_doc || it.nombre || '',
          it.codigo_proveedor || null, cantidad,
          it.precio_unitario || null, it.stock_previo || null, it.stock_nuevo || null, recibido, now);
      }
    });
    saveAll();

    res.json({ ok: true, id: recId, pedido_id: pedidoId });
  });

  // Re-persiste items/docs de un borrador existente (para cuando el usuario editó post-save)
  router.post('/:id/actualizar', (req, res) => {
    const id = parseInt(req.params.id);
    const rec = db.prepare("SELECT estado FROM recepciones WHERE id=?").get(id);
    if (!rec) return res.status(404).json({ ok: false, error: 'no encontrada' });
    if (rec.estado !== 'borrador') return res.status(400).json({ ok: false, error: 'solo borradores' });

    const { items: newItems = [], documentos: newDocs = [] } = req.body || {};
    const now = new Date().toISOString();

    const updateRec = db.transaction(() => {
      db.prepare('DELETE FROM recepcion_items WHERE recepcion_id=?').run(id);
      db.prepare('DELETE FROM recepcion_documentos WHERE recepcion_id=?').run(id);

      const insDoc  = db.prepare('INSERT INTO recepcion_documentos (recepcion_id,tipo,numero,nombre_archivo,drive_url,creado_en) VALUES (?,?,?,?,?,?)');
      const insItem = db.prepare(`
        INSERT INTO recepcion_items
          (recepcion_id,id_woo,sku,nombre_doc,codigo_proveedor,cantidad,precio_unitario,stock_previo,stock_nuevo,recibido,creado_en)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)
      `);

      for (const d of newDocs) {
        const fileUrl = d.file_url ? String(d.file_url).replace(/\.\.\//g, '').replace(/\.\.$/g, '') : null;
        insDoc.run(id, d.tipo || 'otro', d.numero || null, d.nombre_archivo || null, fileUrl, now);
      }
      for (const it of newItems) {
        const recibido = it.recibido === false || it.recibido === 0 ? 0 : 1;
        const cantidad = Math.max(1, parseInt(it.cantidad) || 1);
        insItem.run(id, it.id_woo || null, it.sku_wc || it.sku || null, it.nombre_doc || it.nombre || '',
          it.codigo_proveedor || null, cantidad,
          it.precio_unitario || null, it.stock_wc ?? null, null, recibido, now);
      }
    });
    updateRec();
    res.json({ ok: true, id });
  });

  // Confirma una recepción: actualiza stock en WooCommerce ítem a ítem
  router.post('/:id/confirmar', async (req, res) => {
    const id = parseInt(req.params.id);

    // Marcar como 'procesando' atómicamente — si ya fue confirmada o no existe, changes=0
    const lock = db.prepare(
      "UPDATE recepciones SET estado='procesando' WHERE id=? AND estado='borrador'"
    ).run(id);

    if (lock.changes === 0) {
      const rec = db.prepare('SELECT estado FROM recepciones WHERE id=?').get(id);
      if (!rec) return res.status(404).json({ ok: false, error: 'no encontrada' });
      return res.status(400).json({ ok: false, error: rec.estado === 'confirmada' ? 'ya confirmada' : 'ya en proceso' });
    }

    const recMeta = db.prepare('SELECT pedido_id, solo_documento FROM recepciones WHERE id=?').get(id);
    const resultados = [];

    // Solo actualiza WC si no es "solo documento"
    if (!recMeta?.solo_documento) {
      const items = db.prepare('SELECT * FROM recepcion_items WHERE recepcion_id=? AND id_woo IS NOT NULL AND recibido=1').all(id);
      for (const it of items) {
        try {
          const r = await aplicarStockItem(db, cfg, it);
          resultados.push({ sku: it.sku, nombre: it.nombre_doc, ok: true, stock_previo: r.stock_previo, stock_nuevo: r.stock_nuevo });
        } catch (e) {
          db.prepare("UPDATE recepcion_items SET estado_item='error', error_wc=? WHERE id=?")
            .run(String(e?.message || e), it.id);
          resultados.push({ sku: it.sku, nombre: it.nombre_doc, ok: false, error: e.message });
        }
      }
      // Marcar explícitamente los ítems que NO se aplicaron — nada se pierde en silencio.
      // (los 'pendiente_creacion' ya marcados se conservan; los 'error' ya tienen id_woo y no matchean el WHERE de sin_match)
      db.prepare(`UPDATE recepcion_items SET estado_item='sin_match'
        WHERE recepcion_id=? AND recibido=1 AND id_woo IS NULL
        AND (estado_item IS NULL OR estado_item NOT IN ('pendiente_creacion','creado'))`).run(id);
      db.prepare(`UPDATE recepcion_items SET estado_item='no_recibido'
        WHERE recepcion_id=? AND recibido=0`).run(id);

      // Actualizar estado del pedido asociado solo cuando la recepción tocó stock.
      // Una recepción "solo documento" no debe inflar el avance del pedido.
      if (recMeta?.pedido_id) {
        db.prepare("UPDATE pedidos SET estado='recibido_parcial' WHERE id=? AND estado='pendiente'")
          .run(recMeta.pedido_id);
      }
    }

    const now = new Date().toISOString();
    db.prepare("UPDATE recepciones SET estado='confirmada', confirmado_en=? WHERE id=?").run(now, id);

    const errores = resultados.filter(r => !r.ok).length;
    const aplicados = resultados.filter(r => r.ok).length;
    const soloDoc = recMeta?.solo_documento === 1;

    // Ítems que quedaron pendientes de resolver (visibles, no perdidos)
    const pendientes = soloDoc ? [] : db.prepare(`
      SELECT id, id_woo, sku, nombre_doc, codigo_proveedor, cantidad, estado_item, error_wc
      FROM recepcion_items
      WHERE recepcion_id=? AND estado_item IN ('sin_match','pendiente_creacion','error')
      ORDER BY id
    `).all(id);
    const sin_match = pendientes.filter(p => p.estado_item === 'sin_match').length;

    res.json({ ok: true, aplicados, errores, sin_match, resultados, pendientes, confirmado_en: now, solo_documento: soloDoc });
  });

  return router;
}
