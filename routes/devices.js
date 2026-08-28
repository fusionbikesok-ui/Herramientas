/**
 * routes/devices.js — Gestión de dispositivos para notificaciones push.
 *
 * Contrato: openapi/mobile-v1.yaml, paths /devices (POST, DELETE).
 * Solo usuarios normales autenticados — cada usuario solo puede gestionar SUS PROPIOS dispositivos.
 */

import express from 'express';
import { requireAuth } from '../lib/auth.js';
import { tokenValido } from '../lib/notificacionesPush.js';

const now = () => new Date().toISOString();

/**
 * Valida que `platform` sea uno de los valores permitidos.
 * ALTO 3 fix: incluir 'web' además de iOS/Android (FCM soporta las 3 plataformas).
 */
function platformaValida(plat) {
  return ['ios', 'android', 'web'].includes(plat);
}

/**
 * Formatea un dispositivo para la respuesta API (IDs como strings, timestamps ISO).
 */
function deviceAPublico(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    platform: row.plataforma,
    device_name: row.nombre_dispositivo,
    creado_en: row.creado_en,
  };
}

export function devicesRouter(db) {
  const router = express.Router();

  /**
   * POST /devices
   * Registra un dispositivo para recibir notificaciones push.
   *
   * Body:
   *  - platform: 'ios' | 'android' | 'web'
   *  - push_token: string (token del proveedor)
   *  - device_name?: string (descripción humana, ej. "iPhone de Juan" o "Navegador")
   *
   * Response 200: { id, platform, device_name, creado_en }
   * Response 401: No autenticado
   * Response 422: Falta platform/push_token o valores inválidos
   * Response 500: Error interno
   */
  router.post('/', requireAuth(db), (req, res) => {
    try {
      const { platform, push_token, device_name } = req.body;
      const userId = req.user.id;

      // Validación
      if (!platform || !platformaValida(platform)) {
        return res.status(422).json({
          error: {
            code: 'platform_invalido',
            message: "platform debe ser 'ios' o 'android'",
          },
        });
      }
      if (!push_token || !tokenValido(push_token)) {
        return res.status(422).json({
          error: {
            code: 'push_token_invalido',
            message: 'push_token debe ser un string no vacío',
          },
        });
      }

      const ts = now();

      // Buscar si el token existe (para cualquier usuario)
      const existente = db
        .prepare('SELECT id, user_id FROM device_tokens WHERE token = ?')
        .get(push_token);

      if (existente) {
        if (existente.user_id === userId) {
          // El dispositivo ya existe para ESTE usuario — actualizar
          db.prepare(`
            UPDATE device_tokens
            SET actualizado_en = ?, revocado_en = NULL, nombre_dispositivo = ?
            WHERE id = ?
          `).run(ts, device_name || null, existente.id);

          const device = db.prepare('SELECT * FROM device_tokens WHERE id = ?').get(existente.id);
          return res.json(deviceAPublico(device));
        } else {
          // MEDIO 7 fix: el token pertenece a OTRO usuario — reasignarlo al usuario actual.
          // Escenario real: mismo teléfono con otra cuenta, o FCM recicla tokens.
          db.prepare(`
            UPDATE device_tokens
            SET user_id = ?, actualizado_en = ?, revocado_en = NULL, nombre_dispositivo = ?
            WHERE id = ?
          `).run(userId, ts, device_name || null, existente.id);

          const device = db.prepare('SELECT * FROM device_tokens WHERE id = ?').get(existente.id);
          return res.json(deviceAPublico(device));
        }
      }

      // Token no existe — INSERT nuevo dispositivo
      try {
        const info = db
          .prepare(`
            INSERT INTO device_tokens
            (user_id, token, plataforma, nombre_dispositivo, creado_en, actualizado_en)
            VALUES (?, ?, ?, ?, ?, ?)
          `)
          .run(userId, push_token, platform, device_name || null, ts, ts);

        const device = db.prepare('SELECT * FROM device_tokens WHERE id = ?').get(info.lastInsertRowid);
        return res.json(deviceAPublico(device));
      } catch (insertErr) {
        // Esto no debería pasar (ya verificamos arriba), pero por si acaso
        if (insertErr.message.includes('UNIQUE')) {
          return res.status(422).json({
            error: {
              code: 'token_ya_registrado',
              message: 'Este token ya está registrado',
            },
          });
        }
        throw insertErr;
      }
    } catch (err) {
      console.error('[devices] error en POST /devices:', err.message);
      return res.status(500).json({
        error: {
          code: 'error_interno',
          message: 'Ocurrió un error inesperado, reintentá',
        },
      });
    }
  });

  /**
   * DELETE /devices/{id}
   * Revoca un dispositivo (detiene notificaciones push, invalida refresh_tokens asociados).
   *
   * Response 200: { ok: true }
   * Response 401: No autenticado
   * Response 403: El dispositivo no pertenece al usuario autenticado
   * Response 404: Dispositivo no encontrado
   * Response 500: Error interno
   */
  router.delete('/:id', requireAuth(db), (req, res) => {
    try {
      const deviceId = req.params.id;
      const userId = req.user.id;

      // Verificar que el dispositivo existe y pertenece al usuario autenticado
      const device = db
        .prepare('SELECT * FROM device_tokens WHERE id = ? AND user_id = ?')
        .get(parseInt(deviceId, 10), userId);

      if (!device) {
        // Podría no existir (404) o existir pero ser de otro usuario (403)
        const existeParaOtro = db
          .prepare('SELECT id FROM device_tokens WHERE id = ?')
          .get(parseInt(deviceId, 10));

        if (existeParaOtro) {
          return res.status(403).json({
            error: {
              code: 'sin_permiso',
              message: 'El dispositivo no pertenece al usuario autenticado',
            },
          });
        }

        return res.status(404).json({
          error: {
            code: 'no_encontrado',
            message: 'El dispositivo solicitado no existe',
          },
        });
      }

      // Revocar: marcar con revocado_en = ahora()
      const ts = now();
      db.prepare('UPDATE device_tokens SET revocado_en = ?, actualizado_en = ? WHERE id = ?').run(
        ts,
        ts,
        device.id
      );

      // TODO (opcional): invalidar refresh_tokens emitidos desde este dispositivo
      // (requeriría una tabla device_refresh_tokens para asociar tokens a dispositivos)
      // Por ahora, el frontend cierra sesión explícitamente cuando revoca un dispositivo.

      return res.json({ ok: true });
    } catch (err) {
      console.error('[devices] error en DELETE /devices/:id:', err.message);
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
