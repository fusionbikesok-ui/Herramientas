// E-1a: orden ML pagada que llega por aviso tarde (fuera de la ventana) y nunca tuvo pedido en Woo.
// Decisión de José: NO se crea el pedido (la mercadería ya salió, un pedido nuevo dispararía mails/estados), pero SÍ se
// descuenta en Woo la cantidad vendida de cada línea, UNA sola vez por orden, y se AVISA (incidente crítico → mail + push).
//
// Idempotencia: `ordenes_ml_descuento_sin_pedido` (PK ml_order_id). La fila queda `parcial` mientras falten líneas y
// `completo` cuando todas terminaron; solo `completo` corta los reintentos. El estado por línea se persiste después de cada
// escritura para que un reintento nunca descuente dos veces la misma línea (desvío del "registrar solo al final": con varias
// líneas, reintentar desde cero duplicaría las ya escritas). Un fallo definitivo de la primera línea no deja ninguna fila.
import { conCandados, resolverBolsa, pathProducto, ACCIONES_VINCULO } from './stockBarrera.js';
import { abrirOActualizarIncidente, confirmarCicloSano } from './incidentes.js';
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

/** Destino vigente de la orden: 'descuento' (reclamo guardado), 'pedido' (hay reserva en curso o pedido; se libera solo al borrarse la reserva) o null. */
export function destinoActual(db, id) {
  const d = db.prepare('SELECT destino FROM ordenes_ml_destino WHERE ml_order_id = ?').get(String(id))?.destino;
  if (d) return d;
  const hayPedido = db.prepare('SELECT 1 FROM ordenes_ml_wc_pedidos WHERE ml_order_id = ?').get(String(id))
    || db.prepare('SELECT 1 FROM ordenes_ml_procesadas WHERE order_id = ?').get(String(id));
  return hayPedido ? 'pedido' : null;
}

/**
 * Reclama de forma atómica (transacción IMMEDIATE de SQLite, válida entre procesos) el destino 'descuento'. Solo se guarda
 * el lado descuento; el lado pedido lo es la reserva (`_procesarOrden` la inserta en otra transacción IMMEDIATE que mira este
 * reclamo), así que liberar la reserva libera el destino sin estado extra. Devuelve el destino vigente.
 */
export function reclamarDestino(db, id, quiero) {
  return db.transaction(() => {
    if (db.prepare("SELECT 1 FROM ordenes_ml_descuento_sin_pedido WHERE ml_order_id = ? AND estado = 'completo'").get(String(id))) return 'cancelada'; // lápida o ya cerrada
    const actual = destinoActual(db, id);
    if (actual) return actual;
    db.prepare('INSERT INTO ordenes_ml_destino (ml_order_id, destino, creado_en) VALUES (?, ?, ?)').run(String(id), quiero, ahora());
    return quiero;
  }).immediate();
}

const aMs = (raw) => {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const t = Date.parse(/(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw.trim()) ? raw.trim() : `${raw.trim()}Z`);
  return Number.isFinite(t) ? t : null;
};

/**
 * Fecha de referencia de la orden para la ventana, normalizada a UTC (sin offset se asume UTC): el MÁXIMO `date_approved` de
 * los pagos aprobados; si no hay, `date_closed`; si tampoco, `date_created`. Una venta creada el 10/10 y pagada el 13/10 es
 * una venta del 13/10. `null` si ninguna fecha es legible.
 */
export function fechaOrdenMs(orden) { return fechaBaseOrden(orden).ms; }

/** Igual que `fechaOrdenMs` pero informa de dónde salió la fecha ('pago' | 'cierre' | 'creacion'). */
export function fechaBaseOrden(orden) {
  const pagos = (Array.isArray(orden?.payments) ? orden.payments : [])
    .filter((p) => p?.status === 'approved').map((p) => aMs(p?.date_approved)).filter((t) => t !== null);
  if (pagos.length) return { ms: Math.max(...pagos), fuente: 'pago' };
  const cierre = aMs(orden?.date_closed);
  if (cierre !== null) return { ms: cierre, fuente: 'cierre' };
  const creacion = aMs(orden?.date_created);
  return creacion !== null ? { ms: creacion, fuente: 'creacion' } : { ms: null, fuente: null };
}

function producto(db, sku) {
  const c = db.prepare('SELECT id_woo, nombre, tipo, id_padre FROM catalogo_cache WHERE sku = ? LIMIT 1').get(sku);
  return c ? { product_id: c.tipo === 'variation' ? c.id_padre : c.id_woo, variation_id: c.tipo === 'variation' ? c.id_woo : 0, nombre: c.nombre } : null;
}

/** Relee la fila en la base: ¿está cerrada (`completo`) o la línea ya no sigue pendiente/incierta? Entonces nadie debe escribir. */
function cerradaPorFuera(db, id, l) {
  const f = db.prepare('SELECT estado, lineas_json FROM ordenes_ml_descuento_sin_pedido WHERE ml_order_id = ?').get(id);
  if (!f) return false;
  if (f.estado === 'completo') return true;
  const lv = JSON.parse(f.lineas_json).find((x) => x.sku === l.sku);
  return Boolean(lv) && !['pendiente', 'incierta'].includes(lv.estado);
}

const guardar = (db, id, lineas, estado, { actor, origen, cancelada = false }) => db.prepare(`INSERT INTO ordenes_ml_descuento_sin_pedido (ml_order_id, lineas_json, estado, actor, origen, creado_en, actualizado_en, cancelada_en)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(ml_order_id) DO UPDATE SET lineas_json = excluded.lineas_json, estado = excluded.estado, actualizado_en = excluded.actualizado_en,
    cancelada_en = COALESCE(ordenes_ml_descuento_sin_pedido.cancelada_en, excluded.cancelada_en)
  WHERE ordenes_ml_descuento_sin_pedido.estado <> 'completo'`)
  .run(String(id), JSON.stringify(lineas), estado, actor, origen, ahora(), ahora(), cancelada ? ahora() : null);

/** Texto del aviso (mismo texto en mail y push: `mensaje_humano` del incidente). */
export function textoAviso(orden, lineas, { descontado, motivoNoDescuento = null, dias }) {
  const fecha = String(orden.date_created || '').slice(0, 10);
  const partes = [];
  const fmt = (l) => `${l.sku} – ${l.nombre} x${l.cantidad}: stock leído ${l.antes}, escrito ${l.despues}, releído ${l.releido ?? '?'}${l.despues < 0 ? ' (QUEDÓ NEGATIVO)' : ''}`;
  const hechas = lineas.filter((l) => l.estado === 'descontada');
  if (hechas.length) partes.push(`Se descontó en la web: ${hechas.map(fmt).join('; ')}.`);
  const sinSku = lineas.filter((l) => l.estado === 'omitida' && !l.sku);
  if (sinSku.length) partes.push(`SIN SKU (no se descontó, revisar a mano): ${sinSku.map((l) => `${l.nombre} x${l.cantidad ?? '?'}`).join('; ')}.`);
  const omitidas = lineas.filter((l) => l.estado === 'omitida' && l.sku);
  if (omitidas.length) partes.push(`No se tocó (${omitidas.map((l) => `${l.sku}: ${l.motivo}`).join('; ')}).`);
  const ambiguas = lineas.filter((l) => l.estado === 'ambigua');
  if (ambiguas.length) partes.push(`AMBIGUAS (revisar a mano el stock en Woo): ${ambiguas.map((l) => `${l.sku} x${l.cantidad}: antes ${l.antes}, esperado ${l.esperado ?? l.despues}, actual ${l.actual ?? '?'} (${l.motivo})`).join('; ')}.`);
  const base = fechaBaseOrden(orden);
  const refer = base.ms !== null ? `${new Date(base.ms).toISOString().slice(0, 10)} (${base.fuente === 'pago' ? 'fecha de pago' : base.fuente === 'cierre' ? 'fecha de cierre' : 'fecha de creación'})` : fecha;
  const cab = descontado
    ? `Venta de MercadoLibre ${orden.id} (creada el ${fecha}, referencia ${refer}): el aviso llegó a más de ${dias} días, fuera de la ventana. NO se creó el pedido en la web; solo se descontó el stock vendido.`
    : `Venta de MercadoLibre ${orden.id} (creada el ${fecha}, referencia ${refer}, estado ${orden.status}). ${motivoNoDescuento}`;
  return [cab, ...partes].join(' ');
}

const FALLOS_PARA_CRITICO = 2; // el 3.er fallo seguido de la conciliación abre el incidente crítico

/**
 * ¿La orden ya fue atendida por otro camino? Devuelve `null` (sigue el descuento) o el resultado a devolver:
 *  - Preparación con esa orden → `no_aplica`, incidente informativo para revisar (no se sella: lo decide una persona);
 *  - pedido Woo con `_ml_order_id` = orden → `no_aplica`, fila `manual_sin_descuento` (sellada) e incidente informativo;
 *  - lectura de Woo fallida o no concluyente → `reintentar` sin tocar nada; si persiste, incidente crítico.
 */
async function conciliarOrden(db, cfg, orden, deps, { actor, origen }) {
  const id = String(orden.id);
  let prep = null;
  try { prep = db.prepare('SELECT id, estado, wc_order_id FROM preparaciones WHERE clave = ? OR ml_order_id = ? LIMIT 1').get(`ml:${id}`, id) ?? null; } catch (e) {
    // Solo "no such table" significa ausencia de Preparación; cualquier otro error SQL es inconcluso (nadie descuenta, se reintenta).
    if (!/no such table/i.test(String(e?.message))) return { estado: 'reintentar', motivo: `no se pudo consultar Preparación: ${e?.message}` };
  }
  if (prep) {
    const txt = `Venta de MercadoLibre ${id}: ya existe en Preparación (estado ${prep.estado}). NO se descontó stock ni se creó pedido; revisá si el stock ya está bien.`;
    abrirOActualizarIncidente(db, {
      integracion: 'mercadolibre', proceso: 'orden_ml_tardia', tipoError: `orden_ml_ya_atendida_prep_${id}`.slice(0, 120), severidad: 'info',
      mensajeTecnico: txt, mensajeHumano: txt, contexto: { ml_order_id: id, preparacion_id: prep.id, estado: prep.estado },
    });
    return { estado: 'no_aplica', motivo: 'la orden ya está en Preparación: no se descuenta' };
  }
  if (!deps.conciliarConWoo) return null;
  let wcId, via = 'meta';
  try {
    const r = await deps.conciliarConWoo(db, cfg, orden);
    if (r && typeof r === 'object') { wcId = r.id; via = r.via || 'meta'; } else wcId = r; // compat: id suelto
  } catch (e) {
    const fallos = db.prepare("SELECT fallos_consecutivos AS n FROM trabajos_recurso WHERE tipo = 'order.ml' AND recurso = ?").get(id)?.n ?? 0;
    if (fallos >= FALLOS_PARA_CRITICO) {
      const txt = `Venta de MercadoLibre ${id}: no se pudo comprobar en Woo si ya existe su pedido (${String(e.message).slice(0, 200)}). NO se descontó stock; se sigue reintentando.`;
      abrirOActualizarIncidente(db, {
        integracion: 'woocommerce', proceso: 'orden_ml_tardia', tipoError: `orden_ml_conciliacion_woo_${id}`.slice(0, 120), severidad: 'critico',
        mensajeTecnico: txt, mensajeHumano: txt, contexto: { ml_order_id: id, fallos: fallos + 1 },
      });
    }
    return { estado: 'reintentar', motivo: `no se pudo conciliar con Woo: ${e.message}` };
  }
  if (wcId && via !== 'meta') {
    // Coincidencia solo por texto: NO es concluyente. 0 PUT, no se sella; incidente crítico (con dedupe) para que una persona decida.
    // La orden queda inconclusa y sigue reintentando con backoff.
    const txt = `Posible pedido manual #${wcId} para la orden ML ${id}: el pedido Woo ${wcId} menciona ${via === 'texto_pack' ? 'el pack' : 'el número'} de la venta pero SIN la meta _ml_order_id. NO se descontó stock. Confirmá si es la misma venta (si lo es, cerrala a mano; si no, avisá).`;
    abrirOActualizarIncidente(db, {
      integracion: 'mercadolibre', proceso: 'orden_ml_tardia', tipoError: `orden_ml_posible_pedido_manual_${id}`.slice(0, 120), severidad: 'critico',
      mensajeTecnico: txt, mensajeHumano: txt, contexto: { ml_order_id: id, wc_order_id: wcId, via },
    });
    return { estado: 'reintentar', motivo: `posible pedido manual #${wcId}: a confirmar por una persona` };
  }
  if (wcId) {
    guardar(db, id, [], 'completo', { actor, origen: 'manual_sin_descuento' });
    const txt = `Venta de MercadoLibre ${id}: ya existe el pedido Woo ${wcId} (creado por otro camino). NO se descontó stock; se marcó como atendida.`;
    abrirOActualizarIncidente(db, {
      integracion: 'mercadolibre', proceso: 'orden_ml_tardia', tipoError: `orden_ml_ya_atendida_woo_${id}`.slice(0, 120), severidad: 'info',
      mensajeTecnico: txt, mensajeHumano: txt, contexto: { ml_order_id: id, wc_order_id: wcId, via },
    });
    return { estado: 'no_aplica', motivo: `la orden ya tiene el pedido Woo ${wcId}: no se descuenta` };
  }
  return null;
}

/**
 * Descuenta en Woo la cantidad vendida de una orden ML vieja sin pedido (idempotente por orden) y avisa.
 * `deps`: { enriquecer(db, wooCfg, lineas) → completa manage_stock/stock_gestor_*, encolarBolsas(db, skus), vinculos, diasVentana }.
 * @returns {{estado:'descontada'|'ya_descontada'|'reintentar'|'no_aplica'|'simulado', lineas:object[], motivo?:string}}
 */
export async function descontarOrdenVieja(db, cfg, orden, deps, { dryRun = false, actor = 'sistema', origen = 'job' } = {}) {
  const id = String(orden.id);
  const previa = db.prepare('SELECT estado, lineas_json, origen, cancelada_en FROM ordenes_ml_descuento_sin_pedido WHERE ml_order_id = ?').get(id);
  if (previa?.estado === 'completo' && orden.status === 'paid') {
    try { avisarCanceladaLuegoPagada(db, orden, previa); } catch (e) { (deps.log || console.error)(`descuentoOrdenVieja: aviso cancelada-luego-pagada de ${id} falló: ${e.message}`, id); } // un aviso caído no tira el job
  }
  if (previa?.estado === 'completo') return { estado: 'ya_descontada', lineas: JSON.parse(previa.lineas_json) };
  const dias = Math.round(deps.diasVentana);
  const { lineas: nuevas, sinSku } = lineasDeOrden(db, orden, deps.vinculos);

  // Orden pagada = única que se descuenta. Cancelada u otro estado: solo aviso (incidente), jamás stock.
  if (orden.status !== 'paid') {
    const motivo = `La orden está ${orden.status}: NO se descontó stock ni se creó pedido.`;
    const todasNA = [...nuevas, ...sinSku];
    if (!dryRun && orden.status === 'cancelled') {
      // Fila `completo`: el aviso sale una sola vez por orden (sin reaviso en cada orders_v2) y _procesarOrden no crea pedido.
      guardar(db, id, todasNA, 'completo', { actor, origen, cancelada: true }); // fila y marca en un solo statement
      abrirAviso(db, orden, todasNA, { descontado: false, motivoNoDescuento: motivo, dias });
    }
    return { estado: 'no_aplica', motivo, lineas: todasNA };
  }

  // Conciliación (hotfix ronda 2): una orden sin tratar pudo ser atendida por otro camino (pedido Woo manual, Preparación).
  // Se mira ANTES de reclamar el destino y de cualquier PUT; ante la duda (lectura fallida) no se descuenta y se reintenta.
  if (!previa && !dryRun) {
    const c = await conciliarOrden(db, cfg, orden, deps, { actor, origen });
    if (c) return { ...c, lineas: [...nuevas, ...sinSku] };
  }

  // Destino excluyente por orden: o la orden termina en pedido Woo o en descuento, nunca las dos. Se reclama ANTES de tocar Woo.
  if (!previa) {
    const d = dryRun ? destinoActual(db, id) : reclamarDestino(db, id, 'descuento');
    if (d === 'pedido') return { estado: 'no_aplica', motivo: 'la orden ya tiene (o está creando) su pedido Woo: no se descuenta', lineas: [...nuevas, ...sinSku] };
    if (d === 'cancelada') return { estado: 'cancelada', lineas: [...nuevas, ...sinSku] };
  }

  // Estado previo por línea (reintento tras fallo parcial) + líneas nuevas.
  const prev = new Map((previa ? JSON.parse(previa.lineas_json) : []).filter((l) => l.sku).map((l) => [l.sku, l]));
  const lineas = nuevas.map((l) => prev.get(l.sku) ? { ...prev.get(l.sku), cantidad: l.cantidad } : l);
  const cfgFila = { actor, origen };
  const wooCfg = cfg.woo;

  const procesar = async (candado) => {
    for (const l of lineas) {
      if (TERMINALES.has(l.estado)) continue;
      if (!dryRun && cerradaPorFuera(db, id, l)) return { cancelada: true };
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
      if (l.estado === 'incierta') {
        // Un intento anterior no confirmó. Único caso automático: el stock sigue igual que antes (el PUT no se aplicó) → reescribir
        // es seguro. Cualquier otro valor (incluso el esperado: pudo ser una coincidencia con una venta) → revisión humana.
        if (actual !== l.antes) {
          Object.assign(l, { estado: 'ambigua', actual, esperado: l.despues, motivo: `intento sin confirmar: había ${l.antes}, se esperaba ${l.despues}, hay ${actual}` });
          if (!dryRun) guardar(db, id, [...lineas, ...sinSku], 'parcial', cfgFila);
          continue;
        }
      }
      if (actual < l.cantidad) {
        // Guarda (decisión de José): si el stock de Woo es menor que lo vendido, casi seguro ya se ajustó a mano. Restar dejaría negativo.
        Object.assign(l, { estado: 'omitida', antes: actual, motivo: 'stock insuficiente: probablemente ya se ajustó a mano' });
        if (!dryRun) {
          guardar(db, id, [...lineas, ...sinSku], 'parcial', cfgFila);
          const txt = `Venta de MercadoLibre ${id}: NO se descontó ${l.sku} x${l.cantidad} porque el stock leído en Woo es ${actual} (menor que lo vendido). Probablemente ya se ajustó a mano. Revisalo en la web.`;
          abrirOActualizarIncidente(db, {
            integracion: 'mercadolibre', proceso: 'orden_ml_tardia', tipoError: `orden_ml_stock_insuficiente_${id}_${l.sku}`.slice(0, 120), severidad: 'critico',
            mensajeTecnico: txt, mensajeHumano: txt, contexto: { ml_order_id: id, sku: l.sku, cantidad: l.cantidad, stock: actual },
          });
        }
        continue;
      }
      const nuevo = actual - l.cantidad;
      l.gestor_id = enr.stock_gestor_id; l.gestor_padre = enr.stock_gestor_padre ?? null;
      if (dryRun) { Object.assign(l, { antes: actual, despues: nuevo, estado: 'simulada' }); continue; }
      if (cerradaPorFuera(db, id, l)) return { cancelada: true }; // la cancelación cerró la fila mientras leíamos: no se escribe
      const eraIncierta = l.estado === 'incierta';
      if (!eraIncierta) Object.assign(l, { antes: actual, despues: nuevo }); // el reintento de una incierta conserva su antes/esperado
      // Write-ahead: la intención (antes/esperado) queda persistida ANTES del PUT. Si el proceso muere entre el PUT y el
      // registro, el reintento la encuentra `incierta` y aplica la regla de siempre (reescribe solo si actual === antes).
      const hayFilaPrevia = Boolean(db.prepare('SELECT 1 FROM ordenes_ml_descuento_sin_pedido WHERE ml_order_id = ?').get(id));
      l.estado = 'incierta';
      guardar(db, id, [...lineas, ...sinSku], 'parcial', cfgFila);
      try {
        await wooFetch(wooCfg, path, 'put', { stock_quantity: l.despues });
      } catch (e) {
        // 5xx y 408 pudieron haberse aplicado (incierta); 4xx/429 no se aplicaron; config/circuito abierto no enviaron nada.
        const aplicable = e?.status != null && (e.status >= 500 || e.status === 408);
        if (!aplicable && (e?.status != null || e?.categoria === 'config' || e?.circuitoAbierto)) {
          l.estado = 'pendiente';
          const tocada = lineas.some((x) => ['descontada', 'incierta', 'ambigua'].includes(x.estado));
          if (!hayFilaPrevia && !tocada) db.prepare('DELETE FROM ordenes_ml_descuento_sin_pedido WHERE ml_order_id = ?').run(id);
          else guardar(db, id, [...lineas, ...sinSku], 'parcial', cfgFila);
        }
        return { reintentar: `Woo no aceptó el descuento de ${l.sku}: ${e.message}` };
      }
      // Carrera lectura→PUT: el PUT es absoluto, una venta web intermedia pudo pisarse. Se relee y se compara.
      let leido = null;
      try { leido = Number((await wooFetch(wooCfg, path))?.data?.stock_quantity); } catch { leido = null; }
      if (leido !== l.despues) {
        Object.assign(l, { estado: 'ambigua', actual: Number.isFinite(leido) ? leido : null, esperado: l.despues, motivo: `tras escribir ${l.despues} Woo muestra ${Number.isFinite(leido) ? leido : 'ilegible'} (una venta web pudo pisarse)` });
      } else {
        l.estado = 'descontada';
        l.releido = leido;
      }
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
  if (r.cancelada) { // la cancelación cerró la fila y ya avisó: no se pisa ni se reavisa
    const f = db.prepare('SELECT lineas_json FROM ordenes_ml_descuento_sin_pedido WHERE ml_order_id = ?').get(id);
    return { estado: 'cancelada', lineas: f ? JSON.parse(f.lineas_json) : [...lineas, ...sinSku] };
  }
  const todas = [...lineas, ...sinSku];
  if (dryRun) return { estado: 'simulado', lineas: todas, motivo: r.reintentar };
  if (r.reintentar) {
    avisarParcial(db, orden, todas, deps, r.reintentar);
    return { estado: 'reintentar', motivo: r.reintentar, lineas: todas };
  }

  guardar(db, id, todas, 'completo', cfgFila);
  deps.encolarBolsas(db, lineas.filter((l) => l.estado === 'descontada').map((l) => l.sku));
  confirmarCicloSano(db, { integracion: 'mercadolibre', proceso: 'orden_ml_tardia', tipoError: tipoParcial(orden.id) });
  const huboDescuento = todas.some((l) => l.estado === 'descontada');
  abrirAviso(db, orden, todas, { descontado: huboDescuento, dias, motivoNoDescuento: 'No se descontó stock en la web ni se creó el pedido (ver detalle por línea).' });
  return { estado: 'descontada', lineas: todas };
}

const tipoParcial = (id) => `orden_ml_descuento_parcial_${id}`.slice(0, 120);

/** Si ya se tocó stock en alguna línea y el resto no avanza: incidente crítico (mail + push) con lo descontado y lo pendiente; encola las bolsas ya tocadas. */
function avisarParcial(db, orden, lineas, deps, motivo) {
  const tocadas = lineas.filter((l) => ['descontada', 'incierta', 'ambigua'].includes(l.estado));
  if (!tocadas.length) return; // nada escrito: lo cubre el incidente genérico del trabajo muerto
  const hechas = lineas.filter((l) => l.estado === 'descontada');
  if (hechas.length) deps.encolarBolsas(db, hechas.map((l) => l.sku));
  const pendientes = lineas.filter((l) => !TERMINALES.has(l.estado));
  const txt = `Venta de MercadoLibre ${orden.id}: el descuento de stock quedó A MEDIAS (${motivo}). `
    + `Ya descontado: ${hechas.map((l) => `${l.sku} x${l.cantidad} (${l.antes} → ${l.despues})`).join('; ') || 'nada confirmado'}. `
    + `Sin confirmar/pendiente: ${pendientes.map((l) => `${l.sku} x${l.cantidad}${l.estado === 'incierta' ? ` (intento sin confirmar, antes ${l.antes}, esperado ${l.despues})` : ''}`).join('; ') || 'ninguna'}. `
    + `${lineas.filter((l) => l.estado === 'ambigua').map((l) => `AMBIGUA ${l.sku}: ${l.motivo}.`).join(' ')}`.trim();
  abrirOActualizarIncidente(db, {
    integracion: 'mercadolibre', proceso: 'orden_ml_tardia', tipoError: tipoParcial(orden.id), severidad: 'critico',
    mensajeTecnico: txt, mensajeHumano: txt, contexto: { ml_order_id: String(orden.id), motivo, lineas },
  });
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

/** Una lápida de cancelación y la orden vuelve 'paid': no se crea pedido ni se descuenta; incidente crítico único para revisión manual. */
export function avisarCanceladaLuegoPagada(db, orden, fila) {
  if (!fila?.cancelada_en) return false;
  const tipoError = `orden_ml_cancelada_luego_pagada_${orden.id}`.slice(0, 120);
  if (db.prepare('SELECT 1 FROM incidentes_operativos WHERE tipo_error = ?').get(tipoError)) return false;
  const txt = `La venta de MercadoLibre ${orden.id} había sido CANCELADA y ahora ML la presenta como pagada otra vez. No se creó pedido ni se descontó stock. Revisala a mano en MercadoLibre.`;
  abrirOActualizarIncidente(db, {
    integracion: 'mercadolibre', proceso: 'orden_ml_tardia', tipoError, severidad: 'critico',
    mensajeTecnico: txt, mensajeHumano: txt, contexto: { ml_order_id: String(orden.id), fecha: orden.date_created ?? null },
  });
  return true;
}

/**
 * Orden ML que se CANCELA después de haberse descontado el stock sin pedido: no se repone automáticamente (sería una decisión
 * de negocio nueva). Incidente crítico (mail + push) una sola vez por orden con lo descontado, para reponer a mano.
 * @returns {Promise<boolean|'ocupado'>} true si abrió el aviso; 'ocupado' si no pudo tomar los candados del descuento (reencolar).
 */
export async function avisarCancelacionDescontada(db, orden) {
  const fila0 = db.prepare('SELECT lineas_json FROM ordenes_ml_descuento_sin_pedido WHERE ml_order_id = ?').get(String(orden.id));
  // Sin fila todavía puede haber un descuento en vuelo que leyó 'paid': los SKUs salen de la orden para tomar sus mismos candados.
  let skus = fila0
    ? [...new Set(JSON.parse(fila0.lineas_json).map((l) => l.sku).filter(Boolean))]
    : lineasDeOrden(db, orden, ACCIONES_VINCULO).lineas.map((l) => l.sku);
  let bolsa = { skus };
  try { bolsa = resolverBolsa(db, { skus }); } catch { /* se bloquean los propios SKUs */ }
  // Mismos candados que el descuento: si un descuento está escribiendo, esperamos; si no se obtienen, el llamador reencola.
  const c = await conCandados(db, [...new Set([...bolsa.skus, ...skus])], async () => cerrarYAvisarCancelacion(db, orden));
  return c.ocupado ? 'ocupado' : c.valor;
}

/** Núcleo síncrono (sin candados: el llamador ya los tiene). Cierra la fila y abre el aviso una sola vez. */
export function cerrarYAvisarCancelacion(db, orden) {
  const id = String(orden.id);
  const fila = db.prepare('SELECT estado, lineas_json, origen FROM ordenes_ml_descuento_sin_pedido WHERE ml_order_id = ?').get(id);
  // Fila cerrada a mano por José (origen 'manual_sin_descuento'): se respeta tal cual, no es lápida ni se marca ni avisa.
  if (fila?.origen === 'manual_sin_descuento') return false;
  if (fila?.estado === 'completo') {
    // Único UPDATE permitido sobre una fila cerrada: marca la cancelación (no toca estado ni líneas) para avisar si vuelve 'paid'.
    db.prepare('UPDATE ordenes_ml_descuento_sin_pedido SET cancelada_en = COALESCE(cancelada_en, ?) WHERE ml_order_id = ?').run(ahora(), id);
  }
  if (!fila) {
    // Lápida: la cancelación llegó antes que el descuento. Un descuento que ya leyó 'paid' aborta con 0 PUT (reclamarDestino /
    // cerradaPorFuera la respetan). Solo si la orden no tiene pedido; no genera aviso (nada se descontó).
    db.transaction(() => {
      if (destinoActual(db, id) === 'pedido') return;
      db.prepare(`INSERT OR IGNORE INTO ordenes_ml_descuento_sin_pedido (ml_order_id, lineas_json, estado, actor, origen, creado_en, actualizado_en, cancelada_en)
        VALUES (?, '[]', 'completo', 'sistema', 'cancelada', ?, ?, ?)`).run(id, ahora(), ahora(), ahora());
    }).immediate();
    return false;
  }
  const todas = JSON.parse(fila.lineas_json);
  const hechas = todas.filter((l) => l.estado === 'descontada' || l.estado === 'incierta' || l.estado === 'ambigua');
  const pendientes = todas.filter((l) => l.sku && l.estado === 'pendiente');
  // Descuento a medias: se frena el resto (una orden cancelada no sigue restando) y se cierra la fila.
  if (fila.estado !== 'completo') {
    for (const l of pendientes) Object.assign(l, { estado: 'omitida', motivo: 'orden cancelada antes de descontar esta línea' });
    db.prepare("UPDATE ordenes_ml_descuento_sin_pedido SET lineas_json = ?, estado = 'completo', actualizado_en = ?, cancelada_en = COALESCE(cancelada_en, ?) WHERE ml_order_id = ?").run(JSON.stringify(todas), ahora(), ahora(), id);
  }
  if (!hechas.length) return false;
  const tipoError = `orden_ml_descontada_cancelada_${id}`.slice(0, 120);
  if (db.prepare('SELECT 1 FROM incidentes_operativos WHERE tipo_error = ?').get(tipoError)) return false; // una sola vez por orden
  const txt = `La venta de MercadoLibre ${id} ya había descontado stock en la web (sin crear pedido) y ahora fue CANCELADA. NO se repuso nada automáticamente: reponé a mano. `
    + `Descontado: ${hechas.map((l) => `${l.sku} x${l.cantidad} (stock leído ${l.antes}, escrito ${l.despues}${l.estado === 'descontada' ? '' : `; línea ${l.estado}, verificar`})`).join('; ')}.`
    + (pendientes.length ? ` NO se descontó (quedó pendiente, la orden se canceló): ${pendientes.map((l) => `${l.sku} x${l.cantidad}`).join('; ')}.` : '');
  abrirOActualizarIncidente(db, {
    integracion: 'mercadolibre', proceso: 'orden_ml_tardia', tipoError, severidad: 'critico',
    mensajeTecnico: txt, mensajeHumano: txt, contexto: { ml_order_id: id, lineas: hechas },
  });
  return true;
}
