import express from 'express';
import crypto from 'node:crypto';

// Etiquetas persistentes del control cíclico de stock. Reemplaza el
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
    for (const ddl of [
      'ALTER TABLE etiquetas_cola ADD COLUMN agente_id TEXT',
      'ALTER TABLE etiquetas_cola ADD COLUMN claim_token TEXT',
      'ALTER TABLE etiquetas_cola ADD COLUMN claim_hasta TEXT',
      'ALTER TABLE etiquetas_cola ADD COLUMN ultimo_error TEXT',
      'ALTER TABLE etiquetas_cola ADD COLUMN error_en TEXT',
      'ALTER TABLE etiquetas_cola ADD COLUMN idempotencia TEXT',
    ]) { try { db.prepare(ddl).run(); } catch (_) {} }
    db.prepare('CREATE UNIQUE INDEX IF NOT EXISTS uq_etiquetas_claim_token ON etiquetas_cola(claim_token) WHERE claim_token IS NOT NULL').run();
    db.prepare('CREATE UNIQUE INDEX IF NOT EXISTS uq_etiquetas_idempotencia ON etiquetas_cola(idempotencia) WHERE idempotencia IS NOT NULL').run();
  } catch (_) { /* ya existe */ }

  const now = () => new Date().toISOString();

  router.get('/cola', (req, res) => {
    const estado = req.query?.estado;
    const rows = estado
      ? db.prepare('SELECT * FROM etiquetas_cola WHERE estado=? ORDER BY creado_en').all(estado)
      : db.prepare('SELECT * FROM etiquetas_cola ORDER BY creado_en').all();
    res.json({ ok: true, cola: rows });
  });

  // Agente local: una sola computadora puede reclamar un trabajo a la vez. El lease
  // permite recuperar trabajos si Windows se reinicia o se pierde la red.
  router.post('/cola/reclamar', (req, res) => {
    const agente = String(req.body?.agente_id || '').trim();
    if (!agente) return res.status(400).json({ ok: false, error: 'agente_id requerido' });
    const token = `${agente}:${crypto.randomUUID()}`;
    const hasta = new Date(Date.now() + 60_000).toISOString();
    const trabajo = db.transaction(() => {
      const row = db.prepare(`SELECT id FROM etiquetas_cola
        WHERE estado IN ('pendiente','reintentar') OR (estado='imprimiendo' AND claim_hasta < ?)
        ORDER BY creado_en, id LIMIT 1`).get(now());
      if (!row) return null;
      const updated = db.prepare(`UPDATE etiquetas_cola SET estado='imprimiendo', agente_id=?, claim_token=?, claim_hasta=?
        WHERE id=? AND (estado IN ('pendiente','reintentar') OR (estado='imprimiendo' AND claim_hasta < ?))`)
        .run(agente, token, hasta, row.id, now());
      return updated.changes ? db.prepare('SELECT * FROM etiquetas_cola WHERE id=?').get(row.id) : null;
    })();
    res.json({ ok: true, trabajo });
  });

  router.post('/cola/:id/resultado', (req, res) => {
    const id = Number.parseInt(req.params.id, 10);
    const token = String(req.body?.claim_token || '').trim();
    const ok = req.body?.ok === true;
    if (!Number.isInteger(id) || !token) return res.status(400).json({ ok: false, error: 'id y claim_token requeridos' });
    const estado = ok ? 'impresa' : 'error';
    const ts = now();
    const error = ok ? null : String(req.body?.error || 'fallo de impresión').slice(0, 1000);
    const info = db.prepare(`UPDATE etiquetas_cola SET estado=?, impreso_en=CASE WHEN ?='impresa' THEN ? ELSE impreso_en END,
      ultimo_error=?, error_en=CASE WHEN ?='error' THEN ? ELSE error_en END, claim_token=NULL, claim_hasta=NULL
      WHERE id=? AND claim_token=? AND estado='imprimiendo'`).run(estado, estado, ts, error, estado, ts, id, token);
    if (!info.changes) return res.status(409).json({ ok: false, error: 'trabajo no reclamado o lease vencido', code: 'PRINT_CLAIM_INVALID' });
    res.json({ ok: true, estado });
  });

  router.post('/cola/:id/reintentar', (req, res) => {
    const id = Number.parseInt(req.params.id, 10);
    const info = db.prepare(`UPDATE etiquetas_cola SET estado='reintentar', claim_token=NULL, claim_hasta=NULL
      WHERE id=? AND estado='error'`).run(id);
    if (!info.changes) return res.status(409).json({ ok: false, error: 'solo se puede reintentar un trabajo fallido' });
    res.json({ ok: true });
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
    const item = db.prepare('SELECT * FROM etiquetas_cola WHERE id=?').get(id);
    if (!item) return res.status(404).json({ ok: false, error: 'no encontrado' });
    if (item.estado !== 'pendiente') {
      return res.status(400).json({ ok: false, error: 'solo se puede descartar un ítem pendiente (una impresa no se borra, queda como registro)' });
    }
    db.prepare('DELETE FROM etiquetas_cola WHERE id=?').run(id);
    res.json({ ok: true });
  });

  return router;
}
