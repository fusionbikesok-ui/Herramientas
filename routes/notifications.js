/**
 * routes/notifications.js — Notificaciones visibles al usuario.
 *
 * Contrato: openapi/mobile-v1.yaml, paths /notifications (GET, POST {id}/read).
 * Solo usuarios normales autenticados — cada usuario ve solo SUS PROPIAS notificaciones.
 */

import express from 'express';
import { requireAuth } from '../lib/auth.js';

const now = () => new Date().toISOString();

function idPositivoSeguro(value) {
  const text = String(value);
  if (!/^\d+$/.test(text)) return null;
  const id = Number(text);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/**
 * Cursor-based paginación: base64url(creado_en:id).
 * Permite pivotar por timestamp y luego por ID como desempate.
 *
 * MEDIO 8 fix: usar base64url (no base64) para que el cursor sea URL-safe.
 * base64 emite '+' y '/' que se corrompen en query params.
 * base64url usa '-' y '_' en su lugar.
 */
function decodeCursor(cursor) {
  if (!cursor) return null;
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    const separator = decoded.lastIndexOf(':');
    const createdAt = separator > 0 ? decoded.slice(0, separator) : '';
    const idStr = separator > 0 ? decoded.slice(separator + 1) : '';

    // MEDIO 8 fix: validar que el cursor tiene la forma esperada
    // Si el decodificado no es "ISO_DATE:INTEGER", rechazar explícitamente
    if (!createdAt || !idStr) return null;

    const id = idPositivoSeguro(idStr);
    if (id == null) return null;

    // Validar que createdAt es una fecha ISO válida (simple check: contiene 'T' y 'Z')
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(createdAt)
      || Number.isNaN(Date.parse(createdAt)) || String(id) !== idStr) {
      return null;
    }

    return { createdAt, id };
  } catch (_) {
    return null;
  }
}

function encodeCursor(row) {
  const payload = `${row.creado_en}:${row.id}`;
  return Buffer.from(payload).toString('base64url');
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

export function notificationsRouter(db, authMiddleware = requireAuth(db)) {
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
  router.get('/', authMiddleware, (req, res) => {
    try {
      const userId = req.user.id;
      const { cursor } = req.query;
      const PAGE_SIZE = 20;

      // MEDIO 8 fix: validar cursor si lo hay
      if (cursor) {
        const cursorData = decodeCursor(cursor);
        if (!cursorData) {
          return res.status(422).json({
            error: {
              code: 'cursor_invalido',
              message: 'El cursor de paginación es inválido o ha sido corrompido',
            },
          });
        }
      }

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
  router.post('/:id/read', authMiddleware, (req, res) => {
    try {
      const notifId = idPositivoSeguro(req.params.id);
      if (notifId == null) {
        return res.status(422).json({
          error: { code: 'id_invalido', message: 'El id de la notificación debe ser un entero positivo' },
        });
      }
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

  // Preferencias compartidas por el feed web y la app móvil.
  router.get('/preferences', authMiddleware, (req, res) => {
    const row = db.prepare('SELECT incidentes_criticos FROM preferencias_notificacion WHERE user_id = ?')
      .get(req.user.id);
    res.json({ incidentes_criticos: row ? !!row.incidentes_criticos : true });
  });

  router.patch('/preferences', authMiddleware, (req, res) => {
    if (typeof req.body?.incidentes_criticos !== 'boolean') {
      return res.status(422).json({ error: { code: 'body_invalido', message: 'incidentes_criticos debe ser boolean' } });
    }
    db.prepare(`
      INSERT INTO preferencias_notificacion (user_id, incidentes_criticos, actualizado_en)
      VALUES (?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET incidentes_criticos = excluded.incidentes_criticos,
        actualizado_en = excluded.actualizado_en
    `).run(req.user.id, req.body.incidentes_criticos ? 1 : 0, now());
    return res.json({ incidentes_criticos: req.body.incidentes_criticos });
  });

  return router;
}
