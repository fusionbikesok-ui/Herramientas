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

const config = cargarConfig(process.env);
const logger = crearLogger(config.servicio);
const pool = crearPool(config.pgUrl, { statementTimeoutMs: 5000 });
const detenerLatidos = iniciarLatidos(pool, 'worker', config.instancia, config.version, logger, config.heartbeatIntervalMs);

// Sin configuración de barridos el worker no registra procesadores y por lo tanto no reclama corridas.
let procesadores: Record<string, ProcesadorBarrido> = {};
if (config.barridos) {
  const keyring = cargarKeyring(config.barridos.keyringFile);
  const cuentas = cargarRegistro(config.barridos.registroFile);
  // Un registro que no coincide con la base frena el arranque: es preferible un worker caído y visible
  // en /health a observaciones de un canal escritas bajo la cuenta de otro.
  await validarRegistroContraBase(pool, cuentas);
  const usaGateway = cuentas.some((c) => c.transporte === 'gateway');
  if (usaGateway && !config.barridos.gatewayKeyringFile) throw new Error('el registro usa el gateway y falta BARRIDOS_GATEWAY_KEYRING_FILE');
  // El HMAC del plano de control no comparte claves con el cifrado de sobres.
  const keyringGateway = usaGateway ? cargarKeyring(config.barridos.gatewayKeyringFile!) : null;
  for (const cuenta of cuentas) {
    // Un transporte por cuenta: cada una tiene su URL y, en directo, su semáforo de concurrencia.
    const transporte = cuenta.transporte === 'gateway'
      ? crearTransporteGateway({ url: cuenta.base_url, keyring: keyringGateway!, ...(cuenta.channel === 'mercadolibre' ? { sellerId: cuenta.seller_id } : {}) })
      : crearClienteCanal({ baseUrl: cuenta.base_url });
    const adaptadores = cuenta.channel === 'mercadolibre'
      ? crearAdaptadoresMl({ transporte, db: pool, sellerId: cuenta.seller_id })
      : crearAdaptadoresWoo({ transporte });
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

const barridos = crearWorkerBarridos({ db: pool, workerId: config.instancia, procesadores });
const vuelta = setInterval(() => { void barridos.unaVuelta().catch((error) => {
  logger.error({ err: (error as Error).message }, 'vuelta de barridos falló');
}); }, 1_000);
alApagar(logger, async () => {
  clearInterval(vuelta);
  detenerLatidos();
  await barridos.detener();
  await pool.end();
});
