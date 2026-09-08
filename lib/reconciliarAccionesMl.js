/**
 * Refresco de las acciones que Mercado Libre permite en cada reclamo abierto.
 *
 * Existe por §4.3 de la especificación: `GET /post-purchase/v1/claims/{id}` devolvió
 * `available_actions: []` para los tres players en un reclamo donde la BÚSQUEDA sí declaraba
 * `send_message_to_mediator`. Como la ingesta proyecta desde el detalle, `external_actions`
 * quedaba siempre en NULL y, con la regla de "vacío es desconocido", la app nunca habilitaba
 * una acción de reclamo. La funcionalidad estaba escrita y no se encendía nunca.
 *
 * Este barrido usa la búsqueda, que es la fuente que sí las publica, y con UNA sola llamada
 * cubre todos los reclamos abiertos de la cuenta: es más barato que pedir el detalle de cada
 * uno y no gasta la cuota compartida con la operación real.
 */

import { mlFetch } from './mlClient.js';
import { accionesDelVendedor, serializarAcciones } from './mlAccionesCaso.js';

const now = () => new Date().toISOString();

function tieneColumna(db, tabla, columna) {
  return db.prepare(`PRAGMA table_info(${tabla})`).all().some((c) => c.name === columna);
}

export async function reconciliarAccionesMl(db, mlCfg) {
  // La migración 094 es aditiva y puede no estar aplicada en una base de test.
  if (!tieneColumna(db, 'inbox_items', 'external_actions')) return { actualizados: 0, revisados: 0 };
  const sellerId = mlCfg?.userId;
  if (!sellerId) return { actualizados: 0, revisados: 0 };

  const resp = await mlFetch(db, mlCfg, 'GET',
    `/post-purchase/v1/claims/search?status=opened&players.user_id=${sellerId}&players.role=respondent`,
    null, { manual: false });
  if (!resp || resp.status < 200 || resp.status >= 300) {
    return { actualizados: 0, revisados: 0, status: resp?.status ?? null };
  }

  const reclamos = resp.data?.data || resp.data?.results || [];
  const ts = now();
  let actualizados = 0;

  for (const reclamo of reclamos) {
    const id = reclamo?.id;
    if (id == null) continue;
    // `null` (desconocido) se guarda como NULL, que es exactamente lo que la app necesita
    // para deshabilitar el botón sin esconderlo.
    const acciones = serializarAcciones(accionesDelVendedor(reclamo));
    const r = db.prepare(`UPDATE inbox_items
      SET external_actions = ?, external_status = COALESCE(?, external_status), last_synced_at = ?
      WHERE channel = 'ml' AND resource_id IN (?, ?)`)
      .run(acciones, reclamo.status || null, ts, `claim:${id}`, String(id));
    actualizados += r.changes;
  }

  return { actualizados, revisados: reclamos.length };
}
