/**
 * Devolución post-entrega: ML cancela una venta que ya se despachó o entregó (un retorno).
 * Cancelar el pedido Woo repondría el stock de una unidad que todavía no volvió al depósito, así que en ese caso:
 *  - NO se cancela el pedido Woo ni se encolan bolsas; solo una nota privada y una devolución por SKU en `stock_incidents`;
 *  - el depósito la recibe y la clasifica (pantalla Excepciones); recién entonces el trabajo `devolucion.cierre` cancela el
 *    pedido (Woo repone) y, si está dañada, descuenta la misma cantidad;
 *  - a los 15 días sin recepción se abre un incidente operativo (el stock no se toca).
 * Las dependencias (ML, Woo, cancelación, stock) se inyectan: sync.js pasa las reales y los tests las simulan.
 */
import { abrirOActualizarIncidente } from './incidentes.js';

const ahora = () => new Date().toISOString();
export const ESTADOS_ENVIO_POST_ENTREGA = new Set(['shipped', 'delivered', 'not_delivered']);
// Estados de envío ML conocidos como ANTERIORES al despacho. Cualquier otro valor que no sea post-entrega es información insuficiente.
export const ESTADOS_ENVIO_ANTES_DESPACHO = new Set(['pending', 'handling', 'ready_to_ship', 'to_be_agreed', 'cancelled']);
export const DIAS_SIN_LLEGAR = 15;
export const TIPO_TRABAJO_CIERRE = 'devolucion.cierre';
const NOTA_PRIVADA = 'MercadoLibre canceló esta venta cuando el envío ya estaba despachado o entregado (devolución). '
  + 'El pedido NO se cancela ahora: el stock se repone cuando el depósito reciba la unidad y la clasifique (Excepciones › Devoluciones de clientes).';

/**
 * 'post_entrega' si el envío de la orden ya salió (shipped/delivered/not_delivered); 'antes_despacho' en cualquier otro caso
 * o si la orden no tiene envío. FAIL-CLOSED: si no se puede leer la orden o el envío, lanza (nunca se repone a ciegas).
 */
export async function estadoEnvioDeOrden(db, mlCfg, orden, { mlFetch }) {
  let shipping = orden.shipping;
  if (shipping === undefined) { // el listado del barrido puede no traer el envío: se relee la orden
    const r = await mlFetch(db, mlCfg, 'get', `/orders/${orden.id}`);
    if (r.status !== 200 || !r.data) throw new Error(`ML respondió ${r.status} al consultar /orders/${orden.id}`);
    shipping = r.data.shipping;
  }
  const sid = shipping?.id;
  if (!sid) return 'antes_despacho';
  const r = await mlFetch(db, mlCfg, 'get', `/shipments/${sid}`, null, { headers: { 'x-format-new': 'true' } });
  if (r.status !== 200 || !r.data) throw new Error(`ML respondió ${r.status} al consultar /shipments/${sid}`);
  const st = String(r.data.status ?? '');
  if (ESTADOS_ENVIO_POST_ENTREGA.has(st)) return 'post_entrega';
  if (ESTADOS_ENVIO_ANTES_DESPACHO.has(st)) return 'antes_despacho';
  throw new Error(`ML devolvió un status de envío ${st ? `desconocido (${st})` : 'vacío'} en /shipments/${sid}: no se decide a ciegas`);
}

/** Agrega la nota privada una sola vez (se reclama la marca antes de postear; si falla se libera para reintentar). */
async function asegurarNota(db, wooCfg, mlOrderId, wcOrderId, { wooFetch }) {
  const claim = db.prepare("UPDATE ordenes_ml_wc_pedidos SET devolucion_nota_en = 'en_curso' WHERE ml_order_id = ? AND devolucion_nota_en IS NULL").run(mlOrderId);
  if (!claim.changes) return;
  try {
    await wooFetch(wooCfg, `/orders/${wcOrderId}/notes`, 'post', { note: NOTA_PRIVADA, customer_note: false });
    db.prepare('UPDATE ordenes_ml_wc_pedidos SET devolucion_nota_en = ? WHERE ml_order_id = ?').run(ahora(), mlOrderId);
  } catch {
    db.prepare('UPDATE ordenes_ml_wc_pedidos SET devolucion_nota_en = NULL WHERE ml_order_id = ?').run(mlOrderId); // fail-open: se reintenta
  }
}

function registrarDevolucion(db, mlOrderId, wcOrderId, lineas) {
  const ts = ahora();
  return db.transaction(() => {
    const reg = db.prepare('SELECT cancelado_en, devolucion_pendiente FROM ordenes_ml_wc_pedidos WHERE ml_order_id = ?').get(mlOrderId);
    if (!reg || reg.cancelado_en || reg.devolucion_pendiente) return false; // otro camino ya la registró
    const ins = db.prepare(`INSERT OR IGNORE INTO stock_incidents
      (tipo, severidad, sku, cantidad, motivo, creado_por, creado_en, operation_id, origen, ml_order_id, wc_order_id)
      VALUES ('otro', 'normal', ?, ?, ?, 'sistema', ?, ?, 'devolucion_cliente', ?, ?)`);
    const audit = db.prepare(`INSERT INTO stock_exception_events (entidad, entidad_id, evento, actor, antes_json, despues_json, motivo, operation_id, creado_en)
      VALUES ('incidente', ?, 'creado', 'sistema', NULL, ?, ?, ?, ?)`);
    for (const [sku, cantidad] of lineas) {
      const motivo = `Devolución de cliente: ML canceló la venta ${mlOrderId} con el envío ya despachado/entregado (pedido Woo ${wcOrderId})`;
      const op = `devolucion-ml:${mlOrderId}:${sku}`;
      const r = ins.run(sku, cantidad, motivo, ts, op, mlOrderId, wcOrderId);
      if (r.changes) audit.run(r.lastInsertRowid, JSON.stringify({ sku, cantidad, ml_order_id: mlOrderId }), motivo, `audit:${op}`, ts);
    }
    db.prepare('UPDATE ordenes_ml_wc_pedidos SET devolucion_pendiente = ? WHERE ml_order_id = ?').run(ts, mlOrderId);
    return true;
  })();
}

/**
 * Reemplaza a `cancelarPedidoWooDeOrden` en los dos caminos de cancelación (barrido y puntual).
 * Sin devolución → delega en `cancelar` (comportamiento de siempre). Post-entrega → registra la devolución y devuelve
 * `{ estado: 'devolucion_post_entrega', skus: [] }` (sin SKUs: no hay stock que refrescar). Lanza si el envío no se pudo leer.
 */
export async function tratarCancelacionMl(db, cfg, orden, deps) {
  const mlOrderId = String(orden.id);
  const reg = db.prepare('SELECT wc_order_id, cancelado_en, devolucion_pendiente FROM ordenes_ml_wc_pedidos WHERE ml_order_id = ?').get(mlOrderId);
  if (!reg || reg.cancelado_en || reg.wc_order_id === 0) return deps.cancelar(db, cfg.woo, mlOrderId);
  if (reg.devolucion_pendiente) {
    await asegurarNota(db, cfg.woo, mlOrderId, reg.wc_order_id, deps);
    return { estado: 'devolucion_post_entrega', skus: [] };
  }
  if (await estadoEnvioDeOrden(db, cfg.ml, orden, deps) !== 'post_entrega') {
    // Carrera: el otro camino pudo registrar la devolución mientras se leía el envío. Releer (sincrónico) antes de cancelar.
    const ahoraReg = db.prepare('SELECT devolucion_pendiente FROM ordenes_ml_wc_pedidos WHERE ml_order_id = ?').get(mlOrderId);
    if (ahoraReg?.devolucion_pendiente) return { estado: 'devolucion_post_entrega', skus: [] };
    return deps.cancelar(db, cfg.woo, mlOrderId);
  }

  const pedido = (await deps.wooFetch(cfg.woo, `/orders/${reg.wc_order_id}`))?.data;
  if (!Array.isArray(pedido?.line_items)) throw new Error(`Woo no devolvió las líneas del pedido ${reg.wc_order_id}`);
  const lineas = new Map();
  let invalidas = 0;
  for (const l of pedido.line_items) {
    const cant = Number(l.quantity);
    if (l.sku && Number.isInteger(cant) && cant > 0) lineas.set(l.sku, (lineas.get(l.sku) || 0) + cant);
    else invalidas++;
  }
  if (invalidas || !lineas.size) {
    // Una devolución parcial cancelaría el pedido entero al cerrar y Woo repondría también las líneas omitidas: nada se registra
    // ni se cancela; se marca la orden (el barrido no la reprocesa) y queda un incidente para resolverla a mano.
    const marcada = db.prepare(`UPDATE ordenes_ml_wc_pedidos SET devolucion_pendiente = ?, devolucion_nota_en = 'revision_manual'
      WHERE ml_order_id = ? AND devolucion_pendiente IS NULL AND cancelado_en IS NULL`).run(ahora(), mlOrderId);
    if (marcada.changes) {
      abrirOActualizarIncidente(db, {
        integracion: 'mercadolibre', proceso: 'devoluciones_post_entrega', tipoError: `lineas_invalidas_${mlOrderId}`, severidad: 'critico',
        mensajeTecnico: `orden ML ${mlOrderId} / pedido Woo ${reg.wc_order_id}: ${invalidas} línea(s) sin SKU o con cantidad inválida`,
        mensajeHumano: `ML canceló la venta ${mlOrderId} ya despachada, pero el pedido Woo ${reg.wc_order_id} tiene líneas sin SKU o con cantidad inválida. No se canceló nada ni se registró la devolución: manejala a mano (el stock no se tocó).`,
        contexto: { ml_order_id: mlOrderId, wc_order_id: reg.wc_order_id },
      });
    }
    return { estado: 'devolucion_post_entrega', skus: [] };
  }
  registrarDevolucion(db, mlOrderId, reg.wc_order_id, lineas);
  await asegurarNota(db, cfg.woo, mlOrderId, reg.wc_order_id, deps);
  return { estado: 'devolucion_post_entrega', skus: [] };
}

/**
 * Trabajo `devolucion.cierre` (recurso = ml_order_id). Cuando TODAS las devoluciones de la orden están recibidas y clasificadas:
 * cancela el pedido Woo (Woo repone el stock) y descuenta lo no disponible. Idempotente y con reintento; no da nada por hecho
 * hasta que Woo confirmó. Devuelve { estado: 'hecho', skus } | { estado: 'reencolar', motivo }.
 */
export async function cerrarDevolucionEnWoo(db, cfg, mlOrderId, deps) {
  const filas = db.prepare("SELECT * FROM stock_incidents WHERE origen = 'devolucion_cliente' AND ml_order_id = ? AND estado = 'abierto' ORDER BY id").all(String(mlOrderId));
  if (!filas.length) return { estado: 'hecho', skus: [] };
  if (filas.some((f) => !f.recibido_en || !f.clasificacion)) return { estado: 'hecho', skus: [], espera: true };
  const ids = filas.map((f) => f.id);
  const marcar = (estado, error) => {
    for (const id of ids) db.prepare('UPDATE stock_incidents SET woo_cierre_estado = ?, woo_cierre_error = ? WHERE id = ?').run(estado, error, id);
  };
  try {
    // Dañada: ANTES de cancelar se persiste (una sola vez) el stock vivo; después de cancelar se escribe ese valor ABSOLUTO.
    // Un reintento (aunque el proceso haya caído entre el PUT y la marca) vuelve a escribir el mismo valor: sin doble descuento.
    for (const f of filas) {
      if (f.clasificacion === 'disponible' || f.stock_antes != null) continue;
      const vivo = await deps.getStock(cfg.woo, db, f.sku);
      if (vivo == null) throw new Error(`No pude leer el stock de ${f.sku} para descontar la unidad dañada`);
      db.prepare('UPDATE stock_incidents SET stock_antes = ? WHERE id = ? AND stock_antes IS NULL').run(vivo, f.id);
      f.stock_antes = vivo;
    }
    const c = await deps.cancelar(db, cfg.woo, String(mlOrderId));
    if (c.estado === 'reserva_en_curso') throw new Error('reserva en curso');
    for (const f of filas) {
      if (f.clasificacion === 'disponible' || f.descuento_woo_en) continue;
      await deps.setStock(cfg.woo, db, f.sku, f.stock_antes);
      db.prepare('UPDATE stock_incidents SET descuento_woo_en = ? WHERE id = ?').run(ahora(), f.id);
    }
    const ts = ahora();
    db.transaction(() => {
      for (const f of filas) {
        db.prepare(`UPDATE stock_incidents SET estado = 'resuelto', resuelto_por = 'sistema', resuelto_en = ?, resolucion = ?,
          woo_cierre_estado = 'hecho', woo_cierre_error = NULL, expected_version = expected_version + 1 WHERE id = ?`)
          .run(ts, f.clasificacion === 'disponible' ? 'Pedido Woo cancelado: stock repuesto' : 'Pedido Woo cancelado y unidad descontada (no vendible)', f.id);
      }
    })();
    return { estado: 'hecho', skus: [...new Set(filas.map((f) => f.sku))] };
  } catch (e) {
    const motivo = String(e.message).slice(0, 200);
    marcar('error', motivo);
    return { estado: 'reencolar', motivo };
  }
}

/** Barrido diario: devoluciones sin recepción tras `dias` días → un incidente operativo por devolución (una vez). No toca stock. */
export function avisarDevolucionesSinLlegar(db, { dias = DIAS_SIN_LLEGAR, ahoraMs = Date.now() } = {}) {
  const corte = new Date(ahoraMs - dias * 86400000).toISOString();
  const filas = db.prepare(`SELECT * FROM stock_incidents WHERE origen = 'devolucion_cliente' AND estado = 'abierto'
    AND recibido_en IS NULL AND aviso_sin_llegar_en IS NULL AND creado_en <= ?`).all(corte);
  let avisadas = 0;
  for (const f of filas) {
    abrirOActualizarIncidente(db, {
      integracion: 'mercadolibre', proceso: 'devoluciones_post_entrega', tipoError: `sin_llegar_${f.id}`, severidad: 'advertencia',
      mensajeTecnico: `devolución ${f.id} (${f.sku} x${f.cantidad}) de la orden ML ${f.ml_order_id} sin recepción desde ${f.creado_en}`,
      mensajeHumano: `La devolución de ${f.sku} (x${f.cantidad}, orden ML ${f.ml_order_id}) no llegó al depósito en ${dias} días. Revisá el reclamo en MercadoLibre; el stock no se tocó.`,
      contexto: { incident_id: f.id, ml_order_id: f.ml_order_id, sku: f.sku },
    });
    db.prepare('UPDATE stock_incidents SET aviso_sin_llegar_en = ? WHERE id = ?').run(ahora(), f.id);
    avisadas++;
  }
  return { avisadas };
}
