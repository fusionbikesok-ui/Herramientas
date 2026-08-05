/**
 * Estado del token OAuth de MercadoLibre, para el banner del Home.
 * Separado de syncRouter (montado en /api/sync) porque el contrato pedido es
 * GET /api/ml/token-estado — un endpoint de solo lectura, sin permiso de herramienta
 * específico (lo puede ver cualquier usuario autenticado, ver lib/permisos.js).
 */

import { Router } from 'express';
import { getEstadoRefresh } from '../lib/mlClient.js';

export function mlEstadoRouter(db) {
  const router = Router();

  router.get('/token-estado', (req, res) => {
    const row = db.prepare('SELECT expires_at, actualizado_en FROM ml_oauth_token WHERE id = 1').get();
    const estadoRefresh = getEstadoRefresh();
    // Ruta que ya arranca el flujo de re-autorización manual (routes/sync.js:ml-auth-url).
    const reautorizarUrl = '/api/sync/ml-auth-url';

    if (!row) {
      return res.json({
        ok: false,
        expires_at: null,
        actualizado_en: null,
        vencido: true,
        minutos_restantes: null,
        motivo: estadoRefresh.ultimoError?.mensaje || 'Token ML no inicializado — falta el bootstrap OAuth',
        requiere_reautorizacion: true,
        reautorizar_url: reautorizarUrl,
      });
    }

    const expiresAtMs = new Date(row.expires_at).getTime();
    const vencido = Date.now() >= expiresAtMs;
    const minutosRestantes = Math.round((expiresAtMs - Date.now()) / 60000);
    const motivo = estadoRefresh.ultimoError?.mensaje ?? null;
    // Solo el caso fatal (400/401 — refresh_token quemado o credenciales inválidas)
    // requiere intervención manual; un 429/5xx transitorio no debe mandar al usuario
    // a re-autorizar algo que en realidad está bien.
    const requiereReautorizacion = estadoRefresh.ultimoError?.clase === 'fatal';

    res.json({
      ok: !vencido && !requiereReautorizacion,
      expires_at: row.expires_at,
      actualizado_en: row.actualizado_en,
      vencido,
      minutos_restantes: minutosRestantes,
      motivo,
      requiere_reautorizacion: requiereReautorizacion,
      reautorizar_url: reautorizarUrl,
    });
  });

  return router;
}
