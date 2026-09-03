import express from 'express';
import { crearGarantia, listarGarantias, cambiarGarantia, agregarEventoGarantia, listarEventosGarantia, inspeccionarGarantia, agregarAdjuntoGarantia, listarAdjuntosGarantia, crearCompromisoGarantia, listarCompromisosGarantia, cambiarCompromisoGarantia, consumirCompromisoGarantia, listarWooOutboxGarantia } from '../lib/warranties.js';
const actor = req => req.user?.username || 'desconocido';
const status = code => ({ NOT_FOUND: 404, VERSION_CONFLICT: 409, INVALID_INPUT: 422 }[code] || 400);
const reply = (res, result) => res.status(result.ok ? (result.repetido ? 200 : 201) : status(result.code)).json(result);
export function warrantiesRouter(db) {
  const router = express.Router();
  router.get('/', (req, res) => res.json({ ok: true, data: listarGarantias(db, req.query) }));
  router.post('/', (req, res) => reply(res, crearGarantia(db, { ...req.body, creado_por: actor(req) })));
  router.post('/:id/estado', (req, res) => reply(res, cambiarGarantia(db, req.params.id, { ...req.body, actor: actor(req) })));
  router.post('/:id/inspeccion', (req, res) => reply(res, inspeccionarGarantia(db, req.params.id, { ...req.body, actor: actor(req) })));
  router.post('/:id/eventos', (req, res) => reply(res, agregarEventoGarantia(db, req.params.id, { ...req.body, actor: actor(req) })));
  router.get('/:id/eventos', (req, res) => res.json({ ok: true, data: listarEventosGarantia(db, req.params.id) }));
  router.post('/:id/adjuntos', (req, res) => reply(res, agregarAdjuntoGarantia(db, req.params.id, { ...req.body, actor: actor(req) })));
  router.get('/:id/adjuntos', (req, res) => res.json({ ok: true, data: listarAdjuntosGarantia(db, req.params.id) }));
  router.post('/:id/compromisos', (req, res) => reply(res, crearCompromisoGarantia(db, { ...req.body, caso_id: req.params.id, creado_por: actor(req) })));
  router.get('/:id/compromisos', (req, res) => res.json({ ok: true, data: listarCompromisosGarantia(db, req.params.id) }));
  router.post('/compromisos/:compromisoId/estado', (req, res) => reply(res, cambiarCompromisoGarantia(db, req.params.compromisoId, { ...req.body, actor: actor(req) })));
  router.post('/compromisos/:compromisoId/consumir', (req, res) => reply(res, consumirCompromisoGarantia(db, req.params.compromisoId, { ...req.body, actor: actor(req) })));
  router.get('/woo-outbox', (req, res) => res.json({ ok: true, data: listarWooOutboxGarantia(db, req.query) }));
  return router;
}
