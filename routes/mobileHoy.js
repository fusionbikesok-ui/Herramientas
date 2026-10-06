/**
 * Adaptadores móviles de la pantalla "Hoy" y de la lista de pedidos.
 *
 * El contrato los declaraba desde el principio con `x-implementation-status: adapter-pending`,
 * y nunca se sirvieron: la app los llamaba, el catch-all autenticado de `/api/v1` respondía 401
 * y las dos pantallas mostraban "sin conexión". Es lo que faltaba de E5/E6 del lado del backend.
 *
 * Sólo leen. Cada número sale de la misma fuente que ya usa la herramienta web equivalente, para
 * que la app y la web no puedan contar distinto: dos cuentas del mismo dato terminan divergiendo
 * y nadie sabe cuál creer.
 */
import express from 'express';
import { pedidosElegiblesOrdenados } from '../lib/preparacion.js';

/** Cuenta sin romperse si la tabla todavía no existe en esta base. */
function contar(db, sql, params = []) {
  try {
    return Number(db.prepare(sql).get(...params)?.n ?? 0);
  } catch {
    // Una tabla ausente no es un cero real, pero para un tablero es mejor mostrar 0 que tumbar
    // la pantalla entera por una sección que todavía no existe.
    return 0;
  }
}

export function mobileHoyRouter(db, auth) {
  const router = express.Router();

  router.get('/today', auth, (_req, res) => {
    // Se usa la MISMA función que arma la cola de la herramienta web (`pedidosElegiblesOrdenados`)
    // en vez de una consulta propia. Contar sólo por `estado_envio='pendiente'` daba 64 —incluía
    // pedidos de julio y agosto ya despachados, porque el sync de ML nunca marca la caché como
    // enviada—; el criterio real además descarta los que ya tienen su preparación resuelta.
    // Dos cuentas del mismo dato terminan divergiendo y nadie sabe cuál creer.
    let pendientes;
    try { pendientes = pedidosElegiblesOrdenados(db).length; } catch { pendientes = 0; }
    res.json({
      pedidos_nuevos: pendientes,
      pedidos_preparando: contar(db, "SELECT COUNT(*) n FROM preparaciones WHERE estado = 'en_preparacion'"),
      // Publicaciones activas con stock que no tienen producto Woo detrás: se venden sin nada
      // que las respalde. Misma consulta que el detector de la herramienta de identidad.
      stock_con_error_ml: contar(db, `SELECT COUNT(*) n FROM ml_publicaciones_cache p
        WHERE p.status='active' AND COALESCE(p.available_quantity,0)>0
          AND TRIM(COALESCE(p.seller_sku,'')) <> ''
          AND (p.canales_json IS NULL OR p.canales_json LIKE '%marketplace%')
          AND NOT EXISTS (SELECT 1 FROM catalogo_cache c WHERE c.sku = p.seller_sku)`),
      // Sólo las que se PUEDEN responder. Medido contra la API de ML el 2026-09-06: de 9 sin
      // responder, una la había borrado el comprador y seis estaban en publicaciones pausadas.
      // Un contador que promete 9 acciones y permite 2 no es una bandeja de trabajo: manda a
      // buscar seis veces algo que no está.
      preguntas_sin_responder: contar(db, `SELECT COUNT(*) n FROM ml_preguntas q
        WHERE COALESCE(q.respondida_en,'') = ''
          AND EXISTS (SELECT 1 FROM ml_publicaciones_cache m
                       WHERE m.item_id = q.item_id AND m.status = 'active')`),
      mensajes_sin_responder: contar(db, `SELECT COUNT(*) n FROM ml_mensajes
        WHERE COALESCE(respondido_en,'') = ''`),
      reclamos_abiertos: contar(db, `SELECT COUNT(*) n FROM ml_reclamos
        WHERE COALESCE(estado,'') NOT IN ('closed','cerrado','resuelto')`),
      tareas_pendientes: contar(db, `SELECT COUNT(*) n FROM identidad_casos
        WHERE direccion='ml_fusion' AND estado IN ('urgente','tomado','intervencion')`),
    });
  });

  router.get('/orders', auth, (req, res) => {
    // Tope explícito: la lista es para trabajar en un teléfono, no para volcar el histórico.
    const limite = Math.max(1, Math.min(100, Number(req.query.limit) || 50));
    try {
      // Misma fuente que la cola de la web: lo que ve la app es lo que hay para preparar, no
      // todo lo que la caché todavía no marcó como enviado.
      const filas = pedidosElegiblesOrdenados(db).slice(0, limite);
      res.json(filas.map((p) => ({
        id: String(p.numero_pedido || p.ml_order_id || p.wc_order_id || ''),
        canal: p.canal === 'ml' ? 'ml' : 'web',
        // `new` y `preparing` son los dos estados que el contrato admite; cualquier otro se
        // muestra como nuevo antes que inventar una categoría que la app no sabe dibujar.
        estado: String(p.estado_wc || '') === 'processing' ? 'preparing' : 'new',
        cliente: String(p.comprador || 'Sin datos'),
        // Sin `total`: `pedidos_cache.items_json` guarda sku, nombre, categoría y cantidad,
        // pero no el precio. Calcularlo con el precio actual del catálogo daría un importe que
        // no es el que pagó el cliente, y en una pantalla de trabajo eso es peor que no
        // mostrarlo. Vuelve cuando el pedido traiga su importe.
        items: cantidadDe(p.items_json),
      })));
    } catch {
      res.json([]);
    }
  });

  return router;
}

/** Cuántas unidades tiene el pedido: es el dato útil para preparar, y sí está disponible. */
function cantidadDe(itemsJson) {
  try {
    const items = JSON.parse(itemsJson || '[]');
    return Array.isArray(items) ? items.reduce((a, i) => a + (Number(i.cantidad) || 0), 0) : 0;
  } catch {
    return 0;
  }
}
