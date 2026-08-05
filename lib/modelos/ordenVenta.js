/**
 * Modelo canónico de una orden de venta (WooCommerce o MercadoLibre).
 * Funciones puras: no tocan DB ni red. No confundir con los pedidos de compra
 * a proveedores (routes/pedidos.js, routes/recepciones.js) — dominio distinto.
 */

import { armarClaveMl, normVariationId } from '../mlUtil.js';

/**
 * @typedef {Object} ItemOrdenVenta
 * @property {?number} line_item_id     Solo WC
 * @property {?number} product_id       id_woo del line_item (WC), null en ML
 * @property {?number} variation_id_wc  Solo WC
 * @property {string} item_id_ml        '' si el origen es WC
 * @property {string} variation_id_ml   '' si no aplica
 * @property {string} clave             "itemId|variationId" ('' si el origen es WC)
 * @property {string} sku               '' — solo viene poblado en pedidos WC (line_items ya tienen sku)
 * @property {string} seller_sku        SKU declarado por el vendedor en ML ('' en WC)
 * @property {string} nombre
 * @property {number} cantidad
 * @property {?number} unit_price  Precio real por unidad pagado en la venta (solo ML; null en WC)
 */
/**
 * @typedef {Object} CompradorOrdenVenta
 * @property {string} nombre, apellido, nickname, email, telefono
 */
/**
 * @typedef {Object} OrdenVenta
 * @property {'ml'|'web'} canal
 * @property {?string} ml_order_id
 * @property {?number} wc_order_id
 * @property {string} numero    order.number ?? id (WC) / id (ML)
 * @property {string} fecha     date_created
 * @property {string} estado
 * @property {boolean} espejo_ml  WC con meta _ml_order_id (pedido creado por el sync desde una orden ML)
 * @property {CompradorOrdenVenta} comprador
 * @property {ItemOrdenVenta[]} items
 */

/** Orden ML cruda (de /orders/search o /orders/{id}) → OrdenVenta. Sin resolver contra DB. */
export function normalizarOrdenMl(orden) {
  const buyer = orden.buyer ?? {};
  const items = (orden.order_items || []).map(oi => {
    const itemId = String(oi.item?.id || '');
    const variationId = normVariationId(oi.item?.variation_id);
    return {
      line_item_id: null,
      product_id: null,
      variation_id_wc: null,
      item_id_ml: itemId,
      variation_id_ml: variationId,
      clave: armarClaveMl(itemId, variationId),
      sku: '',
      seller_sku: oi.item?.seller_sku || '',
      nombre: oi.item?.title || '',
      cantidad: oi.quantity || 1,
      // Precio real por unidad de la venta ML (ML lo expone a nivel order_item,
      // no dentro de item). Dato INFORMATIVO únicamente (se registra en meta_data del
      // pedido WC) — desde 2026-08-03 el precio de línea del pedido WC es el precio de
      // CONTADO del catálogo propio (precioContado() en lib/mlPrecios.js), no este valor.
      unit_price: oi.unit_price ?? null,
    };
  });
  return {
    canal: 'ml',
    ml_order_id: String(orden.id),
    wc_order_id: null,
    numero: String(orden.id),
    fecha: orden.date_created,
    estado: orden.status || '',
    espejo_ml: false,
    comprador: {
      nombre: buyer.first_name || '',
      apellido: buyer.last_name || '',
      nickname: buyer.nickname || '',
      email: buyer.email || '',
      telefono: buyer.phone?.number || '',
    },
    items,
  };
}

/** Pedido WC crudo (de /orders o /orders/{id}) → OrdenVenta. */
export function normalizarPedidoWc(order) {
  const espejoMl = (order.meta_data || []).some(m => m.key === '_ml_order_id');
  const items = (order.line_items || []).map(li => ({
    line_item_id: li.id,
    product_id: li.product_id,
    variation_id_wc: li.variation_id || null,
    item_id_ml: '',
    variation_id_ml: '',
    clave: '',
    sku: li.sku || '',
    seller_sku: '',
    nombre: li.name,
    cantidad: li.quantity,
  }));
  return {
    canal: 'web',
    ml_order_id: null,
    wc_order_id: order.id,
    numero: String(order.number || order.id),
    fecha: order.date_created,
    estado: order.status,
    espejo_ml: espejoMl,
    comprador: {
      nombre: order.billing?.first_name || '',
      apellido: order.billing?.last_name || '',
      nickname: '',
      email: order.billing?.email || '',
      telefono: order.billing?.phone || '',
    },
    items,
  };
}

/**
 * Arma el objeto `billing` para la orden de WC con lo que ML deje visible del comprador.
 * ML restringe PII por política de privacidad — normalmente solo vienen nickname/id;
 * nombre, apellido, email o teléfono reales rara vez están disponibles vía API.
 */
export function billingWcDesdeOrdenMl(orden) {
  const buyer = orden.buyer ?? {};
  const first = buyer.first_name || buyer.nickname || 'Comprador';
  const last = buyer.last_name || 'MercadoLibre';
  const billing = { first_name: first, last_name: last };
  if (buyer.email) billing.email = buyer.email;
  if (buyer.phone?.number) billing.phone = buyer.phone.number;
  return billing;
}
