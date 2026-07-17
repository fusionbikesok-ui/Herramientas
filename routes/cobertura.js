import express from 'express';

export function coberturaRouter(db) {
  const router = express.Router();

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
      SELECT c.id_woo, c.nombre, c.sku, c.stock, c.tipo
      FROM catalogo_cache c
      WHERE (c.sku IS NULL OR c.sku = ''
        OR NOT EXISTS (
          SELECT 1 FROM sku_matcher_decisiones d
          WHERE d.sku = c.sku AND d.accion != 'omitir'
        )
      )
      AND c.tipo != 'variable'
      ORDER BY c.nombre
    `).all();

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

  return router;
}
