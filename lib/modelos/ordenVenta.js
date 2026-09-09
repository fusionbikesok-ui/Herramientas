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
    // `pack_id` es el número que ML le MUESTRA al vendedor en su panel cuando la compra
    // agrupa varios ítems, y no coincide con el `id` de la orden: medido sobre las 50 ventas
    // más recientes (2026-08-18), 37 tienen un pack distinto del order id. O sea que 3 de
    // cada 4 veces el número que el operario lee en ML no es el que la herramienta guardaba,
    // y buscarlo acá no encontraba nada — el caso real que lo destapó fue la venta que ML
    // muestra como 2000014544268249 y acá vivía como 2000017948004320.
    pack_id: orden.pack_id ? String(orden.pack_id) : null,
    numero: String(orden.id),
    fecha: orden.date_created,
    estado: orden.status || '',
    pago_estado: orden.payments?.[0]?.status || null,
    pago_metodo: orden.payments?.[0]?.payment_type || orden.payments?.[0]?.payment_method_id || null,
    cuotas: Number.isInteger(Number(orden.payments?.[0]?.installments)) ? Number(orden.payments[0].installments) : null,
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
  const meta = new Map((order.meta_data || []).map(item => [String(item.key), item.value]));
  const cuotasCrudas = meta.get('installments') ?? meta.get('_installments') ?? meta.get('cuotas') ?? meta.get('_cuotas');
  const cuotas = cuotasCrudas != null && /^\d+$/.test(String(cuotasCrudas)) ? Number(cuotasCrudas) : null;
  return {
    canal: 'web',
    ml_order_id: null,
    wc_order_id: order.id,
    numero: String(order.number || order.id),
    fecha: order.date_created,
    estado: order.status,
    pago_estado: order.date_paid ? 'paid' : null,
    pago_metodo: order.payment_method || meta.get('payment_method') || meta.get('_payment_method') || null,
    cuotas,
    espejo_ml: espejoMl,
    notas: order.customer_note || '',
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
 *
 * `shipping` (opcional) es el objeto ya normalizado que arma routes/sync.js con los datos
 * del envío ML (`/shipments/{id}`). Si viene, la facturación se REPLICA del envío: las
 * facturas de esta venta ML se emiten por otro medio (no por Woo), así que la dirección de
 * facturación acá no tiene consecuencia fiscal y es más útil con los datos reales del
 * destinatario que con el nickname de ML (que igual queda registrado en la nota privada y
 * en la meta `_ml_order_id`). Si no hay `shipping` (fail-open de la consulta a ML, orden sin
 * envío, o envío sin nombre/calle), se mantiene el comportamiento anterior: nickname +
 * 'MercadoLibre', para no dejar la facturación vacía ni romper la creación del pedido.
 *
 * Nombre vacío en el envío (hallazgo del revisor, 2026-08-05): `routes/sync.js` arma
 * `shipping` si hay receiver_name **O** street_name — puede haber calle sin nombre. En ese
 * caso `shipping.first_name`/`last_name` llegan `''`. Ahí SOLO en `billing` (nunca en
 * `shipping`, que debe reflejar fielmente lo que dijo ML) se cae al fallback de
 * nickname/'Comprador' + 'MercadoLibre' para el nombre, manteniendo la dirección real del
 * envío — si no, Woo titula el pedido "Pedido #123 de " sin nadie.
 */
export function billingWcDesdeOrdenMl(orden, shipping) {
  const buyer = orden.buyer ?? {};
  const billing = shipping
    ? {
        first_name: shipping.first_name || buyer.first_name || buyer.nickname || 'Comprador',
        last_name: shipping.last_name || buyer.last_name || 'MercadoLibre',
        address_1: shipping.address_1,
        address_2: shipping.address_2,
        city: shipping.city,
        state: shipping.state,
        postcode: shipping.postcode,
        country: shipping.country,
      }
    : { first_name: buyer.first_name || buyer.nickname || 'Comprador', last_name: buyer.last_name || 'MercadoLibre' };
  // email/phone: hoy ML nunca los devuelve, pero si algún día aparecieran no hay que
  // perderlos — Woo usa el email de facturación para las notificaciones del pedido.
  if (buyer.email) billing.email = buyer.email;
  if (buyer.phone?.number) billing.phone = buyer.phone.number;
  return billing;
}
