import express from 'express';
import crypto from 'crypto';
import {
  verifyPassword, hashPassword, cargarUsuario,
  claveRateLimit, loginBloqueado, registrarLoginFallido, registrarLoginExitoso,
} from '../lib/auth.js';
import { enviarEmailReset } from '../lib/mailer.js';

// Evita que el navegador cachee respuestas de sesión: sin esto, el botón "atrás" tras un
// logout puede servir de la bfcache/caché HTTP un /me con el usuario todavía autenticado,
// aunque el servidor ya invalidó la sesión (confirmado con curl: 401 en un fetch manual).
function sinCache(req, res, next) {
  res.set('Cache-Control', 'no-store');
  res.set('Pragma', 'no-cache');
  next();
}

// Router de autenticación. Se monta SIN requireAuth: /login debe ser público.
export function authRouter(db) {
  const router = express.Router();
  router.use(sinCache);

  router.post('/login', (req, res) => {
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ ok: false, error: 'Faltan credenciales' });
    }
    const key = claveRateLimit(username, req.ip);
    const lockedUntil = loginBloqueado(key);
    if (lockedUntil) {
      res.set('Retry-After', String(Math.ceil((lockedUntil - Date.now()) / 1000)));
      return res.status(429).json({ ok: false, error: 'Demasiados intentos fallidos. Esperá antes de reintentar.' });
    }
    const row = db
      .prepare('SELECT id, pass_hash, activo FROM users WHERE username = ? COLLATE NOCASE')
      .get(String(username).trim());
    if (!row || !row.activo || !verifyPassword(password, row.pass_hash)) {
      registrarLoginFallido(key);
      return res.status(401).json({ ok: false, error: 'Usuario o contraseña incorrectos' });
    }
    registrarLoginExitoso(key);
    // Regenerar sesión para evitar fijación de sesión
    req.session.regenerate((err) => {
      if (err) return res.status(500).json({ ok: false, error: 'Error de sesión' });
      req.session.userId = row.id;
      const user = cargarUsuario(db, row.id);
      res.json({ ok: true, ...serializarMe(user) });
    });
  });

  router.post('/logout', (req, res) => {
    req.session?.destroy?.(() => {
      res.clearCookie('connect.sid');
      res.json({ ok: true });
    });
  });

  router.get('/me', (req, res) => {
    const sid = req.session?.userId;
    if (!sid) return res.status(401).json({ ok: false, error: 'No autenticado' });
    const user = cargarUsuario(db, sid);
    if (!user) {
      req.session?.destroy?.(() => {});
      return res.status(401).json({ ok: false, error: 'Sesión inválida' });
    }
    res.json({ ok: true, ...serializarMe(user) });
  });

  // ── Recuperación de contraseña ──

  // POST /api/auth/forgot  {username}
  // Genera un token de reset. Siempre responde "ok" para no revelar si el usuario existe.
  router.post('/forgot', async (req, res) => {
    const username = String(req.body?.username || '').trim();
    if (!username) return res.status(400).json({ ok: false, error: 'Falta el usuario' });

    const user = db.prepare('SELECT id, username, email, activo FROM users WHERE username = ? COLLATE NOCASE').get(username);
    // Responder siempre igual para no filtrar si el usuario existe
    if (!user || !user.activo || !user.email) {
      // No hay email cargado o el usuario no existe: si el usuario existe, loguear el link
      if (user && user.activo && !user.email) {
        console.warn(`[RESET] Usuario "${user.username}" no tiene email registrado. Un admin debe resetear la contraseña desde el panel.`);
      }
      return res.json({ ok: true });
    }

    // Limpiar tokens viejos del usuario
    db.prepare('DELETE FROM password_reset_tokens WHERE user_id = ?').run(user.id);

    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hora
    db.prepare('INSERT INTO password_reset_tokens (user_id, token, expires_at, used) VALUES (?, ?, ?, 0)')
      .run(user.id, token, expiresAt);

    const base = process.env.APP_URL || 'http://179.197.74.83';
    const resetUrl = `${base}/herramientas/reset-password/?token=${token}`;

    try {
      await enviarEmailReset({ to: user.email, username: user.username, resetUrl });
    } catch (e) {
      console.error('[RESET] Error al enviar email:', e.message);
      // No revelar el error al cliente; el link queda en la DB por si el admin lo recupera
    }
    res.json({ ok: true });
  });

  // POST /api/auth/reset  {token, password}
  router.post('/reset', (req, res) => {
    const { token, password } = req.body || {};
    if (!token || !password) return res.status(400).json({ ok: false, error: 'Faltan datos' });
    if (String(password).length < 6) return res.status(400).json({ ok: false, error: 'La contraseña debe tener al menos 6 caracteres' });

    const row = db.prepare(
      "SELECT t.id, t.user_id, t.expires_at, t.used FROM password_reset_tokens t WHERE t.token = ?"
    ).get(String(token));

    if (!row || row.used) return res.status(400).json({ ok: false, error: 'El link es inválido o ya fue usado' });
    if (new Date(row.expires_at) < new Date()) return res.status(400).json({ ok: false, error: 'El link expiró. Pedí uno nuevo.' });

    const user = db.prepare('SELECT id, activo FROM users WHERE id = ?').get(row.user_id);
    if (!user || !user.activo) return res.status(400).json({ ok: false, error: 'Cuenta no disponible' });

    db.prepare('UPDATE users SET pass_hash = ?, actualizado_en = ? WHERE id = ?')
      .run(hashPassword(password), new Date().toISOString(), user.id);
    db.prepare('UPDATE password_reset_tokens SET used = 1 WHERE id = ?').run(row.id);

    res.json({ ok: true });
  });

  // GET /api/auth/reset/check?token=...  — valida si el token es válido (para la UI)
  router.get('/reset/check', (req, res) => {
    const token = String(req.query.token || '');
    const row = db.prepare(
      "SELECT t.used, t.expires_at, u.username FROM password_reset_tokens t JOIN users u ON u.id = t.user_id WHERE t.token = ?"
    ).get(token);
    if (!row || row.used || new Date(row.expires_at) < new Date()) {
      return res.json({ ok: false, error: 'Link inválido o expirado' });
    }
    res.json({ ok: true, username: row.username });
  });

  return router;
}

// Forma que consume el frontend. `scopes` se mantiene por compatibilidad con el home viejo.
function serializarMe(user) {
  const scopes = user.is_admin ? ['all'] : user.permisos.map((p) => p.herramienta);
  return {
    user: user.username,
    is_admin: user.is_admin,
    permisos: user.permisos, // [{herramienta, nivel}]
    scopes,
  };
}
