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
import { crearWorkerBarridos, type ProcesadorBarrido } from './barridos.ts';

const config = cargarConfig(process.env);
const logger = crearLogger(config.servicio);
const pool = crearPool(config.pgUrl, { statementTimeoutMs: 5000 });
const detenerLatidos = iniciarLatidos(pool, 'worker', config.instancia, config.version, logger, config.heartbeatIntervalMs);

// Sin configuración de barridos el worker no registra procesadores y por lo tanto no reclama corridas.
let procesadores: Record<string, ProcesadorBarrido> = {};
if (config.barridos) {
  const barridos = config.barridos;
  const keyring = cargarKeyring(barridos.keyringFile);
  const adaptadores = {
    ...crearAdaptadoresMl({ transporte: crearClienteCanal({ baseUrl: barridos.mlUrl }), db: pool, sellerId: barridos.mlSeller }),
    ...crearAdaptadoresWoo({ transporte: crearClienteCanal({ baseUrl: barridos.wooUrl }) }),
  };
  procesadores = Object.fromEntries(Object.entries(adaptadores).map(([clave, adaptador]) => {
    const motor = crearProcesadorMotor({ db: pool, adaptador, keyring });
    // El reclamo filtra por corriente, no por cuenta: este worker atiende una sola y lo verifica.
    return [clave, async (corrida) => {
      if (corrida.channelAccountId !== barridos.cuenta) throw new Error('corrida de otra cuenta de canal');
      return motor(corrida);
    }] satisfies [string, ProcesadorBarrido];
  }));
  logger.info({ corrientes: Object.keys(procesadores).sort() }, 'adaptadores de barrido registrados');
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
