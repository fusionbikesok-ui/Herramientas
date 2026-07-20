import axios from 'axios';
import express from 'express';
import { normalizarProductoWc, normalizarVariacionWc, filaCatalogo } from '../lib/modelos/producto.js';

const MAX_PAGES = 200; // 200 × 100 items = 20.000 productos máximo por refresco

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

  // Fetch variations for variable products (they have their own SKUs and aren't returned by /products)
  const variableProds = crudos.filter(p => p.type === 'variable');
  for (const vp of variableProds) {
    const padre = normalizarProductoWc(vp);
    let vpage = 1;
    while (vpage <= 20) {
      const vresp = await wooFetch(cfg, `/products/${vp.id}/variations?per_page=100&page=${vpage}&status=any`);
      if (!vresp.data.length) break;
      for (const v of vresp.data) {
        if (!v.sku) continue;
        productos.push(normalizarVariacionWc(v, padre));
      }
      if (vresp.data.length < 100) break;
      vpage++;
    }
  }

  const now = new Date().toISOString();
  const upsert = db.prepare(`
    INSERT INTO catalogo_cache (id_woo, nombre, sku, tipo, id_padre, stock, categorias_json, img, precio, atributos_json, actualizado_en)
    VALUES (@id_woo, @nombre, @sku, @tipo, @id_padre, @stock, @categorias_json, @img, @precio, @atributos_json, @actualizado_en)
    ON CONFLICT(id_woo) DO UPDATE SET
      nombre = excluded.nombre, sku = excluded.sku, tipo = excluded.tipo,
      id_padre = excluded.id_padre, stock = excluded.stock,
      categorias_json = excluded.categorias_json, img = excluded.img, precio = excluded.precio,
      atributos_json = excluded.atributos_json, actualizado_en = excluded.actualizado_en
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

export function getCatalogo(db) {
  return db.prepare('SELECT * FROM catalogo_cache').all();
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
    res.json({ ok: true, data: getCatalogo(db) });
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
