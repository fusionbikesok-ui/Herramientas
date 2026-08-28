/**
 * routes/notifications.js — Notificaciones visibles al usuario.
 *
 * Contrato: openapi/mobile-v1.yaml, paths /notifications (GET, POST {id}/read).
 * Solo usuarios normales autenticados — cada usuario ve solo SUS PROPIAS notificaciones.
 */

import express from 'express';
import { requireAuth } from '../lib/auth.js';

const now = () => new Date().toISOString();

/**
 * Cursor-based paginación: base64(creado_en:id).
 * Permite pivotar por timestamp y luego por ID como desempate.
 */
function decodeCursor(cursor) {
  if (!cursor) return null;
  try {
    const decoded = Buffer.from(cursor, 'base64').toString('utf8');
    const [createdAt, id] = decoded.split(':');
    return { createdAt, id: parseInt(id, 10) };
  } catch (_) {
    return null;
  }
}

function encodeCursor(row) {
  const payload = `${row.creado_en}:${row.id}`;
  return Buffer.from(payload).toString('base64');
}

/**
 * Formatea una notificación para la respuesta API.
 */
function notificacionAPublico(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    tipo: row.tipo,
    titulo: row.titulo,
    cuerpo: row.cuerpo,
    deep_link: row.deep_link,
    leida: row.leida === 1,
    creado_en: row.creado_en,
  };
}

export function notificationsRouter(db) {
  const router = express.Router();

  /**
   * GET /notifications
   * Lista notificaciones del usuario autenticado con cursor-based pagination.
   *
   * Query params:
   *  - cursor?: string (cursor desde la respuesta anterior)
   *
   * Response 200: { items: [...], next_cursor?: string }
   * Response 401: No autenticado
   * Response 500: Error interno
   */
  router.get('/', requireAuth(db), (req, res) => {
    try {
      const userId = req.user.id;
      const { cursor } = req.query;
      const PAGE_SIZE = 20;

      const cursorData = decodeCursor(cursor);

      let query = `
        SELECT id, tipo, titulo, cuerpo, deep_link, leida, creado_en
        FROM notificaciones_usuario
        WHERE user_id = ?
      `;
      const params = [userId];

      // Si hay cursor, buscar notificaciones PREVIAS a ese punto (creado_en DESC)
      if (cursorData) {
        query += `
          AND (creado_en < ? OR (creado_en = ? AND id < ?))
        `;
        params.push(cursorData.createdAt, cursorData.createdAt, cursorData.id);
      }

      query += ` ORDER BY creado_en DESC, id DESC LIMIT ?`;
      params.push(PAGE_SIZE + 1); // Fetch uno extra para detectar si hay más

      const rows = db.prepare(query).all(...params);

      // Si hay más de PAGE_SIZE, tenemos al menos una próxima página
      let nextCursor = null;
      if (rows.length > PAGE_SIZE) {
        rows.pop(); // Quitar el extra que pedimos
        const lastRow = rows[rows.length - 1];
        nextCursor = encodeCursor(lastRow);
      }

      const items = rows.map(notificacionAPublico);

      return res.json({
        items,
        next_cursor: nextCursor,
      });
    } catch (err) {
      console.error('[notifications] error en GET /notifications:', err.message);
      return res.status(500).json({
        error: {
          code: 'error_interno',
          message: 'Ocurrió un error inesperado, reintentá',
        },
      });
    }
  });

  /**
   * POST /notifications/{id}/read
   * Marca una notificación como leída.
   *
   * Response 200: { ok: true }
   * Response 401: No autenticado
   * Response 404: Notificación no encontrada o no pertenece al usuario
   * Response 500: Error interno
   */
  router.post('/:id/read', requireAuth(db), (req, res) => {
    try {
      const notifId = parseInt(req.params.id, 10);
      const userId = req.user.id;

      // Verificar que la notificación existe y pertenece al usuario autenticado
      const notif = db
        .prepare('SELECT id FROM notificaciones_usuario WHERE id = ? AND user_id = ?')
        .get(notifId, userId);

      if (!notif) {
        return res.status(404).json({
          error: {
            code: 'no_encontrado',
            message: 'La notificación solicitada no existe o no pertenece a ti',
          },
        });
      }

      // Marcar como leída
      db.prepare('UPDATE notificaciones_usuario SET leida = 1 WHERE id = ?').run(notifId);

      return res.json({ ok: true });
    } catch (err) {
      console.error('[notifications] error en POST /notifications/:id/read:', err.message);
      return res.status(500).json({
        error: {
          code: 'error_interno',
          message: 'Ocurrió un error inesperado, reintentá',
        },
      });
    }
  });

  return router;
}
