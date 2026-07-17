import express from 'express';
import { getMapeoConocido, guardarMapeo, registrarNuevosPendientes, normalizarTexto } from '../db/mapeo.js';

export function mapeoRouter(db) {
  const router = express.Router();

  router.get('/conocido', (req, res) => {
    res.json({ ok: true, data: getMapeoConocido(db) });
  });

  router.post('/guardar', (req, res) => {
    try {
      const relaciones = (req.body.relaciones || []).map(r => ({
        clave: normalizarTexto(`${r.nombreDoc} ${r.variacion || ''}`),
        idWoo: r.idFusion,
        variacion: r.variacion || ''
      }));
      guardarMapeo(db, relaciones);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  router.post('/pendientes', (req, res) => {
    try {
      const registros = (req.body.registros || []).map(r => ({
        nombreOriginal: r.nombreDoc,
        claveNormalizada: normalizarTexto(`${r.nombreDoc} ${r.variacion || ''}`)
      }));
      registrarNuevosPendientes(db, registros);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  return router;
}
