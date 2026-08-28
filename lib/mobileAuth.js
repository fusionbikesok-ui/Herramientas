import crypto from 'crypto';
import { cargarUsuario, verifyPassword } from './auth.js';

const ACCESS_TTL = 15 * 60;
const REFRESH_TTL_MS = 90 * 24 * 60 * 60 * 1000;

function secret() {
  const value = process.env.MOBILE_JWT_SECRET;
  if (!value || value.length < 32) throw new Error('MOBILE_JWT_SECRET debe tener al menos 32 caracteres');
  return value;
}
function b64(v) { return Buffer.from(v).toString('base64url'); }
function sign(input) { return crypto.createHmac('sha256', secret()).update(input).digest('base64url'); }
function tokenHash(token) { return crypto.createHash('sha256').update(token).digest('hex'); }

export function emitirAccessToken(user) {
  const header = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64(JSON.stringify({ sub: String(user.id), username: user.username, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + ACCESS_TTL }));
  return `${header}.${payload}.${sign(`${header}.${payload}`)}`;
}

export function verificarAccessToken(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  const actual = Buffer.from(parts[2]);
  const expected = Buffer.from(sign(`${parts[0]}.${parts[1]}`));
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); } catch { return null; }
  if (!payload.sub || !Number.isInteger(Number(payload.sub)) || !payload.exp || payload.exp <= Math.floor(Date.now() / 1000)) return null;
  return payload;
}

export function ensureMobileAuthTables(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS mobile_refresh_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_id INTEGER REFERENCES device_tokens(id) ON DELETE SET NULL,
    token_hash TEXT NOT NULL UNIQUE,
    family_id TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    creado_en TEXT NOT NULL,
    usado_en TEXT,
    revocado_en TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_mobile_refresh_user ON mobile_refresh_tokens(user_id, revocado_en);
  CREATE INDEX IF NOT EXISTS idx_mobile_refresh_family ON mobile_refresh_tokens(family_id);`);
}

export function emitirRefreshToken(db, userId, deviceId = null, familyId = crypto.randomUUID()) {
  ensureMobileAuthTables(db);
  const raw = crypto.randomBytes(48).toString('base64url');
  const now = new Date();
  db.prepare(`INSERT INTO mobile_refresh_tokens
    (user_id, device_id, token_hash, family_id, expires_at, creado_en)
    VALUES (?, ?, ?, ?, ?, ?)`).run(userId, deviceId, tokenHash(raw), familyId,
    new Date(now.getTime() + REFRESH_TTL_MS).toISOString(), now.toISOString());
  return { token: raw, familyId };
}

export function rotarRefreshToken(db, raw, deviceId = null) {
  ensureMobileAuthTables(db);
  const row = db.prepare('SELECT * FROM mobile_refresh_tokens WHERE token_hash = ?').get(tokenHash(raw));
  if (!row || row.revocado_en || row.usado_en || new Date(row.expires_at) <= new Date()) {
    if (row?.family_id) db.prepare('UPDATE mobile_refresh_tokens SET revocado_en = COALESCE(revocado_en, ?) WHERE family_id = ?').run(new Date().toISOString(), row.family_id);
    return null;
  }
  const now = new Date().toISOString();
  db.prepare('UPDATE mobile_refresh_tokens SET usado_en = ?, revocado_en = ? WHERE id = ?').run(now, now, row.id);
  return emitirRefreshToken(db, row.user_id, deviceId ?? row.device_id, row.family_id);
}

export function revocarRefreshToken(db, raw) {
  ensureMobileAuthTables(db);
  const row = db.prepare('SELECT family_id FROM mobile_refresh_tokens WHERE token_hash = ?').get(tokenHash(raw));
  if (!row) return false;
  db.prepare('UPDATE mobile_refresh_tokens SET revocado_en = COALESCE(revocado_en, ?) WHERE family_id = ?').run(new Date().toISOString(), row.family_id);
  return true;
}

export function requireMobileAuth(db) {
  return (req, res, next) => {
    const header = req.get('authorization') || '';
    const payload = header.startsWith('Bearer ') ? verificarAccessToken(header.slice(7)) : null;
    const user = payload ? cargarUsuario(db, Number(payload.sub)) : null;
    if (!user) return res.status(401).json({ error: { code: 'no_autenticado', message: 'Access token inválido o expirado' } });
    req.user = user;
    next();
  };
}

export function autenticarCredenciales(db, username, password) {
  const row = db.prepare('SELECT id, pass_hash, activo FROM users WHERE username = ? COLLATE NOCASE').get(String(username || '').trim());
  if (!row || !row.activo || !verifyPassword(password, row.pass_hash)) return null;
  return cargarUsuario(db, row.id);
}

export const accessTokenExpiresIn = ACCESS_TTL;
