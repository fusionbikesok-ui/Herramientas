import express from 'express';
import { calcularCriticidad, ensureVentasHistorialTables, backfillVentas } from '../lib/criticidad.js';
import { requireAdmin } from '../lib/auth.js';

const now = () => new Date().toISOString();

// Fase 3 (Rotación y criticidad). Gateado bajo el permiso 'inventario' — es
// infraestructura que consume el planificador de ciclos (Fase 4), no una herramienta
// propia con pantalla/permiso separados todavía.
export function criticidadRouter(db, cfg) {
  const router = express.Router();
  ensureVentasHistorialTables(db);

  router.get('/top', (req, res) => {
    const limite = Math.min(parseInt(req.query?.limit, 10) || 50, 500);
    const filas = calcularCriticidad(db).slice(0, limite);
    res.json({ ok: true, criticidad: filas });
  });

  router.get('/categorias-criticas', (req, res) => {
    const rows = db.prepare('SELECT * FROM categorias_criticas ORDER BY categoria').all();
    res.json({ ok: true, categorias: rows });
  });

  router.post('/categorias-criticas', requireAdmin, (req, res) => {
    const categoria = String(req.body?.categoria || '').trim();
    if (!categoria) return res.status(400).json({ ok: false, error: 'categoria requerida' });
    db.prepare(`
      INSERT INTO categorias_criticas (categoria, marcado_por, marcado_en) VALUES (?,?,?)
      ON CONFLICT(categoria) DO NOTHING
    `).run(categoria, req.user?.username || null, now());
    res.json({ ok: true });
  });

  router.delete('/categorias-criticas/:categoria', requireAdmin, (req, res) => {
    const info = db.prepare('DELETE FROM categorias_criticas WHERE categoria=?').run(req.params.categoria);
    if (!info.changes) return res.status(404).json({ ok: false, error: 'no estaba marcada como crítica' });
    res.json({ ok: true });
  });

  // Disparo manual del backfill/incremental (el cron diario es la vía normal, ver
  // server.js) — útil para forzar una corrida sin esperar al cron, ej. después de cargar
  // categorías críticas nuevas o para diagnosticar un canal caído.
  router.post('/backfill', requireAdmin, async (req, res) => {
    try {
      const resultado = await backfillVentas(db, cfg);
      res.json({ ok: true, resultado });
    } catch (e) {
      res.status(502).json({ ok: false, error: e.message });
    }
  });

  return router;
}
