import express from 'express';
import { wooFetch } from './woo.js';
import { ejecutarImportacion } from '../lib/gestionPedidosSync.js';
import { calcularDiferenciaPorCuotas } from '../lib/calculoCuotas.js';

function fechaHaceDias(dias) {
  return new Date(Date.now() - dias * 24 * 60 * 60 * 1000).toISOString();
}

// Un pedido deja "Requieren atención" sólo con un cierre confirmado. Un retiro en local
// sigue apareciendo hasta registrarse como retirado: es exactamente el caso que el plan
// pide no perder de vista.
const ESTADOS_CERRADOS = ['cerrado', 'despachado', 'retirado'];

// Una venta de ML entra dos veces: la orden de ML y el pedido espejo que el sync crea en
// WooCommerce. Se muestra la de ML, que es la venta, y su estado lo manda MercadoLibre.
// El espejo se oculta SÓLO si su orden de ML está importada; si no llegó (quedó fuera de
// la ventana, o falló esa página del barrido), el espejo se sigue viendo y el pedido no
// desaparece de la pantalla.
const SIN_ESPEJO_DUPLICADO = `(p.espejo_ml = 0 OR NOT EXISTS (
  SELECT 1 FROM gestion_pedidos ml
  WHERE ml.fuente='mercadolibre' AND ml.external_id = p.ml_order_id))`;

// En ML el estado operativo local puede seguir siendo `importado` aunque el
// shipment ya haya avanzado. En la bandeja de atención manda el estado logístico
// confirmado por ML: un paquete despachado o entregado no requiere intervención.
// `ml_shipment_estado` es de Preparación, no de esta herramienta: si no está, la condición
// no puede nombrarla o el listado responde 500 en cualquier base donde ese módulo no corrió.
// Sin ese dato el pedido queda a la vista, que es el lado seguro: no saber si salió nunca
// puede esconder una venta sin despachar.
function mlEnvioResuelto(hayEnvios) {
  const porShipment = hayEnvios
    ? `NOT EXISTS (SELECT 1 FROM ml_shipment_estado se
        WHERE se.shipment_id = p.ml_shipment_id AND se.status IN ('shipped', 'delivered'))`
    : '1=1';
  return `(p.fuente != 'mercadolibre' OR ${porShipment}
    AND COALESCE(json_extract(p.datos_ml_json, '$.fulfilled'), 0) != 1)`;
}

// Corte operativo solicitado: los pedidos web en espera del pedido de Pilar
// Suquilvide (66887, 2026-07-30 17:59:00) o anteriores no deben entrar en la
// bandeja diaria de atención.
// COALESCE y no una comparación directa: en SQL `NULL != 'on-hold'` no es verdadero sino
// NULL, así que un pedido sin estado del canal quedaba fuera de la bandeja en silencio. Pasa
// con los pedidos del borde de la ventana de importación, que nunca llegan a tener estado.
const WEB_ON_HOLD_ANTIGUOS_EXCLUIDOS = `(p.fuente != 'woocommerce'
  OR COALESCE(p.estado_canal, '') != 'on-hold'
  OR p.creado_fuente_en > '2026-07-30T17:59:00')`;

// `fusion` significa que el pedido ya fue tomado por el circuito interno de
// taller/servicio y no debe aparecer como atención comercial pendiente.
const WEB_EN_FUSION_EXCLUIDOS = `(p.fuente != 'woocommerce' OR COALESCE(p.estado_canal, '') != 'fusion')`;

function fechaLocalArgentina(iso) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Argentina/Buenos_Aires', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
}

function sumarDiasHabiles(fechaIso, dias) {
  const d = new Date(fechaIso);
  while (dias > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    const nombre = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Argentina/Buenos_Aires', weekday: 'short' }).format(d);
    if (!['Sat', 'Sun'].includes(nombre)) dias -= 1;
  }
  return d;
}

function cierreDia(diaLocal, hora = process.env.GESTION_PEDIDOS_CIERRE || '19:00') {
  const [h, m] = String(hora).split(':').map(Number);
  return new Date(`${diaLocal}T${String(h || 19).padStart(2, '0')}:${String(m || 0).padStart(2, '0')}:00-03:00`).toISOString();
}

function vencimientoRecuperacion(creado) {
  const local = fechaLocalArgentina(creado);
  const siguiente = sumarDiasHabiles(new Date(`${local}T12:00:00-03:00`).toISOString(), 1);
  return cierreDia(fechaLocalArgentina(siguiente));
}

function normalizarTelefonoArgentina(value) {
  const digits = String(value || '').replace(/\D/g, '').replace(/^54/, '').replace(/^9/, '');
  return digits.length === 10 ? digits : null;
}

/** Router administrativo para la importación inicial/reconciliación manual. */
export function gestionPedidosRouter(db, { woo, ml, listarWoo: listarWooOverride, listarMl: listarMlOverride, actualizarWoo: actualizarWooOverride } = {}) {
  const router = express.Router();
  // Se resuelve una sola vez: la tabla no aparece ni desaparece durante la vida del proceso.
  const tablas = new Map();
  const hayTabla = (nombre) => {
    if (!tablas.has(nombre)) {
      tablas.set(nombre, Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(nombre)));
    }
    return tablas.get(nombre);
  };
  const hayCatalogo = () => hayTabla('catalogo_cache');
  // El estado logístico de ML vive en otra herramienta (preparación lo mantiene). Si su
  // tabla no está, el listado no puede caerse: se informa sin ese dato.
  const hayEnviosMl = () => hayTabla('ml_shipment_estado');
  router.post('/:id/enviar-woo', async (req, res) => {
    const pedido = db.prepare(`SELECT * FROM gestion_pedidos WHERE id=? AND fuente='woocommerce'`).get(req.params.id);
    if (!pedido) return res.status(404).json({ ok: false, error: 'Pedido WooCommerce no encontrado' });
    const estadoWoo = String(req.body?.estado_woo || process.env.ANDREANI_ENVIADO_STATUS || 'enviadoandreani').trim();
    // wooFetch es (cfg, path, method, body). La versión anterior pasaba un objeto
    // `{ method, data }` en la posición de `method`, así que axios recibía un método
    // inválido: en producción esta ruta nunca pudo actualizar Woo. Los tests no lo
    // detectaron porque siempre inyectan `actualizarWooOverride`.
    const actualizar = actualizarWooOverride || (async ({ externalId, estado }) => wooFetch(woo, `/orders/${encodeURIComponent(externalId)}`, 'put', { status: estado }));
    try {
      const respuesta = await actualizar({ externalId: pedido.external_id, estado: estadoWoo });
      if (!respuesta || (respuesta.status != null && (respuesta.status < 200 || respuesta.status >= 300))) throw new Error(`WooCommerce respondió ${respuesta?.status ?? 'sin status'}`);
      const now = new Date().toISOString(); const actor = String(req.user?.username || req.user?.nombre || 'usuario_actual');
      db.transaction(() => {
        db.prepare(`UPDATE gestion_pedidos SET estado_operativo='enviado', actualizado_en=? WHERE id=?`).run(now, pedido.id);
        db.prepare(`INSERT INTO gestion_pedido_eventos (pedido_id,evento,estado_anterior,estado_nuevo,actor_tipo,datos_json,creado_en) VALUES (?, 'enviado_a_woo', ?, 'enviado', 'usuario', ?, ?)`)
          .run(pedido.id, pedido.estado_operativo, JSON.stringify({ estado_woo: estadoWoo, actor }), now);
      })();
      return res.json({ ok: true, pedido_id: pedido.id, estado_operativo: 'enviado', estado_woo: estadoWoo });
    } catch (error) {
      return res.status(502).json({ ok: false, code: 'WOO_UPDATE_FAILED', error: 'No se pudo actualizar WooCommerce', detalle: error.message });
    }
  });
  router.post('/calcular-diferencia', (req, res) => {
    const resultado = calcularDiferenciaPorCuotas({
      diferenciaContadoCentavos: req.body?.diferencia_contado_centavos,
      cuotas: req.body?.cuotas,
      coeficiente: req.body?.coeficiente,
    });
    return resultado.ok ? res.json(resultado) : res.status(422).json(resultado);
  });
  router.post('/:id/cambios-productos', (req, res) => {
    const pedidoId = Number(req.params.id);
    const accion = String(req.body?.accion || '').toLowerCase();
    const motivo = String(req.body?.motivo || '').toLowerCase();
    const cantidad = Number(req.body?.cantidad);
    const nombre = String(req.body?.producto_nombre || '').trim();
    if (!Number.isInteger(pedidoId) || !['adicion', 'remocion'].includes(accion) || !['no_lo_quiso', 'no_apto_venta', 'falla_stock', 'cambio'].includes(motivo) || !Number.isInteger(cantidad) || cantidad < 1 || !nombre) return res.status(400).json({ ok: false, error: 'acción, producto, cantidad y motivo válidos son obligatorios' });
    const pedido = db.prepare('SELECT id FROM gestion_pedidos WHERE id=?').get(pedidoId);
    if (!pedido) return res.status(404).json({ ok: false, error: 'Pedido no encontrado' });
    const actor = String(req.user?.username || req.user?.nombre || 'usuario_actual');
    const now = new Date().toISOString();
    const cambio = db.prepare(`INSERT INTO gestion_pedido_cambios
      (pedido_id,accion,producto_nombre,sku,cantidad,motivo,diferencia_contado_centavos,diferencia_financiada_centavos,cuotas,actor,creado_en)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(pedidoId, accion, nombre, req.body?.sku || null, cantidad, motivo,
      Number(req.body?.diferencia_contado_centavos || 0), req.body?.diferencia_financiada_centavos ?? null, req.body?.cuotas ?? null, actor, now);
    let stock = null;
    if (motivo === 'falla_stock' && req.body?.sku) {
      try {
        const producto = db.prepare('SELECT stock FROM catalogo_cache WHERE sku=? ORDER BY id LIMIT 1').get(String(req.body.sku));
        if (producto && Number.isFinite(Number(producto.stock))) {
          const anterior = Number(producto.stock);
          const nuevo = Math.max(0, anterior - cantidad);
          db.prepare('UPDATE catalogo_cache SET stock=?, actualizado_en=? WHERE sku=?').run(nuevo, now, String(req.body.sku));
          stock = { sku: String(req.body.sku), anterior, nuevo, cantidad };
        }
      } catch (_) { /* instalaciones sin catálogo aún conservan el cambio auditable */ }
    }
    db.prepare(`INSERT INTO gestion_pedido_eventos (pedido_id,evento,actor_tipo,datos_json,creado_en) VALUES (?, 'cambio_producto', 'usuario', ?, ?)`)
      .run(pedidoId, JSON.stringify({ cambio_id: cambio.lastInsertRowid, accion, motivo, sku: req.body?.sku || null, cantidad, stock }), now);
    return res.status(201).json({ ok: true, cambio: db.prepare('SELECT * FROM gestion_pedido_cambios WHERE id=?').get(cambio.lastInsertRowid), stock });
  });
  router.post('/:id/reintegros/:reintegroId/marcar', (req, res) => {
    const id = Number(req.params.reintegroId); const now = new Date().toISOString();
    const actor = String(req.user?.username || req.user?.nombre || 'usuario_actual');
    const result = db.prepare(`UPDATE gestion_pedido_reintegros SET estado='reintegrado', reintegrado_en=?, reintegrado_por=? WHERE id=? AND estado='pendiente'`).run(now, actor, id);
    if (!result.changes) return res.status(404).json({ ok: false, error: 'Reintegro no encontrado o ya reintegrado' });
    return res.json({ ok: true, reintegro: db.prepare('SELECT * FROM gestion_pedido_reintegros WHERE id=?').get(id) });
  });
  router.post('/recuperar-ventas/importar-carritos', (req, res) => {
    const carritos = Array.isArray(req.body?.carritos) ? req.body.carritos : [];
    if (carritos.length > 1000) return res.status(400).json({ ok: false, error: 'demasiados carritos' });
    const ahora = new Date().toISOString();
    const upsert = db.prepare(`INSERT INTO gestion_recuperacion_oportunidades
      (fuente,external_id,creado_fuente_en,vence_en,datos_json,creado_en,actualizado_en)
      VALUES ('carrito_abandonado',?,?,?,?,?,?)
      ON CONFLICT(fuente,external_id) DO UPDATE SET creado_fuente_en=excluded.creado_fuente_en,
      vence_en=excluded.vence_en, datos_json=excluded.datos_json, actualizado_en=excluded.actualizado_en`);
    const tx = db.transaction(() => carritos.reduce((n, carrito) => {
      const id = String(carrito.id || carrito.cart_id || carrito.cart_hash || '').trim();
      const creado = carrito.abandoned_at || carrito.updated_at || carrito.created_at;
      if (!id || !creado) return n;
      upsert.run(id, creado, vencimientoRecuperacion(creado), JSON.stringify(carrito), ahora, ahora);
      return n + 1;
    }, 0));
    return res.json({ ok: true, importados: tx() });
  });
  router.get('/recuperar-ventas', (req, res) => {
    const ahora = new Date().toISOString();
    const cancelados = db.prepare(`SELECT p.id, p.fuente, p.external_id, p.creado_fuente_en, p.cancelado_en
      FROM gestion_pedidos p
      WHERE p.estado_comercial='cancelado' AND p.cancelado_en IS NOT NULL`).all();
    const crear = db.prepare(`INSERT OR IGNORE INTO gestion_recuperacion_oportunidades
      (pedido_id,fuente,external_id,creado_fuente_en,vence_en,datos_json,creado_en,actualizado_en)
      VALUES (?,?,?,?,?,?,?,?)`);
    const tx = db.transaction(() => {
      for (const pedido of cancelados) {
        const creado = pedido.cancelado_en || pedido.creado_fuente_en || ahora;
        crear.run(pedido.id, 'pedido_cancelado', `${pedido.fuente}:${pedido.external_id}`, creado,
          vencimientoRecuperacion(creado), null, ahora, ahora);
      }
    });
    tx();
    db.prepare(`UPDATE gestion_recuperacion_oportunidades SET estado='recuperada', actualizado_en=?
      WHERE estado='vigente' AND pedido_id IN (SELECT p.id FROM gestion_pedidos p WHERE p.estado_comercial NOT IN ('cancelado','fallido'))`).run(ahora);
    db.prepare(`UPDATE gestion_recuperacion_oportunidades SET estado='vencida', actualizado_en=?
      WHERE estado='vigente' AND vence_en <= ?`).run(ahora, ahora);
    const rows = db.prepare(`SELECT o.*, p.numero_visible, p.fuente AS pedido_fuente,
      c.id AS cliente_id, c.nombre AS cliente_nombre, c.email AS cliente_email, c.telefono AS cliente_telefono,
      (SELECT COUNT(*) FROM gestion_recuperacion_contactos x WHERE x.oportunidad_id=o.id) AS contactos,
      (SELECT x.canal FROM gestion_recuperacion_contactos x WHERE x.oportunidad_id=o.id ORDER BY x.id DESC LIMIT 1) AS ultimo_canal,
      (SELECT x.actor FROM gestion_recuperacion_contactos x WHERE x.oportunidad_id=o.id ORDER BY x.id DESC LIMIT 1) AS ultimo_actor,
      (SELECT x.contactado_en FROM gestion_recuperacion_contactos x WHERE x.oportunidad_id=o.id ORDER BY x.id DESC LIMIT 1) AS ultimo_contacto
      FROM gestion_recuperacion_oportunidades o
      LEFT JOIN gestion_pedidos p ON p.id=o.pedido_id
      LEFT JOIN gestion_pedido_clientes c ON c.id=p.cliente_id
      WHERE o.estado='vigente' ORDER BY o.vence_en ASC, o.creado_fuente_en DESC`).all();
    const consolidadas = new Map();
    for (const row of rows) {
      let datos;
      try { datos = row.datos_json ? JSON.parse(row.datos_json) : {}; } catch { datos = {}; }
      const email = row.cliente_email || datos.email || datos.billing_email;
      const telefono = row.cliente_telefono || datos.phone || datos.billing_phone;
      const key = row.cliente_id ? `cliente:${row.cliente_id}` : email ? `email:${String(email).toLowerCase()}` : telefono ? `telefono:${String(telefono).replace(/\D/g, '')}` : `oportunidad:${row.id}`;
      const anterior = consolidadas.get(key);
      if (!anterior) consolidadas.set(key, { ...row, cliente_email: email, cliente_telefono: telefono, datos, intentos: 1 });
      else if (row.creado_fuente_en > anterior.creado_fuente_en) consolidadas.set(key, { ...row, intentos: anterior.intentos + 1 });
      else anterior.intentos += 1;
    }
    return res.json({ ok: true, oportunidades: [...consolidadas.values()], total: consolidadas.size });
  });
  router.post('/recuperar-ventas/:id/contactar', (req, res) => {
    const canal = String(req.body?.canal || '').toLowerCase();
    if (!['whatsapp', 'email'].includes(canal)) return res.status(400).json({ ok: false, error: 'canal inválido' });
    const oportunidad = db.prepare('SELECT * FROM gestion_recuperacion_oportunidades WHERE id=?').get(req.params.id);
    if (!oportunidad) return res.status(404).json({ ok: false, error: 'Oportunidad no encontrada' });
    if (oportunidad.estado !== 'vigente') return res.status(409).json({ ok: false, error: 'La oportunidad ya no está vigente' });
    const ahora = new Date().toISOString();
    const actor = String(req.user?.username || req.user?.nombre || 'usuario_actual');
    const contacto = db.prepare(`INSERT INTO gestion_recuperacion_contactos
      (oportunidad_id,canal,actor,contactado_en,creado_en) VALUES (?,?,?,?,?)`)
      .run(oportunidad.id, canal, actor, ahora, ahora);
    return res.status(201).json({ ok: true, contacto: { id: contacto.lastInsertRowid, oportunidad_id: oportunidad.id, canal, actor, contactado_en: ahora } });
  });
  router.get('/recuperar-ventas/:id', (req, res) => {
    const oportunidad = db.prepare(`SELECT o.*, p.numero_visible, p.total_centavos,
      c.nombre AS cliente_nombre, c.email AS cliente_email, c.telefono AS cliente_telefono
      FROM gestion_recuperacion_oportunidades o
      LEFT JOIN gestion_pedidos p ON p.id=o.pedido_id
      LEFT JOIN gestion_pedido_clientes c ON c.id=p.cliente_id
      WHERE o.id=?`).get(req.params.id);
    if (!oportunidad) return res.status(404).json({ ok: false, error: 'Oportunidad no encontrada' });
    let datos;
    try { datos = oportunidad.datos_json ? JSON.parse(oportunidad.datos_json) : {}; } catch { datos = {}; }
    const items = oportunidad.pedido_id
      ? db.prepare('SELECT nombre, cantidad, precio_unitario_centavos FROM gestion_pedido_items WHERE pedido_id=? ORDER BY id').all(oportunidad.pedido_id)
      : (Array.isArray(datos.items) ? datos.items : Array.isArray(datos.line_items) ? datos.line_items : []);
    const nombre = oportunidad.cliente_nombre || datos.name || datos.billing_name || 'cliente';
    const email = oportunidad.cliente_email || datos.email || datos.billing_email || '';
    const telefono = oportunidad.cliente_telefono || datos.phone || datos.billing_phone || '';
    const lineas = items.map(item => `${item.nombre || item.name || 'Producto'} x${item.cantidad || item.qty || item.quantity || 1}`).join(', ') || 'los productos seleccionados';
    return res.json({ ok: true, oportunidad: { ...oportunidad, datos, items, contacto: {
      nombre, email, telefono, telefono_argentina: normalizarTelefonoArgentina(telefono),
      asunto: `¿Pudiste completar tu compra? ${oportunidad.numero_visible || 'Carrito abandonado'}`,
      cuerpo: `Hola ${nombre},\n\nVimos que tu compra no llegó a completarse. Habías seleccionado: ${lineas}.\n\n¿Tuviste algún problema con la compra, te arrepentiste o necesitás que te ayudemos con algo? Estamos para ayudarte.\n\nSaludos,\nFusion Bikes`,
    } } });
  });
  // Contadores de las pills y frescura del dato. Va antes de `/:id` a propósito: si se
  // registrara después, Express resolvería "resumen" como un id de pedido.
  router.get('/resumen', (_req, res) => {
    const cerrados = ESTADOS_CERRADOS.map(() => '?').join(',');
    // Mismo colapso del espejo que la lista, o la pill cuenta ventas que no se muestran.
    const atencion = db.prepare(`SELECT COUNT(*) AS n FROM gestion_pedidos p
      WHERE p.estado_operativo NOT IN (${cerrados}) AND ${SIN_ESPEJO_DUPLICADO}
        AND ${mlEnvioResuelto(hayEnviosMl())} AND ${WEB_ON_HOLD_ANTIGUOS_EXCLUIDOS}
        AND ${WEB_EN_FUSION_EXCLUIDOS}`).get(...ESTADOS_CERRADOS).n;
    const total = db.prepare(`SELECT COUNT(*) AS n FROM gestion_pedidos p WHERE ${SIN_ESPEJO_DUPLICADO}`).get().n;
    // Mismo filtro que GET /recuperar-ventas (`estado='vigente'` + no vencida): si el
    // contador de la pill usara otra condición, mostraría un número que la lista no explica.
    const recuperar = db.prepare(`SELECT COUNT(*) AS n FROM gestion_recuperacion_oportunidades
      WHERE estado='vigente' AND vence_en > ?`).get(new Date().toISOString()).n;
    const ultima = db.prepare(`SELECT estado, importados, finalizado_en, error FROM gestion_pedido_importaciones
      WHERE estado != 'iniciada' ORDER BY id DESC LIMIT 1`).get() || null;
    return res.json({ ok: true, atencion, recuperar, total, ultima_importacion: ultima });
  });
  router.get('/', (req, res) => {
    const limite = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const condiciones = [];
    const params = [];
    // `vista=atencion` es la pill inicial: todos los pedidos activos sin cierre confirmado,
    // no sólo las excepciones. La regla vive acá y no en el frontend para que la lista y el
    // contador de la pill no puedan discrepar.
    if (req.query.vista === 'atencion') {
      condiciones.push(`p.estado_operativo NOT IN (${ESTADOS_CERRADOS.map(() => '?').join(',')})`);
      params.push(...ESTADOS_CERRADOS);
      condiciones.push(mlEnvioResuelto(hayEnviosMl()));
      condiciones.push(WEB_ON_HOLD_ANTIGUOS_EXCLUIDOS);
      condiciones.push(WEB_EN_FUSION_EXCLUIDOS);
    }
    if (req.query.estado) { condiciones.push('p.estado_operativo = ?'); params.push(String(req.query.estado)); }
    if (req.query.comercial) { condiciones.push('p.estado_comercial = ?'); params.push(String(req.query.comercial)); }
    if (req.query.fuente) { condiciones.push('p.fuente = ?'); params.push(String(req.query.fuente)); }
    if (req.query.q) {
      // Se busca también por el número del pedido espejo en Woo: la fila que se muestra es
      // la de ML, pero el depósito trabaja con el número de Woo y tiene que encontrarla.
      condiciones.push(`(p.numero_visible LIKE ? OR p.external_id LIKE ? OR c.nombre LIKE ? OR c.email LIKE ? OR c.telefono LIKE ?
        OR EXISTS (SELECT 1 FROM gestion_pedidos w WHERE w.fuente='woocommerce' AND w.ml_order_id = p.external_id
                   AND (w.numero_visible LIKE ? OR w.external_id LIKE ?))
        OR EXISTS (SELECT 1 FROM gestion_pedido_items i WHERE i.pedido_id=p.id AND (i.sku LIKE ? OR i.ean LIKE ? OR i.nombre LIKE ?)))`);
      const q = `%${String(req.query.q).trim()}%`;
      params.push(q, q, q, q, q, q, q, q, q, q);
    }
    condiciones.push(SIN_ESPEJO_DUPLICADO);
    const where = `WHERE ${condiciones.join(' AND ')}`;
    const total = db.prepare(`SELECT COUNT(*) AS total FROM gestion_pedidos p JOIN gestion_pedido_clientes c ON c.id=p.cliente_id ${where}`).get(...params).total;
    const pedidos = db.prepare(`SELECT p.id, p.numero_visible, p.fuente, p.external_id, p.estado_comercial, p.estado_operativo,
      p.estado_canal, p.espejo_ml, p.ml_order_id, p.ml_shipment_id,
      -- El estado que importa en una venta de ML es el del envío: el status de la orden se
      -- queda en paid aunque el paquete ya haya salido.
      ${hayEnviosMl() ? '(SELECT s.status FROM ml_shipment_estado s WHERE s.shipment_id = p.ml_shipment_id)' : 'NULL'} AS estado_envio_ml,
      -- Número del pedido espejo en Woo, para que la fila de ML también lo muestre y el
      -- depósito reconozca el número con el que trabaja.
      (SELECT w.numero_visible FROM gestion_pedidos w
        WHERE w.fuente='woocommerce' AND w.ml_order_id = p.external_id LIMIT 1) AS numero_espejo_woo,
      p.pago_estado, p.total_centavos, p.moneda, p.creado_fuente_en, p.actualizado_en,
      c.nombre AS cliente_nombre, c.email AS cliente_email, c.telefono AS cliente_telefono,
      (SELECT COUNT(*) FROM gestion_pedido_items i WHERE i.pedido_id=p.id) AS productos,
      (SELECT COALESCE(SUM(i.cantidad),0) FROM gestion_pedido_items i WHERE i.pedido_id=p.id) AS unidades
      FROM gestion_pedidos p JOIN gestion_pedido_clientes c ON c.id=p.cliente_id ${where}
      ORDER BY p.creado_fuente_en DESC, p.id DESC LIMIT ? OFFSET ?`).all(...params, limite, offset);
    return res.json({ ok: true, total, limit: limite, offset, pedidos });
  });
  router.post('/preparacion/validar-lote', (req, res) => {
    const ids = [...new Set((Array.isArray(req.body?.pedido_ids) ? req.body.pedido_ids : []).map(Number).filter(Number.isSafeInteger))];
    if (!ids.length || ids.length > 100) return res.status(400).json({ ok: false, error: 'pedido_ids debe contener entre 1 y 100 IDs' });
    const placeholders = ids.map(() => '?').join(',');
    const pedidos = db.prepare(`SELECT id, numero_visible, fuente, estado_comercial, estado_operativo
      FROM gestion_pedidos WHERE id IN (${placeholders})`).all(...ids);
    const encontrados = new Set(pedidos.map(p => p.id));
    const rechazados = ids.filter(id => !encontrados.has(id)).map(id => ({ id, motivo: 'pedido inexistente' }));
    const validos = [];
    for (const pedido of pedidos) {
      if (pedido.estado_comercial !== 'confirmado') {
        rechazados.push({ id: pedido.id, numero_visible: pedido.numero_visible, motivo: `estado comercial ${pedido.estado_comercial}` });
      } else if (!['importado', 'requiere_atencion'].includes(pedido.estado_operativo)) {
        rechazados.push({ id: pedido.id, numero_visible: pedido.numero_visible, motivo: `estado operativo ${pedido.estado_operativo}` });
      } else {
        validos.push(pedido);
      }
    }
    return res.json({ ok: true, puede_iniciar: validos.length > 0 && rechazados.length === 0, solicitados: ids.length, validos, rechazados });
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
  // Reconciliación manual de la ventana completa. La corrida en sí vive en
  // lib/gestionPedidosSync.js, compartida con el cron incremental de server.js: sin
  // override se usa únicamente la ventana de fechas, porque el buscador de vendedor
  // devuelve el universo vigente sin depender de que cada estado documentado siga siendo
  // válido para la cuenta. Los overrides sirven para corridas acotadas y en pruebas.
  router.post('/importar', async (req, res) => {
    try {
      return res.json(await ejecutarImportacion(db, {
        woo,
        ml,
        desde: req.body?.desde || fechaHaceDias(30),
        hasta: req.body?.hasta || new Date().toISOString(),
        listarWoo: listarWooOverride,
        listarMl: listarMlOverride,
      }));
    } catch (error) {
      return res.status(502).json({ ok: false, error: 'No se pudo completar la importación', detalle: error.message });
    }
  });
  router.get('/:id', (req, res) => {
    const pedido = db.prepare(`SELECT p.*, c.nombre AS cliente_nombre, c.email AS cliente_email, c.telefono AS cliente_telefono
      FROM gestion_pedidos p JOIN gestion_pedido_clientes c ON c.id=p.cliente_id WHERE p.id=?`).get(req.params.id);
    if (!pedido) return res.status(404).json({ ok: false, error: 'Pedido no encontrado' });
    pedido.entrega = db.prepare('SELECT * FROM gestion_pedido_entregas WHERE pedido_id=?').get(pedido.id) || null;
    // La imagen se resuelve contra el catálogo por SKU en vez de copiarse al importar:
    // así una foto que se corrige en Woo aparece acá sin reimportar el pedido.
    // La imagen y el stock se resuelven contra el catálogo por SKU en vez de copiarse al
    // importar: así una foto corregida en Woo aparece sin reimportar el pedido. Se
    // consulta sólo si la tabla existe — es de otra herramienta, y el detalle del pedido
    // no puede caerse porque falte. Subconsultas y no JOIN: catalogo_cache puede tener
    // más de una fila por SKU (variaciones) y un JOIN duplicaría la línea.
    pedido.items = hayCatalogo()
      ? db.prepare(`SELECT i.*,
          COALESCE(i.imagen_url, (SELECT c.img FROM catalogo_cache c WHERE c.sku=i.sku AND c.img IS NOT NULL ORDER BY c.id_woo LIMIT 1)) AS imagen,
          (SELECT c.stock FROM catalogo_cache c WHERE c.sku=i.sku ORDER BY c.id_woo LIMIT 1) AS stock_actual
          FROM gestion_pedido_items i WHERE i.pedido_id=? ORDER BY i.id`).all(pedido.id)
      : db.prepare('SELECT i.*, i.imagen_url AS imagen, NULL AS stock_actual FROM gestion_pedido_items i WHERE i.pedido_id=? ORDER BY i.id').all(pedido.id);
    pedido.eventos = db.prepare('SELECT * FROM gestion_pedido_eventos WHERE pedido_id=? ORDER BY creado_en DESC, id DESC').all(pedido.id);
    // Pedido espejo vinculado: la fila que se ve es la de ML, pero el detalle muestra el
    // número de Woo con el que trabaja el depósito y su estado, marcados como dato de Woo.
    pedido.estado_envio_ml = pedido.ml_shipment_id && hayEnviosMl()
      ? db.prepare('SELECT status, logistic_type, actualizado_en FROM ml_shipment_estado WHERE shipment_id=?').get(String(pedido.ml_shipment_id)) || null
      : null;
    pedido.espejo_woo = pedido.fuente === 'mercadolibre'
      ? db.prepare(`SELECT id, numero_visible, external_id, estado_canal
          FROM gestion_pedidos WHERE fuente='woocommerce' AND ml_order_id=? LIMIT 1`).get(pedido.external_id) || null
      : null;
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
