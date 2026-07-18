/**
 * Auditoría de precios ML: compara el neto que recibe el vendedor (precio − comisión − envío)
 * contra el precio web de cada publicación activa mapeada, para detectar precios mal puestos.
 *
 * El scan es largo (~1000 publicaciones × varias llamadas a ML), así que corre en background
 * y persiste el resultado en ml_precio_auditoria; la página lee esa tabla y muestra progreso.
 */

import { Router } from 'express';
import { mlFetch } from '../lib/mlClient.js';
import { netoMl, veredictoNeto } from '../lib/mlPrecios.js';

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
  if (!mlCfgOk(mlCfg)) throw new Error('MercadoLibre no configurado');
  if (_auditEnCurso) return { yaEnCurso: true };
  _auditEnCurso = true;

  const candidatas = db.prepare(`
    SELECT p.clave, p.item_id, p.variation_id, p.titulo, d.sku, c.precio AS precio_web
    FROM ml_publicaciones_cache p
    JOIN sku_matcher_decisiones d ON d.clave = p.clave AND d.accion IN ('asignar','confirmar') AND d.sku <> ''
    LEFT JOIN catalogo_cache c ON c.sku = d.sku AND c.sku <> ''
    WHERE p.status = 'active'
    ORDER BY p.item_id
  `).all();

  _auditProgreso = { enCurso: true, hechos: 0, total: candidatas.length, inicio: now(), fin: null, error: null };

  // Agrupar claves por item para un multiget por lote y compartir shipping/fee.
  const porItem = new Map();
  for (const c of candidatas) {
    if (!porItem.has(c.item_id)) porItem.set(c.item_id, []);
    porItem.get(c.item_id).push(c);
  }
  const itemIds = [...porItem.keys()];

  const upsert = db.prepare(`
    INSERT INTO ml_precio_auditoria
      (clave, item_id, titulo, sku, precio_ml, sale_fee, envio, neto, precio_web, deficit_pct, estado, actualizado_en)
    VALUES (@clave, @item_id, @titulo, @sku, @precio_ml, @sale_fee, @envio, @neto, @precio_web, @deficit_pct, @estado, @actualizado_en)
    ON CONFLICT(clave) DO UPDATE SET
      item_id=excluded.item_id, titulo=excluded.titulo, sku=excluded.sku, precio_ml=excluded.precio_ml,
      sale_fee=excluded.sale_fee, envio=excluded.envio, neto=excluded.neto, precio_web=excluded.precio_web,
      deficit_pct=excluded.deficit_pct, estado=excluded.estado, actualizado_en=excluded.actualizado_en
  `);
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
          upsert.run({
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
}

export function preciosRouter(db, cfg) {
  const router = Router();
  const { ml: mlCfg } = cfg ?? {};

  // Dispara el recálculo en background (no bloquea la respuesta).
  router.post('/recalcular', (req, res) => {
    if (!mlCfgOk(mlCfg)) return res.status(400).json({ ok: false, error: 'MercadoLibre no configurado' });
    if (_auditEnCurso) return res.status(409).json({ ok: false, error: 'Ya hay un recálculo en curso' });
    auditarPrecios(db, mlCfg).catch(err => console.error('auditarPrecios error:', err.message));
    res.json({ ok: true, iniciado: true });
  });

  router.get('/estado', (req, res) => {
    const resumen = { ok: 0, bajo: 0, alto: 0, sin_precio: 0 };
    for (const r of db.prepare('SELECT estado, COUNT(*) n FROM ml_precio_auditoria GROUP BY estado').all()) {
      if (r.estado in resumen) resumen[r.estado] = r.n;
    }
    const ultimo = db.prepare('SELECT MAX(actualizado_en) u FROM ml_precio_auditoria').get()?.u || null;
    res.json({ ok: true, ..._auditProgreso, ultimo, resumen });
  });

  // Lista de publicaciones auditadas. Por defecto solo los problemas (bajo/alto/sin_precio).
  router.get('/', (req, res) => {
    const estado = String(req.query.estado || 'problemas');
    let where;
    if (estado === 'all') where = '1=1';
    else if (['bajo', 'alto', 'sin_precio', 'ok'].includes(estado)) where = `a.estado = '${estado}'`;
    else where = "a.estado IN ('bajo','alto','sin_precio')";
    const rows = db.prepare(`
      SELECT a.clave, a.item_id, a.titulo, a.sku, a.precio_ml, a.sale_fee, a.envio, a.neto,
             a.precio_web, a.deficit_pct, a.estado, a.actualizado_en, p.thumbnail
      FROM ml_precio_auditoria a
      LEFT JOIN ml_publicaciones_cache p ON p.clave = a.clave
      WHERE ${where}
      ORDER BY CASE a.estado WHEN 'bajo' THEN 0 WHEN 'alto' THEN 1 WHEN 'sin_precio' THEN 2 ELSE 3 END,
               a.deficit_pct DESC
      LIMIT 1000
    `).all();
    res.json({ ok: true, total: rows.length, data: rows });
  });

  return router;
}
