/**
 * Persistencia del modelo relacional de Gestión de pedidos.
 * Recibe órdenes ya obtenidas por los clientes de Woo/ML; no hace red ni cambia
 * pedidos_cache. La importación de cada fuente puede reintentarse sin duplicar.
 */

import { normalizarOrdenMl, normalizarPedidoWc } from './modelos/ordenVenta.js';
import { envioMlYaSalio } from './preparacion.js';

function ahora() {
  return new Date().toISOString();
}

function fuenteGestion(orden) {
  if (orden.canal === 'ml') return 'mercadolibre';
  if (orden.canal === 'web') return 'woocommerce';
  return orden.fuente || 'manual';
}

function nombreCliente(comprador = {}) {
  return [comprador.nombre, comprador.apellido].filter(Boolean).join(' ') || comprador.nickname || null;
}

function estadoComercial(orden) {
  const estado = String(orden.estado || '').toLowerCase();
  if (['cancelled', 'canceled', 'cancelado'].includes(estado)) return 'cancelado';
  if (['refunded', 'reembolsado'].includes(estado)) return 'reembolsado';
  if (['failed', 'fallido'].includes(estado)) return 'fallido';
  return 'confirmado';
}

// Estados del canal que significan un cierre confirmado (decisión del usuario, 2026-09-09).
// `paid` de ML NO entra: sólo dice que MercadoLibre cobró, no que la venta salió — saberlo
// exige importar el shipment, que está pendiente. Marcarlo cerrado escondería ventas sin
// despachar, que es exactamente lo que "Requieren atención" no puede dejar pasar.
const CIERRES_DEL_CANAL = (process.env.GESTION_PEDIDOS_ESTADOS_CERRADOS
  || 'enviadoandreani,retiradoenfusion,completed,serviceterminado')
  .split(',').map(x => x.trim().toLowerCase()).filter(Boolean);

// Estados operativos que son nuestros y no del canal: los fija la operación (mandar a
// preparar, despachar, retener) y una reimportación no puede pisarlos.
const ESTADOS_OPERATIVOS_LOCALES = ['en_preparacion', 'listo_para_despachar', 'despachado', 'enviado', 'retenido', 'requiere_atencion'];

function estadoOperativo(orden) {
  const estado = String(orden.estado || '').toLowerCase();
  if (['cancelled', 'canceled', 'cancelado', 'refunded', 'reembolsado', 'failed', 'fallido'].includes(estado)) return 'cerrado';
  if (CIERRES_DEL_CANAL.includes(estado)) return 'cerrado';
  return 'importado';
}

/**
 * Estado operativo a persistir, respetando lo que la operación ya decidió.
 *
 * El importador recalculaba el estado en cada corrida y lo escribía sin mirar el anterior.
 * Con el cron cada 10 minutos, un pedido mandado a preparación volvía solo a 'importado' y
 * reaparecía como pendiente. El canal sólo manda cuando informa un cierre: ahí sí gana,
 * porque una venta cancelada o ya entregada no puede seguir en preparación.
 */
/**
 * Estado del envío de una venta de ML, leído de `ml_shipment_estado`.
 *
 * El `status` de la orden de ML es de cobro: una venta despachada sigue diciendo 'paid', y
 * por eso "Requieren atención" mostraba ventas que ya habían salido. El estado logístico
 * vive en el shipment. Si no hay dato se devuelve null y el pedido sigue abierto: no saber
 * si salió nunca puede esconder una venta sin despachar.
 *
 * Devuelve {status, substatus} (no solo status): `status` por sí solo se queda en
 * 'ready_to_ship' para paquetes ya entregados en el punto de despacho -- ver
 * lib/preparacion.js#envioMlYaSalio, la única función que decide "ya salió".
 */
function estadoEnvioMl(db, shipmentId) {
  if (!shipmentId) return null;
  try {
    return db.prepare('SELECT status, substatus FROM ml_shipment_estado WHERE shipment_id=?').get(String(shipmentId)) || null;
  } catch { return null; } // instalaciones sin la tabla de envíos conservan el resto
}

function estadoOperativoAPersistir(orden, existente, envioMl) {
  const delCanal = estadoOperativo(orden);
  if (delCanal === 'cerrado') return 'cerrado';
  if (envioMlYaSalio(envioMl)) return 'cerrado';
  if (!existente) return delCanal;
  if (ESTADOS_OPERATIVOS_LOCALES.includes(existente.estado_operativo)) return existente.estado_operativo;
  return delCanal;
}

function externalId(orden) {
  return orden.canal === 'ml' ? String(orden.ml_order_id) : String(orden.wc_order_id);
}

function upsertCliente(db, comprador, timestamp) {
  const email = comprador?.email || null;
  const telefono = comprador?.telefono || null;
  // El correo interno de la tienda identifica al usuario que carga la venta,
  // no al cliente final. Nunca se debe usar para fusionar clientes distintos.
  const emailInterno = String(email || '').toLowerCase() === 'contacto@fusionbikes.com.ar';
  let cliente = email && !emailInterno
    ? db.prepare('SELECT id FROM gestion_pedido_clientes WHERE lower(email)=lower(?) ORDER BY id LIMIT 1').get(email)
    : null;
  if (!cliente && telefono) cliente = db.prepare('SELECT id FROM gestion_pedido_clientes WHERE telefono=? ORDER BY id LIMIT 1').get(telefono);
  if (cliente) {
    db.prepare(`UPDATE gestion_pedido_clientes SET nombre=COALESCE(?, nombre), email=COALESCE(?, email), telefono=COALESCE(?, telefono), actualizado_en=? WHERE id=?`)
      .run(nombreCliente(comprador), email, telefono, timestamp, cliente.id);
    return cliente.id;
  }
  return db.prepare(`INSERT INTO gestion_pedido_clientes (nombre, email, telefono, creado_en, actualizado_en) VALUES (?, ?, ?, ?, ?)`).run(
    nombreCliente(comprador), email, telefono, timestamp, timestamp,
  ).lastInsertRowid;
}

function upsertItems(db, pedidoId, items, timestamp) {
  db.prepare('DELETE FROM gestion_pedido_items WHERE pedido_id=?').run(pedidoId);
  const insert = db.prepare(`INSERT INTO gestion_pedido_items
    (pedido_id, producto_woo_id, sku, ean, nombre, imagen_url, cantidad, precio_unitario_centavos, creado_en, actualizado_en)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const item of items || []) {
    insert.run(pedidoId, item.product_id ?? null, item.sku || item.seller_sku || null, item.ean || null,
      item.nombre || 'Producto sin nombre', item.imagen_url || null, Number(item.cantidad || 1),
      item.unit_price == null ? null : Math.round(Number(item.unit_price) * 100), timestamp, timestamp);
  }
}

function centavos(valor) {
  if (valor == null || valor === '') return null;
  const n = Number(valor);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

/**
 * Persiste la entrega. Agregado el 2026-09-09: la tabla existía desde la migración 095 y
 * el importador nunca la escribía, así que los 706 pedidos importados no tenían tipo de
 * entrega ni domicilio — y sin tipo no se puede distinguir un retiro en local pendiente,
 * que es justo lo que "Requieren atención" tiene que mostrar.
 */
function upsertEntrega(db, pedidoId, entrega, timestamp) {
  if (!entrega || !entrega.tipo) return;
  db.prepare(`INSERT INTO gestion_pedido_entregas
    (pedido_id, tipo, transportista, tracking, nombre_receptor, direccion, ciudad, provincia, codigo_postal, actualizado_en)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(pedido_id) DO UPDATE SET
      tipo=excluded.tipo,
      transportista=COALESCE(excluded.transportista, gestion_pedido_entregas.transportista),
      -- El tracking puede haberlo cargado el embalado; una reimportación no debe borrarlo.
      tracking=COALESCE(excluded.tracking, gestion_pedido_entregas.tracking),
      nombre_receptor=COALESCE(excluded.nombre_receptor, gestion_pedido_entregas.nombre_receptor),
      direccion=COALESCE(excluded.direccion, gestion_pedido_entregas.direccion),
      ciudad=COALESCE(excluded.ciudad, gestion_pedido_entregas.ciudad),
      provincia=COALESCE(excluded.provincia, gestion_pedido_entregas.provincia),
      codigo_postal=COALESCE(excluded.codigo_postal, gestion_pedido_entregas.codigo_postal),
      actualizado_en=excluded.actualizado_en`)
    .run(pedidoId, entrega.tipo, entrega.transportista || null, entrega.tracking || null,
      entrega.nombre_receptor || null, entrega.direccion || null, entrega.ciudad || null,
      entrega.provincia || null, entrega.codigo_postal || null, timestamp);
}

/** Inserta o actualiza una orden normalizada y registra el evento de importación. */
export function upsertGestionPedido(db, orden, options = {}) {
  if (!orden || !orden.canal || !externalId(orden) || !orden.fecha) throw new Error('orden normalizada incompleta');
  // Conservamos el payload de ML completo para auditoría y para poder incorporar
  // nuevos campos sin tener que volver a consultar una orden histórica.
  if (orden.canal === 'ml') {
    const columns = db.prepare('PRAGMA table_info(gestion_pedidos)').all();
    if (!columns.some((column) => column.name === 'datos_ml_json')) {
      db.exec('ALTER TABLE gestion_pedidos ADD COLUMN datos_ml_json TEXT');
    }
  }
  const timestamp = options.timestamp || ahora();
  const fuente = fuenteGestion(orden);
  const idExterno = externalId(orden);
  const clienteId = upsertCliente(db, orden.comprador || {}, timestamp);
  const comercial = estadoComercial(orden);

  // El estado del canal se guarda crudo: es el que el operario reconoce ('enviadoandreani',
  // 'lpaandreani', 'completed'), y las clasificaciones propias son demasiado gruesas para
  // distinguir nada — 625 de 723 pedidos caían en la misma combinación.
  const estadoCanal = orden.estado ? String(orden.estado) : null;
  const espejo = orden.espejo_ml ? 1 : 0;
  // Sólo en el espejo: en una orden de ML `ml_order_id` es su propio id (y ya está en
  // `external_id`), mientras que acá la columna significa "la venta de ML que originó este
  // pedido de Woo". Guardarlo en ambos casos haría que una orden de ML se apuntara a sí
  // misma y el colapso del duplicado dejaría de leerse.
  const mlOrderId = espejo && orden.ml_order_id ? String(orden.ml_order_id) : null;
  const mlShipmentId = orden.ml_shipment_id ? String(orden.ml_shipment_id) : null;
  const t = orden.totales || {};
  const moneda = t.moneda || 'ARS';
  const subtotal = centavos(t.subtotal);
  const envio = centavos(t.envio);
  const total = centavos(t.total);
  const existente = db.prepare('SELECT id, estado_comercial, estado_operativo FROM gestion_pedidos WHERE fuente=? AND external_id=?').get(fuente, idExterno);
  const operativo = estadoOperativoAPersistir(orden, existente, estadoEnvioMl(db, mlShipmentId));
  let pedidoId;
  if (existente) {
    pedidoId = existente.id;
    db.prepare(`UPDATE gestion_pedidos SET cliente_id=?, numero_visible=?, estado_comercial=?, estado_operativo=?, estado_canal=?, espejo_ml=?, ml_order_id=?, ml_shipment_id=?, pago_estado=?, pago_metodo=?, cuotas=?, moneda=?, subtotal_centavos=?, envio_centavos=?, total_centavos=?, notas=?, cancelado_en=?, actualizado_en=? WHERE id=?`)
      .run(clienteId, orden.numero || idExterno, comercial, operativo, estadoCanal, espejo, mlOrderId, mlShipmentId, orden.pago_estado || null, orden.pago_metodo || null, orden.cuotas ?? null, moneda, subtotal, envio, total, orden.notas || null, comercial === 'cancelado' ? (orden.cancelado_en || timestamp) : null, timestamp, pedidoId);
  } else {
    pedidoId = db.prepare(`INSERT INTO gestion_pedidos
      (cliente_id, fuente, external_id, numero_visible, estado_comercial, estado_operativo, estado_canal, espejo_ml, ml_order_id, ml_shipment_id, pago_estado, pago_metodo, cuotas, moneda, subtotal_centavos, envio_centavos, total_centavos, notas, creado_fuente_en, cancelado_en, importado_en, actualizado_en)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(clienteId, fuente, idExterno, orden.numero || idExterno, comercial, operativo, estadoCanal, espejo, mlOrderId, mlShipmentId, orden.pago_estado || null, orden.pago_metodo || null, orden.cuotas ?? null, moneda, subtotal, envio, total, orden.notas || null, orden.fecha,
        comercial === 'cancelado' ? (orden.cancelado_en || timestamp) : null, timestamp, timestamp).lastInsertRowid;
  }
  upsertItems(db, pedidoId, orden.items, timestamp);
  upsertEntrega(db, pedidoId, orden.entrega, timestamp);
  if (orden.canal === 'ml' && orden._raw_ml) {
    db.prepare('UPDATE gestion_pedidos SET datos_ml_json=? WHERE id=?').run(JSON.stringify(orden._raw_ml), pedidoId);
  }
  const cambio = !existente || existente.estado_comercial !== comercial || existente.estado_operativo !== operativo;
  if (cambio) db.prepare(`INSERT INTO gestion_pedido_eventos (pedido_id, evento, estado_anterior, estado_nuevo, actor_tipo, datos_json, creado_en) VALUES (?, 'importado', ?, ?, 'sistema', ?, ?)`)
    .run(pedidoId, existente ? `${existente.estado_comercial}/${existente.estado_operativo}` : null, `${comercial}/${operativo}`, JSON.stringify({ fuente, external_id: idExterno }), timestamp);
  return { pedidoId, fuente, externalId: idExterno, created: !existente, changed: cambio };
}

/** Importa una tanda en una única transacción; repetirla es seguro. */
export function importarGestionPedidos(db, ordenes, options = {}) {
  const resultados = [];
  db.transaction(() => {
    for (const orden of ordenes || []) resultados.push(upsertGestionPedido(db, orden, options));
  })();
  return resultados;
}

async function paginar(desde, listarPagina, { porPagina = 100 } = {}) {
  const filas = [];
  for (let pagina = 1; ; pagina += 1) {
    const lote = await listarPagina({ desde, pagina, offset: (pagina - 1) * porPagina, limite: porPagina });
    if (!Array.isArray(lote)) throw new Error('el adaptador de pedidos debe devolver un array');
    filas.push(...lote);
    if (lote.length < porPagina) return filas;
  }
}

/**
 * Importa una ventana de ambas fuentes. Los adaptadores encapsulan la red y devuelven
 * órdenes crudas: esto permite usar Woo/ML reales en producción y dobles deterministas
 * en pruebas, sin acoplar el modelo relacional a los routers actuales.
 */
export async function importarVentanaGestionPedidos(db, { desde, hasta = new Date().toISOString(), listarWoo, listarMl, porPagina = 100 }) {
  if (!desde || typeof listarWoo !== 'function' || typeof listarMl !== 'function') throw new Error('ventana y adaptadores Woo/ML requeridos');
  const [woo, ml] = await Promise.all([
    paginar(desde, ({ pagina, limite }) => listarWoo({ desde, hasta, pagina, limite }), { porPagina }),
    paginar(desde, ({ offset, limite }) => listarMl({ desde, hasta, offset, limite }), { porPagina }),
  ]);
  const ordenes = [
    ...woo.map(normalizarPedidoWc),
    ...ml.map((raw) => Object.assign(normalizarOrdenMl(raw), { _raw_ml: raw })),
  ];
  return importarGestionPedidos(db, ordenes, { timestamp: new Date().toISOString() });
}
