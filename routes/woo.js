import axios from 'axios';
import express from 'express';

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
  const productos = [];
  let page = 1;
  while (page <= MAX_PAGES) {
    const resp = await wooFetch(cfg, `/products?per_page=100&page=${page}&status=any`);
    if (!resp.data.length) break;
    productos.push(...resp.data);
    if (resp.data.length < 100) break;
    page++;
  }

  // Fetch variations for variable products (they have their own SKUs and aren't returned by /products)
  const variableProds = productos.filter(p => p.type === 'variable');
  for (const vp of variableProds) {
    let vpage = 1;
    while (vpage <= 20) {
      const vresp = await wooFetch(cfg, `/products/${vp.id}/variations?per_page=100&page=${vpage}&status=any`);
      if (!vresp.data.length) break;
      for (const v of vresp.data) {
        if (!v.sku) continue;
        // Build name from parent name + variation attributes
        const attrs = (v.attributes || []).map(a => a.option).filter(Boolean).join(' / ');
        v.name = attrs ? `${vp.name} — ${attrs}` : vp.name;
        v.parent_id = vp.id;
        v.categories = vp.categories; // inherit parent categories
        productos.push(v);
      }
      if (vresp.data.length < 100) break;
      vpage++;
    }
  }

  const now = new Date().toISOString();
  const upsert = db.prepare(`
    INSERT INTO catalogo_cache (id_woo, nombre, sku, tipo, id_padre, stock, categorias_json, img, actualizado_en)
    VALUES (@id_woo, @nombre, @sku, @tipo, @id_padre, @stock, @categorias_json, @img, @actualizado_en)
    ON CONFLICT(id_woo) DO UPDATE SET
      nombre = excluded.nombre, sku = excluded.sku, tipo = excluded.tipo,
      id_padre = excluded.id_padre, stock = excluded.stock,
      categorias_json = excluded.categorias_json, img = excluded.img, actualizado_en = excluded.actualizado_en
  `);
  const tx = db.transaction((rows) => {
    for (const p of rows) {
      const cats = Array.isArray(p.categories) && p.categories.length
        ? JSON.stringify(p.categories.map(c => c.name))
        : null;
      // products use images[] array; variations use image singular
      const img = p.image?.src || (Array.isArray(p.images) && p.images[0]?.src) || null;
      upsert.run({
        id_woo: p.id,
        nombre: p.name,
        sku: p.sku || '',
        tipo: p.type,
        id_padre: p.parent_id || null,
        stock: p.stock_quantity ?? 0,
        categorias_json: cats,
        img,
        actualizado_en: now
      });
    }
  });
  tx(productos);
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
