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

// ── Rate limiting de /login (en memoria, un solo proceso bajo PM2) ──
// Sin librería de circuit-breaker: es sobre-ingeniería para un proceso único de tráfico
// bajo. Clave = usuario + IP, así una IP compartida (oficina) no bloquea a otro usuario,
// y un atacante que rota de usuario contra la misma IP tampoco elude el conteo del todo.
// Backoff creciente (nunca bloqueo fijo ni loop inmediato): las primeras 5 fallas no
// penalizan (typo normal); de ahí en más cada falla dobla la espera, arrancando en 1s y
// con techo en 60s, para no dejar una cuenta inutilizable por error de tipeo del usuario
// legítimo. Se resetea al primer login exitoso o tras 15 min sin intentos.
const LOGIN_MAX_LIBRES = 5;
const LOGIN_BASE_MS = 1000;
const LOGIN_TOPE_MS = 60_000;
const LOGIN_VENTANA_INACTIVIDAD_MS = 15 * 60 * 1000;

const intentosLogin = new Map(); // key -> { fails, lockedUntil, ultimoIntento }

export function claveRateLimit(username, ip) {
  return `${String(username || '').trim().toLowerCase()}|${ip || ''}`;
}

/** true si la clave está bloqueada ahora mismo; si no, null. Si vino inactiva, la limpia. */
export function loginBloqueado(key) {
  const st = intentosLogin.get(key);
  if (!st) return null;
  if (Date.now() - st.ultimoIntento > LOGIN_VENTANA_INACTIVIDAD_MS) {
    intentosLogin.delete(key);
    return null;
  }
  if (st.lockedUntil && Date.now() < st.lockedUntil) {
    return st.lockedUntil;
  }
  return null;
}

export function registrarLoginFallido(key) {
  const st = intentosLogin.get(key) || { fails: 0, lockedUntil: 0, ultimoIntento: 0 };
  st.fails += 1;
  st.ultimoIntento = Date.now();
  if (st.fails > LOGIN_MAX_LIBRES) {
    const exceso = st.fails - LOGIN_MAX_LIBRES;
    const espera = Math.min(LOGIN_BASE_MS * 2 ** (exceso - 1), LOGIN_TOPE_MS);
    st.lockedUntil = Date.now() + espera;
  }
  intentosLogin.set(key, st);
}

export function registrarLoginExitoso(key) {
  intentosLogin.delete(key);
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
