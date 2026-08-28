import express from 'express';
import { autenticarCredenciales, emitirAccessToken, emitirRefreshToken, rotarRefreshToken, revocarRefreshToken, requireMobileAuth, accessTokenExpiresIn, ensureMobileAuthTables } from '../lib/mobileAuth.js';
import crypto from 'crypto';
import { cargarUsuario } from '../lib/auth.js';

function publico(user) { return { id: String(user.id), username: user.username, permisos: user.permisos, is_admin: user.is_admin }; }

export function mobileAuthRouter(db) {
  ensureMobileAuthTables(db);
  const router = express.Router();
  router.post('/login', (req, res) => {
    const { username, password, device_id } = req.body || {};
    if (!username || !password) return res.status(422).json({ error: { code: 'credenciales_requeridas', message: 'username y password son obligatorios' } });
    try {
      const user = autenticarCredenciales(db, username, password);
      if (!user) return res.status(401).json({ error: { code: 'credenciales_invalidas', message: 'Usuario o contraseña incorrectos' } });
      const refresh = emitirRefreshToken(db, user.id, Number.isInteger(Number(device_id)) ? Number(device_id) : null);
      return res.json({ access_token: emitirAccessToken(user), refresh_token: refresh.token, expires_in: accessTokenExpiresIn, user: publico(user) });
    } catch (err) { console.error('[mobile-auth] login:', err.message); return res.status(500).json({ error: { code: 'error_interno', message: 'Ocurrió un error inesperado' } }); }
  });
  router.post('/refresh', (req, res) => {
    const raw = req.body?.refresh_token;
    if (!raw) return res.status(422).json({ error: { code: 'refresh_requerido', message: 'refresh_token es obligatorio' } });
    const next = rotarRefreshToken(db, raw);
    if (!next) return res.status(401).json({ error: { code: 'refresh_invalido', message: 'Refresh token inválido, expirado o revocado' } });
    const row = db.prepare('SELECT user_id FROM mobile_refresh_tokens WHERE token_hash = ?').get(crypto.createHash('sha256').update(next.token).digest('hex'));
    const loaded = row ? cargarUsuario(db, row.user_id) : null;
    if (!loaded) return res.status(401).json({ error: { code: 'usuario_invalido', message: 'Cuenta no disponible' } });
    return res.json({ access_token: emitirAccessToken(loaded), refresh_token: next.token, expires_in: accessTokenExpiresIn, user: publico(loaded) });
  });
  router.post('/logout', (req, res) => { if (req.body?.refresh_token) revocarRefreshToken(db, req.body.refresh_token); return res.json({ ok: true }); });
  router.get('/me', requireMobileAuth(db), (req, res) => res.json(publico(req.user)));
  return router;
}
