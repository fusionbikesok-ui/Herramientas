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
  router.post('/importar', async (req, res) => {
    const desde = req.body?.desde || fechaHaceDias(30);
    const hasta = req.body?.hasta || new Date().toISOString();
    // ML permite filtrar por varios estados separados por coma. Se consulta el universo
    // explícito porque el buscador de vendedor no debe asumir que "paid" representa todas
    // las órdenes: también hay órdenes sin pago confirmado, parcialmente reembolsadas o
    // pendientes de cancelación. Puede ajustarse temporalmente por entorno si ML incorpora
    // un estado nuevo.
    const statusesMl = String(process.env.GESTION_PEDIDOS_ML_STATUSES || 'confirmed,payment_required,payment_in_process,partially_paid,paid,partially_refunded,pending_cancel,cancelled,manually_cancelled').split(',').map(x => x.trim()).filter(Boolean);
    try {
      const resultados = await importarVentanaGestionPedidos(db, {
        desde,
        hasta,
        porPagina: 50,
        listarWoo: listarWooOverride || (async ({ desde: after, hasta: before, pagina, limite }) => {
          const query = `/orders?status=any&after=${encodeURIComponent(after)}&before=${encodeURIComponent(before)}&orderby=date&order=asc&per_page=${limite}&page=${pagina}`;
          return exigirRespuesta(await wooFetch(woo, query), 'WooCommerce');
        }),
        listarMl: listarMlOverride || (async ({ desde: from, offset, limite }) => {
          const todas = [];
          for (const status of statusesMl) {
            const query = `/orders/search?seller=${encodeURIComponent(ml.userId)}&order.status=${encodeURIComponent(status)}&sort=date_asc&order.date_created.from=${encodeURIComponent(from)}&order.date_created.to=${encodeURIComponent(hasta)}&offset=${offset}&limit=${limite}`;
            const data = exigirRespuesta(await mlFetch(db, ml, 'get', query), `MercadoLibre ${status}`);
            todas.push(...(data.results || []));
          }
          const unicas = new Map(todas.map(orden => [String(orden.id), orden]));
          return [...unicas.values()];
        }),
      });
      return res.json({ ok: true, desde, hasta, importados: resultados.length, creados: resultados.filter(x => x.created).length, actualizados: resultados.filter(x => x.changed && !x.created).length });
    } catch (error) {
      return res.status(502).json({ ok: false, error: 'No se pudo completar la importación', detalle: error.message });
    }
  });
  return router;
}
