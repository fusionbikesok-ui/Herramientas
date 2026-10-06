/**
 * Acciones de la bandeja móvil contra Mercado Libre (E6, tarea 2).
 *
 * Esta capa es delgada a propósito: valida la forma de la petición, delega en
 * `lib/mobileInboxActions.js` —que es quien relee ML y decide— y traduce el error de negocio
 * a HTTP. Ninguna regla de ML vive acá.
 *
 * Toda escritura exige `Idempotency-Key`. La app la genera por intento, así que un reintento
 * por red cortada devuelve el resultado anterior en lugar de mandarle dos respuestas al
 * comprador. Sin la cabecera se rechaza: hacerla opcional deja el camino inseguro abierto.
 */

import express from 'express';
import {
  AccionError, responderPregunta, enviarMensajePack, ejecutarAccionReclamo,
} from '../lib/mobileInboxActions.js';

const MAX_CLAVE = 128;

function claveDe(req) {
  const clave = req.get('Idempotency-Key');
  if (!clave || clave.length > MAX_CLAVE) {
    throw new AccionError(422, 'idempotency_key_requerida',
      'Falta la cabecera Idempotency-Key o supera el largo permitido');
  }
  return clave;
}

/** Traduce a HTTP. Un error inesperado nunca filtra el mensaje interno al cliente. */
function responderError(res, e, log) {
  if (e instanceof AccionError) {
    return res.status(e.status).json({ error: { code: e.code, message: e.message, ...e.extra } });
  }
  log?.('accion_inbox_error', e);
  return res.status(500).json({ error: { code: 'error_interno', message: 'No se pudo completar la acción' } });
}

export function mobileInboxAccionesRouter(db, authMiddleware, mlCfg, opts = {}) {
  const router = express.Router();
  const auth = authMiddleware;
  const log = opts.log || ((etiqueta, e) => console.error(`[${etiqueta}]`, e?.message || e));

  // Responder una pregunta. Hasta E6 el sistema no podía responder una pregunta desde ningún
  // lado —ni el panel ni la app—: `POST /answers` no existía en el repositorio.
  router.post('/questions/:questionId/reply', auth, async (req, res) => {
    try {
      const salida = await responderPregunta(db, mlCfg, {
        questionId: req.params.questionId,
        texto: req.body?.text,
        userId: req.user.id,
        clave: claveDe(req),
      });
      return res.json(salida);
    } catch (e) {
      return responderError(res, e, log);
    }
  });

  // Mensaje posventa al comprador, por pack.
  router.post('/conversations/:packId/messages', auth, async (req, res) => {
    try {
      const salida = await enviarMensajePack(db, mlCfg, {
        packId: req.params.packId,
        texto: req.body?.text,
        userId: req.user.id,
        clave: claveDe(req),
      });
      return res.json(salida);
    } catch (e) {
      return responderError(res, e, log);
    }
  });

  // Acción sobre un reclamo. La allowlist la decide ML, no esta ruta.
  router.post('/claims/:claimId/actions/:accion', auth, async (req, res) => {
    try {
      const salida = await ejecutarAccionReclamo(db, mlCfg, {
        claimId: req.params.claimId,
        accion: req.params.accion,
        texto: req.body?.text,
        userId: req.user.id,
        clave: claveDe(req),
      });
      return res.json(salida);
    } catch (e) {
      return responderError(res, e, log);
    }
  });

  return router;
}
