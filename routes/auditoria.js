/**
 * Cola de revisión de auditoría de publicaciones ML.
 * Permisos: anyOf ['inventario'] nivel read (mismo gate que criticidad).
 */

import express from 'express';
import { ensureAuditoriaTable } from '../lib/auditoria.js';

export function auditoriaRouter(db) {
  const router = express.Router();

  try { ensureAuditoriaTable(db); } catch (_) {}

  // Cola priorizada: problemas primero, luego por score de criticidad (si disponible)
  router.get('/cola', (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const soloProblemas = req.query.solo_problemas === '1';

    let sql = `
      SELECT a.clave, a.sku, a.health, a.fotos_ml, a.tiene_video,
             a.estado_clip, a.problemas_json, a.auditado_en, a.revisado_en,
             p.titulo, p.thumbnail, p.permalink, p.status AS status_ml,
             c.nombre AS wc_nombre, c.stock AS stock_wc
      FROM auditoria_publicacion a
      JOIN ml_publicaciones_cache p ON p.clave = a.clave
      LEFT JOIN catalogo_cache c ON c.sku = a.sku
    `;
    if (soloProblemas) sql += " WHERE a.problemas_json != '[]' AND a.problemas_json IS NOT NULL";
    sql += `
      ORDER BY
        CASE WHEN a.problemas_json != '[]' AND a.problemas_json IS NOT NULL THEN 0 ELSE 1 END ASC,
        a.health ASC NULLS LAST,
        a.auditado_en ASC
      LIMIT ?
    `;

    const rows = db.prepare(sql).all(limit);
    const items = rows.map(r => ({
      ...r,
      problemas: r.problemas_json ? JSON.parse(r.problemas_json) : [],
      problemas_json: undefined,
    }));
    res.json({ ok: true, total: items.length, items });
  });

  // Resumen para el home/chip
  router.get('/resumen', (req, res) => {
    const total = db.prepare('SELECT COUNT(*) AS n FROM auditoria_publicacion').get()?.n ?? 0;
    const con_problemas = db.prepare(
      "SELECT COUNT(*) AS n FROM auditoria_publicacion WHERE problemas_json != '[]' AND problemas_json IS NOT NULL"
    ).get()?.n ?? 0;
    const sin_clip = db.prepare(
      "SELECT COUNT(*) AS n FROM auditoria_publicacion WHERE tiene_video = 0"
    ).get()?.n ?? 0;
    res.json({ ok: true, total, con_problemas, sin_clip });
  });

  // Actualizar estado_clip de una publicación (revisión manual)
  router.patch('/item/:clave/estado-clip', (req, res) => {
    const clave = String(req.params.clave || '').trim();
    const { estado } = req.body || {};
    const ESTADOS = ['sin_revisar', 'sin_clip', 'grabado', 'subido_ml', 'subido_wc'];
    if (!ESTADOS.includes(estado)) {
      return res.status(400).json({ ok: false, error: `estado debe ser uno de: ${ESTADOS.join(', ')}` });
    }
    const row = db.prepare('SELECT 1 FROM auditoria_publicacion WHERE clave = ?').get(clave);
    if (!row) return res.status(404).json({ ok: false, error: 'clave no encontrada' });

    db.prepare(`
      UPDATE auditoria_publicacion SET estado_clip = ?, revisado_en = ? WHERE clave = ?
    `).run(estado, new Date().toISOString(), clave);
    res.json({ ok: true });
  });

  return router;
}
