import { Router } from 'express';

export function matcherRouter(db) {
  const router = Router();

  router.get('/decisiones', (req, res) => {
    const rows = db.prepare('SELECT clave, sku, wc_nombre, accion FROM sku_matcher_decisiones').all();
    const data = {};
    for (const row of rows) data[row.clave] = { sku: row.sku, wc_nombre: row.wc_nombre, accion: row.accion };
    res.json({ ok: true, data });
  });

  router.post('/decisiones', (req, res) => {
    const { decisiones } = req.body;
    if (!decisiones || typeof decisiones !== 'object') {
      return res.status(400).json({ ok: false, error: 'decisiones requeridas' });
    }
    const now = new Date().toISOString();
    const stmt = db.prepare(
      'INSERT OR REPLACE INTO sku_matcher_decisiones (clave, sku, wc_nombre, accion, actualizado_en) VALUES (?, ?, ?, ?, ?)'
    );
    const upsertAll = db.transaction((entries) => {
      for (const [clave, d] of entries) {
        if (d && d.accion) stmt.run(clave, d.sku || null, d.wc_nombre || null, d.accion, now);
      }
    });
    upsertAll(Object.entries(decisiones));
    res.json({ ok: true });
  });

  return router;
}
