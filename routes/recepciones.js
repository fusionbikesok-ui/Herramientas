import express from 'express';
import { randomUUID } from 'node:crypto';
import { wooFetch } from './woo.js';
import { buildWooPath } from '../lib/wooStock.js';
import { syncSkuPuntual } from './sync.js';
import { resolverLoteRecepcion } from '../lib/recepcionMatching.js';
import { confirmarAlias, revocarAlias, normalizarProveedor } from '../lib/recepcionAliases.js';
import { crearBorradorWoo } from '../lib/nuevosProductosWoo.js';

// Lock en memoria por id_woo para serializar el patrón GET→calcular→PATCH.
// Es un solo proceso Node, así que un Map<id_woo, Promise> a nivel de módulo
// alcanza para evitar que dos recepciones concurrentes sobre el mismo producto
// se pisen las escrituras y pierdan stock recibido.
const locksStockPorIdWoo = new Map();

// Aplica el stock de un ítem recibido en WooCommerce (GET stock actual + PATCH suma).
// Resuelve el path correcto para variaciones vía catalogo_cache/buildWooPath.
// Actualiza recepcion_items (stock_previo/stock_nuevo/estado_item='aplicado') y catalogo_cache.
// Lanza si la API de WC falla — el estado terminal ('error_reintentable'/'operacion_incierta'/'conflicto_stock') ya queda persistido antes de lanzar.
// Serializado por id_woo: si ya hay una aplicación en curso para ese producto,
// esta espera a que termine antes de hacer su propio GET.
export async function aplicarStockItem(db, cfg, item) {
  const previa = locksStockPorIdWoo.get(item.id_woo) || Promise.resolve();
  // Encadenamos ignorando el resultado (y errores) de la previa: cada llamada
  // maneja su propio éxito/fallo, solo necesitamos la serialización temporal.
  const propia = previa.catch(() => {}).then(() => aplicarStockItemInterno(db, cfg, item));
  locksStockPorIdWoo.set(item.id_woo, propia);
  try {
    return await propia;
  } finally {
    // Liberar el lock solo si nadie encadenó después (evita retener promesas viejas).
    if (locksStockPorIdWoo.get(item.id_woo) === propia) {
      locksStockPorIdWoo.delete(item.id_woo);
    }
  }
}

/** Un ítem que no está en un estado desde el que se pueda (re)aplicar: 'aplicado' no se reintenta nunca,
 * y 'aplicando'/'operacion_incierta'/'conflicto_stock' necesitan conciliación, no un reintento a ciegas. */
export class EstadoNoReintentableError extends Error {
  constructor(estado) { super(`el ítem está en estado '${estado}': no se reintenta a ciegas`); this.estado = estado; }
}

async function aplicarStockItemInterno(db, cfg, item) {
  // Claim atómico: solo una llamada (de dos concurrentes, o de un reintento tras 'aplicado') sigue de acá.
  // Nunca sobre un 'aplicado' (se excluye siempre de todo reintento) ni sobre otro 'aplicando'/incierto/conflicto.
  const operationId = randomUUID();
  const inicio = new Date().toISOString();
  const claim = db.prepare(
    `UPDATE recepcion_items SET estado_item='aplicando', operation_id=?, aplicando_desde=?, error_wc=NULL
      WHERE id=? AND (estado_item IS NULL OR estado_item IN ('pendiente','error_reintentable','creado'))`
  ).run(operationId, inicio, item.id);
  if (claim.changes === 0) {
    const actual = db.prepare('SELECT estado_item, stock_previo, stock_objetivo FROM recepcion_items WHERE id=?').get(item.id);
    if (actual?.estado_item === 'aplicado') {
      // Recepción repetida / segunda confirmación concurrente: devuelve el resultado conocido, no reaplica.
      return { stock_previo: actual.stock_previo, stock_nuevo: actual.stock_objetivo, yaAplicado: true };
    }
    throw new EstadoNoReintentableError(actual?.estado_item ?? 'desconocido');
  }

  let prod;
  try {
    prod = db.prepare('SELECT id_woo, id_padre, tipo FROM catalogo_cache WHERE id_woo=?').get(item.id_woo);
    if (!prod) {
      throw new Error(`No se encontró el producto id_woo=${item.id_woo} en catalogo_cache; no se puede determinar si es variación o simple`);
    }
    var apiPath = buildWooPath(prod);
    var get = await wooFetch(cfg, apiPath);
  } catch (e) {
    // Error ANTES del PATCH: nada se disparó contra Woo. Es reintentable.
    db.prepare("UPDATE recepcion_items SET estado_item='error_reintentable', error_wc=?, operation_id=NULL WHERE id=? AND operation_id=?")
      .run(String(e?.message || e), item.id, operationId);
    throw e;
  }
  const stockRaw = get.data?.stock_quantity;
  const stockActual = Number(stockRaw);
  if (stockRaw === null || stockRaw === undefined || !Number.isFinite(stockActual)) {
    const e = new Error(`WooCommerce no devolvió stock_quantity para id_woo=${item.id_woo} (¿manage_stock desactivado?); no se aplica sobre un dato posiblemente desactualizado`);
    db.prepare("UPDATE recepcion_items SET estado_item='error_reintentable', error_wc=?, operation_id=NULL WHERE id=? AND operation_id=?")
      .run(e.message, item.id, operationId);
    throw e;
  }
  const stockObjetivo = stockActual + item.cantidad;
  // Persistido ANTES del PATCH: si el proceso muere entre acá y la verificación, la conciliación tiene
  // con qué comparar (stock_previo vs stock_objetivo) sin tener que adivinar qué se intentó aplicar.
  // El guard `AND operation_id=?` es redundante hoy (el claim ya es la única puerta de entrada por
  // ítem: nadie más pudo tomar este item.id mientras seguimos en 'aplicando'), pero barato y explícito.
  db.prepare('UPDATE recepcion_items SET stock_previo=?, stock_objetivo=? WHERE id=? AND operation_id=?')
    .run(stockActual, stockObjetivo, item.id, operationId);

  try {
    await wooFetch(cfg, apiPath, 'patch', { stock_quantity: stockObjetivo, manage_stock: true });
  } catch (e) {
    // Indeterminado: no sabemos si el PATCH llegó a aplicarse en Woo. NUNCA se reintenta sola.
    db.prepare("UPDATE recepcion_items SET estado_item='operacion_incierta', error_wc=? WHERE id=? AND operation_id=?")
      .run(String(e?.message || e), item.id, operationId);
    const incierta = new Error(`operación incierta tras el PATCH para id_woo=${item.id_woo}: ${e?.message || e}`);
    incierta.operacionIncierta = true;
    throw incierta;
  }

  // Verificación: recién con el GET posterior se confirma 'aplicado'. Un timeout acá es la misma
  // incertidumbre que un timeout en el PATCH: no se sabe si aplicó, y tampoco se reintenta sola.
  let verif;
  try {
    verif = await wooFetch(cfg, apiPath);
  } catch (e) {
    db.prepare("UPDATE recepcion_items SET estado_item='operacion_incierta', error_wc=? WHERE id=? AND operation_id=?")
      .run(String(e?.message || e), item.id, operationId);
    const incierta = new Error(`no se pudo verificar el PATCH para id_woo=${item.id_woo}: ${e?.message || e}`);
    incierta.operacionIncierta = true;
    throw incierta;
  }
  const stockVerif = Number(verif.data?.stock_quantity);
  if (!Number.isFinite(stockVerif) || stockVerif !== stockObjetivo) {
    const motivo = `GET posterior al PATCH devolvió ${verif.data?.stock_quantity} para id_woo=${item.id_woo}; se esperaba ${stockObjetivo}`;
    db.prepare("UPDATE recepcion_items SET estado_item='conflicto_stock', error_wc=? WHERE id=? AND operation_id=?")
      .run(motivo, item.id, operationId);
    const conflicto = new Error(motivo);
    conflicto.conflictoStock = true;
    throw conflicto;
  }

  const now = new Date().toISOString();
  // Mismo guard redundante que arriba (el claim ya serializa por item.id): explícito igual, barato.
  db.prepare("UPDATE recepcion_items SET stock_nuevo=?, estado_item='aplicado', error_wc=NULL WHERE id=? AND operation_id=?")
    .run(stockObjetivo, item.id, operationId);
  db.prepare('UPDATE catalogo_cache SET stock=?, actualizado_en=? WHERE id_woo=?')
    .run(stockObjetivo, now, item.id_woo);

  return { stock_previo: stockActual, stock_nuevo: stockObjetivo };
}

/**
 * Concilia un ítem en 'operacion_incierta' leyendo el stock real de Woo, sin volver a hacer PATCH:
 * si coincide con el `stock_objetivo` que se persistió antes del intento, aplicó y se marca 'aplicado';
 * si sigue en `stock_previo`, nunca aplicó y se libera para un reintento normal ('error_reintentable'); cualquier otro
 * valor es ambiguo (pudo haber otro movimiento de stock de por medio) y queda 'conflicto_stock' para una
 * persona. Nunca decide con un PATCH: eso sería reintentar a ciegas justo lo que no se sabe si ya pasó.
 */
// TODO(P1, antes de exponer esto por HTTP): hay una ventana entre este chequeo de estado y los
// UPDATE de abajo (`await wooFetch` de por medio) — dos llamadas concurrentes sobre el mismo ítem
// entran las dos. Hoy no es explotable porque esto no es una ruta, solo un export. Cuando se agregue
// el endpoint para que un operador concilie a mano, el chequeo de estado tiene que ir en el WHERE del
// UPDATE (ej. `WHERE id=? AND estado_item='operacion_incierta'`), no antes del await, para que sea
// atómico igual que el claim de aplicarStockItemInterno.
export async function conciliarOperacionIncierta(db, cfg, itemId) {
  const item = db.prepare('SELECT * FROM recepcion_items WHERE id=?').get(itemId);
  if (!item || item.estado_item !== 'operacion_incierta') {
    throw new Error(`el ítem ${itemId} no está en operacion_incierta`);
  }
  const prod = db.prepare('SELECT id_woo, id_padre, tipo FROM catalogo_cache WHERE id_woo=?').get(item.id_woo);
  if (!prod) throw new Error(`no se encontró el producto id_woo=${item.id_woo} en catalogo_cache`);
  const apiPath = buildWooPath(prod);
  const get = await wooFetch(cfg, apiPath);
  const stockReal = Number(get.data?.stock_quantity);
  if (!Number.isFinite(stockReal)) {
    db.prepare("UPDATE recepcion_items SET estado_item='conflicto_stock', error_wc=? WHERE id=?")
      .run('WooCommerce no devolvió stock_quantity al conciliar', itemId);
    return { estado: 'conflicto_stock' };
  }
  if (stockReal === item.stock_objetivo) {
    const now = new Date().toISOString();
    db.prepare("UPDATE recepcion_items SET estado_item='aplicado', stock_nuevo=?, error_wc=NULL WHERE id=?")
      .run(stockReal, itemId);
    db.prepare('UPDATE catalogo_cache SET stock=?, actualizado_en=? WHERE id_woo=?').run(stockReal, now, item.id_woo);
    return { estado: 'aplicado', stock_nuevo: stockReal };
  }
  if (stockReal === item.stock_previo) {
    db.prepare("UPDATE recepcion_items SET estado_item='error_reintentable', error_wc='conciliado: el PATCH nunca llegó a aplicarse' WHERE id=?")
      .run(itemId);
    return { estado: 'error_reintentable' };
  }
  db.prepare("UPDATE recepcion_items SET estado_item='conflicto_stock', error_wc=? WHERE id=?")
    .run(`conciliación ambigua: Woo tiene ${stockReal}, ni stock_previo (${item.stock_previo}) ni stock_objetivo (${item.stock_objetivo})`, itemId);
  return { estado: 'conflicto_stock' };
}

/**
 * P0.3: antes de aplicar stock sobre un ítem 'creado', verificar de nuevo contra Woo — no basta con
 * que la fila en recepcion_items diga 'creado' con un alta_operation_id verificado al guardar (eso
 * pudo cambiar desde entonces: alguien lo tocó a mano, un rollback, etc.). Se comprueba: la alta
 * existe, está 'creado', el id_woo corresponde a ESTE ítem, y sigue en draft en Woo AHORA MISMO.
 * Lanza si algo no cierra — el caller decide qué hacer (nunca aplica stock ni sincroniza a ML sobre
 * una alta que no pudo verificar).
 */
async function verificarAltaCreado(db, cfg, item) {
  if (!item.alta_operation_id) {
    throw new Error(`ítem ${item.id} marcado 'creado' sin alta_operation_id: no hay nada que verificar`);
  }
  const alta = db.prepare('SELECT * FROM recepcion_altas_woo WHERE operation_id=?').get(item.alta_operation_id);
  if (!alta || alta.estado !== 'creado') {
    throw new Error(`alta no verificada para el ítem ${item.id}: estado=${alta?.estado ?? 'inexistente'}`);
  }
  if (alta.id_woo !== item.id_woo) {
    throw new Error(`la alta ${item.alta_operation_id} no corresponde a este ítem: id_woo esperado ${item.id_woo}, alta tiene ${alta.id_woo}`);
  }
  const prod = db.prepare('SELECT id_woo, id_padre, tipo FROM catalogo_cache WHERE id_woo=?').get(item.id_woo);
  if (!prod) throw new Error(`producto de la alta no está en catalogo_cache: id_woo=${item.id_woo}`);
  const verif = await wooFetch(cfg, buildWooPath(prod));
  if (verif.data?.status !== 'draft') {
    throw new Error(`la alta ya no está en draft en Woo: status=${verif.data?.status}`);
  }
  return true;
}

// Normaliza número de pedido para matching tolerante:
// "PED 0008-0075B230/X EXPRESS" → "0008-0075B230/X"
// "PED0008-0075B230" → "0008-0075B230"
function normalizarNumeroPedido(num) {
  if (!num) return null;
  return num
    .trim()
    .toUpperCase()
    // Quitar sufijos de servicio al final (EXPRESS, URGENTE, NORMAL, etc.)
    .replace(/\s+(EXPRESS|URGENTE|NORMAL|PRIORITARIO|STANDARD)\s*$/i, '')
    // Quitar prefijos de tipo de documento (PED, OC, OV, ORD, FC, REM, etc.)
    .replace(/^(PEDIDO|PED|ORDEN\s+DE\s+COMPRA|ORDEN|ORD|OC|OV|FACTURA|FAC|FC|REMITO|REM)[.\-\s]*/i, '')
    .trim()
    // Colapsar espacios internos
    .replace(/\s+/g, ' ') || null;
}

/**
 * P0.3: nunca confiar en que el cliente dice `estado_item: 'creado'`. El browser ya demostró en el
 * flujo de matching manual que no es autoridad de identidad — puede mandar cualquier id_woo. Un ítem
 * solo puede quedar 'creado' si trae un `alta_operation_id` que corresponde a una fila real y 'creado'
 * en recepcion_altas_woo, con el MISMO id_woo. Si no se puede verificar, se degrada: con id_woo queda
 * 'pendiente' (matcheo manual normal), sin id_woo queda 'sin_match' — nunca se pierde silenciosamente,
 * pero tampoco se le cree al cliente algo que no puede probar.
 */
function estadoItemAlGuardar(db, it) {
  const idWoo = it.id_woo || null;
  if (it.estado_item === 'creado') {
    const opId = it.alta_operation_id || null;
    const alta = opId ? db.prepare('SELECT * FROM recepcion_altas_woo WHERE operation_id=?').get(opId) : null;
    if (alta && alta.estado === 'creado' && alta.id_woo === idWoo) {
      return { estado_item: 'creado', alta_operation_id: opId };
    }
    return { estado_item: idWoo ? 'pendiente' : 'sin_match', alta_operation_id: null };
  }
  return { estado_item: it.estado_item || (idWoo ? 'pendiente' : 'sin_match'), alta_operation_id: opIdSiVerificable(db, it, idWoo) };
}

// Conserva alta_operation_id en ítems que no reclaman 'creado' pero sí lo traen (p.ej. quedaron en
// 'pendiente' tras una alta previa) — solo si sigue correspondiendo a la misma alta e id_woo.
function opIdSiVerificable(db, it, idWoo) {
  const opId = it.alta_operation_id || null;
  if (!opId) return null;
  const alta = db.prepare('SELECT * FROM recepcion_altas_woo WHERE operation_id=?').get(opId);
  return (alta && alta.id_woo === idWoo) ? opId : null;
}

// P1: persiste la intención "usar y recordar" marcada por línea al guardar/actualizar una recepción
// (no solo vía /resolver para recepciones ya guardadas). `it.aprender_alias`/`it.motivo_alias` son los
// nombres que ya manda el frontend (public/recepcion/index.html, payloadRecepcion()) para el toggle
// "usar y recordar", desmarcado por defecto; sin id_woo (sin match, o alta de producto nuevo) no hay
// nada que aprender todavía. Un fallo al aprender el alias (p.ej. motivo requerido para reasignar y no
// vino) no debe tirar abajo el guardado de la recepción entera — la línea igual queda guardada, solo
// no se aprendió el alias.
function aprenderAliasSiCorresponde(db, it, { proveedor, id_woo, recepcion_item_id, actor }) {
  if (!it?.aprender_alias || !id_woo) return;
  try {
    confirmarAlias(db, {
      proveedor, nombre_doc: it.nombre_doc || it.nombre, codigo_proveedor: it.codigo_proveedor,
      id_woo, sku: it.sku_wc || it.sku || null, recepcion_item_id, actor, motivo: it.motivo_alias,
    });
  } catch (e) {
    console.error(`no se pudo aprender alias para el ítem de recepción ${recepcion_item_id}: ${e.message}`);
  }
}

export function recepcionesRouter(db, cfg) {
  const router = express.Router();

  router.post('/matchear', (req, res) => {
    const { proveedor, items } = req.body || {};
    if (typeof proveedor !== 'string' || !proveedor.trim() || !Array.isArray(items) || !items.length || items.length > 250) return res.status(400).json({ ok:false, code:'payload_invalido', error:'proveedor e items válidos requeridos' });
    if (items.some(i => JSON.stringify(i).length > 500)) return res.status(400).json({ ok:false, code:'linea_demasiado_larga', error:'línea demasiado larga' });
    return res.json({ ok:true, resultados: resolverLoteRecepcion(db, proveedor, items) });
  });

  router.get('/catalogo', (req, res) => {
    const rows = db.prepare('SELECT id_woo,sku,nombre,stock FROM catalogo_cache ORDER BY id_woo').all();
    res.json({ ok: true, data: rows });
  });

  router.get('/aliases', (req, res) => {
    const proveedor = String(req.query.proveedor || '').trim();
    if (!proveedor) return res.status(400).json({ ok:false, error:'proveedor requerido' });
    res.json({ ok:true, data: db.prepare('SELECT * FROM recepcion_aliases_proveedor WHERE proveedor_norm=? AND vigente_hasta IS NULL ORDER BY id').all(normalizarProveedor(proveedor)) });
  });

  router.post('/aliases/:aliasId/revocar', (req, res) => {
    try { const ok=revocarAlias(db, Number(req.params.aliasId), { motivo:req.body?.motivo, actor:req.user?.username || 'sistema' }); return ok ? res.json({ok:true}) : res.status(404).json({ok:false,error:'alias no vigente'}); }
    catch (e) { return res.status(400).json({ok:false,error:e.message}); }
  });

  router.post('/:id/items/:itemId/resolver', (req, res) => {
    const id=Number(req.params.id), itemId=Number(req.params.itemId), item=db.prepare('SELECT * FROM recepcion_items WHERE id=? AND recepcion_id=?').get(itemId,id);
    if (!item) return res.status(404).json({ok:false,error:'item no encontrado'});
    if (!['sin_match','pendiente','error_reintentable'].includes(item.estado_item)) return res.status(409).json({ok:false,error:'item no pendiente'});
    const prod=db.prepare('SELECT id_woo,id_padre,sku,tipo FROM catalogo_cache WHERE id_woo=?').get(req.body?.id_woo);
    if (!prod || !['simple','variation'].includes(prod.tipo)) return res.status(409).json({ok:false,error:'producto no vendible'});
    const now=new Date().toISOString();
    db.prepare("UPDATE recepcion_items SET id_woo=?,sku=?,estado_item='pendiente',error_wc=NULL,resuelto_en=? WHERE id=?").run(prod.id_woo,prod.sku,now,itemId);
    if (req.body?.aprender) confirmarAlias(db,{proveedor:db.prepare('SELECT proveedor FROM recepciones WHERE id=?').get(id)?.proveedor,nombre_doc:item.nombre_doc,codigo_proveedor:item.codigo_proveedor,id_woo:prod.id_woo,sku:prod.sku,recepcion_item_id:itemId,actor:req.user?.username || 'sistema',motivo:req.body.motivo});
    return res.json({ok:true,id_woo:prod.id_woo,sku:prod.sku});
  });

  /**
   * P0.3: dispara el alta en Woo para UN ítem de la recepción, con exclusión de doble alta a nivel
   * de ítem (no solo a nivel de operation_id). recepcion_altas_woo ya es idempotente por operation_id,
   * pero eso no evita que el mismo ítem dispare DOS operation_id distintos (doble click, dos pestañas,
   * un reintento) y termine con dos productos borrador en Woo para la misma línea. La exclusión real
   * va acá: un claim atómico sobre el ítem, mismo patrón que aplicarStockItemInterno (P0.1) — solo una
   * llamada por ítem pasa de acá, antes de tocar Woo.
   */
  router.post('/:id/items/:itemId/crear-alta', async (req, res) => {
    const id = Number(req.params.id), itemId = Number(req.params.itemId);
    const item = db.prepare('SELECT * FROM recepcion_items WHERE id=? AND recepcion_id=?').get(itemId, id);
    if (!item) return res.status(404).json({ ok: false, error: 'item no encontrado' });

    if (item.alta_operation_id) {
      const previa = db.prepare('SELECT * FROM recepcion_altas_woo WHERE operation_id=?').get(item.alta_operation_id);
      if (previa && previa.estado === 'creado') {
        return res.json({ ok: true, id_woo: previa.id_woo, sku: previa.sku, ya_creado: true });
      }
      if (previa && previa.estado !== 'fallido') {
        // 'procesando' o 'incierto': ya hay una alta en vuelo o de resultado desconocido para este
        // ítem — no se dispara una segunda a ciegas. 'fallido' es el único estado que libera reintento.
        return res.status(409).json({ ok: false, error: `alta '${previa.estado}': no se reintenta a ciegas`, operation_id: item.alta_operation_id });
      }
    }

    const operationId = randomUUID();
    const claim = db.prepare(
      'UPDATE recepcion_items SET alta_operation_id=? WHERE id=? AND (alta_operation_id IS NULL OR alta_operation_id=?)'
    ).run(operationId, itemId, item.alta_operation_id);
    if (claim.changes === 0) {
      // Otra llamada concurrente ganó el claim entre nuestro SELECT y este UPDATE.
      return res.status(409).json({ ok: false, error: 'otra alta ya está en curso para este ítem' });
    }

    try {
      const result = await crearBorradorWoo({ db, cfg, operationId, ficha: req.body?.ficha, actor: req.user?.username || 'sistema' });
      db.prepare("UPDATE recepcion_items SET id_woo=?, sku=?, estado_item='creado', error_wc=NULL WHERE id=?")
        .run(result.id_woo, result.sku, itemId);
      return res.json({ ok: true, id_woo: result.id_woo, sku: result.sku });
    } catch (e) {
      const status = /bloqueada|operationId|reutilizado/.test(e.message) ? 409 : /inválido|required|atributos|precio/.test(e.message) ? 400 : 502;
      return res.status(status).json({ ok: false, error: e.message, operation_id: operationId });
    }
  });

  // Migraciones
  try { db.prepare('ALTER TABLE recepcion_items ADD COLUMN recibido INTEGER NOT NULL DEFAULT 1').run(); } catch (_) { /* compatible con bases existentes */ }
  try { db.prepare('ALTER TABLE recepciones ADD COLUMN solo_documento INTEGER NOT NULL DEFAULT 0').run(); } catch (_) { /* compatible con bases existentes */ }
  try { db.prepare('ALTER TABLE recepciones ADD COLUMN numero_pedido_norm TEXT').run(); } catch (_) { /* compatible con bases existentes */ }
  try { db.prepare('ALTER TABLE pedidos ADD COLUMN numero_pedido_norm TEXT').run(); } catch (_) { /* compatible con bases existentes */ }

  // Migración estados de ítem (recepción confiable, sin pérdidas silenciosas)
  let estadoItemNuevo = false;
  try { db.prepare('ALTER TABLE recepcion_items ADD COLUMN estado_item TEXT').run(); estadoItemNuevo = true; } catch (_) { /* compatible con bases existentes */ }
  try { db.prepare('ALTER TABLE recepcion_items ADD COLUMN ficha_json TEXT').run(); } catch (_) { /* compatible con bases existentes */ }
  try { db.prepare('ALTER TABLE recepcion_items ADD COLUMN error_wc TEXT').run(); } catch (_) { /* compatible con bases existentes */ }
  try { db.prepare('ALTER TABLE recepcion_items ADD COLUMN resuelto_en TEXT').run(); } catch (_) { /* compatible con bases existentes */ }

  // P0.1: máquina de estados durable para la aplicación de stock. `operation_id` y `stock_objetivo`
  // se persisten ANTES del PATCH a WooCommerce, para poder conciliar un `operacion_incierta` sin adivinar.
  try { db.prepare('ALTER TABLE recepcion_items ADD COLUMN operation_id TEXT').run(); } catch (_) { /* compatible con bases existentes */ }
  try { db.prepare('ALTER TABLE recepcion_items ADD COLUMN stock_objetivo INTEGER').run(); } catch (_) { /* compatible con bases existentes */ }
  try { db.prepare('ALTER TABLE recepcion_items ADD COLUMN aplicando_desde TEXT').run(); } catch (_) { /* compatible con bases existentes */ }

  // P0.3: relación durable entre el ítem y la alta que lo respalda. Sin esto, un 'creado' persistido
  // es solo lo que el cliente afirmó — nunca una identidad verificable contra recepcion_altas_woo.
  try { db.prepare('ALTER TABLE recepcion_items ADD COLUMN alta_operation_id TEXT').run(); } catch (_) { /* compatible con bases existentes */ }

  // Backfill idempotente: corre una sola vez, cuando la columna estado_item recién se crea.
  // Vuelve visibles los históricos perdidos (sin_match) y los fallos WC silenciosos (error).
  if (estadoItemNuevo) {
    const backfill = db.transaction(() => {
      db.prepare(`UPDATE recepcion_items SET estado_item='no_recibido'
        WHERE recibido=0 AND recepcion_id IN (SELECT id FROM recepciones WHERE solo_documento=0)`).run();
      db.prepare(`UPDATE recepcion_items SET estado_item='aplicado'
        WHERE recibido=1 AND id_woo IS NOT NULL AND stock_nuevo IS NOT NULL
        AND recepcion_id IN (SELECT id FROM recepciones WHERE solo_documento=0 AND estado='confirmada')`).run();
      db.prepare(`UPDATE recepcion_items SET estado_item='sin_match'
        WHERE recibido=1 AND id_woo IS NULL
        AND recepcion_id IN (SELECT id FROM recepciones WHERE solo_documento=0 AND estado='confirmada')`).run();
      // No sabemos si el PATCH llegó a aplicarse en estos históricos: 'operacion_incierta' (conciliar
      // leyendo Woo), nunca 'error_reintentable' — eso habilitaría un reintento a ciegas y el doble stock.
      db.prepare(`UPDATE recepcion_items SET estado_item='operacion_incierta'
        WHERE recibido=1 AND id_woo IS NOT NULL AND stock_nuevo IS NULL
        AND recepcion_id IN (SELECT id FROM recepciones WHERE solo_documento=0 AND estado='confirmada')`).run();
      db.prepare(`UPDATE recepcion_items SET estado_item='pendiente'
        WHERE estado_item IS NULL
        AND recepcion_id IN (SELECT id FROM recepciones WHERE solo_documento=0 AND estado IN ('borrador','procesando'))`).run();
    });
    backfill();
  }

  // P0.1 (rows ya existentes, no ligado a la creación de la columna): cualquier 'error' que haya quedado
  // de la implementación previa (GET→PATCH→UPDATE sin verificación) es de historia ambigua — puede
  // representar un PATCH que sí llegó a aplicarse. Se convierte, conservador, a 'operacion_incierta' para
  // que se concilie leyendo Woo en vez de reintentarse a ciegas. Se conserva error_wc original como evidencia.
  // Verificado en data/fusion.sqlite el 2026-09-21: 0 filas en 'error' en producción hoy — este UPDATE es
  // no-op ahí. Se deja igual (fail-closed) por si otra base o un backup restaurado sí las tiene.
  db.prepare("UPDATE recepcion_items SET estado_item='operacion_incierta' WHERE estado_item='error'").run();

  // Lista historial de recepciones
  router.get('/', (req, res) => {
    const rows = db.prepare(`
      SELECT r.*,
        (SELECT COUNT(*) FROM recepcion_items WHERE recepcion_id = r.id) AS total_items,
        (SELECT COUNT(*) FROM recepcion_documentos WHERE recepcion_id = r.id) AS total_docs,
        (SELECT COUNT(*) FROM recepcion_items WHERE recepcion_id = r.id
           AND estado_item IN ('sin_match','pendiente_creacion','error_reintentable','operacion_incierta','conflicto_stock')) AS pendientes
      FROM recepciones r ORDER BY r.creado_en DESC LIMIT 100
    `).all();
    res.json({ ok: true, data: rows });
  });

  // Detalle de una recepción
  router.get('/:id', (req, res) => {
    const id = parseInt(req.params.id);
    const rec = db.prepare('SELECT * FROM recepciones WHERE id=?').get(id);
    if (!rec) return res.status(404).json({ ok: false, error: 'no encontrada' });
    const docs  = db.prepare('SELECT * FROM recepcion_documentos WHERE recepcion_id=?').all(id);
    const items = db.prepare('SELECT * FROM recepcion_items WHERE recepcion_id=? ORDER BY id').all(id);
    res.json({ ok: true, data: { ...rec, documentos: docs, items } });
  });

  // Guarda una recepción en estado borrador (sin tocar WooCommerce)
  router.post('/', (req, res) => {
    const { proveedor, importador, numero_pedido, fecha, notas, solo_documento = false, documentos = [], items = [] } = req.body || {};
    if (!proveedor) return res.status(400).json({ ok: false, error: 'proveedor requerido' });
    const now = new Date().toISOString();
    // Validar fecha: si viene pero no es YYYY-MM-DD válida, usar fecha actual
    const fechaValida = fecha && /^\d{4}-\d{2}-\d{2}$/.test(fecha) && !isNaN(Date.parse(fecha));
    const fechaDoc = fechaValida ? fecha : now.slice(0, 10);
    const importadorEfectivo = importador || proveedor;

    // Auto-crear o vincular pedido si viene número de pedido
    let pedidoId = null;
    const numPedNorm = normalizarNumeroPedido(numero_pedido);
    if (numPedNorm) {
      const numPedRaw = numero_pedido.trim();
      // Buscar primero por número normalizado (tolerante a prefijos/sufijos)
      let pedido = db.prepare(
        'SELECT id FROM pedidos WHERE numero_pedido_norm=? AND importador=?'
      ).get(numPedNorm, importadorEfectivo);
      if (!pedido) {
        // Crear nuevo pedido con número normalizado como clave de matching
        db.prepare(`INSERT OR IGNORE INTO pedidos (numero_pedido, numero_pedido_norm, importador, proveedor, estado, creado_en)
          VALUES (?,?,?,?,'pendiente',?)`).run(numPedRaw, numPedNorm, importadorEfectivo, proveedor, now);
        pedido = db.prepare(
          'SELECT id FROM pedidos WHERE numero_pedido_norm=? AND importador=?'
        ).get(numPedNorm, importadorEfectivo);
      }
      pedidoId = pedido?.id || null;
    }

    const soloDoc = solo_documento ? 1 : 0;
    const recId = db.prepare(
      'INSERT INTO recepciones (pedido_id,proveedor,importador,numero_pedido,numero_pedido_norm,fecha,notas,solo_documento,estado,creado_en) VALUES (?,?,?,?,?,?,?,?,?,?)'
    ).run(pedidoId, proveedor, importadorEfectivo, numero_pedido?.trim() || null, numPedNorm, fechaDoc, notas || null, soloDoc, 'borrador', now).lastInsertRowid;

    const insDoc  = db.prepare('INSERT INTO recepcion_documentos (recepcion_id,tipo,numero,nombre_archivo,drive_url,creado_en) VALUES (?,?,?,?,?,?)');
    const insItem = db.prepare(`
      INSERT INTO recepcion_items
        (recepcion_id,id_woo,sku,nombre_doc,codigo_proveedor,cantidad,precio_unitario,stock_previo,stock_nuevo,recibido,estado_item,alta_operation_id,creado_en)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    `);

    const saveAll = db.transaction(() => {
      for (const d of documentos) {
        // Sanitizar file_url: rechazar path traversal
        const fileUrl = d.file_url ? String(d.file_url).replace(/\.\.\//g, '').replace(/\.\.$/g, '') : null;
        insDoc.run(recId, d.tipo || 'otro', d.numero || null, d.nombre_archivo || null, fileUrl, now);
      }
      for (const it of items) {
        const recibido = it.recibido === false || it.recibido === 0 ? 0 : 1;
        // Validar cantidad: debe ser entero positivo
        const cantidad = Math.max(1, parseInt(it.cantidad) || 1);
        const { estado_item, alta_operation_id } = estadoItemAlGuardar(db, it);
        const itemId = insItem.run(recId, it.id_woo || null, it.sku || null, it.nombre_doc || it.nombre || '',
          it.codigo_proveedor || null, cantidad,
          it.precio_unitario || null, it.stock_previo || null, it.stock_nuevo || null, recibido,
          estado_item, alta_operation_id, now).lastInsertRowid;
        aprenderAliasSiCorresponde(db, it, { proveedor, id_woo: it.id_woo || null, recepcion_item_id: itemId, actor: req.user?.username || 'sistema' });
      }
    });
    saveAll();

    res.json({ ok: true, id: recId, pedido_id: pedidoId });
  });

  // Re-persiste items/docs de un borrador existente (para cuando el usuario editó post-save)
  router.post('/:id/actualizar', (req, res) => {
    const id = parseInt(req.params.id);
    const rec = db.prepare("SELECT estado FROM recepciones WHERE id=?").get(id);
    if (!rec) return res.status(404).json({ ok: false, error: 'no encontrada' });
    if (rec.estado !== 'borrador') return res.status(400).json({ ok: false, error: 'solo borradores' });

    const { items: newItems = [], documentos: newDocs = [] } = req.body || {};
    const now = new Date().toISOString();

    const updateRec = db.transaction(() => {
      db.prepare('DELETE FROM recepcion_items WHERE recepcion_id=?').run(id);
      db.prepare('DELETE FROM recepcion_documentos WHERE recepcion_id=?').run(id);

      const insDoc  = db.prepare('INSERT INTO recepcion_documentos (recepcion_id,tipo,numero,nombre_archivo,drive_url,creado_en) VALUES (?,?,?,?,?,?)');
      const insItem = db.prepare(`
        INSERT INTO recepcion_items
          (recepcion_id,id_woo,sku,nombre_doc,codigo_proveedor,cantidad,precio_unitario,stock_previo,stock_nuevo,recibido,estado_item,alta_operation_id,creado_en)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
      `);

      for (const d of newDocs) {
        const fileUrl = d.file_url ? String(d.file_url).replace(/\.\.\//g, '').replace(/\.\.$/g, '') : null;
        insDoc.run(id, d.tipo || 'otro', d.numero || null, d.nombre_archivo || null, fileUrl, now);
      }
      const proveedorRec = db.prepare('SELECT proveedor FROM recepciones WHERE id=?').get(id)?.proveedor;
      for (const it of newItems) {
        const recibido = it.recibido === false || it.recibido === 0 ? 0 : 1;
        const cantidad = Math.max(1, parseInt(it.cantidad) || 1);
        const idWooEfectivo = it.id_woo || null;
        const { estado_item, alta_operation_id } = estadoItemAlGuardar(db, { ...it, id_woo: idWooEfectivo });
        const itemId = insItem.run(id, idWooEfectivo, it.sku_wc || it.sku || null, it.nombre_doc || it.nombre || '',
          it.codigo_proveedor || null, cantidad,
          it.precio_unitario || null, it.stock_wc ?? null, null, recibido,
          estado_item, alta_operation_id, now).lastInsertRowid;
        aprenderAliasSiCorresponde(db, it, { proveedor: proveedorRec, id_woo: idWooEfectivo, recepcion_item_id: itemId, actor: req.user?.username || 'sistema' });
      }
    });
    updateRec();
    res.json({ ok: true, id });
  });

  // Confirma una recepción: actualiza stock en WooCommerce ítem a ítem
  router.post('/:id/confirmar', async (req, res) => {
    const id = parseInt(req.params.id);

    // Marcar como 'procesando' atómicamente — si ya fue confirmada o no existe, changes=0
    const lock = db.prepare(
      "UPDATE recepciones SET estado='procesando' WHERE id=? AND estado IN ('borrador','confirmada_con_pendientes')"
    ).run(id);

    if (lock.changes === 0) {
      const rec = db.prepare('SELECT estado FROM recepciones WHERE id=?').get(id);
      if (!rec) return res.status(404).json({ ok: false, error: 'no encontrada' });
      return res.status(400).json({ ok: false, error: rec.estado === 'confirmada' ? 'ya confirmada' : 'ya en proceso' });
    }

    const recMeta = db.prepare('SELECT pedido_id, solo_documento FROM recepciones WHERE id=?').get(id);
    const resultados = [];
    const sync_ml = [];

    // Solo actualiza WC si no es "solo documento"
    if (!recMeta?.solo_documento) {
      const items = db.prepare("SELECT * FROM recepcion_items WHERE recepcion_id=? AND id_woo IS NOT NULL AND recibido=1 AND (estado_item IS NULL OR estado_item IN ('pendiente','creado','error_reintentable'))").all(id);
      for (const it of items) {
        try {
          // P0.3: nunca aplicar stock sobre un 'creado' sin volver a verificar contra Woo — no confiar
          // en que la fila diga 'creado' porque en algún momento (al guardar) se pudo comprobar.
          if (it.estado_item === 'creado') {
            await verificarAltaCreado(db, cfg, it);
          }
          const r = await aplicarStockItem(db, cfg, it);
          resultados.push({ sku: it.sku, nombre: it.nombre_doc, ok: true, alta_borrador: it.estado_item === 'creado', stock_previo: r.stock_previo, stock_nuevo: r.stock_nuevo });
        } catch (e) {
          // aplicarStockItemInterno ya persistió el estado terminal correcto ('error_reintentable' /
          // 'operacion_incierta' / 'conflicto_stock') antes de lanzar, o no tocó nada si el ítem ya
          // estaba en un estado no reintentable (EstadoNoReintentableError). Pisarlo acá a 'error' a
          // ciegas borraría esa distinción y volvería a hacer elegible para reintento algo que no debe.
          resultados.push({ sku: it.sku, nombre: it.nombre_doc, ok: false, error: e.message });
        }
      }

      // Marcar explícitamente los ítems que NO se aplicaron — nada se pierde en silencio.
      // (los 'pendiente_creacion' ya marcados se conservan; los ítems con estado terminal ('error_reintentable'/'aplicando'/'operacion_incierta'/'conflicto_stock'/'aplicado') ya tienen id_woo y no matchean el WHERE de sin_match)
      db.prepare(`UPDATE recepcion_items SET estado_item='sin_match'
        WHERE recepcion_id=? AND recibido=1 AND id_woo IS NULL
        AND (estado_item IS NULL OR estado_item NOT IN ('pendiente_creacion','creado'))`).run(id);
      db.prepare(`UPDATE recepcion_items SET estado_item='no_recibido'
        WHERE recepcion_id=? AND recibido=0`).run(id);

      // Actualizar estado del pedido asociado solo cuando la recepción tocó stock.
      // Una recepción "solo documento" no debe inflar el avance del pedido.
      if (recMeta?.pedido_id) {
        db.prepare("UPDATE pedidos SET estado='recibido_parcial' WHERE id=? AND estado='pendiente'")
          .run(recMeta.pedido_id);
      }
    }

    const now = new Date().toISOString();

    // Sincronizar a ML DESPUÉS de confirmar la recepción (no antes): esto son llamadas de
    // red que pueden tardar decenas de segundos con un lote grande, y no tienen que dejar
    // la recepción en 'procesando' sin salida si el proceso muere en el medio (el lock de
    // la línea ~242 solo acepta reabrir desde 'borrador', no hay recuperación de
    // 'procesando' hoy). Un solo push por SKU (no por ítem): si dos ítems son el mismo
    // SKU, se lee el stock FINAL de catalogo_cache (ya actualizado arriba), el orden no
    // importa. Solo para SKUs que sí se aplicaron con éxito — si aplicarStockItem falló,
    // catalogo_cache sigue con el stock viejo y no hay nada correcto que empujar.
    // Los productos creados desde Recepción son drafts locales: su primer stock no se
    // publica en Mercado Libre. El resto del legado conserva su sincronización normal.
    // P0.3: evidencia explícita de la exclusión — no un silencio indistinguible de "no había nada para
    // sincronizar". `syncSkuPuntual` NUNCA se llama para estos SKUs (ver el filtro `!r.alta_borrador`
    // de abajo); esta entrada es solo un registro de que se excluyó a propósito, no una llamada a ML.
    for (const r of resultados.filter(r => r.ok && r.sku && r.alta_borrador)) {
      sync_ml.push({ sku: r.sku, estado: 'excluido_alta', detalle: 'primer stock de una alta nueva: no se sincroniza a Mercado Libre' });
    }
    const skusAplicados = [...new Set(resultados.filter(r => r.ok && r.sku && !r.alta_borrador).map(r => r.sku))];
    for (const sku of skusAplicados) {
      try {
        sync_ml.push(await syncSkuPuntual(db, cfg, sku));
      } catch (eSync) {
        // syncSkuPuntual no debería tirar, pero un fallo acá nunca debe tocar `resultados`
        // ni el estado de la recepción — la escritura a Woo y la confirmación ya se hicieron.
        sync_ml.push({ sku, estado: 'error', detalle: `Excepción inesperada: ${eSync.message}` });
      }
    }

    const errores = resultados.filter(r => !r.ok).length;
    const aplicados = resultados.filter(r => r.ok).length;
    const soloDoc = recMeta?.solo_documento === 1;
    const estadoFinal = errores ? 'confirmada_con_pendientes' : 'confirmada';
    db.prepare("UPDATE recepciones SET estado=?, confirmado_en=? WHERE id=?").run(estadoFinal, now, id);

    // Ítems que quedaron pendientes de resolver (visibles, no perdidos)
    const pendientes = soloDoc ? [] : db.prepare(`
      SELECT id, id_woo, sku, nombre_doc, codigo_proveedor, cantidad, estado_item, error_wc
      FROM recepcion_items
      WHERE recepcion_id=? AND estado_item IN ('sin_match','pendiente_creacion','error_reintentable','operacion_incierta','conflicto_stock')
      ORDER BY id
    `).all(id);
    const sin_match = pendientes.filter(p => p.estado_item === 'sin_match').length;

    res.json({ ok: true, estado: estadoFinal, aplicados, errores, sin_match, resultados, pendientes, confirmado_en: now, solo_documento: soloDoc, sync_ml });
  });

  return router;
}
