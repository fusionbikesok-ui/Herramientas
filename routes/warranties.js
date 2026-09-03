import express from 'express';
import multer from 'multer';
import { guardarArchivo } from '../utils/storage.js';
import { crearGarantia, listarGarantias, cambiarGarantia, agregarEventoGarantia, listarEventosGarantia, inspeccionarGarantia, agregarAdjuntoGarantia, listarAdjuntosGarantia, crearCompromisoGarantia, listarCompromisosGarantia, cambiarCompromisoGarantia, consumirCompromisoGarantia, listarWooOutboxGarantia } from '../lib/warranties.js';
const actor = req => req.user?.username || 'desconocido';
const status = code => ({ NOT_FOUND: 404, VERSION_CONFLICT: 409, INVALID_INPUT: 422 }[code] || 400);
const reply = (res, result) => res.status(result.ok ? (result.repetido ? 200 : 201) : status(result.code)).json(result);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });
export function warrantiesRouter(db) {
  const router = express.Router();
  router.get('/', (req, res) => res.json({ ok: true, data: listarGarantias(db, req.query) }));
  router.post('/', (req, res) => reply(res, crearGarantia(db, { ...req.body, creado_por: actor(req) })));
  router.post('/:id/estado', (req, res) => reply(res, cambiarGarantia(db, req.params.id, { ...req.body, actor: actor(req) })));
  router.post('/:id/inspeccion', (req, res) => reply(res, inspeccionarGarantia(db, req.params.id, { ...req.body, actor: actor(req) })));
  router.post('/:id/eventos', (req, res) => reply(res, agregarEventoGarantia(db, req.params.id, { ...req.body, actor: actor(req) })));
  router.get('/:id/eventos', (req, res) => res.json({ ok: true, data: listarEventosGarantia(db, req.params.id) }));
  router.post('/:id/adjuntos', (req, res) => reply(res, agregarAdjuntoGarantia(db, req.params.id, { ...req.body, actor: actor(req) })));
  router.post('/:id/adjuntos/archivo', (req, res, next) => upload.single('archivo')(req, res, err => {
    if (err) return res.status(400).json({ ok: false, code: err.code === 'LIMIT_FILE_SIZE' ? 'FILE_TOO_LARGE' : 'UPLOAD_FAILED', error: err.code === 'LIMIT_FILE_SIZE' ? 'archivo demasiado grande (máximo 15MB)' : 'no se pudo cargar el archivo' });
    next();
  }), (req, res) => {
    if (!req.file) return res.status(400).json({ ok: false, code: 'INVALID_INPUT', error: 'archivo requerido' });
    const caso = db.prepare('SELECT pedido_id FROM warranty_cases WHERE id=?').get(Number(req.params.id));
    if (!caso) return res.status(404).json({ ok: false, code: 'NOT_FOUND' });
    const saved = guardarArchivo({ buffer: req.file.buffer, originalname: req.file.originalname, mimetype: req.file.mimetype, importador: 'warranty', numeroPedido: caso.pedido_id || `caso-${req.params.id}` });
    return reply(res, agregarAdjuntoGarantia(db, req.params.id, { tipo: req.body?.tipo || 'foto', referencia: saved.url, nota: req.body?.nota, actor: actor(req), operation_id: req.body?.operation_id }));
  });
  router.get('/:id/adjuntos', (req, res) => res.json({ ok: true, data: listarAdjuntosGarantia(db, req.params.id) }));
  router.post('/:id/compromisos', (req, res) => reply(res, crearCompromisoGarantia(db, { ...req.body, caso_id: req.params.id, creado_por: actor(req) })));
  router.get('/:id/compromisos', (req, res) => res.json({ ok: true, data: listarCompromisosGarantia(db, req.params.id) }));
  router.post('/compromisos/:compromisoId/estado', (req, res) => reply(res, cambiarCompromisoGarantia(db, req.params.compromisoId, { ...req.body, actor: actor(req) })));
  router.post('/compromisos/:compromisoId/consumir', (req, res) => reply(res, consumirCompromisoGarantia(db, req.params.compromisoId, { ...req.body, actor: actor(req) })));
  router.get('/woo-outbox', (req, res) => res.json({ ok: true, data: listarWooOutboxGarantia(db, req.query) }));
  return router;
}
