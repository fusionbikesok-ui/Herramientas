import express from 'express';
import {
  agregarNotaIdentidad,
  asignarCasoIdentidad,
  cambiarModoIdentidad,
  conciliacionIdentidad,
  buscarProductosFusion,
  crearTareaPublicacion,
  decidirCasoIdentidad,
  estadoIdentidadProductos,
  listarCasosIdentidad,
  listarColasIdentidad,
  listarHistorialIdentidad,
  listarOperacionesIdentidad,
  listarProductosFusion,
  obtenerCasoIdentidad,
  obtenerOperacionIdentidad,
  confirmarImpactoIdentidad,
  reintentarOperacionIdentidad,
  conflictosDeBolsaCompartida,
  conflictosDeIdentificador,
  publicacionesSinRespaldoWoo,
} from '../lib/identidadProductos.js';

const actor = (req) => req.user?.username || 'sistema';
const tieneMatcher = (req, nivel = 'read') => req.user?.is_admin || req.user?.permisos?.some((p) =>
  p.herramienta === 'matcher' && (nivel === 'read' || p.nivel === 'write'));

function exigir(nivel = 'read', admin = false) {
  return (req, res, next) => {
    if (admin ? req.user?.is_admin : tieneMatcher(req, nivel)) return next();
    return res.status(403).json({ ok: false, code: 'FORBIDDEN', error: 'Acceso no autorizado' });
  };
}

function statusCode(result) {
  return ({ NOT_FOUND: 404, VERSION_CONFLICT: 409, EVIDENCE_CONFLICT: 409,
    CLAIM_CONFLICT: 409, SIBLING_IMPACT_CONFIRMATION_REQUIRED: 409,
    ALREADY_EXISTS: 409, INVALID_STATE: 409, INVALID_INPUT: 422 }[result?.code] || 400);
}

function responder(res, result, created = false) {
  if (!result?.ok) return res.status(statusCode(result)).json(result);
  return res.status(created && !result.repetido ? 201 : 200).json(result);
}

/** Router compartido por sesión web y JWT móvil; la autenticación se monta en server.js. */
export function identidadProductosRouter(db) {
  const router = express.Router();

  router.get('/resumen', exigir(), (_req, res) => {
    const salud = estadoIdentidadProductos(db);
    const colas = listarColasIdentidad(db);
    // Misma función que usa la auditoría: resumen y gate 2 no pueden divergir.
    const c = conciliacionIdentidad(db);
    // Dos publicaciones que comparten una bolsa de stock de ML apuntando a productos distintos
    // se pisan la cantidad para siempre y una vende sin existencia. No es un caso de la cola:
    // es un riesgo persistente que hay que ver aunque hoy no dé síntoma.
    const conflictosBolsa = conflictosDeBolsaCompartida(db);
    return res.json({ ok: true, data: { salud, conciliacion: { ...c, exacta: c.conciliado },
      conflictos_bolsa: conflictosBolsa,
      // Publicaciones vendiendo sin producto Woo detrás. Si entra una venta el pedido se
      // retiene solo; esto es para enterarse ANTES de que el cliente compre.
      sin_respaldo_woo: publicacionesSinRespaldoWoo(db),
      // Un mismo GTIN reclamado por varios Producto Fusion. La unidad de trabajo es el
      // código, no la fila: resolverlo cierra todas sus filas. Vienen ordenados por stock
      // expuesto en ML, que es por donde se arranca.
      conflictos_gtin: conflictosDeIdentificador(db),
      colas: { ml_to_fusion: colas.ml_to_fusion.length, woo_to_ml: colas.woo_to_ml.length } } });
  });
  router.get('/casos', exigir(), (req, res) => res.json({ ok: true, data: listarCasosIdentidad(db, req.query) }));
  router.get('/casos/:id', exigir(), (req, res) => {
    const data = obtenerCasoIdentidad(db, req.params.id);
    return data ? res.json({ ok: true, data }) : res.status(404).json({ ok: false, code: 'NOT_FOUND', error: 'caso no encontrado' });
  });
  router.get('/productos', exigir(), (_req, res) => res.json({ ok: true, data: listarProductosFusion(db) }));
  // Búsqueda explícita para el vínculo manual; el candidato automático es UM1.4.
  router.get('/productos/buscar', exigir(), (req, res) => res.json({ ok: true, data: buscarProductosFusion(db, req.query) }));
  router.get('/operaciones', exigir(), (_req, res) => res.json({ ok: true, data: listarOperacionesIdentidad(db) }));
  router.get('/operaciones/:id', exigir(), (req, res) => {
    const data = obtenerOperacionIdentidad(db, req.params.id);
    return data ? res.json({ ok: true, data }) : res.status(404).json({ ok: false, code: 'NOT_FOUND', error: 'operación no encontrada' });
  });
  router.get('/historial', exigir(), (req, res) => res.json({ ok: true, data: listarHistorialIdentidad(db, req.query) }));
  router.get('/colas', exigir(), (_req, res) => res.json({ ok: true, data: listarColasIdentidad(db) }));
  router.get('/tareas-publicacion', exigir(), (_req, res) => res.json({ ok: true,
    data: db.prepare('SELECT * FROM identidad_tareas_publicacion ORDER BY id DESC').all() }));

  router.post('/casos/:id/tomar', exigir('write'), (req, res) => responder(res,
    asignarCasoIdentidad(db, req.params.id, { ...req.body, responsable: actor(req) }, actor(req))));
  router.post('/casos/:id/relevar', exigir('write'), (req, res) => responder(res,
    asignarCasoIdentidad(db, req.params.id, req.body || {}, actor(req), { relevo: true })));
  // Agregar evidencia narrativa es deliberadamente una capacidad de matcher:read.
  router.post('/casos/:id/notas', exigir('read'), (req, res) => responder(res,
    agregarNotaIdentidad(db, req.params.id, req.body || {}, actor(req)), true));
  router.post('/casos/:id/decisiones', exigir('write'), (req, res) => responder(res,
    decidirCasoIdentidad(db, req.params.id, req.body || {}, actor(req)), true));
  router.post('/casos/:id/excepciones', exigir('write'), (req, res) => responder(res,
    decidirCasoIdentidad(db, req.params.id, { ...req.body, tipo: 'solo_ml' }, actor(req)), true));
  router.post('/operaciones/:id/reintentar', exigir('write', true), (req, res) => responder(res,
    reintentarOperacionIdentidad(db, req.params.id, req.body || {}, actor(req))));
  // Confirmar impacto en hermanas es una decisión humana con consecuencia remota: mismo
  // nivel que reintentar, sólo Administración.
  router.post('/operaciones/:id/confirmar-impacto', exigir('write', true), (req, res) => responder(res,
    confirmarImpactoIdentidad(db, req.params.id, req.body || {}, actor(req))));
  router.post('/productos/:id/tareas-publicacion', exigir('write'), (req, res) => responder(res,
    crearTareaPublicacion(db, req.params.id, req.body || {}, actor(req)), true));
  router.put('/config/modo', exigir('write', true), (req, res) => responder(res,
    cambiarModoIdentidad(db, req.body?.modo, actor(req))));

  return router;
}
