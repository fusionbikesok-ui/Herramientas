import express from 'express';
import {
  crearIncidente, listarIncidentes, resolverIncidente, listarEventosExcepcion,
  crearTarea, listarTareas, tomarTarea, completarTarea,
} from '../lib/stockExceptions.js';

function actor(req) { return req.user?.username || 'desconocido'; }
function codeStatus(code) { return ({ NOT_FOUND: 404, VERSION_CONFLICT: 409, TASK_NOT_OWNED: 409, INVALID_INPUT: 422 })[code] || 400; }
function reply(res, result, key) { return result.ok ? res.status(result.repetido ? 200 : 201).json(result) : res.status(codeStatus(result.code)).json(result); }

export function stockExceptionsRouter(db) {
  const router = express.Router();
  router.get('/incidentes', (req, res) => res.json({ ok: true, data: listarIncidentes(db, req.query) }));
  router.post('/incidentes', (req, res) => reply(res, crearIncidente(db, { ...req.body, creado_por: actor(req) }), 'incidente'));
  router.post('/incidentes/:id/resolver', (req, res) => reply(res, resolverIncidente(db, req.params.id, { ...req.body, resuelto_por: actor(req) }), 'incidente'));
  router.get('/incidentes/:id/eventos', (req, res) => res.json({ ok: true, data: listarEventosExcepcion(db, 'incidente', req.params.id) }));
  router.get('/tareas', (req, res) => res.json({ ok: true, data: listarTareas(db, req.query) }));
  router.post('/tareas', (req, res) => reply(res, crearTarea(db, { ...req.body, creado_por: actor(req) }), 'tarea'));
  router.post('/tareas/:id/tomar', (req, res) => reply(res, tomarTarea(db, req.params.id, { ...req.body, asignado_a: actor(req) }), 'tarea'));
  router.post('/tareas/:id/completar', (req, res) => reply(res, completarTarea(db, req.params.id, { ...req.body, completada_por: actor(req) }), 'tarea'));
  router.get('/tareas/:id/eventos', (req, res) => res.json({ ok: true, data: listarEventosExcepcion(db, 'tarea', req.params.id) }));
  return router;
}
