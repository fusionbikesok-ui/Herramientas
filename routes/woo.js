import axios from 'axios';
import express from 'express';
import { normalizarProductoWc, normalizarVariacionWc, filaCatalogo } from '../lib/modelos/producto.js';
import { mapConLimite } from '../lib/concurrencia.js';

const MAX_PAGES = 200; // 200 × 100 items = 20.000 productos máximo por refresco

// Máximo de productos variables cuyos endpoints de variaciones se consultan en paralelo.
// Antes se recorrían en serie (una request tras otra), lo que con catálogos grandes hacía
// que el POST /catalogo/recargar superara el proxy_read_timeout de nginx (~120s) y se cayera
// el request. Se acota la concurrencia (mismo patrón que Sync ML con ML_CONCURRENCIA_MAX) para
// no dispararlas todas de golpe y evitar rate-limits/carga en WooCommerce.
const WOO_CONCURRENCIA_MAX = 4;

export async function wooFetch(cfg, path, method = 'get', body = null) {
  if (!cfg.url.startsWith('https://')) {
    throw new Error('WooCommerce URL debe usar HTTPS');
  }
  const url = cfg.url.replace(/\/$/, '') + '/wp-json/wc/v3' + path;
  const resp = await axios.request({
    url,
    method,
    data: body ?? undefined,
    auth: { username: cfg.ck, password: cfg.cs },
    timeout: 20000, // sin timeout, una request colgada congela el sync y toma el candado
    validateStatus: () => true
  });
  if (resp.status < 200 || resp.status >= 300) {
    throw new Error(`WooCommerce API error ${resp.status}`);
  }
  return resp;
}

export async function refrescarCatalogo(db, cfg) {
  const crudos = [];
  let page = 1;
  while (page <= MAX_PAGES) {
    const resp = await wooFetch(cfg, `/products?per_page=100&page=${page}&status=any`);
    if (!resp.data.length) break;
    crudos.push(...resp.data);
    if (resp.data.length < 100) break;
    page++;
  }

  const productos = crudos.map(normalizarProductoWc);

  // Fetch variations for variable products (they have their own SKUs and aren't returned by /products).
  // Se paraleliza por producto con concurrencia acotada (WOO_CONCURRENCIA_MAX): la paginación de
  // variaciones de un mismo padre sigue siendo serial (cada página depende de la anterior), pero los
  // distintos padres se consultan en paralelo. Cada tarea captura su propio error y lo devuelve, así
  // un producto que falla no frena a los demás; los errores se re-lanzan al final para conservar el
  // comportamiento observable anterior (recargar falla si alguna llamada a WC falla).
  //
  // OJO: no hay cancelación anticipada. A diferencia del loop serial anterior (que cortaba en el
  // primer error), ante un fallo las demás tareas en vuelo y las pendientes de la cola siguen
  // ejecutándose hasta drenar todo el lote — es decir, se pueden disparar hasta WOO_CONCURRENCIA_MAX
  // requests en paralelo aun cuando WC ya está fallando (ej. 429/5xx), amplificando la carga. El
  // corte es fail-closed de la ESCRITURA, no de las llamadas HTTP: recién se aborta antes de la
  // transacción de persistencia (más abajo), no de las requests a WC. Aceptado por simplicidad.
  const variableProds = crudos.filter(p => p.type === 'variable');
  const resultadosVar = await mapConLimite(variableProds, WOO_CONCURRENCIA_MAX, async (vp) => {
    const padre = normalizarProductoWc(vp);
    const variaciones = [];
    try {
      let vpage = 1;
      while (vpage <= 20) {
        const vresp = await wooFetch(cfg, `/products/${vp.id}/variations?per_page=100&page=${vpage}&status=any`);
        if (!vresp.data.length) break;
        for (const v of vresp.data) {
          if (!v.sku) continue;
          variaciones.push(normalizarVariacionWc(v, padre));
        }
        if (vresp.data.length < 100) break;
        vpage++;
      }
      return { variaciones };
    } catch (e) {
      return { variaciones, error: e };
    }
  });

  const errorVar = resultadosVar.find(r => r.error);
  if (errorVar) throw errorVar.error;
  for (const r of resultadosVar) {
    for (const v of r.variaciones) productos.push(v);
  }

  const now = new Date().toISOString();
  const upsert = db.prepare(`
    INSERT INTO catalogo_cache (id_woo, nombre, sku, tipo, id_padre, stock, categorias_json, img, precio, atributos_json, marca, gtin, actualizado_en)
    VALUES (@id_woo, @nombre, @sku, @tipo, @id_padre, @stock, @categorias_json, @img, @precio, @atributos_json, @marca, @gtin, @actualizado_en)
    ON CONFLICT(id_woo) DO UPDATE SET
      nombre = excluded.nombre, sku = excluded.sku, tipo = excluded.tipo,
      id_padre = excluded.id_padre, stock = excluded.stock,
      categorias_json = excluded.categorias_json, img = excluded.img, precio = excluded.precio,
      atributos_json = excluded.atributos_json, marca = excluded.marca, gtin = excluded.gtin,
      actualizado_en = excluded.actualizado_en
  `);
  const tx = db.transaction((rows) => {
    for (const p of rows) {
      upsert.run(filaCatalogo(p, now));
    }
  });
  tx(productos);

  // H-08: chequeo de calidad de datos WC — avisa (no bloquea) problemas upstream que
  // ensucian el sync/matcher. Los productos 'variable' (padres) no tienen SKU a propósito,
  // se excluyen del conteo de SKU vacío.
  const negs = db.prepare('SELECT COUNT(*) n FROM catalogo_cache WHERE stock<0').get().n;
  const sinSku = db.prepare("SELECT COUNT(*) n FROM catalogo_cache WHERE tipo<>'variable' AND COALESCE(sku,'')=''").get().n;
  if (negs || sinSku) {
    console.warn(`[woo] calidad catálogo: ${negs} con stock negativo, ${sinSku} sin SKU (no-variable). Revisar en WooCommerce.`);
  }

  return productos.length;
}

// Tope defensivo por defecto: bien por encima del catálogo real (~miles) y del MAX
// de refresco (20.000), así que no trunca a ningún consumidor actual (matcher, etc.)
// pero evita una respuesta sin límite si la tabla crece sin control.
const CATALOGO_LIMIT_DEFAULT = 100000;

export function getCatalogo(db, { limit = CATALOGO_LIMIT_DEFAULT, offset = 0 } = {}) {
  return db.prepare('SELECT * FROM catalogo_cache LIMIT ? OFFSET ?').all(limit, offset);
}

// Parsea ?limit / ?offset opcionales; si no vienen (o son inválidos) usa el tope alto.
function parsePaginado(query) {
  const rawLimit = Number(query.limit);
  const rawOffset = Number(query.offset);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0
    ? Math.min(rawLimit, CATALOGO_LIMIT_DEFAULT)
    : CATALOGO_LIMIT_DEFAULT;
  const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? Math.floor(rawOffset) : 0;
  return { limit: Math.floor(limit), offset };
}

export function wooRouter(db, cfg) {
  const router = express.Router();

  router.get('/test', async (req, res) => {
    try {
      const resp = await wooFetch(cfg, '/products?per_page=1&status=any');
      res.json({ ok: true, total: resp.headers['x-wp-total'] });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  router.get('/catalogo', (req, res) => {
    res.json({ ok: true, data: getCatalogo(db, parsePaginado(req.query)) });
  });

  router.post('/catalogo/recargar', async (req, res) => {
    try {
      const total = await refrescarCatalogo(db, cfg);
      res.json({ ok: true, total });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // Actualiza stock de una lista de productos directamente en WooCommerce
  // Body: { updates: [{id_woo, sku, stock_nuevo}] }
  router.post('/stock/aplicar', async (req, res) => {
    const { updates } = req.body || {};
    if (!Array.isArray(updates) || !updates.length) {
      return res.status(400).json({ ok: false, error: 'updates requerido' });
    }
    const resultados = [];
    for (const u of updates) {
      if (!u.id_woo || u.stock_nuevo == null) {
        resultados.push({ sku: u.sku, ok: false, error: 'faltan id_woo o stock_nuevo' });
        continue;
      }
      try {
        const resp = await wooFetch(cfg, `/products/${u.id_woo}`, 'patch', { stock_quantity: u.stock_nuevo });
        if (resp.status && resp.status !== 200) throw new Error(`WC status ${resp.status}`);
        db.prepare('UPDATE catalogo_cache SET stock=?, actualizado_en=? WHERE id_woo=?')
          .run(u.stock_nuevo, new Date().toISOString(), u.id_woo);
        resultados.push({ sku: u.sku, ok: true, stock_nuevo: u.stock_nuevo });
      } catch (e) {
        resultados.push({ sku: u.sku, ok: false, error: e.message });
      }
    }
    const errores = resultados.filter(r => !r.ok).length;
    res.json({ ok: errores === 0, aplicados: resultados.filter(r => r.ok).length, errores, resultados });
  });

  return router;
}
