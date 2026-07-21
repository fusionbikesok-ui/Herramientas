/**
 * Carga de Códigos Universales: herramienta mobile-first para recorrer el depósito
 * escaneando el código de barras (GTIN/EAN, campo nativo de Woo `global_unique_id`)
 * de cada producto y dejarlo guardado en WooCommerce.
 *
 * - GET  /faltantes  → cola de productos con stock sin código todavía (+ listas de
 *                      marcas y categorías presentes para poblar los desplegables).
 * - GET  /buscar     → busca por SKU/nombre incluyendo productos YA con código
 *                      (para el flujo de sobrescritura).
 * - POST /asignar    → PATCH a Woo del global_unique_id y, si OK, actualiza el cache
 *                      + siembra ean_sku. Fail-closed: si Woo rechaza, no toca la DB.
 */

import axios from 'axios';
import { Router } from 'express';
import { esNoVendible } from '../lib/cobertura.js';
import { productoDesdeFilaCatalogo } from '../lib/modelos/producto.js';

const now = () => new Date().toISOString();

/**
 * PATCH puntual a Woo que preserva el motivo real del rechazo (ej. GTIN duplicado).
 * No reusamos wooFetch porque su contrato descarta el body de error; acá lo necesitamos
 * para mostrarle al usuario por qué Woo no aceptó el código.
 * @returns {{ ok: boolean, error?: string }}
 */
async function patchWoo(cfg, path, body) {
  if (!String(cfg.url || '').startsWith('https://')) {
    return { ok: false, error: 'WooCommerce URL debe usar HTTPS' };
  }
  const url = cfg.url.replace(/\/$/, '') + '/wp-json/wc/v3' + path;
  const resp = await axios.request({
    url,
    method: 'patch',
    data: body,
    auth: { username: cfg.ck, password: cfg.cs },
    timeout: 20000,
    validateStatus: () => true,
  });
  if (resp.status < 200 || resp.status >= 300) {
    const d = resp.data || {};
    return { ok: false, error: d.message || d.code || `error ${resp.status}` };
  }
  return { ok: true };
}

/** Fila de catalogo_cache → objeto liviano para la tarjeta de la cola. */
function productoParaCola(row) {
  const p = productoDesdeFilaCatalogo(row);
  return {
    id_woo: p.id_woo,
    nombre: p.nombre,
    sku: p.sku,
    tipo: p.tipo,
    id_padre: p.id_padre,
    stock: p.stock,
    marca: p.marca,
    categorias: p.categorias,
    atributos: p.atributos,
    img: p.img,
    gtin: p.gtin,
  };
}

export function codigosRouter(db, cfg) {
  const router = Router();

  // Solo id_woo de las exclusiones "solo local" (mismo criterio que Cobertura).
  const exclusionesRows = db.prepare('SELECT id_woo FROM cobertura_exclusiones');
  const porId = db.prepare('SELECT * FROM catalogo_cache WHERE id_woo = ? LIMIT 1');
  const porSku = db.prepare("SELECT * FROM catalogo_cache WHERE sku = ? AND sku <> '' LIMIT 1");

  // ── Cola de faltantes ──────────────────────────────────────────────────────
  // Un producto entra si: stock>0 (salvo que se pida sin ese filtro), sin gtin,
  // tipo != 'variable', sku no vacío, no es no-vendible y no está en "solo local".
  router.get('/faltantes', (req, res) => {
    // conStock ON por defecto: solo lo que tenés físicamente para escanear.
    const conStock = String(req.query.conStock ?? 'true') !== 'false';
    const filtroStock = conStock ? 'AND stock > 0' : '';
    const rows = db.prepare(`
      SELECT * FROM catalogo_cache
      WHERE tipo <> 'variable'
        AND COALESCE(sku, '') <> ''
        AND COALESCE(gtin, '') = ''
        ${filtroStock}
      ORDER BY marca COLLATE NOCASE, nombre COLLATE NOCASE
    `).all();

    const excluidos = new Set(exclusionesRows.all().map((r) => r.id_woo));
    const data = rows
      .filter((r) => !excluidos.has(r.id_woo))
      .filter((r) => !esNoVendible(r))
      .map(productoParaCola);

    // Desplegables dinámicos: solo marcas/categorías que aparecen entre los faltantes.
    const marcas = [...new Set(data.map((p) => p.marca).filter(Boolean))]
      .sort((a, b) => a.localeCompare(b, 'es'));
    const categorias = [...new Set(data.flatMap((p) => p.categorias).filter(Boolean))]
      .sort((a, b) => a.localeCompare(b, 'es'));

    res.json({ ok: true, data, marcas, categorias });
  });

  // ── Búsqueda (incluye productos ya con código, para sobrescribir) ───────────
  router.get('/buscar', (req, res) => {
    const q = String(req.query.q || '').trim();
    if (!q) return res.json({ ok: true, data: [] });
    const like = `%${q}%`;
    const rows = db.prepare(`
      SELECT * FROM catalogo_cache
      WHERE (sku LIKE ? OR nombre LIKE ?)
        AND COALESCE(sku, '') <> ''
        AND tipo <> 'variable'
      ORDER BY marca COLLATE NOCASE, nombre COLLATE NOCASE
      LIMIT 50
    `).all(like, like);
    res.json({ ok: true, data: rows.map(productoParaCola) });
  });

  // ── Asignar el código universal ─────────────────────────────────────────────
  // Fail-closed: PATCH a Woo primero; recién si Woo confirma se toca la DB.
  router.post('/asignar', async (req, res) => {
    const gtin = String(req.body?.gtin || '').trim();
    const idWoo = req.body?.id_woo;
    const skuIn = String(req.body?.sku || '').trim();
    if (!gtin) return res.status(400).json({ ok: false, error: 'gtin requerido' });

    // Resolver el producto en el cache (por id_woo o, si no vino, por sku).
    let fila = null;
    if (idWoo != null && idWoo !== '') fila = porId.get(Number(idWoo));
    else if (skuIn) fila = porSku.get(skuIn);
    if (!fila) return res.status(404).json({ ok: false, error: 'Producto no encontrado en el catálogo' });

    if (fila.tipo === 'variable') {
      return res.status(400).json({ ok: false, error: 'Un producto variable (padre) no lleva código; usá sus variaciones' });
    }

    const sku = String(fila.sku || '').trim();
    // Endpoint correcto según tipo: variación vs producto simple.
    const path = fila.tipo === 'variation'
      ? `/products/${fila.id_padre}/variations/${fila.id_woo}`
      : `/products/${fila.id_woo}`;
    if (fila.tipo === 'variation' && !fila.id_padre) {
      return res.status(400).json({ ok: false, error: 'Variación sin id_padre; no se puede resolver el endpoint de Woo' });
    }

    let woo;
    try {
      woo = await patchWoo(cfg, path, { global_unique_id: gtin });
    } catch (e) {
      // Falla de red/timeout: no se toca la DB.
      return res.status(502).json({ ok: false, error: `No se pudo contactar a WooCommerce: ${e.message}` });
    }
    if (!woo.ok) {
      // Woo rechazó (GTIN duplicado en otro producto, error de API, etc.): no se toca la DB.
      return res.status(502).json({ ok: false, error: `WooCommerce rechazó el código: ${woo.error}` });
    }

    // Woo confirmó → persistimos en el cache y sembramos ean_sku (para Consulta de Precios).
    const gtinPrevio = String(fila.gtin || '').trim();
    const ahora = now();
    const tx = db.transaction(() => {
      db.prepare('UPDATE catalogo_cache SET gtin = ?, actualizado_en = ? WHERE id_woo = ?')
        .run(gtin, ahora, fila.id_woo);
      // Sobrescritura: si el código previo era distinto, borrar su fila ean_sku huérfana
      // para que Consulta de Precios no siga resolviendo el código viejo.
      if (gtinPrevio && gtinPrevio !== gtin) {
        db.prepare('DELETE FROM ean_sku WHERE ean = ?').run(gtinPrevio);
      }
      if (sku) {
        db.prepare(`
          INSERT INTO ean_sku (ean, sku, actualizado_en) VALUES (?, ?, ?)
          ON CONFLICT(ean) DO UPDATE SET sku = excluded.sku, actualizado_en = excluded.actualizado_en
        `).run(gtin, sku, ahora);
      }
    });
    tx();

    res.json({ ok: true, id_woo: fila.id_woo, sku, gtin });
  });

  return router;
}
