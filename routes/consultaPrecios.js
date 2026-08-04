/**
 * Consulta de Precios: busca un producto por SKU o EAN y devuelve su precio web
 * (más título, marca, categoría y foto), leyendo catalogo_cache.
 *
 * El EAN no vive en WooCommerce, así que el puente EAN→SKU se guarda en la tabla
 * ean_sku, que aprende de a uno: cuando aparece un EAN desconocido, el frontend
 * pide el SKU y lo enseña con POST /ean.
 */

import { Router } from 'express';
import { productoDesdeFilaCatalogo } from '../lib/modelos/producto.js';
import { precioContado } from '../lib/mlPrecios.js';
import { armarLike } from '../lib/busqueda.js';

const now = () => new Date().toISOString();

/** ¿El código parece un EAN? Sólo dígitos, largo 8/12/13/14 (EAN-8, UPC-A, EAN-13, GTIN-14). */
export function pareceEan(codigo) {
  const s = String(codigo || '').trim();
  return /^\d+$/.test(s) && [8, 12, 13, 14].includes(s.length);
}

/**
 * Fila de catalogo_cache → objeto liviano para la card de resultado.
 * `precio` es el precio de CONTADO/Transferencia (2/3 del de lista, ver precioContado),
 * no el precio de lista guardado en catalogo_cache. Se mantiene el nombre `precio`
 * (en vez de `precio_web` como en routes/precios.js) para no tocar el frontend, que
 * ya lo consume como `p.precio` en varios lugares. La card lo rotula "Contado/Transf.".
 *
 * A PROPÓSITO usa `p.precio` (VIGENTE) y no `regular_price` (LISTA), a diferencia de los
 * demás call sites de precioContado() en el repo (lib/mlPrecios.js, routes/precios.js,
 * routes/sync.js — todos comparan contra publicaciones de ML y deben ignorar la oferta de
 * la web). Decisión explícita del usuario (2026-08-03): Consulta de Precios es el mostrador
 * — el cliente tiene que ver el mismo "Contado/Transf." que ve en la página del producto,
 * oferta incluida. NO "unificar" este call site con los demás.
 */
function productoParaCard(row) {
  const p = productoDesdeFilaCatalogo(row);
  return {
    sku: p.sku, nombre: p.nombre, marca: p.marca, categorias: p.categorias,
    precio: precioContado(p.precio), stock: p.stock, tipo: p.tipo, img: p.img,
  };
}

export function consultaPreciosRouter(db) {
  const router = Router();

  const porSku = db.prepare("SELECT * FROM catalogo_cache WHERE sku = ? AND sku <> '' LIMIT 1");
  const eanRow = db.prepare('SELECT sku FROM ean_sku WHERE ean = ?');

  // Búsqueda unificada: SKU exacto → EAN conocido → ¿parece EAN nuevo? → nada.
  router.get('/buscar', (req, res) => {
    const q = String(req.query.q || '').trim();
    if (!q) return res.json({ ok: true, found: false });

    const filaSku = porSku.get(q);
    if (filaSku) return res.json({ ok: true, found: true, tipo: 'sku', producto: productoParaCard(filaSku) });

    const ean = eanRow.get(q);
    if (ean) {
      const fila = porSku.get(ean.sku);
      if (fila) return res.json({ ok: true, found: true, tipo: 'ean', producto: productoParaCard(fila) });
      return res.json({ ok: true, found: false, tipo: 'ean', ean: q, skuHuerfano: ean.sku });
    }

    if (pareceEan(q)) return res.json({ ok: true, found: false, needsSku: true, ean: q });
    return res.json({ ok: true, found: false });
  });

  // Enseña un EAN nuevo (o corrige uno mal mapeado). Valida que el SKU exista.
  router.post('/ean', (req, res) => {
    const ean = String(req.body?.ean || '').trim();
    const sku = String(req.body?.sku || '').trim();
    if (!ean || !sku) return res.status(400).json({ ok: false, error: 'ean y sku requeridos' });
    const fila = porSku.get(sku);
    if (!fila) return res.status(400).json({ ok: false, error: `SKU "${sku}" no está en el catálogo` });
    db.prepare(`
      INSERT INTO ean_sku (ean, sku, actualizado_en) VALUES (?, ?, ?)
      ON CONFLICT(ean) DO UPDATE SET sku = excluded.sku, actualizado_en = excluded.actualizado_en
    `).run(ean, sku, now());
    res.json({ ok: true, producto: productoParaCard(fila) });
  });

  // Sembrado en lote desde el mapa del Contador de inventario. No valida contra el catálogo.
  router.post('/importar', (req, res) => {
    const pares = Array.isArray(req.body?.pares) ? req.body.pares : [];
    const validos = pares
      .map(p => ({ ean: String(p?.ean || '').trim(), sku: String(p?.sku || '').trim() }))
      .filter(p => p.ean && p.sku);
    const ins = db.prepare(`
      INSERT INTO ean_sku (ean, sku, actualizado_en) VALUES (?, ?, ?)
      ON CONFLICT(ean) DO UPDATE SET sku = excluded.sku, actualizado_en = excluded.actualizado_en
    `);
    const tx = db.transaction((filas) => { for (const f of filas) ins.run(f.ean, f.sku, now()); });
    tx(validos);
    res.json({ ok: true, importados: validos.length, recibidos: pares.length });
  });

  // Autocomplete de SKU para enseñar un EAN nuevo.
  router.get('/buscar-sku', (req, res) => {
    const q = String(req.query.q || '').trim();
    if (!q) return res.json({ ok: true, data: [] });
    const like = armarLike(q);
    const rows = db.prepare(`
      SELECT sku, nombre, stock, tipo FROM catalogo_cache
      WHERE (sku LIKE ? ESCAPE '\\' OR nombre LIKE ? ESCAPE '\\') AND sku <> ''
      ORDER BY nombre ASC LIMIT 20
    `).all(like, like);
    res.json({ ok: true, data: rows });
  });

  return router;
}
