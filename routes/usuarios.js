import express from 'express';
import { hashPassword } from '../lib/auth.js';
import { HERRAMIENTAS, HERRAMIENTA_IDS } from '../lib/permisos.js';

// Router de gestión de usuarios. Se monta detrás de requireAuth + requireAdmin.
export function usuariosRouter(db) {
  const router = express.Router();

  const ahora = () => new Date().toISOString();
  const contarAdmins = () =>
    db.prepare('SELECT COUNT(*) AS n FROM users WHERE is_admin = 1 AND activo = 1').get().n;

  function permisosDe(userId) {
    return db
      .prepare('SELECT herramienta, nivel FROM user_permisos WHERE user_id = ?')
      .all(userId);
  }

  function serializar(u) {
    return {
      id: u.id,
      username: u.username,
      is_admin: !!u.is_admin,
      activo: !!u.activo,
      email: u.email || null,
      creado_en: u.creado_en,
      permisos: u.is_admin ? [] : permisosDe(u.id),
    };
  }

  // Valida y normaliza un array de permisos entrante.
  function sanearPermisos(permisos) {
    if (!Array.isArray(permisos)) return [];
    const out = [];
    const vistos = new Set();
    for (const p of permisos) {
      const herramienta = p?.herramienta;
      if (!HERRAMIENTA_IDS.includes(herramienta) || vistos.has(herramienta)) continue;
      vistos.add(herramienta);
      const nivel = p?.nivel === 'write' ? 'write' : 'read';
      out.push({ herramienta, nivel });
    }
    return out;
  }

  const setPermisos = db.transaction((userId, permisos) => {
    db.prepare('DELETE FROM user_permisos WHERE user_id = ?').run(userId);
    const ins = db.prepare(
      'INSERT INTO user_permisos (user_id, herramienta, nivel) VALUES (?, ?, ?)'
    );
    for (const p of permisos) ins.run(userId, p.herramienta, p.nivel);
  });

  // Catálogo de herramientas disponibles (para poblar la UI de checkboxes).
  router.get('/herramientas', (_req, res) => {
    res.json({ ok: true, herramientas: HERRAMIENTAS });
  });

  // Listado
  router.get('/', (_req, res) => {
    const rows = db
      .prepare('SELECT * FROM users ORDER BY is_admin DESC, username ASC')
      .all();
    res.json({ ok: true, usuarios: rows.map(serializar) });
  });

  // Alta
  router.post('/', (req, res) => {
    const { username, password, is_admin, permisos, email } = req.body || {};
    const uname = String(username || '').trim();
    if (!uname || !password) {
      return res.status(400).json({ ok: false, error: 'Usuario y contraseña requeridos' });
    }
    if (String(password).length < 6) {
      return res.status(400).json({ ok: false, error: 'La contraseña debe tener al menos 6 caracteres' });
    }
    const existe = db.prepare('SELECT 1 FROM users WHERE username = ? COLLATE NOCASE').get(uname);
    if (existe) return res.status(409).json({ ok: false, error: 'Ese usuario ya existe' });

    const t = ahora();
    const admin = is_admin ? 1 : 0;
    const emailVal = email ? String(email).trim().toLowerCase() : null;
    const info = db
      .prepare(`INSERT INTO users (username, pass_hash, is_admin, activo, email, creado_en, actualizado_en)
                VALUES (?, ?, ?, 1, ?, ?, ?)`)
      .run(uname, hashPassword(password), admin, emailVal, t, t);
    if (!admin) setPermisos(info.lastInsertRowid, sanearPermisos(permisos));
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
    res.status(201).json({ ok: true, usuario: serializar(u) });
  });

  // Editar email
  router.patch('/:id/email', (req, res) => {
    const id = Number(req.params.id);
    const u = db.prepare('SELECT id FROM users WHERE id = ?').get(id);
    if (!u) return res.status(404).json({ ok: false, error: 'Usuario no encontrado' });
    const email = req.body?.email ? String(req.body.email).trim().toLowerCase() : null;
    db.prepare('UPDATE users SET email = ?, actualizado_en = ? WHERE id = ?').run(email, ahora(), id);
    res.json({ ok: true });
  });

  // Editar rol / activo
  router.patch('/:id', (req, res) => {
    const id = Number(req.params.id);
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!u) return res.status(404).json({ ok: false, error: 'Usuario no encontrado' });

    let is_admin = u.is_admin;
    let activo = u.activo;
    if (typeof req.body?.is_admin === 'boolean') is_admin = req.body.is_admin ? 1 : 0;
    if (typeof req.body?.activo === 'boolean') activo = req.body.activo ? 1 : 0;

    // Proteger al último admin activo
    const perderiaAdmin = u.is_admin && u.activo && (is_admin === 0 || activo === 0);
    if (perderiaAdmin && contarAdmins() <= 1) {
      return res.status(409).json({ ok: false, error: 'No podés dejar el sistema sin administradores' });
    }

    db.prepare('UPDATE users SET is_admin = ?, activo = ?, actualizado_en = ? WHERE id = ?')
      .run(is_admin, activo, ahora(), id);
    // Si pasó a admin, sus permisos por herramienta dejan de aplicar (tiene todo)
    if (is_admin && !u.is_admin) db.prepare('DELETE FROM user_permisos WHERE user_id = ?').run(id);
    const nu = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    res.json({ ok: true, usuario: serializar(nu) });
  });

  // Set de permisos por herramienta
  router.put('/:id/permisos', (req, res) => {
    const id = Number(req.params.id);
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!u) return res.status(404).json({ ok: false, error: 'Usuario no encontrado' });
    if (u.is_admin) {
      return res.status(400).json({ ok: false, error: 'Un admin ya tiene acceso a todo' });
    }
    setPermisos(id, sanearPermisos(req.body?.permisos));
    db.prepare('UPDATE users SET actualizado_en = ? WHERE id = ?').run(ahora(), id);
    res.json({ ok: true, usuario: serializar(u) });
  });

  // Reset de contraseña
  router.post('/:id/password', (req, res) => {
    const id = Number(req.params.id);
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!u) return res.status(404).json({ ok: false, error: 'Usuario no encontrado' });
    const { password } = req.body || {};
    if (!password || String(password).length < 6) {
      return res.status(400).json({ ok: false, error: 'La contraseña debe tener al menos 6 caracteres' });
    }
    db.prepare('UPDATE users SET pass_hash = ?, actualizado_en = ? WHERE id = ?')
      .run(hashPassword(password), ahora(), id);
    res.json({ ok: true });
  });

  // Baja
  router.delete('/:id', (req, res) => {
    const id = Number(req.params.id);
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!u) return res.status(404).json({ ok: false, error: 'Usuario no encontrado' });
    if (id === req.user?.id) {
      return res.status(409).json({ ok: false, error: 'No podés eliminar tu propia cuenta' });
    }
    if (u.is_admin && u.activo && contarAdmins() <= 1) {
      return res.status(409).json({ ok: false, error: 'No podés eliminar al último administrador' });
    }
    db.prepare('DELETE FROM user_permisos WHERE user_id = ?').run(id);
    db.prepare('DELETE FROM users WHERE id = ?').run(id);
    res.json({ ok: true });
  });

  return router;
}
