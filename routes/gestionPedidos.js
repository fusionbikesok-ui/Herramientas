import express from 'express';
import { wooFetch } from './woo.js';
import { mlFetch } from '../lib/mlClient.js';
import { importarVentanaGestionPedidos } from '../lib/gestionPedidos.js';

function fechaHaceDias(dias) {
  return new Date(Date.now() - dias * 24 * 60 * 60 * 1000).toISOString();
}

function exigirRespuesta(resp, nombre) {
  if (!resp || resp.status < 200 || resp.status >= 300) throw new Error(`${nombre} respondió ${resp?.status ?? 'sin status'}`);
  return resp.data;
}

/** Router administrativo para la importación inicial/reconciliación manual. */
export function gestionPedidosRouter(db, { woo, ml, listarWoo: listarWooOverride, listarMl: listarMlOverride }) {
  const router = express.Router();
  router.get('/', (req, res) => {
    const limite = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const condiciones = [];
    const params = [];
    if (req.query.estado) { condiciones.push('p.estado_operativo = ?'); params.push(String(req.query.estado)); }
    if (req.query.comercial) { condiciones.push('p.estado_comercial = ?'); params.push(String(req.query.comercial)); }
    if (req.query.fuente) { condiciones.push('p.fuente = ?'); params.push(String(req.query.fuente)); }
    if (req.query.q) {
      condiciones.push(`(p.numero_visible LIKE ? OR p.external_id LIKE ? OR c.nombre LIKE ? OR c.email LIKE ? OR c.telefono LIKE ? OR EXISTS
        (SELECT 1 FROM gestion_pedido_items i WHERE i.pedido_id=p.id AND (i.sku LIKE ? OR i.ean LIKE ? OR i.nombre LIKE ?)))`);
      const q = `%${String(req.query.q).trim()}%`;
      params.push(q, q, q, q, q, q, q, q);
    }
    const where = condiciones.length ? `WHERE ${condiciones.join(' AND ')}` : '';
    const total = db.prepare(`SELECT COUNT(*) AS total FROM gestion_pedidos p JOIN gestion_pedido_clientes c ON c.id=p.cliente_id ${where}`).get(...params).total;
    const pedidos = db.prepare(`SELECT p.id, p.numero_visible, p.fuente, p.external_id, p.estado_comercial, p.estado_operativo,
      p.pago_estado, p.total_centavos, p.moneda, p.creado_fuente_en, p.actualizado_en,
      c.nombre AS cliente_nombre, c.email AS cliente_email, c.telefono AS cliente_telefono,
      (SELECT COUNT(*) FROM gestion_pedido_items i WHERE i.pedido_id=p.id) AS productos,
      (SELECT COALESCE(SUM(i.cantidad),0) FROM gestion_pedido_items i WHERE i.pedido_id=p.id) AS unidades
      FROM gestion_pedidos p JOIN gestion_pedido_clientes c ON c.id=p.cliente_id ${where}
      ORDER BY p.creado_fuente_en DESC, p.id DESC LIMIT ? OFFSET ?`).all(...params, limite, offset);
    return res.json({ ok: true, total, limit: limite, offset, pedidos });
  });
  router.get('/importar/config', (_req, res) => res.json({
    ok: true,
    woocommerce: Boolean(woo?.url && woo?.ck && woo?.cs),
    mercadolibre: Boolean(ml?.clientId && ml?.clientSecret && ml?.userId),
    ventana_por_defecto_dias: 30,
    estados_ml: process.env.GESTION_PEDIDOS_ML_STATUSES ? process.env.GESTION_PEDIDOS_ML_STATUSES.split(',').map(x => x.trim()).filter(Boolean) : null,
  }));
  router.get('/importaciones', (req, res) => {
    const limite = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
    const corridas = db.prepare(`SELECT id, desde, hasta, estado, woo_recibidos, ml_recibidos, importados, creados, actualizados, error, iniciado_en, finalizado_en
      FROM gestion_pedido_importaciones ORDER BY id DESC LIMIT ?`).all(limite);
    return res.json({ ok: true, corridas });
  });
  router.post('/importar', async (req, res) => {
    const desde = req.body?.desde || fechaHaceDias(30);
    const hasta = req.body?.hasta || new Date().toISOString();
    // Sin override se usa únicamente la ventana de fechas: el buscador de vendedor devuelve
    // el universo vigente sin depender de que cada estado documentado sea válido para la
    // cuenta/API actual. El override sirve para corridas acotadas y se deduplica por ID.
    const statusesMl = process.env.GESTION_PEDIDOS_ML_STATUSES
      ? process.env.GESTION_PEDIDOS_ML_STATUSES.split(',').map(x => x.trim()).filter(Boolean)
      : null;
    const iniciadoEn = new Date().toISOString();
    const corrida = db.prepare(`INSERT INTO gestion_pedido_importaciones (desde, hasta, estado, iniciado_en) VALUES (?, ?, 'iniciada', ?)`).run(desde, hasta, iniciadoEn);
    try {
      const resultados = await importarVentanaGestionPedidos(db, {
        desde,
        hasta,
        porPagina: 50,
        listarWoo: listarWooOverride || (async ({ desde: after, hasta: before, pagina, limite }) => {
          const query = `/orders?status=any&after=${encodeURIComponent(after)}&before=${encodeURIComponent(before)}&orderby=date&order=asc&per_page=${limite}&page=${pagina}`;
          return exigirRespuesta(await wooFetch(woo, query), 'WooCommerce');
        }),
        listarMl: listarMlOverride || (async ({ desde: from, hasta: to, offset, limite }) => {
          const todas = [];
          for (const status of statusesMl || [null]) {
            const estado = status ? `&order.status=${encodeURIComponent(status)}` : '';
            const query = `/orders/search?seller=${encodeURIComponent(ml.userId)}${estado}&sort=date_asc&order.date_created.from=${encodeURIComponent(from)}&order.date_created.to=${encodeURIComponent(to)}&offset=${offset}&limit=${limite}`;
            const data = exigirRespuesta(await mlFetch(db, ml, 'get', query), `MercadoLibre ${status}`);
            todas.push(...(data.results || []));
          }
          const unicas = new Map(todas.map(orden => [String(orden.id), orden]));
          return [...unicas.values()];
        }),
      });
      const resumen = { ok: true, desde, hasta, importados: resultados.length, creados: resultados.filter(x => x.created).length, actualizados: resultados.filter(x => x.changed && !x.created).length };
      db.prepare(`UPDATE gestion_pedido_importaciones SET estado='completada', importados=?, creados=?, actualizados=?, finalizado_en=? WHERE id=?`).run(resumen.importados, resumen.creados, resumen.actualizados, new Date().toISOString(), corrida.lastInsertRowid);
      return res.json(resumen);
    } catch (error) {
      db.prepare(`UPDATE gestion_pedido_importaciones SET estado='fallida', error=?, finalizado_en=? WHERE id=?`).run(error.message, new Date().toISOString(), corrida.lastInsertRowid);
      return res.status(502).json({ ok: false, error: 'No se pudo completar la importación', detalle: error.message });
    }
  });
  router.get('/:id', (req, res) => {
    const pedido = db.prepare(`SELECT p.*, c.nombre AS cliente_nombre, c.email AS cliente_email, c.telefono AS cliente_telefono
      FROM gestion_pedidos p JOIN gestion_pedido_clientes c ON c.id=p.cliente_id WHERE p.id=?`).get(req.params.id);
    if (!pedido) return res.status(404).json({ ok: false, error: 'Pedido no encontrado' });
    pedido.entrega = db.prepare('SELECT * FROM gestion_pedido_entregas WHERE pedido_id=?').get(pedido.id) || null;
    pedido.items = db.prepare('SELECT * FROM gestion_pedido_items WHERE pedido_id=? ORDER BY id').all(pedido.id);
    pedido.eventos = db.prepare('SELECT * FROM gestion_pedido_eventos WHERE pedido_id=? ORDER BY creado_en DESC, id DESC').all(pedido.id);
    if (pedido.fuente === 'woocommerce' && woo?.url) {
      const base = String(woo.url).replace(/\/$/, '');
      pedido.enlace_woocommerce = `${base}/wp-admin/post.php?post=${encodeURIComponent(pedido.external_id)}&action=edit`;
    } else {
      pedido.enlace_woocommerce = null;
    }
    return res.json({ ok: true, pedido });
  });
  return router;
}
