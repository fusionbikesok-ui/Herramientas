import express from 'express';
import crypto from 'crypto';
import {
  verifyPassword,
  cargarUsuario,
  crearAccessToken,
  MOBILE_ACCESS_EXPIRES_IN,
  mobileAuthMiddleware,
  validarMobileJwtSecret,
  claveRateLimit,
  loginBloqueado,
  registrarLoginFallido,
  registrarLoginExitoso,
} from '../lib/auth.js';

const now = () => new Date().toISOString();
const hashRefreshToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

function error(res, status, code, message) {
  return res.status(status).json({ error: { code, message } });
}

function userPublico(user) {
  return {
    id: String(user.id),
    username: user.username,
    roles: user.is_admin ? ['admin'] : [],
    permisos: user.is_admin ? ['all'] : user.permisos.map((p) => `${p.herramienta}:${p.nivel}`),
  };
}

function crearRefresh(db, userId, deviceId) {
  if (!Number.isSafeInteger(deviceId) || deviceId <= 0) {
    throw new Error('Un refresh token móvil debe estar ligado a un dispositivo');
  }
  const raw = crypto.randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  db.prepare(`
    INSERT INTO mobile_refresh_tokens (token_hash, user_id, device_id, expires_at, creado_en)
    VALUES (?, ?, ?, ?, ?)
  `).run(hashRefreshToken(raw), userId, deviceId ?? null, expires, now());
  return { raw, hash: hashRefreshToken(raw) };
}

function deviceFromLogin(db, userId, body) {
  if (body.device_id != null) {
    if (body.platform != null || body.push_token != null || body.device_name != null) {
      return {
        code: 'body_invalido',
        error: 'device_id no puede combinarse con platform, push_token o device_name',
      };
    }
    const textId = String(body.device_id);
    if (!/^\d+$/.test(textId)) return { error: 'device_id inválido o no pertenece al usuario' };
    const deviceId = Number(textId);
    const device = db.prepare('SELECT id FROM device_tokens WHERE id = ? AND user_id = ? AND revocado_en IS NULL')
      .get(deviceId, userId);
    if (!device) return { error: 'device_id inválido o no pertenece al usuario' };
    return { id: device.id };
  }
  if (typeof body.push_token !== 'string' || !body.push_token.trim()) {
    return { error: 'device_id o push_token son requeridos' };
  }
  if (!['ios', 'android', 'web'].includes(body.platform)) return { error: 'platform inválido' };
  const token = body.push_token.trim();
  const ts = now();
  const active = db.prepare('SELECT id, user_id FROM device_tokens WHERE token = ? AND revocado_en IS NULL').get(token);
  if (active && active.user_id !== userId) {
    db.prepare('UPDATE device_tokens SET revocado_en = ?, actualizado_en = ? WHERE id = ?').run(ts, ts, active.id);
    db.prepare('UPDATE mobile_refresh_tokens SET revocado_en = ? WHERE device_id = ? AND revocado_en IS NULL')
      .run(ts, active.id);
    const result = db.prepare(`
      INSERT INTO device_tokens (user_id, token, plataforma, nombre_dispositivo, creado_en, actualizado_en)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(userId, token, body.platform, body.device_name || null, ts, ts);
    return { id: Number(result.lastInsertRowid) };
  }
  if (active) {
    db.prepare('UPDATE device_tokens SET plataforma = ?, nombre_dispositivo = ?, actualizado_en = ? WHERE id = ?')
      .run(body.platform, body.device_name || null, ts, active.id);
    return { id: active.id };
  }
  const result = db.prepare(`
    INSERT INTO device_tokens (user_id, token, plataforma, nombre_dispositivo, creado_en, actualizado_en)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(userId, token, body.platform, body.device_name || null, ts, ts);
  return { id: Number(result.lastInsertRowid) };
}

export function mobileAuthRouter(db, secret) {
  validarMobileJwtSecret(secret);
  const router = express.Router();

  router.post('/login', (req, res) => {
    const { username, password } = req.body || {};
    if (!username || !password) return error(res, 422, 'body_invalido', 'username y password son requeridos');
    const rateLimitKey = claveRateLimit(username, req.ip);
    const lockedUntil = loginBloqueado(rateLimitKey, req.ip);
    if (lockedUntil) {
      res.set('Retry-After', String(Math.ceil((lockedUntil - Date.now()) / 1000)));
      return error(res, 429, 'demasiados_intentos', 'Demasiados intentos fallidos. Esperá antes de reintentar');
    }
    const row = db.prepare('SELECT id, username, pass_hash, activo FROM users WHERE username = ? COLLATE NOCASE')
      .get(String(username).trim());
    if (!row || !row.activo || !verifyPassword(password, row.pass_hash)) {
      registrarLoginFallido(rateLimitKey, req.ip);
      return error(res, 401, 'credenciales_invalidas', 'Usuario o contraseña incorrectos');
    }
    try {
      const user = cargarUsuario(db, row.id);
      registrarLoginExitoso(rateLimitKey);
      const issued = db.transaction(() => {
        const device = deviceFromLogin(db, row.id, req.body || {});
        if (device.error) return device;
        const refresh = crearRefresh(db, row.id, device.id);
        return { device, refresh };
      })();
      if (issued.error) return error(res, 422, issued.code || 'device_invalido', issued.error);
      return res.json({
        access_token: crearAccessToken(user, secret, undefined, issued.refresh.hash),
        refresh_token: issued.refresh.raw,
        expires_in: MOBILE_ACCESS_EXPIRES_IN,
        user: userPublico(user),
        device_id: String(issued.device.id),
      });
    } catch (err) {
      console.error('[mobile-auth] error de login:', err.message);
      return error(res, 500, 'error_interno', 'Ocurrió un error inesperado, reintentá');
    }
  });

  router.post('/refresh', (req, res) => {
    const raw = String(req.body?.refresh_token || '');
    if (!raw) return error(res, 422, 'body_invalido', 'refresh_token es requerido');
    try {
      const tx = db.transaction(() => {
        const token = db.prepare(`
          SELECT t.* FROM mobile_refresh_tokens t
          JOIN device_tokens d ON d.id = t.device_id AND d.user_id = t.user_id
          WHERE t.token_hash = ? AND t.revocado_en IS NULL AND t.expires_at > ?
            AND d.revocado_en IS NULL
        `).get(hashRefreshToken(raw), now());
        if (!token) return null;
        const user = cargarUsuario(db, token.user_id);
        if (!user || !Number.isSafeInteger(token.device_id) || token.device_id <= 0) return null;
        const replacement = crearRefresh(db, token.user_id, token.device_id);
        db.prepare('UPDATE mobile_refresh_tokens SET revocado_en = ?, reemplazado_por = ? WHERE id = ?')
          .run(now(), replacement.hash, token.id);
        return { user, replacement, deviceId: token.device_id };
      });
      const result = tx();
      if (!result) return error(res, 401, 'refresh_revocado', 'El refresh_token es inválido, expiró o fue revocado');
      return res.json({
        access_token: crearAccessToken(result.user, secret, undefined, result.replacement.hash),
        refresh_token: result.replacement.raw,
        expires_in: MOBILE_ACCESS_EXPIRES_IN,
        device_id: String(result.deviceId),
        user: userPublico(result.user),
      });
    } catch (err) {
      console.error('[mobile-auth] error de refresh:', err.message);
      return error(res, 500, 'error_interno', 'Ocurrió un error inesperado, reintentá');
    }
  });

  router.post('/logout', mobileAuthMiddleware(db, secret), (req, res) => {
    const raw = String(req.body?.refresh_token || '');
    if (!raw) return error(res, 422, 'body_invalido', 'refresh_token es requerido');
    const tokenHash = hashRefreshToken(raw);
    if (tokenHash !== req.mobileClaims.sid) {
      return error(res, 401, 'sesion_invalida', 'El refresh_token no corresponde a la sesión actual');
    }
    const result = db.prepare(`UPDATE mobile_refresh_tokens SET revocado_en = ?
      WHERE token_hash = ? AND user_id = ? AND revocado_en IS NULL`)
      .run(now(), tokenHash, req.user.id);
    if (!result.changes) return error(res, 401, 'sesion_invalida', 'La sesión ya fue revocada');
    return res.json({ ok: true });
  });

  return router;
}

export function mobileMeHandler(db) {
  return (req, res) => res.json(userPublico(cargarUsuario(db, req.user.id)));
}
