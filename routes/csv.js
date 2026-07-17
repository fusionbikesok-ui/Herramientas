import express from 'express';
import { generarCSVStock, generarCSVNuevosCompleto } from '../lib/csv.js';

export function csvRouter() {
  const router = express.Router();

  router.post('/stock', (req, res) => {
    try {
      const csv = generarCSVStock(req.body.items || []);
      res.json({ ok: true, csv });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  router.post('/nuevos', (req, res) => {
    try {
      const csv = generarCSVNuevosCompleto(req.body);
      res.json({ ok: true, csv });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  return router;
}
