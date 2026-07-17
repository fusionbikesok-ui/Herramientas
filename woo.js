import axios from 'axios';
import express from 'express';

export async function wooFetch(cfg, path, method = 'get', body = null) {
  const url = cfg.url.replace(/\/$/, '') + '/wp-json/wc/v3' + path;
  const resp = await axios.request({
    url,
    method,
    data: body ?? undefined,
    auth: { username: cfg.ck, password: cfg.cs },
    validateStatus: () => true
  });
  if (resp.status !== 200) {
    throw new Error(`WooCommerce API error ${resp.status}: ${JSON.stringify(resp.data).slice(0, 200)}`);
  }
  return resp;
}

export async function refrescarCatalogo(db, cfg) {
  const productos = [];
  let page = 1;
  while (true) {
    const resp = await wooFetch(cfg, `/products?per_page=100&page=${page}&status=any`);
    if (!resp.data.length) break;
    productos.push(...resp.data);
    if (resp.data.length < 100) break;
    page++;
  }

  const now = new Date().toISOString();
  const upsert = db.prepare(`
    INSERT INTO catalogo_cache (id_woo, nombre, sku, tipo, id_padre, stock, actualizado_en)
    VALUES (@id_woo, @nombre, @sku, @tipo, @id_padre, @stock, @actualizado_en)
    ON CONFLICT(id_woo) DO UPDATE SET
      nombre = excluded.nombre, sku = excluded.sku, tipo = excluded.tipo,
      id_padre = excluded.id_padre, stock = excluded.stock, actualizado_en = excluded.actualizado_en
  `);
  const tx = db.transaction((rows) => {
    for (const p of rows) {
      upsert.run({
        id_woo: p.id,
        nombre: p.name,
        sku: p.sku || '',
        tipo: p.type,
        id_padre: p.parent_id || null,
        stock: p.stock_quantity ?? 0,
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

  return router;
}
