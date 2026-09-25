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
import { wooRouter, refrescarCatalogo, wooFetch } from './routes/woo.js';
import { geminiRouter } from './routes/gemini.js';
import { nuevosProductosRouter } from './routes/nuevosProductos.js';
import { mapeoRouter } from './routes/mapeo.js';
import { csvRouter } from './routes/csv.js';
import { bandejaIdentidadRouter } from './routes/bandejaIdentidad.js';
import { matcherRouter, dispararRefrescoMl, estadoRefrescoMl } from './routes/matcher.js';
import { syncRouter, syncMlToWc, syncOrdenMlPuntual, syncWcToMl, procesarReintentos, procesarCancelacionesMl, reactivarAutomatico, reconciliarStockMl } from './routes/sync.js';
import { recepcionesRouter } from './routes/recepciones.js';
import { pedidosRouter } from './routes/pedidos.js';
import { coberturaRouter } from './routes/cobertura.js';
import { guardiaMlRouter } from './routes/guardiaMl.js';
import { procesarOperacionesGuardia, liberarRetenidasResueltas } from './lib/guardiaMl.js';
import { procesarOperacionesIdentidad } from './lib/identidadProductos.js';
import { adaptadorMlIdentidad } from './lib/identidadMl.js';
import { identidadProductosRouter } from './routes/identidadProductos.js';
import { preciosRouter } from './routes/precios.js';
import { configurarAuditoriaPrecios, dispararAuditoriaPrecios } from './lib/auditoriaPrecios.js';
import { preparacionRouter, syncPedidosCache, syncPedidoWebPuntual, syncPedidoMlPuntual, purgarFotosBorradas, reintentarColgadosTracking } from './routes/preparacion.js';
import { gestionPedidosRouter } from './routes/gestionPedidos.js';
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
import { abrirOActualizarIncidente, confirmarCicloSano, procesarAlertasEmailIncidentes } from './lib/incidentes.js';
import { revisarBackupNube, revisarBackupPostgres } from './lib/vigiaBackup.js';
import { anunciarVigilanteApagado, revisarInformeDelDia } from './lib/vigilanteInformes.js';
import { devicesRouter } from './routes/devices.js';
import { notificationsRouter } from './routes/notifications.js';
import { procesarNotificacionesPush } from './lib/workerNotificacionesPush.js';
import { validarConfiguracionPush } from './lib/notificacionesPush.js';
import { mlEstadoRouter } from './routes/mlEstado.js';
import { getAccessToken, mlFetch } from './lib/mlClient.js';
import { notificacionesMlRouter } from './routes/notificacionesMl.js';
import { stockExceptionsRouter } from './routes/stockExceptions.js';
import { warrantiesRouter } from './routes/warranties.js';
import { workshopRouter } from './routes/workshop.js';
import { mobileWorkshopRouter } from './routes/mobileWorkshop.js';
import { mobilePreparacionRouter } from './routes/mobilePreparacion.js';
import { inboxClaimsRouter } from './routes/inboxClaims.js';
import { mobileInboxAccionesRouter } from './routes/mobileInboxAcciones.js';
import { operacionesMobileRouter } from './routes/operacionesMobile.js';
import { mobileHoyRouter } from './routes/mobileHoy.js';
import { registrarWebhookMl, registrarWebhookWooProducto, registrarWebhookWooPedido, procesarIntegrationJobs } from './lib/workerIntegrationJobs.js';
import { marcarSombra, abandonarHuerfanas, abandonarVencidos, permitirCuentaAjena, copiaHabilitada, crearColaSombra, crearSelectorCanario } from './lib/sombra.js';
import { crearEmisorSombra, crearEnvioSenal, destinoSenal, importarPerdidas } from './lib/emisorSombra.js';
import { iniciarOutboxPlataforma } from './lib/outboxPlataforma.js';
import { copiaDiaria, msHastaProximaCopia } from './lib/catalogoCopia.js';
import { crearMuestreoCola, evaluarAlertasLegado, medirSombraLegado, publicarAlertasLegado } from './lib/metricasSombra.js';
import { cargarKeyringInterno, cargarKeyringInternoActivo, crearOrigenesInternos, verificarInterno } from './lib/internoHmac.js';
import { crearGatewayCanal, crearPresupuestoShadow, CORRIENTES_ML, ErrorOperacionInvalida, validarConfiguracionCupoSombra } from './lib/gatewayCanal.js';
import { reprocesarJob } from './lib/integrationJobs.js';
import { chatEventsRouter } from './routes/chatEvents.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function buildApp({ dbPath, sessionSecret, wooCfg, geminiKey, mlCfg, mobileJwtSecret, gatewayInterno = null, sombraEnviar = null }) {
  const mobileSecret = mobileJwtSecret ?? process.env.MOBILE_JWT_SECRET;
  validarMobileJwtSecret(mobileSecret);
  validarConfiguracionPush(process.env);
  const db = openDb(dbPath);
  const app = express();

  // Endpoint mínimo para health checks del despliegue. No expone credenciales ni datos
  // operativos; sólo confirma que el proceso responde y SQLite está íntegro.
  // `integrity_check` bloquea el event loop ~0,5 s con la base de producción (medido
  // 2026-09-13) y el endpoint es público: se recalcula a lo sumo cada 5 min. Cada llamada sí
  // verifica que la base responda.
  const HEALTHZ_INTEGRIDAD_TTL_MS = 5 * 60 * 1000;
  let healthzIntegridad = null; // { valor, en }
  app.get('/healthz', (req, res) => {
    try {
      db.prepare('SELECT 1').get();
      if (!healthzIntegridad || Date.now() - healthzIntegridad.en > HEALTHZ_INTEGRIDAD_TTL_MS) {
        healthzIntegridad = { valor: db.prepare('PRAGMA integrity_check').get().integrity_check, en: Date.now() };
      }
      const integridad = healthzIntegridad.valor;
      if (integridad !== 'ok') return res.status(503).json({ ok: false, integridad });
      return res.json({ ok: true, integridad: 'ok' });
    } catch (error) {
      return res.status(503).json({ ok: false, error: 'base de datos no disponible' });
    }
  });

  app.set('trust proxy', 1); // detrás de Nginx

  // ── E1 T3: copia de sombra posterior al ACK ─────────────────────────────────
  // Apagada salvo SOMBRA_COPIA_ENABLED=true con SOMBRA_PLATAFORMA_URL y SOMBRA_KEYRING_FILE. Media
  // configuración apaga la copia con un log: nunca puede impedir que el legado arranque ni cambiar un ACK.
  const colaSombra = (() => {
    if (sombraEnviar) return crearColaSombra({ db, enviar: sombraEnviar });
    if (!copiaHabilitada()) return null;
    if (!process.env.SOMBRA_PLATAFORMA_URL || !process.env.SOMBRA_KEYRING_FILE) {
      console.error('[sombra] SOMBRA_COPIA_ENABLED=true sin SOMBRA_PLATAFORMA_URL o SOMBRA_KEYRING_FILE: copia apagada');
      return null;
    }
    try {
      const keyring = cargarKeyringInternoActivo(process.env.SOMBRA_KEYRING_FILE);
      const cola = crearColaSombra({ db, enviar: crearEmisorSombra({ db, url: process.env.SOMBRA_PLATAFORMA_URL, keyring }) });
      cola.enviarSenal = crearEnvioSenal({ url: process.env.SOMBRA_PLATAFORMA_URL, keyring, timeoutMs: 5000 });
      return cola;
    } catch (e) {
      console.error('[sombra] configuración de copia inválida, copia apagada:', e.message);
      return null;
    }
  })();
  if (colaSombra) {
    // Intentos de este proceso que nunca cerraron (p. ej. un fetch colgado más allá del timeout), muestreo
    // de la cola, alertas como incidentes operativos e importación de pérdidas. Todo fail-open.
    const muestreo = crearMuestreoCola(colaSombra);
    setInterval(() => { try { muestreo.registrar(); } catch { /* fail-open */ } }, 30_000).unref();
    setInterval(() => {
      try {
        abandonarVencidos(db);
        const m = medirSombraLegado(db, { cola: colaSombra });
        publicarAlertasLegado(db, evaluarAlertasLegado(m, { colaSaturadaSostenida: muestreo.saturadaSostenida() }));
      } catch { /* base cerrada en pruebas */ }
    }, 60_000).unref();
    if (colaSombra.enviarSenal) {
      let importando = false;
      setInterval(() => {
        if (importando) return;
        importando = true;
        importarPerdidas({ db, enviarSenal: colaSombra.enviarSenal })
          .then((r) => { if (r.importadas || r.detenida) console.log(`[sombra] pérdidas importadas=${r.importadas} pendientes=${r.pendientes} detenida=${r.detenida}`); })
          .catch((e) => console.error('[sombra] importación de pérdidas falló:', e.message))
          .finally(() => { importando = false; });
      }, Number(process.env.SOMBRA_IMPORTAR_CADA_MS) > 0 ? Number(process.env.SOMBRA_IMPORTAR_CADA_MS) : 5 * 60_000).unref();
    }
  }
  // E1 T4: vigilante de los informes firmados. Apagado salvo VIGILANTE_INFORMES_ENABLED=true: si se encendiera
  // solo al desplegar, alertaría esa misma mañana, porque la plataforma todavía no emite informes. Usa el mismo
  // destino y keyring que la copia de sombra. Revisa cada hora; antes de las 09:00 ART no consulta.
  if (process.env.VIGILANTE_INFORMES_ENABLED === 'true') {
    try {
      const keyringVigilante = cargarKeyringInternoActivo(process.env.SOMBRA_KEYRING_FILE);
      const revisar = () => revisarInformeDelDia(db, { url: process.env.SOMBRA_PLATAFORMA_URL, keyring: keyringVigilante })
        .then((r) => { if (r.estado !== 'ok' && r.estado !== 'temprano') console.error(`[informes] vigilante: ${r.estado} (esperado ${r.esperado})`); })
        .catch((e) => console.error('[informes] vigilante falló:', e.message));
      // Una vez al arrancar (a los dos minutos, con el servicio ya estable) y después cada hora: sin la corrida
      // inicial, un reinicio después de las 09:00 demoraba el primer control una hora.
      setTimeout(revisar, 2 * 60_000).unref();
      setInterval(revisar, 60 * 60_000).unref();
    } catch (e) {
      // No alcanza con registrarlo: si el vigilante no arranca, nadie avisaría que la plataforma dejó de emitir.
      console.error('[informes] vigilante sin configuración válida, apagado:', e.message);
      try { anunciarVigilanteApagado(db, e.message); } catch (e2) { console.error('[informes] tampoco se pudo abrir el incidente:', e2.message); }
    }
  }
  // E2 T1: despachador de la outbox hacia la plataforma. Apagado salvo OUTBOX_PLATAFORMA_ENVIO=true. La captura
  // (OUTBOX_PLATAFORMA_CAPTURA) es independiente: se enciende antes, para que no se pierda ningún cambio mientras
  // se toma la copia del matcher (plan de E2 T1, tarea 14).
  try {
    iniciarOutboxPlataforma(db, { cargarKeyring: cargarKeyringInternoActivo });
  } catch (e) {
    console.error('[outbox] configuración inválida, despachador apagado:', e.message);
  }
  // E2 T1: copia diaria del matcher y de los casos de identidad a la plataforma, 03:30 ART. Es la conciliación:
  // con la outbox funcionando no cambia nada, y si cambia algo abre un incidente. Apagada salvo
  // CATALOGO_COPIA_DIARIA=true; usa el destino y el keyring de la sombra.
  if (process.env.CATALOGO_COPIA_DIARIA === 'true') {
    try {
      const keyringCopia = cargarKeyringInternoActivo(process.env.SOMBRA_KEYRING_FILE);
      const opcionesCopia = { url: process.env.SOMBRA_PLATAFORMA_URL, keyring: keyringCopia };
      const programar = () => setTimeout(() => {
        copiaDiaria(db, opcionesCopia, {
          abrir: (i) => abrirOActualizarIncidente(db, i), cerrar: (i) => confirmarCicloSano(db, i),
        })
          .then((r) => console.log(`[catalogo] copia diaria: matcher=${r.matcher.total} identidad=${r.identidad.total} diferencias=${r.diferencias}`))
          .catch((e) => console.error('[catalogo] copia diaria falló:', e.message))
          .finally(programar);
      }, msHastaProximaCopia()).unref();
      programar();
    } catch (e) {
      console.error('[catalogo] copia diaria sin configuración válida, apagada:', e.message);
    }
  }
  app._colaSombra = colaSombra;
  const canario = crearSelectorCanario();
  if (colaSombra) console.log(`[sombra] copia encendida: canales=${canario.canales.join(',')} porcentaje=${canario.porcentaje}`);

  /**
   * Engancha el ciclo de sombra a una respuesta. Se llama ANTES de responder: `finish` significa que el
   * ACK salió; `close` sin `finish` es una respuesta cortada. Todo lo que pasa acá ocurre después del ACK.
   * Un duplicado no se copia: el aviso original ya tuvo su intento.
   */
  function engancharSombra(res, persistido) {
    if (!colaSombra || !persistido || persistido.duplicate) return;
    const id = persistido.eventId;
    let terminada = false;
    res.once('finish', () => {
      terminada = true;
      try {
        const ahora = new Date().toISOString();
        const evento = db.prepare('SELECT event_id, channel, resource_id, metadata_json FROM integration_events WHERE event_id = ?').get(id);
        const senal = destinoSenal(evento);
        if (!senal) {
          marcarSombra(db, id, 'excluded', { razon: 'unsupported_topic', ackAt: ahora, completedAt: ahora });
          return;
        }
        if (!canario.incluye(evento.channel, `${senal.topic}|${senal.resource_id}`)) {
          marcarSombra(db, id, 'excluded', { razon: 'canary_excluded', ackAt: ahora, completedAt: ahora });
          return;
        }
        marcarSombra(db, id, 'pending', { ackAt: ahora });
        colaSombra.encolar(id);
      } catch (e) {
        console.error('[sombra] no se pudo encolar la copia:', e.message);
      }
    });
    res.once('close', () => {
      if (terminada) return;
      try { marcarSombra(db, id, 'abandoned', { razon: 'response_not_finished', completedAt: new Date().toISOString() }); } catch { /* fail-open */ }
    });
  }

  // ── E1 T3 C5: gateway interno de sólo lectura ────────────────────────────────
  // POST /internal/v1/channel-read. Nace apagado: sin GATEWAY_KEYRING_FILE y GATEWAY_ORIGENES la ruta no
  // existe (404). Nginx la niega desde Internet por /internal/ y /herramientas/internal/; HMAC, nonce y
  // origen son la defensa adicional. El origen se toma del socket, no de X-Forwarded-For: una petición
  // que pasó por Nginx llega desde 127.0.0.1 y ese origen NO está en la lista de la red de Docker.
  const gw = gatewayInterno ?? (process.env.GATEWAY_KEYRING_FILE && process.env.GATEWAY_ORIGENES ? (() => {
    const rpmGlobal = Number(process.env.GATEWAY_ML_SHADOW_RPM || 0);
    const configuracionPorCorriente = Object.fromEntries(
      CORRIENTES_ML.map((c) => [c, Number(process.env[`GATEWAY_ML_SHADOW_RPM_${c.toUpperCase()}`] || 0)]),
    );
    // Sin coercionar acá: si viene con un typo (no numérico), que lo detecte validarConfiguracionCupoSombra
    // en vez de que `Number('typo') || 0` lo aplane a "cerrado" en silencio antes de validar.
    configuracionPorCorriente.e2e3 = process.env.GATEWAY_ML_SHADOW_RPM_E2E3;
    // Fail-closed SÓLO de la sombra (E1 T5): una variable por corriente faltante o inválida jamás debe
    // tumbar el arranque de herramientas entero (pedidos/stock/preparación no dependen de esto). Si la
    // validación falla, la sombra queda cerrada (todas las corrientes ML dan 429 sintético con
    // x-fusion-cupo, vía buckets en 0) y el legado sigue arrancando normal.
    let presupuestoMl;
    try {
      validarConfiguracionCupoSombra(configuracionPorCorriente, rpmGlobal);
      presupuestoMl = crearPresupuestoShadow(configuracionPorCorriente, rpmGlobal);
    } catch (error) {
      console.error(`[gateway-sombra] configuración de cupo por corriente inválida, sombra cerrada: ${error.message}`);
      presupuestoMl = crearPresupuestoShadow({}, 0);
    }
    return {
      claves: cargarKeyringInterno(process.env.GATEWAY_KEYRING_FILE),
      origenes: crearOrigenesInternos(process.env.GATEWAY_ORIGENES),
      ejecutar: crearGatewayCanal({
        mlUserId: mlCfg?.userId || process.env.ML_USER_ID,
        mlAppId: mlCfg?.clientId || process.env.ML_CLIENT_ID,
        mlSiteId: process.env.ML_SITE_ID || null,
        presupuestoMl,
        ejecutarMl: (ruta, headers) => mlFetch(app._db, mlCfg, 'get', ruta, null, { headers }),
        ejecutarWoo: (ruta) => wooFetch(wooCfg, ruta),
      }),
    };
  })() : null);
  if (gw) {
    app.post('/internal/v1/channel-read', express.raw({ type: 'application/json', limit: '16kb' }), async (req, res) => {
      const correlacion = crypto.randomUUID();
      const cuerpo = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      let v;
      try {
        v = verificarInterno({ db: app._db, claves: gw.claves, origenes: gw.origenes, direccion: req.socket.remoteAddress,
          headers: req.headers, metodo: 'POST', ruta: '/internal/v1/channel-read', cuerpo });
      } catch {
        return res.status(503).json({ code: 'unavailable', correlation_id: correlacion });
      }
      if (!v.ok) {
        console.warn(`[gateway] rechazo motivo=${v.motivo} correlacion=${correlacion}`);
        return res.status(401).json({ code: 'unauthorized', correlation_id: correlacion });
      }
      let peticion;
      try { peticion = JSON.parse(cuerpo.toString('utf8')); } catch { return res.status(400).json({ code: 'invalid_operation', correlation_id: correlacion }); }
      try {
        return res.status(200).json(await gw.ejecutar(peticion));
      } catch (err) {
        if (err instanceof ErrorOperacionInvalida) return res.status(400).json({ code: 'invalid_operation', correlation_id: correlacion });
        // Sin mensaje remoto: puede traer URL, cuerpo o detalle de credenciales.
        console.error(`[gateway] fallo de ejecución correlacion=${correlacion}`);
        return res.status(502).json({ code: 'channel_unavailable', correlation_id: correlacion });
      }
    });
  }
  // Ingesta firmada del chat: debe montarse antes de express.json para verificar el cuerpo crudo.
  app.use(chatEventsRouter(db));
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
        const received = Buffer.from(String(sig));
        const expectedBuffer = Buffer.from(expected);
        if (received.length !== expectedBuffer.length || !crypto.timingSafeEqual(received, expectedBuffer)) {
          return res.status(401).json({ ok: false, error: 'firma inválida' });
        }
      }
      let order;
      try { order = JSON.parse(req.body.toString('utf8')); }
      catch { return res.status(400).json({ ok: false, error: 'payload inválido' }); }

      // E1 T3 C2: recibo durable ANTES del ACK. Es el único cambio deliberado de código de respuesta
      // del legado: este webhook no tenía recibo y un reinicio perdía el aviso sin rastro. Si SQLite
      // falla devolvemos 503 y WC reintenta, que es exactamente lo que queremos de un aviso no
      // registrado; un id inválido es 400 y no se reintenta. El ACK sigue sin esperar a la plataforma.
      try {
        const persistido = registrarWebhookWooPedido(app._db, order, {
          topic: req.headers['x-wc-webhook-topic'],
          deliveryId: req.headers['x-wc-webhook-delivery-id'],
          sombra: Boolean(colaSombra),
        });
        engancharSombra(res, persistido);
      } catch (err) {
        const status = err.code === 'woo_order_id_invalid' ? 400 : 503;
        return res.status(status).json({ ok: false, error: err.message });
      }

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

  // ── Webhook WooCommerce → catálogo puntual durable ──────────────────────────
  // Configurar en Woo los topics product.created, product.updated y product.deleted hacia
  // esta ruta. El ACK solo se emite tras persistir evento+job: un reinicio posterior no pierde
  // el cambio y el worker relee Woo como fuente de verdad.
  app.post('/api/woo/webhook/product',
    express.raw({ type: 'application/json', limit: '1mb' }),
    (req, res) => {
      const whSecret = process.env.WOO_WEBHOOK_SECRET || '';
      if (whSecret) {
        const sig = req.headers['x-wc-webhook-signature'];
        if (!sig) return res.status(401).json({ ok: false, error: 'sin firma' });
        const expected = crypto.createHmac('sha256', whSecret).update(req.body).digest('base64');
        const received = Buffer.from(String(sig));
        const expectedBuffer = Buffer.from(expected);
        if (received.length !== expectedBuffer.length || !crypto.timingSafeEqual(received, expectedBuffer)) {
          return res.status(401).json({ ok: false, error: 'firma inválida' });
        }
      }
      let producto;
      try { producto = JSON.parse(req.body.toString('utf8')); }
      catch { return res.status(400).json({ ok: false, error: 'payload inválido' }); }
      try {
        const persistido = registrarWebhookWooProducto(app._db, producto, {
          topic: req.headers['x-wc-webhook-topic'],
          deliveryId: req.headers['x-wc-webhook-delivery-id'],
          sombra: Boolean(colaSombra),
        });
        engancharSombra(res, persistido);
        return res.status(200).json({ ok: true, duplicate: persistido.duplicate, event_id: persistido.eventId });
      } catch (err) {
        const status = err.code === 'woo_product_topic_invalid' || err.code === 'woo_product_id_invalid' ? 400 : 503;
        return res.status(status).json({ ok: false, error: err.message });
      }
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

  // Política de privacidad: pública y sin sesión, porque App Store exige una URL que el
  // revisor y cualquier usuario puedan abrir sin credenciales.
  app.use('/privacidad', express.static(path.join(__dirname, 'public/privacidad')));
  app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
  app.use('/stock', express.static(path.join(__dirname, 'public/stock')));
  app.use('/excepciones', express.static(path.join(__dirname, 'public/excepciones')));
  app.use('/garantias', express.static(path.join(__dirname, 'public/garantias')));
  app.use('/taller', express.static(path.join(__dirname, 'public/taller')));
  app.use('/etiquetas', express.static(path.join(__dirname, 'public/etiquetas')));
  // Una sesión de conteo tiene URL propia, igual que un pedido en gestión de pedidos
  // (/gestion-pedidos/pedidos/:id). VA ANTES del static: express.static no conoce esta ruta y
  // devolvería 404. La pantalla decide qué hacer con el id — retomar si es tuya y está abierta,
  // abrirla en lectura si no.
  app.get('/inventario/sesion/:id', (req, res) => {
    res.sendFile(path.join(__dirname, 'public/inventario/index.html'));
  });
  app.use('/inventario', express.static(path.join(__dirname, 'public/inventario')));
  app.use('/home', express.static(path.join(__dirname, 'public/home')));
  app.use('/login', express.static(path.join(__dirname, 'public/login')));
  app.use('/matcher', express.static(path.join(__dirname, 'public/matcher')));
  app.use('/bandeja-identidad', express.static(path.join(__dirname, 'public/bandeja-identidad')));
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
  // Versión del contrato, ANTES de la autenticación: una app que quedó vieja tiene que poder
  // enterarse de que debe actualizarse sin necesidad de una sesión válida —si el contrato
  // cambió, su login puede ser justamente lo que ya no funciona—.
  app.get('/api/v1/meta', async (req, res) => {
    const { estadoCompatibilidad } = await import('./lib/contratoMovil.js');
    res.json({ ok: true, ...estadoCompatibilidad(req.query.app_version || req.get('x-app-version')) });
  });
  app.use('/api/v1/auth', mobileAuthRouter(db, mobileSecret));
  app.get('/api/v1/me', mobileAuth, mobileMeHandler(db));
  app.use('/api/v1/devices', devicesRouter(db, mobileAuth));
  app.use('/api/v1/notifications', notificationsRouter(db, mobileNotificationsAuth));
  app.use('/api/v1/inbox', inboxClaimsRouter(db, mobileNotificationsAuth));
  // Acciones contra Mercado Libre. Va antes del catch-all de `/api/v1` por el mismo motivo
  // que las de abajo: si no, sus rutas quedarían capturadas y responderían 404.
  app.use('/api/v1', mobileInboxAccionesRouter(db, mobileNotificationsAuth, mlCfg));
  app.use('/api/v1/workshop', mobileWorkshopRouter(db, mobileAuth));
  app.use('/api/v1/identidad-productos', mobileAuth, identidadProductosRouter(db));
  // Preparación para la app. Delega en los handlers del panel (routes/preparacion.js) para
  // no tener dos versiones de las reglas de picking; acá solo se traduce al contrato móvil.
  // Va antes del catch-all de /api/v1 por el mismo motivo que las de arriba.
  app.use('/api/v1/preparation', mobilePreparacionRouter(db, mobileAuth, {
    woo: wooCfg, ml: mlCfg,
    andreaniStatus: process.env.ANDREANI_ORDER_STATUS || 'lpaandreani',
    enviadoAndreaniStatus: process.env.ANDREANI_ENVIADO_STATUS || 'enviadoandreani',
  }));
  // Antes del catch-all de `/api/v1`, o sus rutas quedarían capturadas por él y responderían
  // 401 en vez de existir —que es exactamente lo que les pasaba—.
  app.use('/api/v1', mobileHoyRouter(db, mobileAuth));
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
  configurarAuditoriaPrecios({ mlCfg });

  // Deduplicación corta de webhooks `orders`/`orders_v2` de la misma orden ML (2026-09-20): ML manda
  // varias notificaciones del mismo pedido en ráfaga (cambios de estado, envío, pago) y cada una
  // disparaba su propia llamada a ML, hasta 17 veces para un solo pedido en producción — compite por un
  // cupo que ya sabemos escaso (ver el 429 del bootstrap del catálogo). El ACK a ML nunca cambia por
  // esto: sigue siendo 200 siempre: la ventana sólo decide si se llama a ML de nuevo, no si el webhook
  // se acepta. Ventana corta (15 s) a propósito: alcanza para matar la ráfaga de notificaciones del
  // mismo evento sin perder un cambio de estado real y posterior del mismo pedido. Clave por función
  // (`syncOrdenMlPuntual`/`syncPedidoMlPuntual`) + `mlOrderId`, no sólo por pedido: son sincronizaciones
  // distintas (stock por venta vs. pedidos_cache) y compartir la ventana dejaría que una consuma la
  // dedup de la otra y la salte sin haber corrido nunca. Fail-open preexistente intacto: si la dedup
  // saltea un pedido que sí cambió, `syncPedidosCache` (cron cada 10 min) lo agarra igual por
  // `pendientesMl` — por eso una ventana corta es segura.
  const VENTANA_DEDUP_NOTIF_ML_MS = 15_000;
  const notifMlVistos = new Map(); // clave `${funcion}:${mlOrderId}` → timestamp del último disparo.
  function deberiaSincronizarNotifMl(funcion, mlOrderId) {
    const clave = `${funcion}:${mlOrderId}`;
    const ahora = Date.now();
    // Purga perezosa de vencidos en cada llamada: sin tabla ni temporizador aparte, y el tráfico real
    // que se quiere deduplicar es justamente lo que dispara esta función seguido.
    for (const [k, t] of notifMlVistos) if (ahora - t > VENTANA_DEDUP_NOTIF_ML_MS) notifMlVistos.delete(k);
    if (notifMlVistos.has(clave)) return false;
    notifMlVistos.set(clave, ahora);
    return true;
  }

  // ── Notificaciones ML ────────────────────────────────────────────────────────
  // POST /api/ml/notificacion
  // La app tiene TODOS los topics seleccionados en el panel de ML Developers (decisión
  // 2026-08-26: filtrar acá es más simple que ir y volver al panel cada vez que se suma una
  // función nueva). Body: { topic, resource, user_id, ... }. ML no envía firma — la
  // autenticidad se valida por: el user_id del body debe coincidir con ML_USER_ID.
  // ML espera un ACK rápido — persistimos el evento+job en una transacción y respondemos siempre 200 (ver nota junto al res.status más abajo).
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
    const { topic, resource, user_id } = req.body || {};
    // Helper para prevenir log injection: truncar y quitar saltos de línea.
    const sanear = (v) => String(v ?? '').slice(0, 200).replace(/[\r\n]/g, ' ');
    const legacyClaimEnvelope = topic === 'post_purchase'
      && (typeof req.body?.claim_id === 'string' || typeof req.body?.envelope?.claim_id === 'string');
    // Validar resource: puede contener query strings y puntos (ej. "/messages/packs/2000.../sellers/123?mark_as_read=false").
    // Parseamos el pathname con URL (con host ficticio) y validamos que sea una ruta válida.
    let validResource = false;
    if (typeof resource === 'string') {
      try {
        const url = new URL(resource, 'http://x');
        const pathname = url.pathname;
        validResource = /^\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(pathname);
      } catch { /* URL inválida */ }
    }
    const validTopic = typeof topic === 'string' && /^[a-z][a-z0-9_.-]{0,63}$/i.test(topic);
    if (!validTopic || ((!validResource) && !legacyClaimEnvelope)) {
      const timestamp = new Date().toISOString();
      const motivo = !validTopic ? 'topic inválido' : 'resource inválido/faltante';
      console.error(`[notif-ml-error] ${timestamp} 400 envelope-inválido | topic=${sanear(topic)} resource=${sanear(resource)} user_id=${sanear(user_id)} | motivo: ${motivo}`);
      return res.status(400).json({ ok: false, error: 'envelope inválido' });
    }
    if (user_id === undefined || user_id === null || String(user_id).trim() === '') {
      const timestamp = new Date().toISOString();
      console.error(`[notif-ml-error] ${timestamp} 400 user_id-faltante | topic=${sanear(topic)} resource=${sanear(resource)} user_id=${sanear(user_id)} | motivo: user_id ausente, null o vacío`);
      return res.status(400).json({ ok: false, error: 'user_id requerido' });
    }

    // Validar que la notificación es para nuestra cuenta.
    // Persistir antes del ACK: si es de otra cuenta, respondemos 200 (no reintentable).
    // Solo 503 si falta config y no se pudo persistir.
    const mlUserId = process.env.ML_USER_ID;
    if (!mlUserId) {
      // ML no está configurado: no se puede persistir. Fail-closed.
      const timestamp = new Date().toISOString();
      console.error(`[notif-ml-error] ${timestamp} 503 config-ml-ausente | topic=${sanear(topic)} resource=${sanear(resource)} user_id=${sanear(user_id)} | motivo: ML_USER_ID no configurado`);
      return res.status(503).json({ ok: false, error: 'integración ML no configurada' });
    }
    const esOtraCuenta = String(user_id) !== String(mlUserId);
    if (esOtraCuenta) {
      // E1 T3 C2: se persiste el recibo como `excluded/foreign_account` para que el aviso deje traza,
      // pero SÓLO si la defensa por IP lo permite (20/IP/hora, lib/sombra.js). Ese límite es la razón
      // por la que antes no se persistía nada: sin él, user_id al azar infla la base. Pasado el techo
      // se descarta sin escribir. El código de respuesta no cambia: siempre 200, no reintentable.
      if (permitirCuentaAjena(req.ip)) {
        try {
          // `sinJob`: la traza no debe agendar trabajo sobre el recurso de otra cuenta.
          const ajeno = registrarWebhookMl(app._db, req.body, { sinJob: true });
          marcarSombra(app._db, ajeno.eventId, 'excluded', { razon: 'foreign_account', completedAt: new Date().toISOString() });
        } catch { /* fail-open: la traza no vale romper el ACK de ML */ }
      }
      return res.status(200).json({ ok: true, ignored: true });
    }

    // Persistir el recibo antes del ACK. El procesamiento sigue siendo fail-open para
    // conservar el contrato de orders y no bloquear los webhooks de ML por una llamada
    // externa lenta; el evento durable permite auditar el recibo aunque falle el handler.
    let persisted;
    try {
      persisted = registrarWebhookMl(app._db, req.body, { sombra: Boolean(colaSombra) });
      engancharSombra(res, persisted);
    }
    catch (err) {
      const timestamp = new Date().toISOString();
      console.error(`[notif-ml-error] ${timestamp} 503 persistencia-fallo | topic=${sanear(topic)} resource=${sanear(resource)} user_id=${sanear(user_id)} | motivo: ${err.message}`);
      return res.status(503).json({ ok: false, error: 'no se pudo persistir el evento' });
    }
    // ML solo documenta 200 como ACK válido de un webhook. Usar códigos distintos (202 para
    // nuevo, 200 para duplicado) arriesga que ML trate el recibo como fallo y reintente
    // indefinidamente hasta deshabilitar la URL de notificaciones. Por eso siempre 200:
    // distinguimos nuevo/duplicado únicamente en el response body con { duplicate: boolean }.
    res.status(200).json({ ok: true, duplicate: persisted.duplicate });

    if (topic === 'orders' || topic === 'orders_v2') {
      console.log(`[notif-ml] topic=${topic} resource=${resource} → ${topic === 'orders' ? 'syncOrdenMlPuntual' : 'syncPedidoMlPuntual'}`);
      // `resource` viene como "/orders/{id}" -- se toma el último segmento.
      const recursoPedido = String(resource || '').match(/^\/orders\/([^/]+)\/?$/);
      const mlOrderId = recursoPedido?.[1];

      // A.3 (2026-08-27): syncMlToWc ya NO se dispara acá — hacía un barrido paginado
      // completo de /orders/search por cada webhook, cuando el propio webhook ya trae el id
      // puntual de la orden. syncOrdenMlPuntual procesa SOLO esa orden (GET /orders/{id}).
      // El barrido paginado completo sigue de respaldo vía el cron ('3-59/10 * * * *', más
      // abajo) — si esto falla o no llega, el cron la termina agarrando igual. Comportamiento
      // preexistente (solo 'orders', no 'orders_v2') sin tocar: syncMlToWc/syncOrdenMlPuntual
      // ajustan stock por venta, no aplica a 'orders_v2' hasta que se defina esa función.
      if (topic === 'orders' && mlOrderId && deberiaSincronizarNotifMl('syncOrdenMlPuntual', mlOrderId)) {
        syncOrdenMlPuntual(app._db, syncCfg, mlOrderId)
          .catch(err => console.error('[notif-ml] syncOrdenMlPuntual error:', err.message));
      }

      // A.1 (2026-08-26): camino rápido a la cola de Preparación, para 'orders' y 'orders_v2'
      // por igual. Fail-open: si falla o el order id no se puede extraer, no se pierde nada --
      // el pedido igual va a aparecer en la próxima corrida de syncPedidosCache (cron cada 10
      // min) vía pendientesMl, que no depende de este camino puntual.
      if (mlOrderId && deberiaSincronizarNotifMl('syncPedidoMlPuntual', mlOrderId)) {
        syncPedidoMlPuntual(app._db, mlCfg, mlOrderId)
          .catch(err => console.error('[notif-ml] syncPedidoMlPuntual error:', err.message));
      }
      return;
    }

    // Topic post_purchase: la proyección real vive en el worker (procesarIntegrationJobs).
    // Aquí solo persistimos el evento; no hay logs informativos.
    if (topic === 'post_purchase') {
      return;
    }

    // Topic sin función todavía (shipments, orders_feedback, items, invoices) —
    // se descarta en silencio, a propósito. (orders_v2 sí tiene función: ver más arriba,
    // camino puntual vía syncPedidoMlPuntual.)
  });

  // El agente Windows no dispone de sesión de navegador: cuando presenta Bearer
  // se autentica con el mismo JWT revocable de dispositivos que usa la App. Las
  // solicitudes sin Bearer siguen por la sesión web y sus permisos normales.
  app.use('/api/etiquetas', (req, res, next) => {
    if (!/^Bearer\s+/i.test(req.get('authorization') || '')) return next();
    return mobileAuth(req, res, next);
  });
  app.use('/api', (req, res, next) => {
    if (req.path.startsWith('/etiquetas') && req.user && /^Bearer\s+/i.test(req.get('authorization') || '')) return next();
    return authGuard(req, res, next);
  }, scopeCheck);

  app.post('/api/admin/integration-jobs/:id/reprocess', requireAdmin, (req, res) => {
    const ok = reprocesarJob(app._db, Number(req.params.id));
    return ok ? res.status(202).json({ ok: true, reprocessed: true })
      : res.status(404).json({ ok: false, error: 'job DLQ no encontrado' });
  });

  // Gestión de usuarios: solo admins.
  app.use('/api/usuarios', requireAdmin, usuariosRouter(db));


  app.use('/api/woo', wooRouter(db, wooCfg));
  app.use('/api/gemini', geminiRouter(geminiKey));
  app.use('/api/nuevos-productos', nuevosProductosRouter(geminiKey, db, wooCfg));
  app.use('/api/mapeo', mapeoRouter(db));
  app.use('/api/csv', csvRouter());
  app.use('/api/matcher', matcherRouter(db, syncCfg));
  // E3: bandeja de identidad. Proxy firmado a la plataforma (mismo keyring y URL que la copia de sombra); sin esa
  // configuración responde 503 bandeja_no_configurada, nunca impide arrancar. El permiso `matcher` lo aplica
  // scopeCheck (lib/permisos.js) y el actor sale de la sesión.
  app.use('/api/bandeja-identidad', (() => {
    let keyring = null;
    try { if (process.env.SOMBRA_KEYRING_FILE) keyring = cargarKeyringInternoActivo(process.env.SOMBRA_KEYRING_FILE); }
    catch (e) { console.error('[bandeja-identidad] keyring inválido:', e.message); }
    return bandejaIdentidadRouter({ url: process.env.SOMBRA_PLATAFORMA_URL, keyring });
  })());
  app.use('/api/sync', syncRouter(db, syncCfg));
  app.use('/api/recepciones', recepcionesRouter(db, wooCfg));
  app.use('/recepcion', express.static(path.join(__dirname, 'public/recepcion')));
  app.use('/api/pedidos', pedidosRouter(db));
  app.use('/api/gestion-pedidos', gestionPedidosRouter(db, { woo: wooCfg, ml: mlCfg }));
  app.use('/pedidos', express.static(path.join(__dirname, 'public/pedidos')));
  // La pantalla exige el mismo permiso que su API (`pedidos`, nivel lectura): el gate de
  // preview por nombre de usuario se retiró el 2026-09-09 porque excluía a operarios que ya
  // tenían `pedidos:write` en la base. Las mutaciones las sigue filtrando scopeCheck sobre
  // /api/gestion-pedidos, que resuelve write por método.
  function pedidosPageGuard(req, res, next) {
    if (req.user?.is_admin) return next();
    if (permiteAcceso(req.user?.permisos || [], { anyOf: ['pedidos'], nivel: 'read' })) return next();
    return res.status(403).send('No tenés permiso para ver Gestión de pedidos.');
  }
  // URL persistente del detalle: sirve la misma SPA, que resuelve el id desde el pathname.
  app.get('/gestion-pedidos/pedidos/:id', authGuard, pedidosPageGuard, (req, res) => {
    res.sendFile(path.join(__dirname, 'public/gestion-pedidos/index.html'));
  });
  app.use('/gestion-pedidos', authGuard, pedidosPageGuard, express.static(path.join(__dirname, 'public/gestion-pedidos')));
  app.use('/api/cobertura', coberturaRouter(db, syncCfg));
  app.use('/api/guardia-ml', guardiaMlRouter(db, syncCfg));
  app.use('/api/identidad-productos', identidadProductosRouter(db));
  app.use('/guardia-ml', express.static(path.join(__dirname, 'public/guardia-ml')));
  app.use('/identidad-productos', express.static(path.join(__dirname, 'public/identidad-productos')));
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
  app.use('/api/stock-exceptions', stockExceptionsRouter(db));
  app.use('/api/warranties', warrantiesRouter(db));
  app.use('/api/workshop', workshopRouter(db));
  app.use('/api/devices', devicesRouter(db));
  app.use('/api/notifications', notificationsRouter(db));
  app.use('/api/ml', mlEstadoRouter(db));
  app.use('/api/notificaciones-ml', notificacionesMlRouter(db));

  // Express responde 404 con HTML por defecto. Para la API eso rompe el contrato y hace
  // que los clientes fallen al ejecutar response.json(); una ruta o método inexistente
  // debe conservar el mismo formato JSON que el resto de los errores de /api.
  app.use('/api', (req, res) => {
    return res.status(404).json({ ok: false, error: 'Endpoint no encontrado' });
  });

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
  // E1 T3 C2: toda sombra activa de un proceso anterior quedó huérfana — su intento murió con él.
  // Se cierra con razón explícita en vez de quedar `attempting` para siempre. Fail-open: esto es
  // higiene de la copia, no puede impedir que la app arranque.
  try {
    const huerfanas = abandonarHuerfanas(db);
    if (huerfanas) console.log(`[sombra] ${huerfanas} copia(s) huérfana(s) de un proceso anterior abandonadas`);
  } catch (e) { console.error('[sombra] no se pudo limpiar huérfanas:', e.message); }
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
      // Gestión de pedidos: importación incremental de la ventana reciente. Sin esto la
      // herramienta muestra el resultado de la última corrida manual y envejece sola —
      // era el estado al 2026-09-09, con la única corrida completa del día anterior.
      // Ventana corta (GESTION_PEDIDOS_VENTANA_HORAS, 48 h por defecto) porque el upsert
      // es idempotente por (fuente, external_id): reimportar lo mismo no duplica, y una
      // ventana de 30 días cada 10 minutos gastaría cuota de ML sin necesidad. La
      // reconciliación completa del mes sigue siendo el botón manual de la pantalla.
      // Minuto 9, paso 10: no pisa ningún otro cron de esta lista (offsets 1..8).
      cron.schedule('9-59/10 * * * *', async () => {   // ML + Woo
        try {
          const { ejecutarImportacion } = await import('./lib/gestionPedidosSync.js');
          const horas = Number(process.env.GESTION_PEDIDOS_VENTANA_HORAS) || 48;
          const r = await ejecutarImportacion(app._db, {
            woo: wooCfg,
            ml: mlCfg,
            desde: new Date(Date.now() - horas * 60 * 60 * 1000).toISOString(),
          });
          if (r.creados || r.actualizados) console.log(`[gestion-pedidos] ${r.creados} nuevos, ${r.actualizados} actualizados`);
        } catch (e) { console.error('[gestion-pedidos] importación incremental falló:', e.message); }
      });
      // Estado de los webhooks de Woo. Cada hora alcanza: no cambian solos salvo que Woo
      // desactive uno tras entregas fallidas, y ahí lo que importa es enterarse, no el minuto
      // exacto. Es una sola llamada, así que no mueve la aguja del consumo.
      cron.schedule('7 * * * *', async () => {           // Woo
        try {
          const { refrescarWebhooksWoo, webhooksWooCaidos } = await import('./lib/wooWebhooks.js');
          const r = await refrescarWebhooksWoo(app._db, wooCfg);
          if (!r.ok) { console.error('[woo-webhooks]', r.error); return; }
          const caidos = webhooksWooCaidos(app._db);
          if (caidos.length) {
            console.error('[woo-webhooks] NO están entregando: '
              + caidos.map((w) => `${w.topic} (${w.status} desde ${w.status_desde})`).join(', '));
          }
        } catch (e) { console.error('[woo-webhooks] error:', e.message); }
      });

      cron.schedule('3-59/10 * * * *', () => {          // ML
        syncMlToWc(app._db, syncCfg)
          .catch(err => console.error('ML→WC error:', err.message));
      });

      // UM1 — Guardia ML: refresco completo de publicaciones cada 15 min. El candado
      // compartido de matcher evita solapamientos; el refresco es fail-closed y no toca
      // publicaciones remotas, solo actualiza el cache local que la Guardia inspecciona.
      // Tick fino: la cadencia real la decide el ramp (`lib/mlScanRamp.js`), no el cron. Empieza
      // en 15 minutos y sólo se relaja cuando el webhook de `items` demuestra que cubre; ante un
      // cambio que ningún webhook anunció, o si la proyección falla, vuelve atrás sola.
      cron.schedule('*/5 * * * *', async () => {
        const { tocaScan, evaluarRamp, medirCoberturaWebhook, proyeccionItemsRota, estadoRamp } =
          await import('./lib/mlScanRamp.js');
        if (!tocaScan(app._db)) return;
        // `dispararRefrescoMl` corre en BACKGROUND y vuelve al instante. Medir la cobertura
        // justo después de lanzarlo compararía un cache que todavía no cambió y reportaría
        // siempre cero sorpresas: el ramp subiría con evidencia falsa. Por eso se mide el
        // refresco ANTERIOR —ya terminado— y recién después se dispara el siguiente.
        if (estadoRefrescoMl()?.running) return;
        const desde = estadoRamp(app._db)?.ultimo_scan_en || null;
        try {
          const cobertura = medirCoberturaWebhook(app._db, desde);
          const paso = evaluarRamp(app._db, {
            cambiosSinAviso: cobertura.cambiosSinAviso,
            proyeccionRota: proyeccionItemsRota(app._db),
          });
          if (paso.accion !== 'sin_cambio') {
            console.log(`[scan-ramp] ${paso.accion} → ${paso.intervalo_min}min/frescura ${paso.frescura_min}min` +
              (paso.motivo ? ` — ${paso.motivo}` : '') + ` | cambios sin aviso: ${cobertura.cambiosSinAviso}/${cobertura.cambios}`);
          }
        } catch (e) { console.error('[scan-ramp] error evaluando cobertura:', e.message); }
        const r = dispararRefrescoMl(app._db, syncCfg.ml, 'all');
        if (!r.ok && !r.running) console.error('Guardia ML: no se pudo iniciar lectura:', r.error);
      });
      cron.schedule('*/5 * * * *', () => {
        procesarOperacionesGuardia(app._db, syncCfg)
          .catch(err => console.error('Guardia ML operaciones:', err.message))
          // A continuación: un vincular confirmado en esta misma corrida ya libera la venta.
          .finally(() => {
            try {
              const r = liberarRetenidasResueltas(app._db);
              if (r.liberadas) console.log(`Guardia ML: ${r.liberadas} venta(s) retenida(s) liberada(s) al resolverse su bloqueo`);
            } catch (err) { console.error('Guardia ML liberación automática:', err.message); }
          });
      });

      // UM1 — único ejecutor de la saga remota de identidad. Fail-closed: si
      // `identidad_config` no está en `enforced` con escrituras habilitadas, no hace nada.
      // Respeta además el canario designado y el tope de lote, para que habilitar el modo no
      // largue de una todas las operaciones ya encoladas (cada una pone el stock en 0 antes
      // de escribir el SKU).
      // Cada minuto: la saga son ~8 pasos y con 5 minutos entre pasos una publicación pasaba
      // ~30 minutos en stock 0. A 1 minuto esa ventana baja a ~8. El solapamiento entre
      // corridas lo corta el filtro de `claim_hasta` del worker, no la frecuencia del cron.
      cron.schedule('* * * * *', () => {
        procesarOperacionesIdentidad(app._db, adaptadorMlIdentidad(app._db, syncCfg.ml))
          .then((r) => {
            if (r?.procesadas) console.log(`identidad: ${r.procesadas} operación(es)${r.canario ? ` [canario ${r.canario}]` : ''}`);
          })
          .catch(err => console.error('identidad operaciones:', err.message));
      });

      cron.schedule('2-59/10 * * * *', () => {          // ML
        syncWcToMl(app._db, syncCfg)
          .catch(err => console.error('WC→ML error:', err.message));
      });

      cron.schedule('4-59/10 * * * *', () => {          // ML
        procesarReintentos(app._db, syncCfg)
          .catch(err => console.error('reintentos error:', err.message));
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

      // Red de seguridad de la auditoría de precios: sólo deriva filas que cambió alguno de
      // sus orígenes o que quedaron pendientes. No hace multiget /items ni se superpone.
      cron.schedule('12-59/15 * * * *', () => {
        dispararAuditoriaPrecios(app._db, { origen: 'cron', mlCfg: syncCfg.ml });
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

      // Vigía del backup a B2 (Gate 0): backup.sh corre por cron del sistema a las 06:00 UTC.
      cron.schedule('17 * * * *', () => { revisarBackupNube(app._db); });
      // Vigía de PostgreSQL (E0 nivel 1): archivado de WAL y backup verificado; inactivo hasta desplegarlo.
      cron.schedule('2-59/5 * * * *', () => { revisarBackupPostgres(app._db); });

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
        barridoAuditoria(app._db, mlCfg)
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
      // Red de reconciliación de preguntas: el webhook es la vía rápida, esto la red. ML no
      // garantiza entrega, y medido el 2026-09-06 faltaban 6 de 10 preguntas sin responder
      // —algunas de marzo— que ningún aviso trajo. Una sola llamada por corrida: se piden
      // únicamente las UNANSWERED, que son las que exigen acción humana.
      // Reloj de escalamiento de la bandeja (§14). Corre cada minuto porque la política más
      // corta repite a los 2: con una vuelta más lenta, "urgente" dejaría de serlo. Vive en
      // el VPS y no en la app a propósito: un teléfono apagado no puede ser responsable de
      // que una alerta urgente escale.
      cron.schedule('* * * * *', async () => {
        const { procesarEscalamiento } = await import('./lib/workerEscalamiento.js');
        procesarEscalamiento(app._db)
          .catch(err => console.error('Error en el escalamiento de la bandeja:', err.message));
      });

      // Acciones permitidas de los reclamos abiertos. Se lee de la BÚSQUEDA y no del detalle
      // porque el detalle devuelve la lista vacía para los tres players (§4.3 de la
      // especificación de ML). Sin este barrido `external_actions` quedaría siempre nulo y la
      // app no habilitaría nunca una acción de reclamo. Una sola llamada por corrida cubre
      // todos los reclamos abiertos de la cuenta.
      cron.schedule('17-59/20 * * * *', async () => {
        const { reconciliarAccionesMl } = await import('./lib/reconciliarAccionesMl.js');
        reconciliarAccionesMl(app._db, mlCfg)
          .catch(err => console.error('Error reconciliando acciones de reclamo ML:', err.message));
      });

      cron.schedule('11-59/20 * * * *', async () => {
        const { reconciliarPreguntasMl } = await import('./routes/notificacionesMl.js');
        reconciliarPreguntasMl(app._db, mlCfg)
          .catch(err => console.error('Error reconciliando preguntas ML:', err.message));
      });

      // Misma red para los mensajes post-venta, y acá hace más falta todavía: el camino del
      // webhook nunca funcionó —39 jobs muertos entre el 30/08 y el 05/09— porque el id que
      // manda ML no se puede resolver con credenciales de vendedor. Una llamada a
      // `/messages/unread` por corrida, y sólo se leen los packs que tienen pendientes.
      // Se lee con `mark_as_read=false`: un cron no decide por una persona que ya vio un mensaje.
      cron.schedule('13-59/20 * * * *', async () => {
        const { reconciliarMensajesMl } = await import('./routes/notificacionesMl.js');
        reconciliarMensajesMl(app._db, mlCfg)
          .catch(err => console.error('Error reconciliando mensajes ML:', err.message));
      });

      cron.schedule('*/30 * * * *', () => {
        getAccessToken(app._db, mlCfg)
          .catch(err => console.error('Error renovando token ML (cron dedicado):', err.message));
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
          // UM1: no escribir decisiones desde un cron legacy. La publicación
          // debe ser detectada por Guardia y resuelta con dueño y auditoría.
          const vinculadas = 0;
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

      // Outbox de alertas SMTP: persiste antes de enviar y reintenta fallos sin
      // afectar ningún canal de sincronización.
      cron.schedule('* * * * *', () => {
        procesarAlertasEmailIncidentes(app._db);
      });

      // P1 Claims: entregas durables aisladas del worker legacy de incidentes.
      cron.schedule('*/1 * * * *', () => {
        import('./lib/workerIntegrationNotifications.js').then(({ procesarEntregasPush }) =>
          procesarEntregasPush(app._db)
        ).catch(err => console.error('Error en entregas push de integraciones:', err.message));
      });

      // P1: consumidor durable de integration_jobs. Es independiente del worker push.
      cron.schedule('* * * * *', () => {
        procesarIntegrationJobs(app._db, { mlCfg, wooCfg })
          .catch(err => console.error('Error en jobs de integraciones:', err.message));
      });
    }

    const port = process.env.PORT || 3001;
    // LISTEN_HOST sólo para instancias de prueba aisladas (C9 de E1): escuchar en 127.0.0.1 evita exponer un
    // puerto nuevo a Internet. Sin la variable el comportamiento es el de siempre (todas las interfaces).
    const host = process.env.LISTEN_HOST || undefined;
    app.listen(port, host, () => console.log(`herramientas-app escuchando en ${host || '*'}:${port}`));
  });
}
