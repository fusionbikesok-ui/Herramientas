import express from 'express';
import session from 'express-session';
import SqliteStoreFactory from 'better-sqlite3-session-store';
import Database from 'better-sqlite3';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import cron from 'node-cron';
import { openDb } from './db/index.js';
import {
  requireAuth,
  requireAdmin,
  mobileAuthMiddleware,
  mobileRequirePermission,
  validarMobileJwtSecret,
} from './lib/auth.js';
import { resolvePermiso, permiteAcceso } from './lib/permisos.js';
import { authRouter } from './routes/auth.js';
import { mobileAuthRouter, mobileMeHandler } from './routes/mobileAuth.js';
import { usuariosRouter } from './routes/usuarios.js';
import { wooRouter, refrescarCatalogo } from './routes/woo.js';
import { geminiRouter } from './routes/gemini.js';
import { nuevosProductosRouter } from './routes/nuevosProductos.js';
import { mapeoRouter } from './routes/mapeo.js';
import { csvRouter } from './routes/csv.js';
import { matcherRouter } from './routes/matcher.js';
import { pushSkusPendientes } from './lib/matcherPush.js';
import { syncRouter, syncMlToWc, syncOrdenMlPuntual, syncWcToMl, procesarReintentos, procesarCancelacionesMl, reactivarAutomatico, reconciliarStockMl } from './routes/sync.js';
import { recepcionesRouter } from './routes/recepciones.js';
import { pedidosRouter } from './routes/pedidos.js';
import { coberturaRouter } from './routes/cobertura.js';
import { preciosRouter } from './routes/precios.js';
import { preparacionRouter, syncPedidosCache, syncPedidoWebPuntual, syncPedidoMlPuntual, purgarFotosBorradas, reintentarColgadosTracking } from './routes/preparacion.js';
import { procesarColaFotos } from './lib/fotosPreparacionCola.js';
import { consultaPreciosRouter } from './routes/consultaPrecios.js';
import { codigosRouter } from './routes/codigos.js';
import { inventarioRouter } from './routes/inventario.js';
import { etiquetasRouter } from './routes/etiquetas.js';
import { criticidadRouter } from './routes/criticidad.js';
import { backfillVentas } from './lib/criticidad.js';
import { auditoriaRouter } from './routes/auditoria.js';
import { barridoAuditoria } from './lib/auditoria.js';
import { incidentesRouter } from './routes/incidentes.js';
import { devicesRouter } from './routes/devices.js';
import { notificationsRouter } from './routes/notifications.js';
import { procesarNotificacionesPush } from './lib/workerNotificacionesPush.js';
import { validarConfiguracionPush } from './lib/notificacionesPush.js';
import { mlEstadoRouter } from './routes/mlEstado.js';
import { getAccessToken } from './lib/mlClient.js';
import { notificacionesMlRouter, ingerirPregunta, ingerirMensaje, ingerirReclamo, extraerClaimId, reintentarReclamosSinConsultar } from './routes/notificacionesMl.js';
import { inboxClaimsRouter } from './routes/inboxClaims.js';
import { operacionesMobileRouter } from './routes/operacionesMobile.js';
import { autoVincularPorSellerSku } from './lib/mlMapeo.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function buildApp({ dbPath, sessionSecret, wooCfg, geminiKey, mlCfg, mobileJwtSecret }) {
  const mobileSecret = mobileJwtSecret ?? process.env.MOBILE_JWT_SECRET;
  validarMobileJwtSecret(mobileSecret);
  validarConfiguracionPush(process.env);
  const db = openDb(dbPath);
  const app = express();

  app.set('trust proxy', 1); // detrás de Nginx
  // ── Webhook WooCommerce → sync inmediato a ML ───────────────────────────────
  // POST /api/woo/webhook/order
  // WC lo llama con topic order.created y order.updated.
  // Verifica HMAC-SHA256 (WOO_WEBHOOK_SECRET en .env) antes de procesar.
  // Responde 200 inmediatamente y dispara syncWcToMl en background para no
  // bloquear el reintento de WC (WC reintenta si no recibe 200 en < 5s).
  app.post('/api/woo/webhook/order',
    express.raw({ type: 'application/json', limit: '1mb' }),
    (req, res) => {
      const whSecret = process.env.WOO_WEBHOOK_SECRET || '';
      if (whSecret) {
        const sig = req.headers['x-wc-webhook-signature'];
        if (!sig) return res.status(401).json({ ok: false, error: 'sin firma' });
        const expected = crypto.createHmac('sha256', whSecret)
          .update(req.body).digest('base64');
        if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
          return res.status(401).json({ ok: false, error: 'firma inválida' });
        }
      }
      let order;
      try { order = JSON.parse(req.body.toString('utf8')); }
      catch { return res.status(400).json({ ok: false, error: 'payload inválido' }); }

      // Responder antes de procesar — WC no espera más de 5s
      res.json({ ok: true });

      // A.1 (2026-08-26): camino rápido a la cola de Preparación. Va ANTES del filtro
      // ESTADOS_CON_STOCK de abajo a propósito: ese filtro es para relevancia de stock/precio
      // ML (syncWcToMl), pero el estado que de verdad importa para la cola de preparación es
      // el de Andreani (lpaandreani/completed/enviadoandreani), que no está en esa lista. La
      // función puntual ya descarta en silencio cualquier estado que no sea uno de esos 3.
      // Fail-open: si esto falla, syncPedidosCache (cron cada 10 min) igual va a traer el
      // pedido en su próxima corrida -- no se pierde, solo tarda más en aparecer.
      syncPedidoWebPuntual(app._db, {
        woo: wooCfg,
        andreaniStatus: process.env.ANDREANI_ORDER_STATUS || 'lpaandreani',
        enviadoAndreaniStatus: process.env.ANDREANI_ENVIADO_STATUS || 'enviadoandreani',
      }, order.id).catch(err => console.error('[webhook-woo] syncPedidoWebPuntual error:', err.message));

      const ESTADOS_CON_STOCK = ['processing', 'completed', 'on-hold'];
      if (!ESTADOS_CON_STOCK.includes(order.status)) return;

      const skus = (order.line_items || []).map(li => li.sku).filter(Boolean).join(', ');
      console.log(`[webhook-woo] order #${order.id} status=${order.status} skus=${skus || '(sin sku)'} → syncWcToMl`);
      syncWcToMl(app._db, syncCfg, { maxLlamadas: 30 })
        .catch(err => console.error('[webhook-woo] syncWcToMl error:', err.message));
    }
  );

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
  app.use('/vendor', express.static(path.join(__dirname, 'public/vendor')));
  app.use('/lib', express.static(path.join(__dirname, 'public/lib')));

  // Raíz → home (que a su vez redirige a login si no hay sesión).
  app.get('/', function (req, res) { res.redirect('/herramientas/home/'); });

  // Auth: público (login) + endpoints de sesión. NO pasa por requireAuth.
  app.use('/api/auth', authRouter(db));

  // API móvil: mecanismo independiente de la sesión web, con Bearer JWT y refresh
  // revocable por dispositivo. Se monta antes del guard del panel /api.
  const mobileAuth = mobileAuthMiddleware(db, mobileSecret);
  const mobileNotificationsAuth = [mobileAuth, mobileRequirePermission('notificaciones-ml')];
  app.use('/api/v1/auth', mobileAuthRouter(db, mobileSecret));
  app.get('/api/v1/me', mobileAuth, mobileMeHandler(db));
  app.use('/api/v1/devices', devicesRouter(db, mobileAuth));
  app.use('/api/v1/notifications', notificationsRouter(db, mobileNotificationsAuth));
  app.use('/api/v1/inbox', inboxClaimsRouter(db, mobileNotificationsAuth));
  app.use('/api/v1', operacionesMobileRouter(db, mobileNotificationsAuth));

  // A partir de acá, todo /api exige sesión válida + permiso por herramienta.
  const authGuard = requireAuth(db);
  function scopeCheck(req, res, next) {
    if (req.user?.is_admin) return next(); // admin bypass
    const permiso = resolvePermiso(req.method, req.path);
    if (permiteAcceso(req.user.permisos, permiso)) return next();
    return res.status(403).json({ ok: false, error: 'Acceso no autorizado' });
  }
  const syncCfg = { woo: wooCfg, ml: mlCfg };

  // ── Notificaciones ML ────────────────────────────────────────────────────────
  // POST /api/ml/notificacion
  // La app tiene TODOS los topics seleccionados en el panel de ML Developers (decisión
  // 2026-08-26: filtrar acá es más simple que ir y volver al panel cada vez que se suma una
  // función nueva). Body: { topic, resource, user_id, ... }. ML no envía firma — la
  // autenticidad se valida por: el user_id del body debe coincidir con ML_USER_ID.
  // ML espera 200 en < 500ms — respondemos antes de procesar cualquier topic.
  // Docs: https://developers.mercadolibre.com.ar/es_ar/recibir-notificaciones
  //
  // Topics soportados hoy: 'orders' (sync puntual a WC de ESA orden vía syncOrdenMlPuntual,
  // A.3, + camino puntual a pedidos_cache, A.1 — el barrido paginado completo, syncMlToWc,
  // ya no se dispara acá, queda solo como respaldo del cron), 'orders_v2' (solo camino
  // puntual a pedidos_cache — no dispara syncOrdenMlPuntual, mismo comportamiento
  // preexistente de 'orders' respecto de eso), 'questions', 'messages', 'claims' y
  // 'post_purchase' con acción 'claims'
  // (preguntas/mensajes/reclamos sin resolver, guardados para el aviso del Home — ver
  // routes/notificacionesMl.js). El resto de los topics que ML manda (shipments,
  // orders_feedback, items, invoices) se reciben y se descartan en silencio hasta que se sume
  // su función acá, mismo patrón que 'orders' tenía antes de este cambio.
  app.post('/api/ml/notificacion', express.json({ limit: '64kb' }), (req, res) => {
    res.json({ ok: true }); // responder inmediatamente antes de procesar

    const { topic, resource, user_id } = req.body || {};

    // Validar que la notificación es para nuestra cuenta
    const mlUserId = process.env.ML_USER_ID;
    if (mlUserId && String(user_id) !== String(mlUserId)) return;

    if (topic === 'orders' || topic === 'orders_v2') {
      console.log(`[notif-ml] topic=${topic} resource=${resource} → ${topic === 'orders' ? 'syncOrdenMlPuntual' : 'syncPedidoMlPuntual'}`);
      // `resource` viene como "/orders/{id}" -- se toma el último segmento.
      const mlOrderId = String(resource || '').split('/').filter(Boolean).pop();

      // A.3 (2026-08-27): syncMlToWc ya NO se dispara acá — hacía un barrido paginado
      // completo de /orders/search por cada webhook, cuando el propio webhook ya trae el id
      // puntual de la orden. syncOrdenMlPuntual procesa SOLO esa orden (GET /orders/{id}).
      // El barrido paginado completo sigue de respaldo vía el cron ('3-59/10 * * * *', más
      // abajo) — si esto falla o no llega, el cron la termina agarrando igual. Comportamiento
      // preexistente (solo 'orders', no 'orders_v2') sin tocar: syncMlToWc/syncOrdenMlPuntual
      // ajustan stock por venta, no aplica a 'orders_v2' hasta que se defina esa función.
      if (topic === 'orders' && mlOrderId) {
        syncOrdenMlPuntual(app._db, syncCfg, mlOrderId)
          .catch(err => console.error('[notif-ml] syncOrdenMlPuntual error:', err.message));
      }

      // A.1 (2026-08-26): camino rápido a la cola de Preparación, para 'orders' y 'orders_v2'
      // por igual. Fail-open: si falla o el order id no se puede extraer, no se pierde nada --
      // el pedido igual va a aparecer en la próxima corrida de syncPedidosCache (cron cada 10
      // min) vía pendientesMl, que no depende de este camino puntual.
      if (mlOrderId) {
        syncPedidoMlPuntual(app._db, mlCfg, mlOrderId)
          .catch(err => console.error('[notif-ml] syncPedidoMlPuntual error:', err.message));
      }
      return;
    }

    if (topic === 'questions') {
      console.log(`[notif-ml] topic=${topic} resource=${resource} → ingerirPregunta`);
      ingerirPregunta(app._db, mlCfg, resource)
        .catch(err => console.error('[notif-ml] ingerirPregunta error:', err.message));
      return;
    }

    if (topic === 'messages') {
      console.log(`[notif-ml] topic=${topic} resource=${resource} → ingerirMensaje`);
      ingerirMensaje(app._db, mlCfg, resource)
        .catch(err => console.error('[notif-ml] ingerirMensaje error:', err.message));
      return;
    }

    if (topic === 'claims') {
      console.log(`[notif-ml] topic=${topic} resource=${resource} → ingerirReclamo`);
      ingerirReclamo(app._db, mlCfg, resource)
        .catch(err => console.error('[notif-ml] ingerirReclamo error:', err.message));
      return;
    }

    // Topic post_purchase con acción 'claims' — envelope oficial de ML: el resource
    // ya contiene /post-purchase/v1/claims/{id}. Se conservan fallbacks para variantes
    // antiguas o no confirmadas del envelope.
    if (topic === 'post_purchase') {
      const action = req.body?.action;
      const actions = Array.isArray(req.body?.actions) ? req.body.actions : [];
      const resourceClaimId = extraerClaimId(resource);
      const claimId = resourceClaimId
          || req.body?.envelope?.claim_id
          || req.body?.claim_id;
      if (action === 'claims' || actions.includes('claims') || resourceClaimId) {
        if (claimId) {
          const pseudoResource = `/post-purchase/v1/claims/${claimId}`;
          console.log(`[notif-ml] topic=${topic} action=${action || actions.join(',') || 'none'} claim_id=${claimId} → ingerirReclamo`);
          ingerirReclamo(app._db, mlCfg, pseudoResource, resource)
            .catch(err => console.error('[notif-ml] ingerirReclamo (post_purchase) error:', err.message));
        } else {
          console.warn(`[notif-ml] topic=${topic} action=${action}: no se pudo extraer claim_id; `
            + `envelope=${Boolean(req.body?.envelope)} resource=${Boolean(resource)} body_claim_id=${Boolean(req.body?.claim_id)}`);
        }
      } else if (action || actions.length) {
        console.warn(`[notif-ml] topic=${topic} action=${action}: acción no soportada`);
      } else {
        console.warn(`[notif-ml] topic=${topic}: envelope sin action/actions ni claim resource`);
      }
      return;
    }

    // Topic sin función todavía (shipments, orders_feedback, items, invoices) —
    // se descarta en silencio, a propósito. (orders_v2 sí tiene función: ver más arriba,
    // camino puntual vía syncPedidoMlPuntual.)
  });

  app.use('/api', authGuard, scopeCheck);

  // Gestión de usuarios: solo admins.
  app.use('/api/usuarios', requireAdmin, usuariosRouter(db));


  app.use('/api/woo', wooRouter(db, wooCfg));
  app.use('/api/gemini', geminiRouter(geminiKey));
  app.use('/api/nuevos-productos', nuevosProductosRouter(geminiKey, db));
  app.use('/api/mapeo', mapeoRouter(db));
  app.use('/api/csv', csvRouter());
  app.use('/api/matcher', matcherRouter(db, syncCfg));
  app.use('/api/sync', syncRouter(db, syncCfg));
  app.use('/api/recepciones', recepcionesRouter(db, wooCfg));
  app.use('/recepcion', express.static(path.join(__dirname, 'public/recepcion')));
  app.use('/api/pedidos', pedidosRouter(db));
  app.use('/pedidos', express.static(path.join(__dirname, 'public/pedidos')));
  app.use('/api/cobertura', coberturaRouter(db, syncCfg));
  // Matcher unificado, entrega 1 (2026-08-14): Cobertura dejó de ser una pantalla propia,
  // pasó a ser la dirección Woo→ML del Matcher. `/cobertura` no puede dar 404 (puede haber
  // accesos directos guardados) — redirige con `?aviso=unificado` para que el frontend del
  // Matcher muestre el cartel de "se unificó" (la parte visible la hace el frontend, acá solo
  // la señal). `/api/cobertura` NO se toca: sigue siendo el mismo router.
  app.use('/cobertura', (req, res) => res.redirect('/herramientas/matcher/?aviso=unificado'));
  app.use('/api/precios', preciosRouter(db, syncCfg));
  app.use('/precios', express.static(path.join(__dirname, 'public/precios')));
  app.use('/api/preparacion', preparacionRouter(db, {
    woo: wooCfg, ml: mlCfg,
    andreaniStatus: process.env.ANDREANI_ORDER_STATUS || 'lpaandreani',
    enviadoAndreaniStatus: process.env.ANDREANI_ENVIADO_STATUS || 'enviadoandreani',
  }));
  app.use('/preparacion', express.static(path.join(__dirname, 'public/preparacion')));
  app.use('/api/consulta-precios', consultaPreciosRouter(db, wooCfg));
  app.use('/consulta-precios', express.static(path.join(__dirname, 'public/consulta-precios')));
  app.use('/api/codigos', codigosRouter(db, wooCfg));
  app.use('/codigos', express.static(path.join(__dirname, 'public/codigos')));
  app.use('/config-ml', express.static(path.join(__dirname, 'public/config-ml')));
  app.use('/sync-ml', express.static(path.join(__dirname, 'public/sync-ml')));
  app.use('/sync-detalle', express.static(path.join(__dirname, 'public/sync-detalle')));
  // Vínculos se absorbió dentro del Matcher (Buscar producto + Sospechosos, ver
  // routes/cobertura.js) — mismo criterio de redirect con aviso que /cobertura arriba.
  app.use('/vinculos', (req, res) => res.redirect('/herramientas/matcher/?aviso=unificado'));
  app.use('/api/inventario', inventarioRouter(db, wooCfg));
  app.use('/api/etiquetas', etiquetasRouter(db));
  app.use('/api/criticidad', criticidadRouter(db, syncCfg));
  app.use('/api/auditoria', auditoriaRouter(db));
  app.use('/api/incidentes', incidentesRouter(db, syncCfg));
  app.use('/api/devices', devicesRouter(db));
  app.use('/api/notifications', notificationsRouter(db));
  app.use('/api/ml', mlEstadoRouter(db));
  app.use('/api/notificaciones-ml', notificacionesMlRouter(db));

  // -- Error handler global (respaldo) ---------------------------------
  // Debe ir al final, con 4 argumentos para que Express lo reconozca. Cualquier
  // error no capturado en una ruta /api/* (p.ej. un MulterError por archivo muy
  // pesado que no se atrapo en su router) se devuelve como JSON en vez de la
  // pagina HTML 500 por defecto, que el frontend no puede parsear. Para rutas
  // no-API se mantiene el comportamiento default (estaticos, etc.).
  app.use((err, req, res, next) => {
    console.error('Error no manejado:', err);
    if (res.headersSent) return next(err);
    if (req.path.startsWith('/api/')) {
      return res.status(err.status || 500).json({ ok: false, error: 'error interno del servidor' });
    }
    next(err);
  });

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
      mobileJwtSecret: process.env.MOBILE_JWT_SECRET,
      wooCfg,
      geminiKey: process.env.GEMINI_KEY,
      mlCfg,
    });

    const syncCfg = app._syncCfg;

    // Instancias efímeras (probador-e2e, pruebas manuales con `node server.js` apuntando
    // a la base real) deben arrancar con DISABLE_CRONS=true — sin esto, dos procesos
    // corriendo el mismo cron en paralelo pueden crear pedidos duplicados en WooCommerce
    // (ver incidente 2026-07-25: ventana de carrera en _procesarOrden de routes/sync.js
    // sumada a procesos huérfanos que quedaron corriendo estos crons por horas).
    if (process.env.DISABLE_CRONS === 'true') {
      console.log('DISABLE_CRONS=true — crons de sync deshabilitados en esta instancia.');
    } else {
      // Frecuencias bajas y ESCALONADAS a propósito (incidente 2026-08-04): ML empezó a
      // devolver 429 sobre toda su API —no solo /oauth/token— con el token sano, porque el
      // volumen de llamadas en régimen excedía su límite. Dos causas sumadas: la frecuencia,
      // y que todos los `*/10` disparaban en el MISMO minuto (:00, :10, …), o sea una ráfaga
      // simultánea de 5-6 jobs pegándole a ML de golpe. Por eso cada uno arranca en un minuto
      // distinto. Antes de volver a subir cualquiera de estas frecuencias o de realinearlas
      // al mismo minuto, revisar el límite de ML: el backoff de lib/mlClient.js amortigua el
      // 429 pero no lo evita. Los que pegan a ML están marcados.
      // Bajado de cada 15 min a cada 5 min (plan 2026-08-10-codigos-frescura-y-catalogo-
      // incremental): con el modo incremental, una corrida en régimen estable es 1 sola
      // llamada a /products y 0 de variaciones (antes eran ~584 SIEMPRE, haya cambiado algo
      // o no). El barrido completo periódico (cada 6h, ver INTERVALO_COMPLETO_MS en
      // routes/woo.js) sigue siendo el único que poda borrados, así que subir la frecuencia
      // acá no lo reemplaza ni compite con él en costo. Minuto 1, paso 5 no pisa ningún otro
      // cron de esta lista (los /10 caen en offsets 2,3,4,5,7,8,9; el único cruce es con la
      // cancelación ML de "6 1-23/2", una vez cada 2h, insignificante).
      cron.schedule('1-59/5 * * * *', () => {          // Woo
        refrescarCatalogo(app._db, wooCfg)
          .catch(err => console.error('Error refrescando catálogo:', err.message));
      });

      cron.schedule('3-59/10 * * * *', () => {          // ML
        syncMlToWc(app._db, syncCfg)
          .catch(err => console.error('ML→WC error:', err.message));
      });

      cron.schedule('2-59/10 * * * *', () => {          // ML
        syncWcToMl(app._db, syncCfg)
          .catch(err => console.error('WC→ML error:', err.message));
      });

      cron.schedule('4-59/10 * * * *', () => {          // ML
        procesarReintentos(app._db, syncCfg)
          .catch(err => console.error('reintentos error:', err.message));
      });

      cron.schedule('6-59/10 * * * *', () => {          // ML: recuperar fail-open de claims
        reintentarReclamosSinConsultar(app._db, mlCfg)
          .catch(err => console.error('reintentos claims ML error:', err.message));
      });

      cron.schedule('6 1-23/2 * * *', () => {          // ML — cada 2h (bajado del 15 min, ver plan ahorro-llamadas-ml)
        procesarCancelacionesMl(app._db, syncCfg)
          .catch(err => console.error('cancelaciones ML error:', err.message));
      });

      // Reactivación automática de pausadas por falta de stock que ya recuperaron stock.
      // Las que no pasan el chequeo de precio quedan registradas como frenadas (badge en el home).
      cron.schedule('8-59/15 * * * *', () => {          // ML
        reactivarAutomatico(app._db, syncCfg)
          .then(r => {
            // Solo dejar rastro cuando hubo algo que hacer, para no ensuciar el log.
            if (r && !r.omitido && (r.reactivadas || r.frenadas)) {
              console.log(`reactivación automática: ${r.reactivadas} reactivadas, ${r.frenadas} frenadas`);
            }
            // Modo de falla mudo (hallazgo del revisor 2026-08-03): si este cron corre antes
            // que el de catálogo tras un reinicio, catalogo_cache.regular_price puede estar
            // vacío para todo el mundo y TODAS las reactivables quedan bloqueadas por "sin
            // precio web mapeado" sin dejar frenada (se reintentan solas) — indistinguible en
            // el log de un ciclo sin trabajo. Avisar explícitamente para que no pase inadvertido.
            if (r && !r.omitido && r.sin_precio_web > 0) {
              console.warn(`reactivación automática: ${r.sin_precio_web} bloqueadas por falta de precio web (catalogo_cache.regular_price vacío) — si persiste varios ciclos, refrescar el catálogo de WooCommerce`);
            }
          })
          .catch(err => console.error('reactivación automática error:', err.message));
      });

      cron.schedule('5-59/10 * * * *', () => {          // ML + Woo
        syncPedidosCache(app._db, {
          woo: wooCfg, ml: mlCfg,
          andreaniStatus: process.env.ANDREANI_ORDER_STATUS || 'lpaandreani',
          enviadoAndreaniStatus: process.env.ANDREANI_ENVIADO_STATUS || 'enviadoandreani',
        }).catch(err => console.error('Error sincronizando pedidos_cache:', err.message));
      });

      cron.schedule('0 4 * * *', () => {
        try {
          const n = purgarFotosBorradas(app._db);
          if (n) console.log(`Purgadas ${n} fotos de preparación (borrado_en > 60 días)`);
        } catch (err) { console.error('Error purgando fotos de preparación:', err.message); }
      });

      // Fase 3 (rotación y criticidad): backfill/incremental diario de ventas_historial.
      // Horario de baja actividad, corrido de los otros crons diarios para no competir por
      // el rate-limit de ML.
      // Auto-confirmar publicaciones ML con seller_sku válido que no tienen entrada
      // en sku_matcher_decisiones (el agujero que causó la sobreventa de FB-67289 el
      // 2026-08-26). Corre cada 30 min — las publicaciones nuevas entran al cache de ML
      // via syncMlToWc (cada 10 min) y en la siguiente corrida quedan bajo control de stock.
      cron.schedule('*/30 * * * *', () => {
        try {
          const insert = app._db.prepare(
            "INSERT OR IGNORE INTO sku_matcher_decisiones (clave, sku, accion) " +
            "SELECT p.clave, p.seller_sku, 'confirmar' " +
            "FROM ml_publicaciones_cache p " +
            "WHERE p.seller_sku IS NOT NULL AND p.seller_sku != '' " +
            "  AND p.status = 'active' " +
            "  AND EXISTS (SELECT 1 FROM catalogo_cache c WHERE c.sku = p.seller_sku) " +
            "  AND NOT EXISTS (SELECT 1 FROM sku_matcher_decisiones d WHERE d.clave = p.clave)"
          );
          const r = insert.run();
          if (r.changes > 0)
            console.log(`[auto-confirm-huerfanas] ${r.changes} publicaciones activas agregadas al matcher`);
        } catch (err) {
          console.error('[auto-confirm-huerfanas] error:', err.message);
        }
      });

      cron.schedule('0 5 * * *', () => {
        backfillVentas(app._db, syncCfg)
          .then(r => console.log('backfillVentas:', JSON.stringify(r)))
          .catch(err => console.error('Error en backfillVentas:', err.message));
      });

      // Fase 5 (auditoría de publicaciones): barrido rotativo cada 15 min, cursor en sync_estado.
      // 2 chunks de 20 por corrida → ~40 publicaciones por tick. Con ~4541 SKUs vinculados
      // una vuelta completa tarda ~19 h. No compite con la reconciliación de stock (cada 10 min)
      // ni con backfillVentas (diario) porque usa atributos distintos del multiget de ML.
      cron.schedule('*/15 * * * *', () => {
        barridoAuditoria(app._db, syncCfg)
          .then(r => { if (r.auditados) console.log('barridoAuditoria:', JSON.stringify(r)); })
          .catch(err => console.error('Error en barridoAuditoria:', err.message));
      });

      // Cola de procesamiento de fotos de preparación (plan 2026-08-12-fotos-preparacion.md):
      // red de seguridad además del disparo inmediato tras cada subida (routes/preparacion.js).
      // Cubre lo que el disparo inmediato pudo perder (ej. el proceso se reinició justo
      // después de guardar el original y antes de procesarlo) y drena backlogs grandes en
      // varias corridas (MAX_POR_TICK en lib/fotosPreparacionCola.js). No pega a ML/Woo —
      // solo CPU/disco locales — así que 1 min de frecuencia no compite por el presupuesto de
      // llamadas a ML de los demás crons.
      cron.schedule('* * * * *', () => {
        procesarColaFotos(app._db)
          .catch(err => console.error('Error en cola de fotos de preparación:', err.message));
      });

      cron.schedule('7-59/10 * * * *', () => {          // Woo
        reintentarColgadosTracking(app._db, {
          woo: wooCfg,
          enviadoAndreaniStatus: process.env.ANDREANI_ENVIADO_STATUS || 'enviadoandreani',
        }).catch(err => console.error('Error en reintentarColgadosTracking:', err.message));
      });

      // Renovación proactiva del token ML: da una oportunidad regular de renovar antes de
      // que el token llegue a vencer, sin sumar otro llamador más a la tormenta que causó
      // el incidente original (getAccessToken no pega a ML si el token sigue vigente, y no
      // hace nada si hay cooldown activo).
      cron.schedule('*/30 * * * *', () => {
        getAccessToken(app._db, mlCfg)
          .catch(err => console.error('Error renovando token ML (cron dedicado):', err.message));
      });

      // Push automático matcher → ML: escribe los SKU de decisiones pendientes (activas y
      // pausadas; activas primero) directo en las publicaciones, sin depender de que alguien
      // tenga la pestaña del matcher abierta. Comparte el mismo motor/mutex que el botón
      // manual (POST /api/matcher/push-skus-pendientes) — nunca corren dos a la vez DENTRO
      // de este proceso (el mutex es una variable en memoria, no cubre dos procesos node en
      // paralelo contra la misma base; ver incidente de pedidos duplicados del 2026-07-25).
      cron.schedule('*/10 * * * *', () => {
        pushSkusPendientes(app._db, syncCfg)
          .catch(err => console.error('push SKUs matcher error:', err.message));
      });

      // Reconciliación incremental de stock contra ML real (plan 2026-08-06, caso real:
      // MLA1117110786| quedó 3 semanas con sobreventa invisible porque ml_stock_estado
      // guardaba lo que RECORDÁBAMOS haber empujado, no lo que ML tenía de verdad). NO
      // escribe en ML: solo corrige ml_stock_estado; syncWcToMl empuja la corrección real
      // en su próxima corrida por su camino ya probado. Minuto propio (:09, libre — ver el
      // comentario de arriba con los minutos ya ocupados) para no sumar ráfaga a los demás.
      cron.schedule('9-59/10 * * * *', () => {          // ML
        // Auto-vincula publicaciones con seller_sku ya cargado y sin ambigüedad (incidente
        // 2026-08-27, FB-68055 y otras 83 quedaban invisibles al sync sin esto) — corre acá
        // para no depender de que alguien abra el Matcher; síncrono y barato (solo SELECTs
        // indexados + un INSERT por vinculación, nada de red).
        try {
          const vinculadas = autoVincularPorSellerSku(app._db);
          if (vinculadas > 0) console.log(`auto-vinculación por seller_sku: ${vinculadas} publicaciones`);
        } catch (err) {
          console.error('auto-vinculación por seller_sku error:', err.message);
        }
        reconciliarStockMl(app._db, syncCfg)
          .catch(err => console.error('reconciliación de stock ML error:', err.message));
      });

      // Hito 7: Worker de notificaciones push — escanea incidentes activos/resueltos
      // y envía notificaciones a dispositivos registrados. Corre cada 2 minutos.
      cron.schedule('*/2 * * * *', () => {
        procesarNotificacionesPush(app._db)
          .catch(err => console.error('Error en procesarNotificacionesPush:', err.message));
      });

      // P1 Claims: entregas durables aisladas del worker legacy de incidentes.
      cron.schedule('*/1 * * * *', () => {
        import('./lib/workerIntegrationNotifications.js').then(({ procesarEntregasPush }) =>
          procesarEntregasPush(app._db)
        ).catch(err => console.error('Error en entregas push de integraciones:', err.message));
      });
    }

    const port = process.env.PORT || 3001;
    app.listen(port, () => console.log(`herramientas-app escuchando en :${port}`));
  });
}
