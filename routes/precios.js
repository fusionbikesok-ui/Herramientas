/**
 * Auditoría de precios ML: compara el neto que recibe el vendedor (precio − comisión − envío)
 * contra el precio de CONTADO de cada publicación activa mapeada, para detectar precios mal
 * puestos. catalogo_cache.regular_price guarda el precio de LISTA (catalogo_cache.precio es
 * el VIGENTE, que ya trae el sale_price si hay oferta); precioContado() en lib/mlPrecios.js
 * convierte el de lista a precio de contado antes de comparar — ver el comentario ahí.
 *
 * El scan es largo (~1000 publicaciones × varias llamadas a ML), así que corre en background
 * y persiste el resultado en ml_precio_auditoria; la página lee esa tabla y muestra progreso.
 */

import { Router } from 'express';
import { mlFetch } from '../lib/mlClient.js';
import { netoMl, veredictoNeto, upsertAuditoria, precioContado, precioObjetivoMl } from '../lib/mlPrecios.js';
import { partirClaveMl, extraerErrorMl } from '../lib/mlUtil.js';
import { sincronizarAuditoriaPreciosDesdeCache, estadoProgresoAuditoria, estadoAuditoriaPrecios, auditoriaEnCurso } from '../lib/auditoriaPrecios.js';

const MULTIGET_CHUNK = 20;
const ML_CALL_DELAY_MS = 500;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const now = () => new Date().toISOString();
const mlCfgOk = (cfg) => cfg?.clientId && cfg?.clientSecret && cfg?.userId;

// Estado de la corrida en curso (proceso único bajo PM2).
let _auditEnCurso = false;
let _auditProgreso = { enCurso: false, hechos: 0, total: 0, inicio: null, fin: null, error: null };

/** Precio efectivo de la clave: precio de la variación si existe, si no el del item. */
function precioEfectivo(item, variationId) {
  if (variationId) {
    const v = (item.variations || []).find(v => String(v.id) === String(variationId));
    if (v && v.price != null) return v.price;
  }
  return item.price ?? null;
}

/**
 * Recorre las publicaciones activas mapeadas, calcula el neto vs el precio web y upsertea
 * el veredicto en ml_precio_auditoria. Guardado contra corridas concurrentes.
 */
export async function auditarPrecios(db, mlCfg) {
  // La auditoría ya no relee `/items`: el refresco ML guarda precio, categoría, tipo y envío
  // gratis en ml_publicaciones_cache. Se conserva este export para callers/tests históricos.
  return sincronizarAuditoriaPreciosDesdeCache(db, { origen: 'manual', manual: true, mlCfg });
  /* c8 ignore start -- implementación remota histórica, retirada al migrar a proyección local.
  if (!mlCfgOk(mlCfg)) throw new Error('MercadoLibre no configurado');
  if (_auditEnCurso) return { yaEnCurso: true };
  _auditEnCurso = true;

  // c.regular_price es el precio de LISTA (ver JSDoc arriba); NUNCA c.precio (vigente, ya
  // trae el sale_price si el producto está en oferta) — evita acumular dos descuentos.
  const candidatas = db.prepare(`
    SELECT p.clave, p.item_id, p.variation_id, p.titulo, d.sku, c.regular_price AS precio_lista
    FROM ml_publicaciones_cache p
    JOIN sku_matcher_decisiones d ON d.clave = p.clave AND d.accion IN ('asignar','confirmar') AND d.sku <> ''
    LEFT JOIN catalogo_cache c ON c.sku = d.sku AND c.sku <> ''
    WHERE p.status = 'active'
    ORDER BY p.item_id
  `).all().map(c => ({ ...c, precio_web: precioContado(c.precio_lista) }));

  _auditProgreso = { enCurso: true, hechos: 0, total: candidatas.length, inicio: now(), fin: null, error: null };

  // Agrupar claves por item para un multiget por lote y compartir shipping/fee.
  const porItem = new Map();
  for (const c of candidatas) {
    if (!porItem.has(c.item_id)) porItem.set(c.item_id, []);
    porItem.get(c.item_id).push(c);
  }
  const itemIds = [...porItem.keys()];

  const caches = { fee: new Map(), envio: new Map() };

  try {
    for (let i = 0; i < itemIds.length; i += MULTIGET_CHUNK) {
      const chunk = itemIds.slice(i, i + MULTIGET_CHUNK);
      const resp = await mlFetch(
        db, mlCfg, 'get',
        `/items?ids=${chunk.join(',')}&attributes=id,price,category_id,listing_type_id,shipping,variations,status`
      );
      await sleep(ML_CALL_DELAY_MS);

      const items = new Map();
      if (resp.status === 200 && Array.isArray(resp.data)) {
        for (const e of resp.data) if (e.code === 200 && e.body) items.set(String(e.body.id), e.body);
      }

      for (const itemId of chunk) {
        const item = items.get(itemId);
        const filas = porItem.get(itemId) || [];
        for (const fila of filas) {
          let precio_ml = null, sale_fee = null, envio = null, neto = null, estado = 'sin_precio', deficit_pct = null;
          if (item) {
            precio_ml = precioEfectivo(item, fila.variation_id);
            const freeShipping = !!item.shipping?.free_shipping;
            const r = await netoMl(db, mlCfg, {
              itemId, price: precio_ml, categoryId: item.category_id,
              listingTypeId: item.listing_type_id, freeShipping,
            }, caches);
            sale_fee = r.sale_fee; envio = r.envio; neto = r.neto;
            const v = veredictoNeto(neto, fila.precio_web);
            estado = v.estado; deficit_pct = v.deficitPct;
            await sleep(ML_CALL_DELAY_MS);
          }
          upsertAuditoria(db, {
            clave: fila.clave, item_id: itemId, titulo: fila.titulo, sku: fila.sku,
            precio_ml, sale_fee, envio, neto, precio_web: fila.precio_web,
            deficit_pct, estado, actualizado_en: now(),
          });
          _auditProgreso.hechos++;
        }
      }
    }
    _auditProgreso.fin = now();
    return { total: candidatas.length };
  } catch (e) {
    _auditProgreso.error = e.message;
    throw e;
  } finally {
    _auditProgreso.enCurso = false;
    _auditEnCurso = false;
  }
  c8 ignore stop */
}

/** Path + body para actualizar el precio de una publicación/variación en ML. */
function buildMlPriceUpdate(itemId, variationId, precio) {
  if (variationId) return { path: `/items/${itemId}/variations/${variationId}`, body: { price: precio } };
  return { path: `/items/${itemId}`, body: { price: precio } };
}

/**
 * Recalcula el neto/veredicto de una sola clave (tras corregir su precio en ML) y lo
 * persiste en ml_precio_auditoria. Devuelve la fila actualizada (con thumbnail) o null
 * si la clave ya no está mapeada o la publicación no se pudo consultar.
 */
async function refrescarFila(db, mlCfg, clave) {
  const filaRaw = db.prepare(`
    SELECT p.clave, p.item_id, p.variation_id, p.titulo, d.sku, c.regular_price AS precio_lista
    FROM ml_publicaciones_cache p
    JOIN sku_matcher_decisiones d ON d.clave = p.clave AND d.accion IN ('asignar','confirmar') AND d.sku <> ''
    LEFT JOIN catalogo_cache c ON c.sku = d.sku AND c.sku <> ''
    WHERE p.clave = ?
  `).get(clave);
  if (!filaRaw) return null;
  const fila = { ...filaRaw, precio_web: precioContado(filaRaw.precio_lista) };

  const resp = await mlFetch(db, mlCfg, 'get',
    `/items/${fila.item_id}?attributes=id,price,category_id,listing_type_id,shipping,variations,status`,
    null, { manual: true });
  if (resp.status !== 200 || !resp.data) return null;
  const item = resp.data;

  let precio_ml = null, sale_fee = null, envio = null, neto = null, estado = 'sin_precio', deficit_pct = null;
  if (item.status === 'active') {
    precio_ml = precioEfectivo(item, fila.variation_id);
    const freeShipping = !!item.shipping?.free_shipping;
    const r = await netoMl(db, mlCfg, {
      itemId: fila.item_id, price: precio_ml, categoryId: item.category_id,
      listingTypeId: item.listing_type_id, freeShipping,
    }, {}, { manual: true });
    sale_fee = r.sale_fee; envio = r.envio; neto = r.neto;
    const v = veredictoNeto(neto, fila.precio_web);
    estado = v.estado; deficit_pct = v.deficitPct;
  }

  upsertAuditoria(db, {
    clave: fila.clave, item_id: fila.item_id, titulo: fila.titulo, sku: fila.sku,
    precio_ml, sale_fee, envio, neto, precio_web: fila.precio_web,
    deficit_pct, estado, actualizado_en: now(),
  });

  return db.prepare(`
    SELECT a.clave, a.item_id, a.titulo, a.sku, a.precio_ml, a.sale_fee, a.envio, a.neto,
           a.precio_web, a.deficit_pct, a.estado, a.actualizado_en, p.thumbnail,
           c.marca AS marca, c.categorias_json AS categorias_json, c.stock AS stock
    FROM ml_precio_auditoria a
    LEFT JOIN ml_publicaciones_cache p ON p.clave = a.clave
    LEFT JOIN (
      SELECT sku, marca, categorias_json, stock
      FROM catalogo_cache c1
      WHERE sku <> '' AND actualizado_en = (
        SELECT MAX(actualizado_en) FROM catalogo_cache c2 WHERE c2.sku = c1.sku
      )
      GROUP BY sku
    ) c ON c.sku = a.sku
    WHERE a.clave = ?
  `).get(clave);
}

export function preciosRouter(db, cfg) {
  const router = Router();
  const { ml: mlCfg } = cfg ?? {};

  // Dispara el recálculo en background (no bloquea la respuesta).
  router.post('/recalcular', (req, res) => {
    if (!mlCfgOk(mlCfg)) return res.status(400).json({ ok: false, error: 'MercadoLibre no configurado' });
    if (auditoriaEnCurso()) return res.status(409).json({ ok: false, error: 'Ya hay un recálculo en curso' });
    auditarPrecios(db, mlCfg).catch(err => console.error('auditarPrecios error:', err.message));
    res.json({ ok: true, iniciado: true });
  });

  router.get('/estado', (req, res) => {
    const resumen = { ok: 0, bajo: 0, alto: 0, sin_precio: 0 };
    for (const r of db.prepare('SELECT estado, COUNT(*) n FROM ml_precio_auditoria GROUP BY estado').all()) {
      if (r.estado in resumen) resumen[r.estado] = r.n;
    }
    const ultimo = db.prepare('SELECT MAX(actualizado_en) u FROM ml_precio_auditoria').get()?.u || null;
    res.json({ ok: true, ..._auditProgreso, ...estadoProgresoAuditoria(), ...estadoAuditoriaPrecios(db), ultimo, resumen });
  });

  // Lista de publicaciones auditadas. Por defecto solo los problemas (bajo/alto/sin_precio).
  router.get('/', (req, res) => {
    const estado = String(req.query.estado || 'problemas');
    let where;
    if (estado === 'all') where = '1=1';
    else if (['bajo', 'alto', 'sin_precio', 'ok'].includes(estado)) where = `a.estado = '${estado}'`;
    else where = "a.estado IN ('bajo','alto','sin_precio')";
    // Total real (sin LIMIT), para no reportar el tope de la query como si fuera el total.
    const totalReal = db.prepare(`SELECT COUNT(*) n FROM ml_precio_auditoria a WHERE ${where}`).get().n;
    const rows = db.prepare(`
      SELECT a.clave, a.item_id, a.titulo, a.sku, a.precio_ml, a.sale_fee, a.envio, a.neto,
             a.precio_web, a.deficit_pct, a.estado, a.actualizado_en, p.thumbnail,
             c.marca AS marca, c.categorias_json AS categorias_json, c.stock AS stock
      FROM ml_precio_auditoria a
      LEFT JOIN ml_publicaciones_cache p ON p.clave = a.clave
      LEFT JOIN (
        SELECT sku, marca, categorias_json, stock
        FROM catalogo_cache c1
        WHERE sku <> '' AND actualizado_en = (
          SELECT MAX(actualizado_en) FROM catalogo_cache c2 WHERE c2.sku = c1.sku
        )
        GROUP BY sku
      ) c ON c.sku = a.sku
      WHERE ${where}
      ORDER BY CASE a.estado WHEN 'bajo' THEN 0 WHEN 'alto' THEN 1 WHEN 'sin_precio' THEN 2 ELSE 3 END,
               a.deficit_pct DESC
      LIMIT 1000
    `).all();
    // Sin `precio_sugerido`: esa fórmula cerrada ignoraba que la comisión de ML tiene parte
    // fija y que el envío se recotiza al precio nuevo, así que dejaba el neto corto. El precio
    // objetivo lo calcula `POST /objetivo` contra ML, a pedido y sobre lo seleccionado.
    const data = rows;
    // total = COUNT real (no el LIMIT); truncado avisa cuando data.length quedó recortado.
    res.json({ ok: true, total: totalReal, truncado: totalReal > data.length, data });
  });

  // Corrige el precio de una publicación/variación en ML y refresca su fila auditada.
  /**
   * Precio objetivo: el que deja el neto igual al precio de contado de la tienda.
   *
   * Es sólo CÁLCULO — no escribe nada en ML. Lo usan las dos puertas: el reactivador (sobre las
   * publicaciones frenadas por precio) y, más adelante, la auditoría. Aplicar es una acción
   * aparte que dispara el usuario (`/actualizar-precio`).
   *
   * Devuelve una fila por clave, con el desglose completo: sin ver de qué se compone el precio,
   * aplicarlo es un acto de fe.
   */
  router.post('/objetivo', async (req, res) => {
    if (!mlCfgOk(mlCfg)) return res.status(400).json({ ok: false, error: 'MercadoLibre no configurado' });
    const claves = Array.isArray(req.body?.claves)
      ? [...new Set(req.body.claves.map(v => String(v || '').trim()).filter(Boolean))]
      : [];
    if (!claves.length) return res.status(400).json({ ok: false, error: 'Indicá `claves` (array no vacío).' });
    if (claves.length > 100) return res.status(400).json({ ok: false, error: 'Máximo 100 publicaciones por vez.' });

    // El contado sale de donde ya está calculado: la frenada lo guarda, y si no, del catálogo.
    const contadoDe = db.prepare(`
      SELECT COALESCE(f.precio_contado, ?) AS contado FROM ml_reactivacion_frenada f WHERE f.clave = ?
    `);
    // Mismo origen que la auditoría (`auditarPrecios`): el SKU sale de la decisión del matcher
    // —no del `seller_sku` crudo, que difiere en algunas— y el precio de `regular_price`, el de
    // LISTA. Con `c.precio` (vigente) una oferta de la web se descontaría dos veces y el objetivo
    // quedaría por debajo del contado real.
    const contadoDelCatalogo = db.prepare(`
      SELECT c.regular_price AS precio_lista FROM ml_publicaciones_cache p
      LEFT JOIN sku_matcher_decisiones d
        ON d.clave = p.clave AND d.accion IN ('asignar','confirmar') AND d.sku <> ''
      LEFT JOIN catalogo_cache c
        ON c.sku = COALESCE(NULLIF(d.sku,''), NULLIF(p.seller_sku,'')) AND c.sku <> ''
      WHERE p.clave = ? LIMIT 1
    `);
    const envioAuditado = db.prepare('SELECT envio FROM ml_precio_auditoria WHERE clave = ?');

    const caches = { fee: new Map(), envio: new Map() };
    const resultados = [];
    try {
      for (let i = 0; i < claves.length; i += MULTIGET_CHUNK) {
        const chunk = claves.slice(i, i + MULTIGET_CHUNK);
        const porItem = new Map();
        for (const clave of chunk) {
          const { itemId, variationId } = partirClaveMl(clave);
          if (!itemId) { resultados.push({ clave, precio: null, motivo: 'Clave inválida' }); continue; }
          if (!porItem.has(itemId)) porItem.set(itemId, []);
          porItem.get(itemId).push({ clave, variationId });
        }
        if (!porItem.size) continue;

        const resp = await mlFetch(
          db, mlCfg, 'get',
          `/items?ids=${[...porItem.keys()].join(',')}&attributes=id,price,category_id,listing_type_id,shipping,variations,status`
        );
        await sleep(ML_CALL_DELAY_MS);
        const items = new Map();
        if (resp.status === 200 && Array.isArray(resp.data)) {
          for (const e of resp.data) if (e.code === 200 && e.body) items.set(String(e.body.id), e.body);
        }

        for (const [itemId, filas] of porItem) {
          const item = items.get(itemId);
          for (const { clave, variationId } of filas) {
            if (!item) {
              resultados.push({ clave, precio: null, motivo: 'ML no devolvió la publicación.' });
              continue;
            }
            const precioActual = precioEfectivo(item, variationId);
            const lista = contadoDelCatalogo.get(clave)?.precio_lista ?? null;
            const contado = contadoDe.get(precioContado(lista), clave)?.contado ?? precioContado(lista);
            const envioActual = envioAuditado.get(clave)?.envio ?? null;

            const r = await precioObjetivoMl(db, mlCfg, {
              itemId,
              categoryId: item.category_id,
              listingTypeId: item.listing_type_id,
              freeShipping: !!item.shipping?.free_shipping,
              contado,
              envioActual,
            }, caches);
            await sleep(ML_CALL_DELAY_MS);

            resultados.push({
              clave, item_id: itemId, sku: item.seller_custom_field || null,
              precio_actual: precioActual,
              contado,
              ...r,
              // Cuánto sube o baja, para que la confirmación diga algo entendible.
              delta: r.precio != null && precioActual > 0 ? +(r.precio - precioActual).toFixed(2) : null,
            });
          }
        }
      }
      res.json({
        ok: true,
        resultados,
        calculadas: resultados.filter(r => r.precio != null).length,
        sin_precio: resultados.filter(r => r.precio == null).length,
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  router.post('/actualizar-precio', async (req, res) => {
    if (!mlCfgOk(mlCfg)) return res.status(400).json({ ok: false, error: 'MercadoLibre no configurado' });
    const { clave } = req.body || {};
    const precio = Number(req.body?.precio);
    if (!clave || !(precio > 0)) return res.status(400).json({ ok: false, error: 'Faltan clave o precio válido' });
    const { itemId, variationId } = partirClaveMl(clave);
    if (!itemId) return res.status(400).json({ ok: false, error: 'Clave inválida' });
    try {
      const { path, body } = buildMlPriceUpdate(itemId, variationId, precio);
      const resp = await mlFetch(db, mlCfg, 'put', path, body, { manual: true });
      if (resp.status !== 200) return res.status(400).json({ ok: false, error: extraerErrorMl(resp) });
      // Cerrar el agujero encontrado por el revisor (BLOQUEANTE 1): `ml_publicaciones_cache.precio`
      // NO se refresca por ningún cron (solo por el refresco manual del matcher), así que si el
      // operador corrige acá el precio que frenó una reactivación automática, sin esto la fila de
      // ml_reactivacion_frenada seguía viva y `necesitaRecheck` (routes/sync.js) leía el precio
      // local desactualizado como "no cambió" — la reactivación quedaba sin efecto hasta la red
      // de seguridad de horas, sin error ni rastro. Este es el punto exacto donde el sistema SABE
      // que el precio de ML cambió: se actualiza el caché y se borra la frenada, si existía.
      // Fail-open respecto del PUT: si esto falla, el precio en ML YA se corrigió y la respuesta
      // al usuario no debe fallar por un problema de caché local — se deja rastro en el log.
      try {
        db.prepare('UPDATE ml_publicaciones_cache SET precio = ?, precio_actualizado_en = ? WHERE clave = ?')
          .run(precio, now(), clave);
        db.prepare('DELETE FROM ml_reactivacion_frenada WHERE clave = ?').run(clave);
      } catch (e) {
        console.error(`actualizar-precio: no se pudo refrescar el caché local de ${clave}:`, e.message);
      }
      const fila = await refrescarFila(db, mlCfg, clave);
      res.json({ ok: true, data: fila });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  return router;
}
