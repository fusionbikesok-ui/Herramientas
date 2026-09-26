import { planDeKeyrings } from '../catalogo/arranque.ts';
import { crearBootstrap, prepararBootstrap, type CuentaBootstrap } from '../catalogo/bootstrap.ts';
import { crearProyector } from '../catalogo/proyector.ts';
import { iniciarCicloBootstrap, iniciarCicloCatalogo } from './catalogo.ts';
import { iniciarCicloIdentidad } from './identidad.ts';
import { cargarConfig } from '../comun/config.ts';
import { crearLogger } from '../comun/logger.ts';
import { crearPool } from '../db/pool.ts';
import { iniciarLatidos } from '../comun/latido.ts';
import { alApagar } from '../comun/apagado.ts';
import { crearAdaptadoresMl } from '../reconciliacion/adaptadores/ml.ts';
import { crearAdaptadoresWoo } from '../reconciliacion/adaptadores/woo.ts';
import { crearClienteCanal } from '../reconciliacion/cliente-http.ts';
import { crearProcesadorMotor } from '../reconciliacion/motor.ts';
import { cargarKeyring } from '../seguridad/keyring.ts';
import { cargarRegistro, validarRegistroContraBase } from '../reconciliacion/registro.ts';
import { crearTransporteGateway } from '../reconciliacion/transporte-gateway.ts';
import { claveCorrienteCuenta } from '../reconciliacion/tipos.ts';
import { crearWorkerBarridos, type ProcesadorBarrido } from './barridos.ts';
import { crearRelectoresMl, crearRelectoresWoo, type Relector } from '../reconciliacion/relectura.ts';
import { claveRelector, crearWorkerSenales } from './senales.ts';
import { enumerarMissedFeeds } from '../reconciliacion/missed-feeds.ts';
import type { TransporteCanal } from '../reconciliacion/cliente-http.ts';

const config = cargarConfig(process.env);
const logger = crearLogger(config.servicio);
const pool = crearPool(config.pgUrl, { statementTimeoutMs: 5000 });
const detenerLatidos = iniciarLatidos(pool, 'worker', config.instancia, config.version, logger, config.heartbeatIntervalMs);

// Sin configuración de barridos el worker no registra procesadores y por lo tanto no reclama corridas.
let procesadores: Record<string, ProcesadorBarrido> = {};
const relectores: Record<string, Relector> = {};
const cuentasMissedFeeds: Array<{ id: string; sellerId: string; transporte: TransporteCanal }> = [];
// Las cuentas que el bootstrap del catálogo lee, con el mismo transporte que usan los barridos.
const cuentasBootstrap: CuentaBootstrap[] = [];
// El plan decide qué keyrings cargar. Antes el de sobres salía de dentro de `if (config.barridos)`, así que
// el catálogo no podía encenderse sin barridos: al revés del orden de puesta en producción.
const plan = planDeKeyrings(config.barridos, config.catalogo);
const keyrings = new Map(plan.archivos.map((archivo) => [archivo, cargarKeyring(archivo)]));
const keyringSobres = plan.sobresFile ? keyrings.get(plan.sobresFile)! : null;
const keyringCatalogo = plan.catalogoFile ? keyrings.get(plan.catalogoFile)! : null;
if (config.barridos) {
  const keyring = keyringSobres!;
  const cuentas = cargarRegistro(config.barridos.registroFile);
  // Un registro que no coincide con la base frena el arranque: es preferible un worker caído y visible
  // en /health a observaciones de un canal escritas bajo la cuenta de otro.
  await validarRegistroContraBase(pool, cuentas);
  const usaGateway = cuentas.some((c) => c.transporte === 'gateway');
  if (usaGateway && !config.barridos.gatewayKeyringFile) throw new Error('el registro usa el gateway y falta BARRIDOS_GATEWAY_KEYRING_FILE');
  // El HMAC del plano de control no comparte claves con el cifrado de sobres.
  const keyringGateway = usaGateway ? cargarKeyring(config.barridos.gatewayKeyringFile!) : null;
  for (const cuenta of cuentas) {
    // Un transporte por (cuenta, consumidor) (E1 T5 §2.8, decisión de José opción b): E2/E3 no comparten
    // cupo con E1, así que el bootstrap del catálogo (E2) usa una instancia propia marcada 'catalogo', y
    // los barridos/relectores C6/missed_feeds de E1 usan la de siempre (consumidor 'e1', el default).
    const transporte = cuenta.transporte === 'gateway'
      ? crearTransporteGateway({ url: cuenta.base_url, keyring: keyringGateway!, ...(cuenta.channel === 'mercadolibre' ? { sellerId: cuenta.seller_id } : {}) })
      : crearClienteCanal({ baseUrl: cuenta.base_url });
    const transporteBootstrap = cuenta.transporte === 'gateway'
      ? crearTransporteGateway({ url: cuenta.base_url, keyring: keyringGateway!, consumidor: 'catalogo', ...(cuenta.channel === 'mercadolibre' ? { sellerId: cuenta.seller_id } : {}) })
      : transporte;
    const adaptadores = cuenta.channel === 'mercadolibre'
      ? crearAdaptadoresMl({ transporte, db: pool, sellerId: cuenta.seller_id })
      : crearAdaptadoresWoo({ transporte });
    // Relectura puntual por señal (C6) con el mismo transporte de la cuenta: son E1, no E3.
    const propios = cuenta.channel === 'mercadolibre' ? crearRelectoresMl({ transporte }) : crearRelectoresWoo({ transporte });
    if (cuenta.channel === 'mercadolibre') cuentasMissedFeeds.push({ id: cuenta.id, sellerId: cuenta.seller_id, transporte });
    cuentasBootstrap.push(cuenta.channel === 'mercadolibre'
      ? { id: cuenta.id, topic: 'ml.items', transporte: transporteBootstrap, sellerId: cuenta.seller_id }
      : { id: cuenta.id, topic: 'woo.products', transporte: transporteBootstrap });
    for (const relector of Object.values(propios)) relectores[claveRelector(cuenta.id, relector.topic)] = relector;
    for (const adaptador of Object.values(adaptadores)) {
      const motor = crearProcesadorMotor({ db: pool, adaptador, keyring });
      const clave = claveCorrienteCuenta(cuenta.id, adaptador.topic, adaptador.cursorKind);
      // Redundante con el reclamo filtrado por cuenta; barato y deja el invariante explícito.
      procesadores[clave] = (async (corrida) => {
        if (corrida.channelAccountId !== cuenta.id) throw new Error('corrida de otra cuenta de canal');
        return motor(corrida);
      }) satisfies ProcesadorBarrido;
    }
  }
  logger.info({ cuentas: cuentas.length, corrientes: Object.keys(procesadores).length }, 'adaptadores de barrido registrados');
} else {
  logger.warn('sin configuración de barridos: el worker no reclama corridas');
}

// El proyector del catálogo (E2 T1) tiene su propio ciclo: lee lo que el inbox ya tiene, no llama al canal,
// así que no compite por el cupo del gateway con barridos y señales. El bootstrap llega en la tarea 12.
const cicloCatalogo = config.catalogo?.proyector && keyringCatalogo
  ? iniciarCicloCatalogo(crearProyector({
      pool, keyring: keyringCatalogo, lote: config.catalogo.lote, canario: config.catalogo.canario,
      umbralErrorPorciento: config.catalogo.umbralErrorPorciento,
      compararAtributos: config.catalogo.compararAtributos, bandeja: config.bandeja, flagsAutoSku: config.flagsAutoSku, log: logger,
    }), config.catalogo.pausaMs, logger)
  : null;
// El bootstrap necesita los transportes de las cuentas, que salen de la configuración de barridos.
let cicloBootstrap: ReturnType<typeof iniciarCicloBootstrap> | null = null;
if (config.catalogo?.bootstrap && keyringCatalogo) {
  if (!cuentasBootstrap.length) {
    logger.error({}, 'el bootstrap del catálogo está encendido pero no hay cuentas de barridos configuradas: no arranca');
  } else {
    for (const c of cuentasBootstrap) await prepararBootstrap(pool, c.id, c.topic);
    cicloBootstrap = iniciarCicloBootstrap(crearBootstrap({
      pool, keyring: keyringCatalogo, rpm: config.catalogo.bootstrapRpm, cedeSenales: config.catalogo.bootstrapCedeSenales,
      workerId: config.instancia,
    }), cuentasBootstrap, config.catalogo.pausaMs, logger);
    logger.info({ cuentas: cuentasBootstrap.length, rpm: config.catalogo.bootstrapRpm }, 'bootstrap del catálogo encendido');
  }
}
if (cicloCatalogo) {
  logger.info({ lote: config.catalogo!.lote, canario: config.catalogo!.canario, pausaMs: config.catalogo!.pausaMs },
    'proyector del catálogo encendido');
}

// El motor en sombra (E3 T4) tiene su propio ciclo, igual de independiente que el del proyector: no
// llama al canal, sólo lee lo que el proyector de E2 ya escribió (product_models, model_attributes).
// cargarConfig ya exigió CATALOGO_PROYECTOR=1 si motor está encendido, así que acá alcanza con mirar el flag.
const cicloIdentidad = config.motor ? iniciarCicloIdentidad(pool, config.motorPausaMs, logger) : null;
if (cicloIdentidad) logger.info({ pausaMs: config.motorPausaMs }, 'motor de identidad en sombra encendido');

const barridos = crearWorkerBarridos({ db: pool, workerId: config.instancia, procesadores });
const senales = keyringSobres ? crearWorkerSenales({ db: pool, workerId: config.instancia, keyring: keyringSobres, relectores }) : null;
let enVuelta = false;
const vuelta = setInterval(() => {
  // Una vuelta a la vez: señales después de barridos, para no competir por el mismo presupuesto remoto.
  if (enVuelta) return;
  enVuelta = true;
  void (async () => {
    await barridos.unaVuelta().catch((error) => { logger.error({ err: (error as Error).message }, 'vuelta de barridos falló'); });
    await senales?.unaVuelta().catch((error) => { logger.error({ err: (error as Error).message }, 'vuelta de señales falló'); });
  })().finally(() => { enVuelta = false; });
}, 1_000);
// missed_feeds cada 30 minutos por cuenta ML (C7). El lock consultivo evita que dos workers enumeren a la vez;
// aun sin él, la deduplicación por notificación haría inocua la repetición, pero gastaría presupuesto.
const MISSED_FEEDS_MS = 30 * 60 * 1000;
async function rondaMissedFeeds(): Promise<void> {
  for (const c of cuentasMissedFeeds) {
    const cliente = await pool.connect();
    try {
      const lock = await cliente.query<{ ok: boolean }>("SELECT pg_try_advisory_lock(hashtextextended('missed_feeds:' || $1, 0)) ok", [c.id]);
      if (!lock.rows[0]?.ok) continue;
      try {
        const cobertura = await enumerarMissedFeeds({ db: pool, transporte: c.transporte, channelAccountId: c.id, sellerId: c.sellerId });
        logger.info({ cuenta: c.id, cobertura }, 'missed_feeds enumerado');
      } finally {
        await cliente.query("SELECT pg_advisory_unlock(hashtextextended('missed_feeds:' || $1, 0))", [c.id]);
      }
    } catch (error) {
      logger.error({ cuenta: c.id, err: (error as Error).message }, 'missed_feeds falló');
    } finally {
      cliente.release();
    }
  }
}
const vueltaMissedFeeds = cuentasMissedFeeds.length ? setInterval(() => { void rondaMissedFeeds(); }, MISSED_FEEDS_MS) : null;

alApagar(logger, async () => {
  clearInterval(vuelta);
  if (vueltaMissedFeeds) clearInterval(vueltaMissedFeeds);
  detenerLatidos();
  senales?.detener();
  await cicloCatalogo?.detener();
  await cicloBootstrap?.detener();
  await cicloIdentidad?.detener();
  await barridos.detener();
  await pool.end();
});
