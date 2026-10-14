// E-1b: SKUs conocidos de una orden Woo ANTES de que el trabajo `order.woo` haya cerrado alguna vez para ella.
// `woo_orden_skus` nace vacía en el deploy: si el primer aviso de una orden anterior es `deleted`/trash, sin una fuente alternativa
// no se encolaría ninguna bolsa y el stock de sus líneas quedaría sin liberar. Las fuentes locales ya existen: la cola de Preparación
// (`pedidos_cache.items_json`) y las preparaciones (`preparacion_items`).

const norm = (v) => String(v ?? '').trim();

function fuentes(db, filtroOrden) {
  const porOrden = new Map(); // wc_order_id (string) → Set de SKUs
  const agregar = (orderId, sku) => {
    const o = norm(orderId); const s = norm(sku);
    if (!o || !s) return;
    if (!porOrden.has(o)) porOrden.set(o, new Set());
    porOrden.get(o).add(s);
  };
  try {
    const filas = filtroOrden
      ? db.prepare("SELECT wc_order_id, items_json FROM pedidos_cache WHERE canal = 'web' AND wc_order_id = ?").all(Number(filtroOrden))
      : db.prepare("SELECT wc_order_id, items_json FROM pedidos_cache WHERE canal = 'web' AND wc_order_id IS NOT NULL").all();
    for (const f of filas) {
      try { for (const it of JSON.parse(f.items_json || '[]')) agregar(f.wc_order_id, it?.sku); } catch { /* fila ilegible */ }
    }
  } catch { /* sin tabla: no hay esta fuente */ }
  try {
    const filas = filtroOrden
      ? db.prepare("SELECT p.wc_order_id, i.sku FROM preparaciones p JOIN preparacion_items i ON i.preparacion_id = p.id WHERE p.canal = 'web' AND p.wc_order_id = ?").all(Number(filtroOrden))
      : db.prepare("SELECT p.wc_order_id, i.sku FROM preparaciones p JOIN preparacion_items i ON i.preparacion_id = p.id WHERE p.canal = 'web' AND p.wc_order_id IS NOT NULL").all();
    for (const f of filas) agregar(f.wc_order_id, f.sku);
  } catch { /* sin tabla: no hay esta fuente */ }
  return porOrden;
}

/** SKUs de una orden Woo según lo que ya guardó Preparación (cola y preparaciones). Vacío si no hay ninguna fuente. */
export function skusConocidosOrdenWoo(db, orderId) {
  return [...(fuentes(db, orderId).get(norm(orderId)) || [])];
}

/**
 * Siembra `woo_orden_skus` con los SKUs de las órdenes web que Preparación ya conoce. Idempotente y sin pisar nada: solo inserta
 * las órdenes que todavía no tienen fila (una fila escrita por un trabajo verificado manda siempre). Devuelve cuántas sembró.
 */
export function sembrarWooOrdenSkus(db) {
  let sembradas = 0;
  try {
    const ins = db.prepare('INSERT OR IGNORE INTO woo_orden_skus (order_id, skus_json, actualizado_en) VALUES (?, ?, ?)');
    const ts = new Date().toISOString();
    db.transaction(() => {
      for (const [orderId, skus] of fuentes(db, null)) sembradas += ins.run(orderId, JSON.stringify([...skus]), ts).changes;
    })();
  } catch (e) {
    console.error('[woo_orden_skus] siembra omitida:', e.message);
  }
  return sembradas;
}
