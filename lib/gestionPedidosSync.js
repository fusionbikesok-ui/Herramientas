/*
 * lib/gestionPedidosSync.js — Corrida de importación de Gestión de pedidos.
 *
 * Extraído de routes/gestionPedidos.js el 2026-09-09 para que el cron incremental y el
 * botón de reconciliación manual compartan exactamente el mismo camino: los adaptadores
 * de red, el registro en `gestion_pedido_importaciones` y el manejo de error. Antes la
 * lógica vivía sólo dentro del POST, así que un cron habría sido una segunda
 * implementación del mismo flujo, con su propia forma de fallar.
 */
import { wooFetch } from '../routes/woo.js';
import { mlFetch } from './mlClient.js';
import { importarVentanaGestionPedidos } from './gestionPedidos.js';

function exigirRespuesta(resp, nombre) {
  if (!resp || resp.status < 200 || resp.status >= 300) throw new Error(`${nombre} respondió ${resp?.status ?? 'sin status'}`);
  return resp.data;
}

export function fechaHaceDias(dias) {
  return new Date(Date.now() - dias * 24 * 60 * 60 * 1000).toISOString();
}

/** Estados de ML a barrer. Sin override se usa sólo la ventana de fechas. */
export function estadosMlConfigurados() {
  return process.env.GESTION_PEDIDOS_ML_STATUSES
    ? process.env.GESTION_PEDIDOS_ML_STATUSES.split(',').map(x => x.trim()).filter(Boolean)
    : null;
}

/** Adaptador Woo por defecto: página de pedidos de la ventana, cualquier estado. */
export function listarWooReal(woo) {
  return async ({ desde, hasta, pagina, limite }) => {
    const query = `/orders?status=any&after=${encodeURIComponent(desde)}&before=${encodeURIComponent(hasta)}&orderby=date&order=asc&per_page=${limite}&page=${pagina}`;
    return exigirRespuesta(await wooFetch(woo, query), 'WooCommerce');
  };
}

/** Adaptador ML por defecto: búsqueda del vendedor por ventana, deduplicada por id. */
export function listarMlReal(db, ml) {
  const statuses = estadosMlConfigurados();
  return async ({ desde, hasta, offset, limite }) => {
    const todas = [];
    for (const status of statuses || [null]) {
      const estado = status ? `&order.status=${encodeURIComponent(status)}` : '';
      const query = `/orders/search?seller=${encodeURIComponent(ml.userId)}${estado}&sort=date_asc&order.date_created.from=${encodeURIComponent(desde)}&order.date_created.to=${encodeURIComponent(hasta)}&offset=${offset}&limit=${limite}`;
      todas.push(...(exigirRespuesta(await mlFetch(db, ml, 'get', query), `MercadoLibre ${status}`).results || []));
    }
    return [...new Map(todas.map(orden => [String(orden.id), orden])).values()];
  };
}

/**
 * Ejecuta una corrida completa y la deja registrada en `gestion_pedido_importaciones`,
 * pase lo que pase. Devuelve el resumen; ante fallo lanza con la corrida ya marcada
 * `fallida`, para que el historial muestre el intento y no sólo los éxitos.
 */
export async function ejecutarImportacion(db, { woo, ml, desde, hasta, porPagina = 50, listarWoo, listarMl } = {}) {
  const inicio = desde || fechaHaceDias(30);
  const fin = hasta || new Date().toISOString();
  const corrida = db.prepare(`INSERT INTO gestion_pedido_importaciones (desde, hasta, estado, iniciado_en) VALUES (?, ?, 'iniciada', ?)`)
    .run(inicio, fin, new Date().toISOString());
  try {
    const resultados = await importarVentanaGestionPedidos(db, {
      desde: inicio,
      hasta: fin,
      porPagina,
      listarWoo: listarWoo || listarWooReal(woo),
      listarMl: listarMl || listarMlReal(db, ml),
    });
    const resumen = {
      ok: true,
      desde: inicio,
      hasta: fin,
      importados: resultados.length,
      creados: resultados.filter(x => x.created).length,
      actualizados: resultados.filter(x => x.changed && !x.created).length,
    };
    db.prepare(`UPDATE gestion_pedido_importaciones SET estado='completada', importados=?, creados=?, actualizados=?, finalizado_en=? WHERE id=?`)
      .run(resumen.importados, resumen.creados, resumen.actualizados, new Date().toISOString(), corrida.lastInsertRowid);
    return resumen;
  } catch (error) {
    db.prepare(`UPDATE gestion_pedido_importaciones SET estado='fallida', error=?, finalizado_en=? WHERE id=?`)
      .run(error.message, new Date().toISOString(), corrida.lastInsertRowid);
    throw error;
  }
}
