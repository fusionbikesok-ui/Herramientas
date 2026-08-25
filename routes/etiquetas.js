import express from 'express';

// Fase 1 (Etiquetas persistentes) del plan de control de stock de José — ver
// docs/superpowers/plans/2026-08-plan-jose-control-stock-ciclos.md. Reemplaza el
// localStorage de public/etiquetas/index.html, que se pierde al cerrar el navegador, por
// una cola persistente en la base. No toca el renderer 50×25mm existente: esta es
// exclusivamente la fuente de datos.
export function etiquetasRouter(db) {
  const router = express.Router();

  try {
    db.prepare(`CREATE TABLE IF NOT EXISTS etiquetas_cola (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      sku             TEXT NOT NULL,
      cantidad        INTEGER NOT NULL,
      origen          TEXT,
      sesion_id       INTEGER,
      solicitado_por  TEXT,
      nota            TEXT,
      estado          TEXT NOT NULL DEFAULT 'pendiente',
      creado_en       TEXT NOT NULL,
      impreso_en      TEXT
    )`).run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_etiquetas_cola_estado ON etiquetas_cola(estado)').run();
  } catch (_) { /* ya existe */ }

  const now = () => new Date().toISOString();

  router.get('/cola', (req, res) => {
    const estado = req.query?.estado;
    const rows = estado
      ? db.prepare('SELECT * FROM etiquetas_cola WHERE estado=? ORDER BY creado_en').all(estado)
      : db.prepare('SELECT * FROM etiquetas_cola ORDER BY creado_en').all();
    res.json({ ok: true, cola: rows });
  });

  router.post('/cola', (req, res) => {
    const { sku, cantidad, origen, sesion_id, nota } = req.body || {};
    const cant = parseInt(cantidad, 10);
    if (!sku || typeof sku !== 'string' || !sku.trim()) {
      return res.status(400).json({ ok: false, error: 'sku requerido' });
    }
    if (!Number.isInteger(cant) || cant <= 0) {
      return res.status(400).json({ ok: false, error: 'cantidad debe ser un entero mayor a 0' });
    }
    const info = db.prepare(`
      INSERT INTO etiquetas_cola (sku, cantidad, origen, sesion_id, solicitado_por, nota, estado, creado_en)
      VALUES (?, ?, ?, ?, ?, ?, 'pendiente', ?)
    `).run(sku.trim(), cant, origen || null, sesion_id ?? null, req.user?.username || null, nota || null, now());
    const item = db.prepare('SELECT * FROM etiquetas_cola WHERE id=?').get(info.lastInsertRowid);
    res.json({ ok: true, item });
  });

  router.patch('/cola/:id', (req, res) => {
    const id = parseInt(req.params.id, 10);
    const item = db.prepare('SELECT * FROM etiquetas_cola WHERE id=?').get(id);
    if (!item) return res.status(404).json({ ok: false, error: 'no encontrado' });
    if (item.estado !== 'pendiente') {
      return res.status(400).json({ ok: false, error: 'solo se puede editar un ítem pendiente' });
    }
    const { cantidad, nota } = req.body || {};
    if (cantidad !== undefined) {
      const cant = parseInt(cantidad, 10);
      if (!Number.isInteger(cant) || cant <= 0) {
        return res.status(400).json({ ok: false, error: 'cantidad debe ser un entero mayor a 0' });
      }
      db.prepare('UPDATE etiquetas_cola SET cantidad=? WHERE id=?').run(cant, id);
    }
    if (nota !== undefined) {
      db.prepare('UPDATE etiquetas_cola SET nota=? WHERE id=?').run(nota || null, id);
    }
    res.json({ ok: true, item: db.prepare('SELECT * FROM etiquetas_cola WHERE id=?').get(id) });
  });

  router.post('/cola/marcar-impresas', (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? [...new Set(req.body.ids.map(v => parseInt(v, 10)).filter(Number.isInteger))] : [];
    if (!ids.length) return res.status(400).json({ ok: false, error: 'Indicá `ids` (array no vacío).' });
    const marcar = db.prepare(`UPDATE etiquetas_cola SET estado='impresa', impreso_en=? WHERE id=? AND estado='pendiente'`);
    const ts = now();
    const tx = db.transaction(lista => {
      let n = 0;
      for (const id of lista) n += marcar.run(ts, id).changes;
      return n;
    });
    const marcadas = tx(ids);
    res.json({ ok: true, marcadas });
  });

  router.delete('/cola/:id', (req, res) => {
    const id = parseInt(req.params.id, 10);
    const info = db.prepare('DELETE FROM etiquetas_cola WHERE id=?').run(id);
    if (!info.changes) return res.status(404).json({ ok: false, error: 'no encontrado' });
    res.json({ ok: true });
  });

  return router;
}
