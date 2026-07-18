import express from 'express';
import session from 'express-session';
import SqliteStoreFactory from 'better-sqlite3-session-store';
import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import cron from 'node-cron';
import { openDb } from './db/index.js';
import { requireAuth, requireAdmin } from './lib/auth.js';
import { resolvePermiso, permiteAcceso } from './lib/permisos.js';
import { authRouter } from './routes/auth.js';
import { usuariosRouter } from './routes/usuarios.js';
import { wooRouter, refrescarCatalogo } from './routes/woo.js';
import { geminiRouter } from './routes/gemini.js';
import { nuevosProductosRouter } from './routes/nuevosProductos.js';
import { mapeoRouter } from './routes/mapeo.js';
import { csvRouter } from './routes/csv.js';
import { matcherRouter } from './routes/matcher.js';
import { syncRouter, syncMlToWc, syncWcToMl, procesarReintentos, procesarCancelacionesMl } from './routes/sync.js';
import { recepcionesRouter } from './routes/recepciones.js';
import { pedidosRouter } from './routes/pedidos.js';
import { coberturaRouter } from './routes/cobertura.js';
import { preciosRouter } from './routes/precios.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function buildApp({ dbPath, sessionSecret, wooCfg, geminiKey, mlCfg }) {
  const db = openDb(dbPath);
  const app = express();

  app.set('trust proxy', 1); // detrás de Nginx
  app.use(express.json({ limit: '10mb' }));

  // ── Sesión (store en SQLite aparte, para no contender con las escrituras del sync) ──
  const SqliteStore = SqliteStoreFactory(session);
  const sessionDbPath = path.join(path.dirname(dbPath), 'sessions.sqlite');
  const sessionDb = new Database(sessionDbPath);
  app.use(session({
    store: new SqliteStore({ client: sessionDb, expired: { clear: true, intervalMs: 15 * 60 * 1000 } }),
    secret: sessionSecret || 'cambiame-en-.env',
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: false, // la app corre por HTTP plano; poner true cuando haya TLS
      maxAge: 12 * 60 * 60 * 1000, // 12h
    },
  }));

  app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
  app.use('/stock', express.static(path.join(__dirname, 'public/stock')));
  app.use('/etiquetas', express.static(path.join(__dirname, 'public/etiquetas')));
  app.use('/inventario', express.static(path.join(__dirname, 'public/inventario')));
  app.use('/home', express.static(path.join(__dirname, 'public/home')));
  app.use('/login', express.static(path.join(__dirname, 'public/login')));
  app.use('/matcher', express.static(path.join(__dirname, 'public/matcher')));
  app.use('/usuarios', express.static(path.join(__dirname, 'public/usuarios')));
  app.use('/reset-password', express.static(path.join(__dirname, 'public/reset-password')));

  // Auth: público (login) + endpoints de sesión. NO pasa por requireAuth.
  app.use('/api/auth', authRouter(db));

  // A partir de acá, todo /api exige sesión válida + permiso por herramienta.
  const authGuard = requireAuth(db);
  function scopeCheck(req, res, next) {
    if (req.user?.is_admin) return next(); // admin bypass
    const permiso = resolvePermiso(req.method, req.path);
    if (permiteAcceso(req.user.permisos, permiso)) return next();
    return res.status(403).json({ ok: false, error: 'Acceso no autorizado' });
  }
  app.use('/api', authGuard, scopeCheck);

  // Gestión de usuarios: solo admins.
  app.use('/api/usuarios', requireAdmin, usuariosRouter(db));

  const syncCfg = { woo: wooCfg, ml: mlCfg };

  app.use('/api/woo', wooRouter(db, wooCfg));
  app.use('/api/gemini', geminiRouter(geminiKey));
  app.use('/api/nuevos-productos', nuevosProductosRouter(geminiKey));
  app.use('/api/mapeo', mapeoRouter(db));
  app.use('/api/csv', csvRouter());
  app.use('/api/matcher', matcherRouter(db, syncCfg));
  app.use('/api/sync', syncRouter(db, syncCfg));
  app.use('/api/recepciones', recepcionesRouter(db, wooCfg));
  app.use('/recepcion', express.static(path.join(__dirname, 'public/recepcion')));
  app.use('/api/pedidos', pedidosRouter(db));
  app.use('/pedidos', express.static(path.join(__dirname, 'public/pedidos')));
  app.use('/api/cobertura', coberturaRouter(db));
  app.use('/cobertura', express.static(path.join(__dirname, 'public/cobertura')));
  app.use('/api/precios', preciosRouter(db, syncCfg));
  app.use('/precios', express.static(path.join(__dirname, 'public/precios')));
  app.use('/config-ml', express.static(path.join(__dirname, 'public/config-ml')));
  app.use('/sync-ml', express.static(path.join(__dirname, 'public/sync-ml')));
  app.use('/sync-detalle', express.static(path.join(__dirname, 'public/sync-detalle')));

  app._db = db;
  app._syncCfg = syncCfg;
  return app;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  import('dotenv/config').then(() => {
    const wooCfg = { url: process.env.WOO_URL, ck: process.env.WOO_CK, cs: process.env.WOO_CS };
    const mlCfg = {
      clientId: process.env.ML_CLIENT_ID,
      clientSecret: process.env.ML_CLIENT_SECRET,
      userId: process.env.ML_USER_ID,
    };

    const app = buildApp({
      dbPath: process.env.DB_PATH,
      sessionSecret: process.env.SESSION_SECRET,
      wooCfg,
      geminiKey: process.env.GEMINI_KEY,
      mlCfg,
    });

    const syncCfg = app._syncCfg;

    cron.schedule('*/15 * * * *', () => {
      refrescarCatalogo(app._db, wooCfg)
        .catch(err => console.error('Error refrescando catálogo:', err.message));
    });

    cron.schedule('*/3 * * * *', () => {
      syncMlToWc(app._db, syncCfg)
        .catch(err => console.error('ML→WC error:', err.message));
    });

    cron.schedule('*/5 * * * *', () => {
      syncWcToMl(app._db, syncCfg)
        .catch(err => console.error('WC→ML error:', err.message));
    });

    cron.schedule('*/10 * * * *', () => {
      procesarReintentos(app._db, syncCfg)
        .catch(err => console.error('reintentos error:', err.message));
    });

    cron.schedule('*/10 * * * *', () => {
      procesarCancelacionesMl(app._db, syncCfg)
        .catch(err => console.error('cancelaciones ML error:', err.message));
    });

    const port = process.env.PORT || 3001;
    app.listen(port, () => console.log(`herramientas-app escuchando en :${port}`));
  });
}
