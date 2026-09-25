/**
 * E3 corte 1 T6 — proxy firmado de la bandeja de identidad hacia la API interna de la plataforma.
 *
 *   GET    /api/bandeja-identidad/casos?tipo&estado&cursor&limit   → GET    /internal/v1/identidad/casos
 *   GET    /api/bandeja-identidad/casos/:id                        → GET    /internal/v1/identidad/casos/:id
 *   POST   /api/bandeja-identidad/casos/:id/decisiones             → POST   /internal/v1/identidad/casos/:id/decisiones
 *   GET    /api/bandeja-identidad/variantes?q=                     → GET    /internal/v1/identidad/variantes
 *   POST   /api/bandeja-identidad/casos/:id/apartar                → POST   /internal/v1/identidad/casos/:id/apartar
 *   DELETE /api/bandeja-identidad/casos/:id/apartar                → DELETE /internal/v1/identidad/casos/:id/apartar
 *
 * Frontera de confianza (enmienda de Codex al plan): la plataforma le cree al legado el actor y `es_admin` que
 * viajan en el cuerpo firmado, así que la garantía de que son verdaderos vive ACÁ. El actor y `es_admin` salen
 * SÓLO de `req.user` (la sesión); todo lo que el cliente mande con ese nombre se descarta. El cuerpo que se
 * reenvía se arma campo por campo (no se reenvía el del cliente), y la firma cubre exactamente los bytes enviados.
 *
 * En los GET se firma la ruta con la query tal como la ve el servidor (la plataforma firma `req.url` completo).
 * El permiso (`matcher`) lo aplica lib/permisos.js antes de llegar acá; el 401 lo da la sesión.
 */
import crypto from 'crypto';
import { Router } from 'express';
import { firmarInterno } from '../lib/internoHmac.js';

const PREFIJO = '/internal/v1/identidad';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONSULTAS = { casos: ['tipo', 'estado', 'grupo', 'cursor', 'limit'], variantes: ['q'] };

export function bandejaIdentidadRouter({ url, keyring, fetch: hacerFetch = globalThis.fetch, timeoutMs = 5000 } = {}) {
  const router = Router();

  async function reenviar(res, metodo, ruta, cuerpo, cabecerasExtra = {}) {
    if (!url || !keyring) return res.status(503).json({ ok: false, code: 'bandeja_no_configurada', message: 'La plataforma no está configurada.' });
    const destino = new URL(ruta, url);
    const rutaFirmada = destino.pathname + destino.search; // exactamente lo que va por el cable
    const buf = cuerpo === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(cuerpo));
    const ts = String(Math.floor(Date.now() / 1000));
    const nonce = crypto.randomBytes(18).toString('base64url');
    let r;
    try {
      r = await hacerFetch(destino, {
        method: metodo, signal: AbortSignal.timeout(timeoutMs),
        headers: {
          ...(cuerpo === undefined ? {} : { 'content-type': 'application/json' }),
          'x-fusion-key-id': keyring.activeKeyId, 'x-fusion-timestamp': ts, 'x-fusion-nonce': nonce,
          'x-fusion-signature': firmarInterno(keyring.keys[keyring.activeKeyId], ts, nonce, metodo, rutaFirmada, buf),
          ...cabecerasExtra,
        },
        ...(cuerpo === undefined ? {} : { body: buf }),
      });
    } catch {
      return res.status(502).json({ ok: false, code: 'plataforma_no_responde', message: 'La plataforma no responde.' });
    }
    let json = null;
    try { json = await r.json(); } catch { /* cuerpo vacío o no JSON */ }
    return res.status(r.status).json(json ?? { code: `plataforma_${r.status}` });
  }

  const consulta = (req, nombres) => {
    const p = new URLSearchParams();
    for (const n of nombres) { const v = req.query[n]; if (typeof v === 'string' && v !== '') p.set(n, v); }
    const s = p.toString();
    return s ? `?${s}` : '';
  };

  router.get('/casos', (req, res) => reenviar(res, 'GET', `${PREFIJO}/casos${consulta(req, CONSULTAS.casos)}`));
  router.get('/casos/:id', (req, res) => {
    if (!UUID.test(req.params.id)) return res.status(404).json({ ok: false, code: 'caso_inexistente' });
    return reenviar(res, 'GET', `${PREFIJO}/casos/${req.params.id}`);
  });
  router.get('/variantes', (req, res) => reenviar(res, 'GET', `${PREFIJO}/variantes${consulta(req, CONSULTAS.variantes)}`));

  router.post('/casos/:id/decisiones', (req, res) => {
    if (!UUID.test(req.params.id)) return res.status(404).json({ ok: false, code: 'caso_inexistente' });
    const clave = req.get('idempotency-key');
    if (!clave) return res.status(422).json({ ok: false, code: 'idempotency_key_requerida', message: 'Falta la cabecera Idempotency-Key.' });
    const c = req.body ?? {};
    // Se arma el cuerpo campo por campo: nada de `usuario`/`es_admin`/`actor` del cliente llega a la plataforma.
    const cuerpo = {
      expected_version: c.expected_version, eleccion: c.eleccion,
      ...(c.variant_id != null ? { variant_id: c.variant_id } : {}),
      ...(c.motivo != null ? { motivo: c.motivo } : {}),
      ...(c.revierte != null ? { revierte: c.revierte } : {}),
      // Punto A: marca del botón/tecla "Confirmar" (SKU ya vinculado, sin candidatos). Sólo un booleano —
      // no habilita nada que `eleccion:'vincular'` no habilitara ya; la plataforma antepone el prefijo al motivo.
      ...(c.confirmar === true ? { confirmar: true } : {}),
      actor: { usuario: req.user.username, es_admin: req.user.is_admin === true },
    };
    return reenviar(res, 'POST', `${PREFIJO}/casos/${req.params.id}/decisiones`, cuerpo, { 'idempotency-key': clave });
  });

  const manejarMarca = (metodo) => (req, res) => {
    if (!UUID.test(req.params.id)) return res.status(404).json({ ok: false, code: 'caso_inexistente' });
    const clave = req.get('idempotency-key');
    if (!clave) return res.status(422).json({ ok: false, code: 'idempotency_key_requerida', message: 'Falta la cabecera Idempotency-Key.' });
    const c = req.body ?? {};
    // Mismo criterio que /decisiones: el cuerpo se arma campo por campo, actor sale SÓLO de la sesión.
    const cuerpo = {
      expected_version: c.expected_version,
      ...(c.motivo != null ? { motivo: c.motivo } : {}),
      actor: { usuario: req.user.username, es_admin: req.user.is_admin === true },
    };
    return reenviar(res, metodo, `${PREFIJO}/casos/${req.params.id}/apartar`, cuerpo, { 'idempotency-key': clave });
  };
  router.post('/casos/:id/apartar', manejarMarca('POST'));
  router.delete('/casos/:id/apartar', manejarMarca('DELETE'));

  return router;
}
