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

// ── Autenticación móvil (Bearer JWT, separada de la sesión web) ─────────────
const MOBILE_ACCESS_TTL_SECONDS = 15 * 60;

function base64url(value) {
  return Buffer.from(value).toString('base64url');
}

function firmaJwt(input, secret) {
  return crypto.createHmac('sha256', secret).update(input).digest('base64url');
}

export function validarMobileJwtSecret(secret) {
  if (typeof secret !== 'string' || secret.length < 32) {
    throw new Error('MOBILE_JWT_SECRET debe tener al menos 32 caracteres');
  }
  return secret;
}

export function crearAccessToken(user, secret, nowSeconds = Math.floor(Date.now() / 1000), sessionId) {
  validarMobileJwtSecret(secret);
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const claims = {
    sub: String(user.id),
    username: user.username,
    iat: nowSeconds,
    exp: nowSeconds + MOBILE_ACCESS_TTL_SECONDS,
  };
  if (sessionId) claims.sid = sessionId;
  const payload = base64url(JSON.stringify(claims));
  const input = `${header}.${payload}`;
  return `${input}.${firmaJwt(input, secret)}`;
}

export function verificarAccessToken(token, secret, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (typeof secret !== 'string' || secret.length < 32 || typeof token !== 'string') return null;
  const partes = token.split('.');
  if (partes.length !== 3) return null;
  const [header, payload, signature] = partes;
  const expected = firmaJwt(`${header}.${payload}`, secret);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const h = JSON.parse(Buffer.from(header, 'base64url').toString('utf8'));
    const p = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (h.alg !== 'HS256' || h.typ !== 'JWT' || p.exp <= nowSeconds || !p.sub) return null;
    return p;
  } catch (_) {
    return null;
  }
}

export function mobileAuthMiddleware(db, secret) {
  return (req, res, next) => {
    const authorization = req.get('authorization') || '';
    const match = authorization.match(/^Bearer\s+([^\s]+)$/i);
    const claims = match ? verificarAccessToken(match[1], secret) : null;
    const session = claims?.sid ? db.prepare(`
      SELECT t.user_id, t.device_id
      FROM mobile_refresh_tokens t
      JOIN device_tokens d ON d.id = t.device_id AND d.user_id = t.user_id
      WHERE t.token_hash = ? AND t.user_id = ?
        AND t.revocado_en IS NULL AND t.expires_at > ? AND d.revocado_en IS NULL
    `).get(claims.sid, Number(claims.sub), new Date().toISOString()) : null;
    const user = claims && session ? cargarUsuario(db, Number(claims.sub)) : null;
    if (!user) return res.status(401).json({ error: { code: 'no_autenticado', message: 'Token inválido o expirado' } });
    req.user = user;
    req.mobileClaims = claims;
    next();
  };
}

export function mobileRequirePermission(herramienta, nivel = 'read') {
  return (req, res, next) => {
    if (req.user?.is_admin || req.user?.permisos?.some((p) => p.herramienta === herramienta
      && (nivel === 'read' || p.nivel === 'write'))) return next();
    return res.status(403).json({ error: { code: 'sin_permiso', message: 'Tu usuario no tiene permiso para esta acción' } });
  };
}

export const MOBILE_ACCESS_EXPIRES_IN = MOBILE_ACCESS_TTL_SECONDS;

// ── Rate limiting de /login (en memoria, un solo proceso bajo PM2) ──
// Sin librería de circuit-breaker: es sobre-ingeniería para un proceso único de tráfico
// bajo. Clave = usuario + IP, así una IP compartida (oficina) no bloquea a otro usuario,
// y un atacante que rota de usuario contra la misma IP tampoco elude el conteo del todo.
// Backoff creciente (nunca bloqueo fijo ni loop inmediato): las primeras 5 fallas no
// penalizan (typo normal); de ahí en más cada falla dobla la espera, arrancando en 1s y
// con techo en 60s, para no dejar una cuenta inutilizable por error de tipeo del usuario
// legítimo. Se resetea al primer login exitoso o tras 15 min sin intentos.
const LOGIN_MAX_LIBRES = 5;
// Umbral agregado deliberadamente más amplio: varias personas pueden compartir una IP
// (oficina/NAT) y no deben bloquearse por unos pocos errores de tipeo cada una.
const LOGIN_IP_MAX_LIBRES = 30;
const LOGIN_BASE_MS = 1000;
const LOGIN_TOPE_MS = 60_000;
const LOGIN_VENTANA_INACTIVIDAD_MS = 15 * 60 * 1000;

const intentosLogin = new Map(); // key -> { fails, lockedUntil, ultimoIntento }
const intentosLoginPorIp = new Map(); // ip -> { fails, lockedUntil, ultimoIntento }

// Sweep perezoso: sin esto, un scanner que rota usuario/IP en cada intento (la IP entra en
// la clave) deja una entrada nueva por combinación para siempre, en un proceso PM2 que vive
// semanas — crecimiento monótono disparable desde afuera sin loguearse nunca con éxito.
// Se dispara cada REGISTROS_LOGIN_ANTES_DE_SWEEP fallos (no en cada uno: recorrer todo el
// mapa en cada request de login sería trabajo de más para el caso común de tráfico bajo) y
// borra las claves inactivas hace más de LOGIN_VENTANA_INACTIVIDAD_MS, el mismo criterio que
// ya usa loginBloqueado() para una sola clave.
const REGISTROS_LOGIN_ANTES_DE_SWEEP = 200;
let contadorRegistrosLogin = 0;

function sweepIntentosLoginVencidos() {
  const ahora = Date.now();
  for (const [key, st] of intentosLogin) {
    if (ahora - st.ultimoIntento > LOGIN_VENTANA_INACTIVIDAD_MS) {
      intentosLogin.delete(key);
    }
  }
  for (const [ip, st] of intentosLoginPorIp) {
    if (ahora - st.ultimoIntento > LOGIN_VENTANA_INACTIVIDAD_MS) {
      intentosLoginPorIp.delete(ip);
    }
  }
}

export function claveRateLimit(username, ip) {
  return `${String(username || '').trim().toLowerCase()}|${ip || ''}`;
}

/** true si la clave está bloqueada ahora mismo; si no, null. Si vino inactiva, la limpia. */
function bloqueoEnMapa(mapa, key) {
  const st = mapa.get(key);
  if (!st) return null;
  if (Date.now() - st.ultimoIntento > LOGIN_VENTANA_INACTIVIDAD_MS) {
    mapa.delete(key);
    return null;
  }
  if (st.lockedUntil && Date.now() < st.lockedUntil) return st.lockedUntil;
  return null;
}

export function loginBloqueado(key, ip = null) {
  const bloqueoUsuario = bloqueoEnMapa(intentosLogin, key);
  if (bloqueoUsuario) return bloqueoUsuario;
  if (ip != null) return bloqueoEnMapa(intentosLoginPorIp, String(ip));
  return null;
}

function registrarFalloEnMapa(mapa, key, maxLibres) {
  const st = mapa.get(key) || { fails: 0, lockedUntil: 0, ultimoIntento: 0 };
  st.fails += 1;
  st.ultimoIntento = Date.now();
  if (st.fails > maxLibres) {
    const exceso = st.fails - maxLibres;
    const espera = Math.min(LOGIN_BASE_MS * 2 ** (exceso - 1), LOGIN_TOPE_MS);
    st.lockedUntil = Date.now() + espera;
  }
  mapa.set(key, st);
}

export function registrarLoginFallido(key, ip = null) {
  registrarFalloEnMapa(intentosLogin, key, LOGIN_MAX_LIBRES);
  if (ip != null) registrarFalloEnMapa(intentosLoginPorIp, String(ip), LOGIN_IP_MAX_LIBRES);

  contadorRegistrosLogin += 1;
  if (contadorRegistrosLogin >= REGISTROS_LOGIN_ANTES_DE_SWEEP) {
    contadorRegistrosLogin = 0;
    sweepIntentosLoginVencidos();
  }
}

export function registrarLoginExitoso(key) {
  intentosLogin.delete(key);
}

// Solo para tests: resetea ambos límites sin depender del orden de los archivos Vitest.
export function _resetIntentosLoginParaTest() {
  intentosLogin.clear();
  intentosLoginPorIp.clear();
  contadorRegistrosLogin = 0;
}

// Solo para tests: tamaño actual del mapa de rate-limit, para verificar que el sweep
// perezoso lo mantiene acotado en vez de crecer sin límite.
export function _tamanioIntentosLoginParaTest() {
  return intentosLogin.size;
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
