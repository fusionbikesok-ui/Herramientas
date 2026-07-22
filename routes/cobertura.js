import express from 'express';
import {
  esNoVendible,
  esFaltante,
  esMultiPublicacion,
  esActivaMl,
} from '../lib/cobertura.js';

/**
 * Cruza el catálogo de WooCommerce (catalogo_cache) contra las publicaciones de ML
 * en vivo (ml_publicaciones_cache) y devuelve, ya procesado, todo lo que la página
 * de Cobertura necesita para pintar sus pestañas. Antes esta lógica (joins/filtros)
 * vivía replicada en el cliente; ahora es la única fuente de verdad en el backend.
 *
 * Es espejo exacto del cruce que hacía el front sobre la fuente "API de ML":
 *  - skusEnML: SKUs (seller_sku) presentes en cualquier publicación (activa o pausada).
 *  - conteoPorSku: cantidad de publicaciones por seller_sku (multi-publicación).
 *  - en_ambos: publicaciones cuyo seller_sku coincide con un SKU de WC.
 *  - solo_ml: publicaciones sin seller_sku o cuyo SKU no existe en WC.
 *  - pausadas: las de en_ambos con status distinto de activo.
 *  - faltantes / multiPub / excluidos: reglas de lib/cobertura.js sobre el catálogo WC.
 */
export function computarCruce(db) {
  const wcProductos = db.prepare('SELECT * FROM catalogo_cache').all();
  const mlRows = db.prepare(`
    SELECT item_id, variation_id, titulo, status, seller_sku, variations_texto
    FROM ml_publicaciones_cache
  `).all();
  const excluidosArr = db.prepare('SELECT id_woo FROM cobertura_exclusiones').all();
  const excluidosSet = new Set(excluidosArr.map((e) => e.id_woo));

  // Normalizar publicaciones ML al mismo shape que usaba el cliente.
  const mlItems = mlRows.map((p) => ({
    ml_item_id: String(p.item_id),
    ml_variation_id: p.variation_id ? String(p.variation_id) : '',
    ml_title: p.titulo || '(sin título)',
    ml_sku: (p.seller_sku || '').trim(),
    ml_status: p.status || '',
    ml_variante: p.variations_texto || '',
  }));

  // Índices: SKUs presentes en ML y conteo de publicaciones por SKU.
  const skusEnML = new Set();
  const conteoPorSku = new Map();
  const pubsPorSku = new Map();
  for (const m of mlItems) {
    if (!m.ml_sku) continue;
    skusEnML.add(m.ml_sku);
    conteoPorSku.set(m.ml_sku, (conteoPorSku.get(m.ml_sku) || 0) + 1);
    if (!pubsPorSku.has(m.ml_sku)) pubsPorSku.set(m.ml_sku, []);
    pubsPorSku.get(m.ml_sku).push(m);
  }

  // Índice WC por SKU.
  const wcPorSku = new Map();
  for (const p of wcProductos) {
    const s = String(p.sku || '').trim();
    if (s) wcPorSku.set(s, p);
  }

  // EN AMBOS: publicación ML cuyo SKU existe en WC.
  const en_ambos = [];
  for (const m of mlItems) {
    if (!m.ml_sku) continue;
    const wc = wcPorSku.get(m.ml_sku);
    if (!wc) continue;
    en_ambos.push({
      nombre: wc.nombre,
      sku: wc.sku,
      stock_wc: wc.stock,
      ml_title: m.ml_title,
      ml_item_id: m.ml_item_id,
      ml_var_id: m.ml_variation_id,
      ml_status: m.ml_status,
      ml_variante: m.ml_variante,
    });
  }

  // SOLO ML: sin SKU o SKU inexistente en WC.
  const solo_ml = mlItems.filter((m) => !m.ml_sku || !wcPorSku.has(m.ml_sku));

  // PAUSADAS: de en_ambos, las que no están activas.
  const pausadas = en_ambos.filter((r) => !esActivaMl(r.ml_status));

  // FALTANTES / EXCLUIDOS / MULTI-PUBLICACIÓN: reglas canónicas sobre WC.
  const faltantes = wcProductos.filter((p) => esFaltante(p, skusEnML, excluidosSet));
  const excluidos = wcProductos.filter((p) => excluidosSet.has(p.id_woo));
  const multiPub = wcProductos
    .filter((p) => esMultiPublicacion(p, conteoPorSku, excluidosSet))
    .map((p) => {
      const sku = String(p.sku || '').trim();
      const pubs = pubsPorSku.get(sku) || [];
      return {
        ...p,
        conteo: conteoPorSku.get(sku) || 0,
        publicaciones: pubs.map((m) => ({
          ml_item_id: m.ml_item_id,
          ml_variation_id: m.ml_variation_id,
          ml_variante: m.ml_variante,
        })),
      };
    });

  return {
    en_ambos,
    solo_ml,
    pausadas,
    faltantes,
    excluidos,
    multiPub,
    resumen: {
      total_ambos: en_ambos.length,
      total_solo_ml: solo_ml.length,
      total_pausadas: pausadas.length,
      total_faltantes: faltantes.length,
      total_excluidos: excluidos.length,
      total_multipub: multiPub.length,
      total_ml_pubs: mlItems.length,
      total_wc: wcProductos.length,
    },
  };
}

export function coberturaRouter(db) {
  const router = express.Router();

  // Cruce WC × ML ya procesado para todas las pestañas de Cobertura (fuente "API de ML").
  // Un solo round-trip y un snapshot consistente de los caches; reemplaza el cruce que
  // el cliente hacía a mano con /api/woo/catalogo + /api/matcher/publicaciones.
  router.get('/cruce', (req, res) => {
    res.json({ ok: true, ...computarCruce(db) });
  });

  // Slices individuales (mismo cruce) — útiles para consumo puntual y para tests.
  router.get('/faltantes', (req, res) => {
    const { faltantes, excluidos } = computarCruce(db);
    res.json({ ok: true, data: faltantes, excluidos, total: faltantes.length });
  });

  router.get('/multi-publicacion', (req, res) => {
    const { multiPub } = computarCruce(db);
    res.json({ ok: true, data: multiPub, total: multiPub.length });
  });

  router.get('/pausadas', (req, res) => {
    const { pausadas } = computarCruce(db);
    res.json({ ok: true, data: pausadas, total: pausadas.length });
  });

  router.get('/', (req, res) => {
    // Productos en AMBOS: catalogo_cache JOIN sku_matcher_decisiones por SKU
    const enAmbos = db.prepare(`
      SELECT
        c.id_woo, c.nombre, c.sku, c.stock as stock_wc, c.tipo,
        d.clave, d.wc_nombre, d.accion,
        m.cantidad_ml as stock_ml
      FROM catalogo_cache c
      JOIN sku_matcher_decisiones d ON d.sku = c.sku AND d.accion != 'omitir'
      LEFT JOIN ml_stock_estado m ON m.clave = d.clave
      WHERE c.sku IS NOT NULL AND c.sku != ''
      ORDER BY c.nombre
    `).all();

    // Solo en WC: productos sin ningún match en ML (activo)
    const soloWc = db.prepare(`
      SELECT c.id_woo, c.nombre, c.sku, c.stock, c.tipo, c.categorias_json
      FROM catalogo_cache c
      WHERE (c.sku IS NULL OR c.sku = ''
        OR NOT EXISTS (
          SELECT 1 FROM sku_matcher_decisiones d
          WHERE d.sku = c.sku AND d.accion != 'omitir'
        )
      )
      AND c.tipo != 'variable'
      ORDER BY c.nombre
    `).all().map(({ categorias_json, ...row }) => ({
      ...row,
      no_vendible: esNoVendible({ categorias_json }) ? 1 : 0,
    }));

    // Solo en ML: matches que apuntan a un SKU que ya no existe en WC
    const soloMl = db.prepare(`
      SELECT d.clave, d.sku, d.wc_nombre, d.accion, m.cantidad_ml as stock_ml
      FROM sku_matcher_decisiones d
      LEFT JOIN ml_stock_estado m ON m.clave = d.clave
      WHERE d.accion != 'omitir'
        AND (d.sku IS NULL OR d.sku = ''
          OR NOT EXISTS (
            SELECT 1 FROM catalogo_cache c WHERE c.sku = d.sku
          )
        )
      ORDER BY d.wc_nombre
    `).all();

    res.json({
      ok: true,
      en_ambos: enAmbos,
      solo_wc: soloWc,
      solo_ml: soloMl,
      resumen: {
        total_ambos: enAmbos.length,
        total_solo_wc: soloWc.length,
        total_solo_ml: soloMl.length,
      }
    });
  });

  // ── Exclusiones manuales "solo local" ──────────────────────────────────────
  // Productos WC que no deben publicarse en ML (venta solo en el local físico) y
  // por lo tanto no cuentan como faltantes de cobertura.

  router.get('/exclusiones', (req, res) => {
    const data = db.prepare(
      'SELECT id_woo, sku, nombre, motivo, creado_en FROM cobertura_exclusiones ORDER BY nombre'
    ).all();
    res.json({ ok: true, data });
  });

  router.post('/exclusiones', (req, res) => {
    const { id_woo, sku, nombre } = req.body || {};
    if (id_woo == null || id_woo === '') {
      return res.status(400).json({ ok: false, error: 'id_woo requerido' });
    }
    db.prepare(`
      INSERT INTO cobertura_exclusiones (id_woo, sku, nombre, motivo, creado_en)
      VALUES (@id_woo, @sku, @nombre, 'solo_local', @creado_en)
      ON CONFLICT(id_woo) DO UPDATE SET
        sku = excluded.sku, nombre = excluded.nombre
    `).run({
      id_woo: Number(id_woo),
      sku: sku || null,
      nombre: nombre || null,
      creado_en: new Date().toISOString(),
    });
    res.json({ ok: true });
  });

  router.delete('/exclusiones/:id_woo', (req, res) => {
    const info = db.prepare('DELETE FROM cobertura_exclusiones WHERE id_woo = ?')
      .run(Number(req.params.id_woo));
    res.json({ ok: true, borrado: info.changes });
  });

  return router;
}
