import crypto from 'crypto';

// ── Password hashing (scrypt, sin dependencias nativas extra) ──
// Formato almacenado: scrypt$<saltHex>$<hashHex>
export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(password, stored) {
  if (!stored || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[1], 'hex');
  const expected = Buffer.from(parts[2], 'hex');
  let actual;
  try {
    actual = crypto.scryptSync(String(password), salt, expected.length);
  } catch (_) {
    return false;
  }
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

// ── Carga de un usuario con sus permisos desde la DB ──
export function cargarUsuario(db, id) {
  const u = db.prepare('SELECT id, username, is_admin, activo FROM users WHERE id = ?').get(id);
  if (!u || !u.activo) return null;
  const permisos = db
    .prepare('SELECT herramienta, nivel FROM user_permisos WHERE user_id = ?')
    .all(id);
  return {
    id: u.id,
    username: u.username,
    is_admin: !!u.is_admin,
    permisos, // [{herramienta, nivel}]
  };
}

// ── Middlewares ──
// Requiere sesión válida. Refresca los permisos desde la DB en cada request
// (así un cambio de permisos del admin surte efecto sin re-login).
export function requireAuth(db) {
  return (req, res, next) => {
    const sid = req.session?.userId;
    if (!sid) return res.status(401).json({ ok: false, error: 'No autenticado' });
    const user = cargarUsuario(db, sid);
    if (!user) {
      // Usuario borrado o desactivado → matar sesión
      req.session?.destroy?.(() => {});
      return res.status(401).json({ ok: false, error: 'Sesión inválida' });
    }
    req.user = user;
    next();
  };
}

export function requireAdmin(req, res, next) {
  if (!req.user?.is_admin) {
    return res.status(403).json({ ok: false, error: 'Requiere administrador' });
  }
  next();
}
