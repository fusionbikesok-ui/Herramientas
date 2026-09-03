import express from 'express';
import {
  crearIncidente, listarIncidentes, resolverIncidente, listarEventosExcepcion,
  crearTarea, listarTareas, tomarTarea, completarTarea,
  recibirDevolucion, clasificarDevolucion, marcarDanoDevolucion,
  listarWooOutbox,
  procesarWooOutbox,
  crearDevolucionProveedor, listarDevolucionesProveedor, descartarIncidente,
  cambiarEstadoDevolucionProveedor, listarEventosDevolucionProveedor,
} from '../lib/stockExceptions.js';

function actor(req) { return req.user?.username || 'desconocido'; }
function requireMutationPermission(req, res, next) {
  if (!req.user?.permisos) return next(); // el guard global aplica en server.js
  if (req.user.is_admin || req.user.permisos.some((p) => (p.herramienta === 'stock-exceptions' || p.herramienta === 'stock') && p.nivel === 'write')) return next();
  return res.status(403).json({ ok: false, code: 'FORBIDDEN' });
}
function codeStatus(code) { return ({ NOT_FOUND: 404, VERSION_CONFLICT: 409, TASK_NOT_OWNED: 409, INVALID_INPUT: 422 })[code] || 400; }
function reply(res, result, key) { return result.ok ? res.status(result.repetido ? 200 : 201).json(result) : res.status(codeStatus(result.code)).json(result); }

export function stockExceptionsRouter(db) {
  const router = express.Router();
  router.use((req, res, next) => req.method === 'POST' ? requireMutationPermission(req, res, next) : next());
  router.get('/incidentes', (req, res) => res.json({ ok: true, data: listarIncidentes(db, req.query) }));
  router.post('/incidentes', (req, res) => reply(res, crearIncidente(db, { ...req.body, creado_por: actor(req) }), 'incidente'));
  router.post('/incidentes/:id/resolver', (req, res) => reply(res, resolverIncidente(db, req.params.id, { ...req.body, resuelto_por: actor(req) }), 'incidente'));
  router.get('/incidentes/:id/eventos', (req, res) => res.json({ ok: true, data: listarEventosExcepcion(db, 'incidente', req.params.id) }));
  router.get('/woo-outbox', (req, res) => res.json({ ok: true, data: listarWooOutbox(db, req.query) }));
  router.get('/proveedor/devoluciones', (req, res) => res.json({ ok: true, data: listarDevolucionesProveedor(db, req.query) }));
  router.post('/proveedor/devoluciones', (req, res) => reply(res, crearDevolucionProveedor(db, { ...req.body, creado_por: actor(req) }), 'devolucion'));
  router.post('/proveedor/devoluciones/:id/estado', (req, res) => reply(res, cambiarEstadoDevolucionProveedor(db, req.params.id, { ...req.body, cambiado_por: actor(req) }), 'devolucion'));
  router.get('/proveedor/devoluciones/:id/eventos', (req, res) => res.json({ ok: true, data: listarEventosDevolucionProveedor(db, req.params.id) }));
  router.post('/incidentes/:id/descarte', (req, res) => reply(res, descartarIncidente(db, req.params.id, { ...req.body, descartado_por: actor(req) }), 'incidente'));
  router.post('/devoluciones/:id/recibir', (req, res) => reply(res, recibirDevolucion(db, req.params.id, { ...req.body, recibido_por: actor(req) }), 'incidente'));
  router.post('/devoluciones/:id/clasificar', (req, res) => reply(res, clasificarDevolucion(db, req.params.id, { ...req.body, clasificado_por: actor(req) }), 'incidente'));
  router.post('/devoluciones/:id/dano', (req, res) => reply(res, marcarDanoDevolucion(db, req.params.id, { ...req.body, marcado_por: actor(req) }), 'incidente'));
  router.get('/tareas', (req, res) => res.json({ ok: true, data: listarTareas(db, req.query) }));
  router.post('/tareas', (req, res) => reply(res, crearTarea(db, { ...req.body, creado_por: actor(req) }), 'tarea'));
  router.post('/tareas/:id/tomar', (req, res) => reply(res, tomarTarea(db, req.params.id, { ...req.body, asignado_a: actor(req) }), 'tarea'));
  router.post('/tareas/:id/completar', (req, res) => reply(res, completarTarea(db, req.params.id, { ...req.body, completada_por: actor(req) }), 'tarea'));
  router.get('/tareas/:id/eventos', (req, res) => res.json({ ok: true, data: listarEventosExcepcion(db, 'tarea', req.params.id) }));
  return router;
}
