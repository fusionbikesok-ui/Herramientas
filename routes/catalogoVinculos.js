import express from 'express';
import {
  agregarNotaIdentidad, asignarCasoIdentidad, confirmarImpactoIdentidad, decidirCasoIdentidad,
  destrabarOperacionIdentidad, reintentarOperacionIdentidad,
} from '../lib/identidadProductos.js';
import { liberarPedidoRetenido } from '../lib/guardiaMl.js';
import { marcarNoSincronizar, marcarLinkDePago, deshacerNoSincronizar } from '../lib/noSincronizar.js';
import { solicitarNoSincronizarPausa } from '../lib/pausasIdentidad.js';
import { colaCasos, detalleCaso, ejecucion, estadoSalud, retenidas, salteoVigente } from '../lib/catalogoVinculos.js';

/**
 * API de la pantalla "Catálogo y vínculos" (Fase D). Las lecturas arman vistas sobre Identidad; las escrituras
 * delegan en sus funciones sin duplicar lógica. Contrato: `operation_id` en el cuerpo. Los permisos de
 * administración se verifican AQUÍ, en el servidor, y no solo en la pantalla.
 */
const actor = (req) => req.user?.username || 'sistema';
const esAdmin = (req) => !!req.user?.is_admin;
const tieneMatcher = (req, nivel = 'read') => esAdmin(req) || req.user?.permisos?.some((p) =>
  p.herramienta === 'matcher' && (nivel === 'read' || p.nivel === 'write'));
// Liberar una venta retenida: Ventas, Supervisor o Admin, como en Guardia (`puedeResolver`).
const puedeLiberar = (req) => tieneMatcher(req, 'write');

const FORBIDDEN = { ok: false, code: 'FORBIDDEN', error: 'Acceso no autorizado' };

function exigir(nivel = 'read', admin = false) {
  return (req, res, next) => ((admin ? esAdmin(req) : tieneMatcher(req, nivel)) ? next() : res.status(403).json(FORBIDDEN));
}

const ESTADOS = { NOT_FOUND: 404, VERSION_CONFLICT: 409, EVIDENCE_CONFLICT: 409, CLAIM_CONFLICT: 409,
  SIBLING_IMPACT_CONFIRMATION_REQUIRED: 409, ALREADY_EXISTS: 409, INVALID_STATE: 409, INVALID_INPUT: 422,
  FORBIDDEN: 403, contradiccion_titulo: 409, omitir_requiere_override: 409,
  // Distinto de la API de Identidad (400): acá un reintento o una corrección sin efecto es un conflicto de estado.
  OPERACION_DUPLICADA: 409, SIN_CAMBIO_SKU: 409 };

function responder(res, r, creado = false) {
  if (!r?.ok) return res.status(r?.status || ESTADOS[r?.code || r?.error] || 400).json(r);
  return res.status(creado && !r.repetido ? 201 : 200).json(r);
}

export function catalogoVinculosRouter(db) {
  const router = express.Router();

  // ── Lecturas ──
  router.get('/cola', exigir(), (req, res) => responder(res, colaCasos(db, { filtro: req.query.filtro || 'abiertos', q: req.query.q || '',
    limit: req.query.limit, offset: req.query.offset })));
  router.get('/casos/:id', exigir(), (req, res) => {
    const data = detalleCaso(db, req.params.id, { sku: req.query.sku || null });
    return data ? res.json({ ok: true, data }) : res.status(404).json({ ok: false, code: 'NOT_FOUND', error: 'caso no encontrado' });
  });
  router.get('/estado', exigir(), (_req, res) => res.json({ ok: true, data: estadoSalud(db) }));
  router.get('/ejecucion', exigir(), (_req, res) => res.json({ ok: true, data: ejecucion(db) }));
  router.get('/retenidas', exigir(), (_req, res) => res.json({ ok: true, data: retenidas(db) }));

  // ── Casos: operador (matcher:write) ──
  router.post('/casos/:id/tomar', exigir('write'), (req, res) => responder(res,
    asignarCasoIdentidad(db, req.params.id, { ...req.body, responsable: actor(req) }, actor(req))));
  router.post('/casos/:id/relevar', exigir('write'), (req, res) => responder(res,
    asignarCasoIdentidad(db, req.params.id, req.body || {}, actor(req), { relevo: true })));
  router.post('/casos/:id/notas', exigir('read'), (req, res) => responder(res,
    agregarNotaIdentidad(db, req.params.id, req.body || {}, actor(req)), true));

  // Vincular. Confirmar igual (`override_contradiccion`) y saltear un omitir (`override_omitir`) son de administración.
  router.post('/casos/:id/decisiones', exigir('write'), (req, res) => {
    if ((req.body?.override_contradiccion === true || req.body?.override_omitir === true) && !esAdmin(req)) {
      return res.status(403).json(FORBIDDEN);
    }
    return responder(res, decidirCasoIdentidad(db, req.params.id, req.body || {}, actor(req)), true);
  });

  // Saltear: manda el caso al final de la cola; no resuelve nada. Vale hasta que el caso cambie de versión.
  router.post('/casos/:id/saltear', exigir('write'), (req, res) => {
    const caso = db.prepare('SELECT * FROM identidad_casos WHERE id=?').get(Number(req.params.id));
    if (!caso) return res.status(404).json({ ok: false, code: 'NOT_FOUND', error: 'caso no encontrado' });
    if (['resuelto', 'verificado', 'exceptuado'].includes(caso.estado)) {
      return res.status(409).json({ ok: false, code: 'INVALID_STATE', error: 'el caso ya está cerrado; no se puede saltear' });
    }
    if (Number(req.body?.expected_version) !== caso.expected_version) {
      return res.status(409).json({ ok: false, code: 'VERSION_CONFLICT', error: 'El caso cambió; refrescá antes de saltear' });
    }
    const previo = salteoVigente(db, caso);
    if (previo) return res.json({ ok: true, repetido: true, salteado_por: previo });
    db.prepare(`INSERT INTO identidad_historial (entidad_tipo,entidad_id,evento,actor,detalle_json,creado_en)
      VALUES ('caso',?,'caso_salteado',?,?,?)`).run(caso.id, actor(req), JSON.stringify({ expected_version: caso.expected_version }), new Date().toISOString());
    return res.json({ ok: true, salteado_por: actor(req) });
  });

  // No sincronizar (a/b/c). La (b) pausa el ítem completo en ML como operación durable.
  router.post('/casos/:id/no-sincronizar', exigir('write'), (req, res) => {
    const caso = db.prepare('SELECT ml_key FROM identidad_casos WHERE id=?').get(Number(req.params.id));
    if (!caso?.ml_key) return res.status(404).json({ ok: false, code: 'NOT_FOUND', error: 'caso no encontrado' });
    const b = req.body || {};
    const base = { clave: caso.ml_key, motivo: b.motivo, actor: actor(req),
      expectedSku: b.expected_sku, expectedSkuProvided: Object.prototype.hasOwnProperty.call(b, 'expected_sku') };
    return responder(res, b.variante === 'b'
      ? solicitarNoSincronizarPausa(db, { ...base, variante: 'b', operation_id: b.operation_id, confirm_sibling_impact: b.confirm_sibling_impact })
      : marcarNoSincronizar(db, { ...base, variante: b.variante }), true);
  });

  // Deshacer la marca: (a)/(b) cualquier operador; (c) solo admin, validado en la función con `esAdmin`.
  router.post('/claves/no-sincronizar/deshacer', exigir('write'), (req, res) => responder(res,
    deshacerNoSincronizar(db, { clave: req.body?.clave, motivo: req.body?.motivo, actor: actor(req), esAdmin: esAdmin(req) })));

  // ── Administración ──
  router.post('/claves/link-de-pago', exigir('write', true), (req, res) => {
    const b = req.body || {};
    return responder(res, marcarLinkDePago(db, { clave: b.clave, motivo: b.motivo, actor: actor(req), esAdmin: esAdmin(req),
      expectedSku: b.expected_sku, expectedSkuProvided: Object.prototype.hasOwnProperty.call(b, 'expected_sku') }), true);
  });
  router.post('/operaciones/:id/reintentar', exigir('write', true), (req, res) => responder(res,
    reintentarOperacionIdentidad(db, req.params.id, req.body || {}, actor(req))));
  router.post('/operaciones/:id/confirmar-impacto', exigir('write', true), (req, res) => responder(res,
    confirmarImpactoIdentidad(db, req.params.id, req.body || {}, actor(req))));
  router.post('/operaciones/:id/destrabar', exigir('write', true), (req, res) => responder(res,
    destrabarOperacionIdentidad(db, req.params.id, req.body || {}, actor(req))));

  // ── Retenidas ──
  router.post('/retenidas/:orderId/liberar', (req, res) => {
    if (!puedeLiberar(req)) return res.status(403).json({ ok: false, code: 'FORBIDDEN', error: 'solo Ventas, Supervisor o Admin puede liberar una venta retenida' });
    const motivo = String(req.body?.motivo || '').trim();
    if (!motivo) return res.status(422).json({ ok: false, code: 'INVALID_INPUT', error: 'motivo obligatorio' });
    if (!liberarPedidoRetenido(db, req.params.orderId, { actor: actor(req), motivo })) {
      return res.status(404).json({ ok: false, code: 'NOT_FOUND', error: 'retención no encontrada o ya resuelta' });
    }
    return res.json({ ok: true, estado: 'liberado' });
  });

  return router;
}
