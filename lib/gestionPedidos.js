/**
 * Persistencia del modelo relacional de Gestión de pedidos.
 * Recibe órdenes ya obtenidas por los clientes de Woo/ML; no hace red ni cambia
 * pedidos_cache. La importación de cada fuente puede reintentarse sin duplicar.
 */

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

function estadoOperativo(orden) {
  const estado = String(orden.estado || '').toLowerCase();
  if (['cancelled', 'canceled', 'cancelado', 'refunded', 'reembolsado', 'failed', 'fallido'].includes(estado)) return 'cerrado';
  return 'importado';
}

function externalId(orden) {
  return orden.canal === 'ml' ? String(orden.ml_order_id) : String(orden.wc_order_id);
}

function upsertCliente(db, comprador, timestamp) {
  const email = comprador?.email || null;
  const telefono = comprador?.telefono || null;
  let cliente = email
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

/** Inserta o actualiza una orden normalizada y registra el evento de importación. */
export function upsertGestionPedido(db, orden, options = {}) {
  if (!orden || !orden.canal || !externalId(orden) || !orden.fecha) throw new Error('orden normalizada incompleta');
  const timestamp = options.timestamp || ahora();
  const fuente = fuenteGestion(orden);
  const idExterno = externalId(orden);
  const clienteId = upsertCliente(db, orden.comprador || {}, timestamp);
  const comercial = estadoComercial(orden);
  const operativo = estadoOperativo(orden);
  const existente = db.prepare('SELECT id, estado_comercial, estado_operativo FROM gestion_pedidos WHERE fuente=? AND external_id=?').get(fuente, idExterno);
  let pedidoId;
  if (existente) {
    pedidoId = existente.id;
    db.prepare(`UPDATE gestion_pedidos SET cliente_id=?, numero_visible=?, estado_comercial=?, estado_operativo=?, notas=?, cancelado_en=?, actualizado_en=? WHERE id=?`)
      .run(clienteId, orden.numero || idExterno, comercial, operativo, orden.notas || null, comercial === 'cancelado' ? (orden.cancelado_en || timestamp) : null, timestamp, pedidoId);
  } else {
    pedidoId = db.prepare(`INSERT INTO gestion_pedidos
      (cliente_id, fuente, external_id, numero_visible, estado_comercial, estado_operativo, notas, creado_fuente_en, cancelado_en, importado_en, actualizado_en)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(clienteId, fuente, idExterno, orden.numero || idExterno, comercial, operativo, orden.notas || null, orden.fecha,
        comercial === 'cancelado' ? (orden.cancelado_en || timestamp) : null, timestamp, timestamp).lastInsertRowid;
  }
  upsertItems(db, pedidoId, orden.items, timestamp);
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
