// E-1a: orden ML pagada que llega por aviso tarde (fuera de la ventana) y nunca tuvo pedido en Woo.
// Decisión de José: NO se crea el pedido (la mercadería ya salió, un pedido nuevo dispararía mails/estados), pero SÍ se
// descuenta en Woo la cantidad vendida de cada línea, UNA sola vez por orden, y se AVISA (incidente crítico → mail + push).
//
// Idempotencia: `ordenes_ml_descuento_sin_pedido` (PK ml_order_id). La fila queda `parcial` mientras falten líneas y
// `completo` cuando todas terminaron; solo `completo` corta los reintentos. El estado por línea se persiste después de cada
// escritura para que un reintento nunca descuente dos veces la misma línea (desvío del "registrar solo al final": con varias
// líneas, reintentar desde cero duplicaría las ya escritas). Un fallo definitivo de la primera línea no deja ninguna fila.
import { conCandados, resolverBolsa, pathProducto } from './stockBarrera.js';
import { abrirOActualizarIncidente } from './incidentes.js';
import { wooFetch } from '../routes/woo.js';

const ahora = () => new Date().toISOString();
const TERMINALES = new Set(['descontada', 'omitida', 'ambigua']);

/** Líneas de la orden agrupadas por SKU (suma cantidades). Las sin SKU resoluble quedan aparte, sin descontar. */
export function lineasDeOrden(db, orden, vinculos) {
  const porSku = new Map();
  const sinSku = [];
  for (const it of orden?.order_items || []) {
    const clave = `${it?.item?.id}|${it?.item?.variation_id || ''}`;
    const sku = db.prepare(`SELECT sku FROM sku_matcher_decisiones WHERE clave = ? AND accion IN ${vinculos} AND sku IS NOT NULL AND sku <> ''`).get(clave)?.sku
      || db.prepare('SELECT seller_sku FROM ml_publicaciones_cache WHERE clave = ?').get(clave)?.seller_sku || null;
    const cantidad = Number(it?.quantity);
    const titulo = it?.item?.title || it?.item?.id || '?';
    if (!sku || !Number.isFinite(cantidad) || cantidad <= 0) { sinSku.push({ sku: null, item: it?.item?.id ?? null, nombre: titulo, cantidad: it?.quantity ?? null, estado: 'omitida', motivo: sku ? 'cantidad inválida' : 'sin SKU resoluble' }); continue; }
    const l = porSku.get(sku) || { sku, nombre: titulo, cantidad: 0, estado: 'pendiente' };
    l.cantidad += cantidad;
    porSku.set(sku, l);
  }
  return { lineas: [...porSku.values()], sinSku };
}

function producto(db, sku) {
  const c = db.prepare('SELECT id_woo, nombre, tipo, id_padre FROM catalogo_cache WHERE sku = ? LIMIT 1').get(sku);
  return c ? { product_id: c.tipo === 'variation' ? c.id_padre : c.id_woo, variation_id: c.tipo === 'variation' ? c.id_woo : 0, nombre: c.nombre } : null;
}

const guardar = (db, id, lineas, estado, { actor, origen }) => db.prepare(`INSERT INTO ordenes_ml_descuento_sin_pedido (ml_order_id, lineas_json, estado, actor, origen, creado_en, actualizado_en)
  VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(ml_order_id) DO UPDATE SET lineas_json = excluded.lineas_json, estado = excluded.estado, actualizado_en = excluded.actualizado_en`)
  .run(String(id), JSON.stringify(lineas), estado, actor, origen, ahora(), ahora());

/** Texto del aviso (mismo texto en mail y push: `mensaje_humano` del incidente). */
export function textoAviso(orden, lineas, { descontado, motivoNoDescuento = null, dias }) {
  const fecha = String(orden.date_created || '').slice(0, 10);
  const partes = [];
  const fmt = (l) => `${l.sku} – ${l.nombre} x${l.cantidad}: stock ${l.antes} → ${l.despues}${l.despues < 0 ? ' (QUEDÓ NEGATIVO)' : ''}`;
  const hechas = lineas.filter((l) => l.estado === 'descontada');
  if (hechas.length) partes.push(`Se descontó en la web: ${hechas.map(fmt).join('; ')}.`);
  const sinSku = lineas.filter((l) => l.estado === 'omitida' && !l.sku);
  if (sinSku.length) partes.push(`SIN SKU (no se descontó, revisar a mano): ${sinSku.map((l) => `${l.nombre} x${l.cantidad ?? '?'}`).join('; ')}.`);
  const omitidas = lineas.filter((l) => l.estado === 'omitida' && l.sku);
  if (omitidas.length) partes.push(`No se tocó (${omitidas.map((l) => `${l.sku}: ${l.motivo}`).join('; ')}).`);
  const ambiguas = lineas.filter((l) => l.estado === 'ambigua');
  if (ambiguas.length) partes.push(`AMBIGUAS (no se sabe si Woo aplicó el descuento, revisar a mano): ${ambiguas.map((l) => `${l.sku} x${l.cantidad}`).join('; ')}.`);
  const cab = descontado
    ? `Venta de MercadoLibre ${orden.id} del ${fecha} (tarde: llegó el aviso a más de ${dias} días). El pedido en la web NO se creó porque la venta es vieja y ya fue atendida; solo se ajustó el stock.`
    : `Venta de MercadoLibre ${orden.id} del ${fecha} (${orden.status}). ${motivoNoDescuento}`;
  return [cab, ...partes].join(' ');
}

/**
 * Descuenta en Woo la cantidad vendida de una orden ML vieja sin pedido (idempotente por orden) y avisa.
 * `deps`: { enriquecer(db, wooCfg, lineas) → completa manage_stock/stock_gestor_*, encolarBolsas(db, skus), vinculos, diasVentana }.
 * @returns {{estado:'descontada'|'ya_descontada'|'reintentar'|'no_aplica'|'simulado', lineas:object[], motivo?:string}}
 */
export async function descontarOrdenVieja(db, cfg, orden, deps, { dryRun = false, actor = 'sistema', origen = 'job' } = {}) {
  const id = String(orden.id);
  const previa = db.prepare('SELECT estado, lineas_json FROM ordenes_ml_descuento_sin_pedido WHERE ml_order_id = ?').get(id);
  if (previa?.estado === 'completo') return { estado: 'ya_descontada', lineas: JSON.parse(previa.lineas_json) };
  const dias = Math.round(deps.diasVentana);
  const { lineas: nuevas, sinSku } = lineasDeOrden(db, orden, deps.vinculos);

  // Orden pagada = única que se descuenta. Cancelada u otro estado: solo aviso (incidente), jamás stock.
  if (orden.status !== 'paid') {
    const motivo = `La orden está ${orden.status}: NO se descontó stock ni se creó pedido.`;
    if (!dryRun) abrirAviso(db, orden, [...nuevas, ...sinSku], { descontado: false, motivoNoDescuento: motivo, dias });
    return { estado: 'no_aplica', motivo, lineas: [...nuevas, ...sinSku] };
  }

  // Estado previo por línea (reintento tras fallo parcial) + líneas nuevas.
  const prev = new Map((previa ? JSON.parse(previa.lineas_json) : []).filter((l) => l.sku).map((l) => [l.sku, l]));
  const lineas = nuevas.map((l) => prev.get(l.sku) ? { ...prev.get(l.sku), cantidad: l.cantidad } : l);
  const cfgFila = { actor, origen };
  const wooCfg = cfg.woo;

  const procesar = async (candado) => {
    for (const l of lineas) {
      if (TERMINALES.has(l.estado)) continue;
      const p = producto(db, l.sku);
      if (!p) { Object.assign(l, { estado: 'omitida', motivo: 'SKU sin producto en el catálogo' }); if (!dryRun) guardar(db, id, [...lineas, ...sinSku], 'parcial', cfgFila); continue; }
      l.nombre = p.nombre || l.nombre;
      const enr = { product_id: p.product_id, variation_id: p.variation_id };
      await deps.enriquecer(db, wooCfg, [enr]);
      if (enr.manage_stock === 'desconocido') return { reintentar: `no se pudo leer manage_stock de ${l.sku}` };
      if (enr.manage_stock === 'false' || !enr.stock_gestor_id) { Object.assign(l, { estado: 'omitida', motivo: 'no gestiona stock (manage_stock=false)' }); if (!dryRun) guardar(db, id, [...lineas, ...sinSku], 'parcial', cfgFila); continue; }
      const path = pathProducto(enr.stock_gestor_padre, enr.stock_gestor_id);
      let actual;
      try { actual = (await wooFetch(wooCfg, path))?.data?.stock_quantity; } catch (e) { return { reintentar: `no se pudo leer el stock de ${l.sku}: ${e.message}` }; }
      if (actual === null || actual === undefined || !Number.isFinite(Number(actual))) { Object.assign(l, { estado: 'omitida', motivo: 'Woo no devuelve stock_quantity (sin gestión de stock)' }); if (!dryRun) guardar(db, id, [...lineas, ...sinSku], 'parcial', cfgFila); continue; }
      actual = Number(actual);
      if (l.estado === 'incierta') { // un intento anterior no confirmó: se decide por el stock actual, nunca se descuenta a ciegas
        if (actual === l.despues) { l.estado = 'descontada'; delete l.intento; guardar(db, id, [...lineas, ...sinSku], 'parcial', cfgFila); continue; }
        if (actual !== l.antes) { Object.assign(l, { estado: 'ambigua', motivo: `Woo cambió de ${l.antes} a ${actual} tras un intento sin confirmar` }); guardar(db, id, [...lineas, ...sinSku], 'parcial', cfgFila); continue; }
      }
      const nuevo = actual - l.cantidad;
      l.gestor_id = enr.stock_gestor_id; l.gestor_padre = enr.stock_gestor_padre ?? null;
      if (dryRun) { Object.assign(l, { antes: actual, despues: nuevo, estado: 'simulada' }); continue; }
      Object.assign(l, { antes: actual, despues: nuevo });
      try {
        await wooFetch(wooCfg, path, 'put', { stock_quantity: nuevo });
      } catch (e) {
        if (e?.status == null) { l.estado = 'incierta'; guardar(db, id, [...lineas, ...sinSku], 'parcial', cfgFila); } // red/timeout: puede haberse aplicado
        return { reintentar: `Woo no aceptó el descuento de ${l.sku}: ${e.message}` };
      }
      l.estado = 'descontada';
      guardar(db, id, [...lineas, ...sinSku], 'parcial', cfgFila);
    }
    return { ok: true };
  };

  let r;
  if (dryRun) r = await procesar(null);
  else {
    const skus = lineas.map((l) => l.sku);
    let bolsa = { skus };
    try { bolsa = resolverBolsa(db, { skus }); } catch { /* se bloquean los propios SKUs */ }
    const c = await conCandados(db, [...new Set([...bolsa.skus, ...skus])], procesar);
    if (c.ocupado) return { estado: 'reintentar', motivo: 'candados de stock ocupados', lineas: [...lineas, ...sinSku] };
    r = c.valor;
  }
  const todas = [...lineas, ...sinSku];
  if (dryRun) return { estado: 'simulado', lineas: todas, motivo: r.reintentar };
  if (r.reintentar) return { estado: 'reintentar', motivo: r.reintentar, lineas: todas };

  guardar(db, id, todas, 'completo', cfgFila);
  deps.encolarBolsas(db, lineas.filter((l) => l.estado === 'descontada').map((l) => l.sku));
  abrirAviso(db, orden, todas, { descontado: true, dias });
  return { estado: 'descontada', lineas: todas };
}

/** Incidente crítico por orden (dedupe del incidente = un solo aviso; no se reabre porque la orden queda `completo`). */
function abrirAviso(db, orden, lineas, { descontado, motivoNoDescuento, dias }) {
  const texto = textoAviso(orden, lineas, { descontado, motivoNoDescuento, dias });
  abrirOActualizarIncidente(db, {
    integracion: 'mercadolibre', proceso: 'orden_ml_tardia', tipoError: `orden_ml_vieja_sin_pedido_${orden.id}`.slice(0, 120), severidad: 'critico',
    mensajeTecnico: texto,
    mensajeHumano: texto,
    contexto: { ml_order_id: String(orden.id), fecha: orden.date_created, estado: orden.status, descontado, lineas },
  });
}
