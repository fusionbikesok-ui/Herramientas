/**
 * Carga de Códigos Universales: herramienta mobile-first para recorrer el depósito
 * escaneando el código de barras (GTIN/EAN, campo nativo de Woo `global_unique_id`)
 * de cada producto y dejarlo guardado en WooCommerce.
 *
 * - GET  /faltantes  → cola de productos con stock sin código todavía (+ listas de
 *                      marcas y categorías presentes para poblar los desplegables).
 * - GET  /firma      → firma liviana (COUNT + MAX actualizado_en) de esa misma cola, para
 *                      que el front sondee cada ~20s sin bajar los 417 KB de /faltantes.
 * - GET  /buscar     → busca por SKU/nombre incluyendo productos YA con código
 *                      (para el flujo de sobrescritura).
 * - POST /asignar    → PATCH a Woo del global_unique_id y, si OK, actualiza el cache
 *                      + siembra ean_sku. Fail-closed: si Woo rechaza, no toca la DB.
 */

import { Router } from 'express';
import { esNoVendible } from '../lib/cobertura.js';
import { productoDesdeFilaCatalogo } from '../lib/modelos/producto.js';
import { armarLike } from '../lib/busqueda.js';
import { subirGtinAWoo, persistirGtinConfirmado } from '../lib/gtinWoo.js';

const now = () => new Date().toISOString();

// WHERE compartido entre /faltantes y /firma: si se toca acá, se toca para las dos —
// evita que la firma se desincronice de lo que realmente lista la cola (mismo patrón que
// firmaCandidatos en routes/matcher.js, que separa firma barata de cómputo caro).
function whereFaltantes(conStock) {
  const filtroStock = conStock ? 'AND stock > 0' : '';
  return `
    tipo <> 'variable'
      AND COALESCE(sku, '') <> ''
      AND COALESCE(gtin, '') = ''
      ${filtroStock}
  `;
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
  const contarPorSku = db.prepare("SELECT COUNT(*) n FROM catalogo_cache WHERE sku = ? AND sku <> ''");

  // ── Cola de faltantes ──────────────────────────────────────────────────────
  // Un producto entra si: stock>0 (salvo que se pida sin ese filtro), sin gtin,
  // tipo != 'variable', sku no vacío, no es no-vendible y no está en "solo local".
  router.get('/faltantes', (req, res) => {
    // conStock ON por defecto: solo lo que tenés físicamente para escanear.
    const conStock = String(req.query.conStock ?? 'true') !== 'false';
    const rows = db.prepare(`
      SELECT * FROM catalogo_cache
      WHERE ${whereFaltantes(conStock)}
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

  // ── Firma liviana de la cola (para que el front sepa si vale la pena pedir /faltantes) ──
  // COUNT(*) + MAX(actualizado_en) sobre el mismo WHERE que /faltantes. NO replica el
  // filtro JS de exclusionesRows/esNoVendible (riesgo asimétrico aceptado a propósito) —
  // detalle completo en docs/api-contrato.md, sección "GET /api/codigos/firma".
  router.get('/firma', (req, res) => {
    const conStock = String(req.query.conStock ?? 'true') !== 'false';
    const row = db.prepare(`
      SELECT COUNT(*) n, MAX(actualizado_en) max_act FROM catalogo_cache
      WHERE ${whereFaltantes(conStock)}
    `).get();
    // no-store: se sondea cada ~20s a propósito; un 200 cacheado por el navegador
    // congelaría la feature en silencio sin que nada lo avise.
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, firma: `${row.n}:${row.max_act || ''}` });
  });

  // ── Búsqueda (incluye productos ya con código, para sobrescribir) ───────────
  router.get('/buscar', (req, res) => {
    const q = String(req.query.q || '').trim();
    if (!q) return res.json({ ok: true, data: [] });
    const like = armarLike(q);
    const rows = db.prepare(`
      SELECT * FROM catalogo_cache
      WHERE (sku LIKE ? ESCAPE '\\' OR nombre LIKE ? ESCAPE '\\')
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
    if (idWoo != null && idWoo !== '') {
      fila = porId.get(Number(idWoo));
    } else if (skuIn) {
      // Fail-closed: si el SKU es homónimo (hay múltiples productos), rechazar sin
      // llamar a Woo. El usuario debe ser más específico (id_woo).
      const cnt = contarPorSku.get(skuIn);
      if (cnt.n > 1) {
        return res.status(400).json({
          ok: false,
          error: `El SKU '${skuIn}' es ambiguo: hay ${cnt.n} productos. Especificá el id_woo para desambiguar.`,
          codigo: 'sku_ambiguo',
        });
      }
      fila = porSku.get(skuIn);
    }
    if (!fila) return res.status(404).json({ ok: false, error: 'Producto no encontrado en el catálogo' });

    const sku = String(fila.sku || '').trim();

    // PATCH a Woo + resolución de endpoint (compartido con /api/inventario/.../asociar).
    // Fail-closed acá: si Woo rechaza o falla, no se toca la DB.
    const woo = await subirGtinAWoo(cfg, fila, gtin);
    if (!woo.ok) {
      const status = woo.motivo === 'no_endpoint' ? 400 : 502;
      return res.status(status).json({ ok: false, error: woo.error });
    }

    // Woo confirmó → persistimos en el cache y sembramos ean_sku (para Consulta de Precios).
    persistirGtinConfirmado(db, fila, gtin, sku);

    res.json({ ok: true, id_woo: fila.id_woo, sku, gtin });
  });

  return router;
}
