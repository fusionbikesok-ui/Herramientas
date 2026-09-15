import { cargarConfig } from '../comun/config.ts';
import { crearLogger } from '../comun/logger.ts';
import { crearPool } from '../db/pool.ts';
import { iniciarLatidos } from '../comun/latido.ts';
import { alApagar } from '../comun/apagado.ts';
import { crearWorkerBarridos } from './barridos.ts';

const config = cargarConfig(process.env);
const logger = crearLogger(config.servicio);
const pool = crearPool(config.pgUrl, { statementTimeoutMs: 5000 });
const detenerLatidos = iniciarLatidos(pool, 'worker', config.instancia, config.version, logger, config.heartbeatIntervalMs);
// Sin adaptadores registrados no reclama corridas. El corte 4 inyecta sólo tópicos implementados.
const barridos = crearWorkerBarridos({ db: pool, workerId: config.instancia, procesadores: {} });
const vuelta = setInterval(() => { void barridos.unaVuelta().catch((error) => {
  logger.error({ err: (error as Error).message }, 'vuelta de barridos falló');
}); }, 1_000);
alApagar(logger, async () => {
  clearInterval(vuelta);
  detenerLatidos();
  await barridos.detener();
  await pool.end();
});
