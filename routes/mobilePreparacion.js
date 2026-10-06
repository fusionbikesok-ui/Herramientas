import express from 'express';
import { preparacionRouter } from './preparacion.js';

/**
 * Adaptador móvil de preparación (`/api/v1/preparation`).
 *
 * Las reglas de picking —perfiles de embalaje, requisitos de foto, claims, cierre— viven en
 * routes/preparacion.js (3.300 líneas) y en el panel web ya están probadas en producción.
 * Este router NO las reimplementa: reescribe la URL y delega en los handlers legacy, así no
 * hay dos versiones de la misma regla que puedan divergir. Lo único propio de acá es la
 * traducción de nombres y de forma de respuesta al contrato móvil.
 *
 * Auth: se monta detrás de `mobileAuth`, que deja `req.user` igual que la sesión del panel,
 * que es lo que los handlers legacy leen para saber quién opera.
 */

/**
 * Versión para control optimista.
 *
 * `preparaciones` no tiene columna de versión y agregarla exigiría migrar una tabla viva.
 * Los eventos sí son monótonos por preparación y toda mutación escribe uno, así que el id
 * del último evento sirve: si alguien tocó la preparación, cambió.
 */
function versionDe(db, preparacionId) {
  const fila = db.prepare('SELECT MAX(id) AS v FROM preparacion_eventos WHERE preparacion_id=?').get(preparacionId);
  return Number(fila?.v || 0);
}

function resumenDesdeCola(fila) {
  return {
    id: fila.preparacion_id != null ? String(fila.preparacion_id) : null,
    clave: fila.clave || null,
    canal: fila.canal,
    estado: fila.estado_preparacion || 'sin_iniciar',
    pack_id: fila.pack_id || null,
    numero_pedido: fila.numero_pedido != null ? String(fila.numero_pedido) : null,
    comprador: fila.comprador || null,
    fecha: fila.fecha || null,
    fecha_despacho: fila.fecha_despacho || null,
    fecha_despacho_limite: fila.fecha_despacho_limite || null,
    estado_despacho: fila.estado_despacho || null,
    etiqueta_lista: Number(fila.etiqueta_lista || 0) === 1,
    cantidad_items: Array.isArray(fila.items) ? fila.items.length : 0,
    items: Array.isArray(fila.items) ? fila.items : [],
  };
}

export function mobilePreparacionRouter(db, auth, cfg = {}) {
  const router = express.Router();
  router.use(auth);
  const legacy = preparacionRouter(db, cfg);

  // Delega en el handler legacy cambiando solo la URL. `next` se pasa tal cual para que un
  // error siga cayendo en el manejador de errores de Express.
  const delegar = (destino) => (req, res, next) => {
    req.url = destino(req);
    legacy(req, res, next);
  };

  // Envuelve la respuesta legacy `{ok, data}` en la forma que espera la app.
  const envolver = (res, transformar) => {
    const original = res.json.bind(res);
    res.json = (cuerpo) => {
      if (!cuerpo || cuerpo.ok !== true) return original(cuerpo);
      return original(transformar(cuerpo));
    };
  };

  router.get('/queue', (req, res, next) => {
    const limite = Math.min(Math.max(Number(req.query.limit) || 20, 1), 50);
    envolver(res, (cuerpo) => {
      const todas = Array.isArray(cuerpo.data) ? cuerpo.data : [];
      return {
        items: todas.slice(0, limite).map(resumenDesdeCola),
        // La cola legacy no pagina: devuelve el día completo, que son decenas de filas.
        // Se declara el cursor igual para no cambiar el contrato cuando sí se pagine.
        next_cursor: null,
        total: todas.length,
        actualizado_en: cuerpo.actualizado_en || null,
        sync_error: cuerpo.sync_error || null,
      };
    });
    req.url = '/pendientes';
    legacy(req, res, next);
  });

  router.post('/:id/take', (req, res, next) => {
    const id = Number(req.params.id);
    const esperada = req.body?.expected_version;
    // El contrato pide control optimista y el handler legacy no lo hace: se valida acá
    // antes de delegar, para que dos personas no tomen la misma preparación pisándose.
    if (esperada !== undefined && esperada !== null) {
      const actual = versionDe(db, id);
      if (Number(esperada) !== actual) {
        return res.status(409).json({ ok: false, code: 'VERSION_CONFLICT', error: 'La preparación cambió mientras la mirabas.', version: actual });
      }
    }
    envolver(res, (cuerpo) => ({ ...cuerpo, version: versionDe(db, id) }));
    req.url = `/${req.params.id}/tomar`;
    legacy(req, res, next);
  });

  router.get('/:id', (req, res, next) => {
    envolver(res, (cuerpo) => ({ ...cuerpo, version: versionDe(db, Number(req.params.id)) }));
    req.url = `/${req.params.id}`;
    legacy(req, res, next);
  });

  router.get('/:id/events', delegar((req) => `/${req.params.id}/eventos`));
  router.post('/:id/scans', delegar((req) => `/${req.params.id}/escanear`));
  router.post('/:id/items/:itemId/confirm-manual', delegar((req) => `/${req.params.id}/item/${req.params.itemId}/confirmar-manual`));
  router.post('/:id/items/:itemId/packaging', delegar((req) => `/${req.params.id}/item/${req.params.itemId}/embalaje`));
  router.post('/:id/complete', delegar((req) => `/${req.params.id}/completar`));
  router.post('/:id/claim/renew', delegar((req) => `/${req.params.id}/claim/renovar`));
  router.post('/:id/claim/release', delegar((req) => `/${req.params.id}/claim/liberar`));

  return router;
}
