import { cargarConfig } from '../comun/config.ts';
import { crearLogger } from '../comun/logger.ts';
import { crearPool } from '../db/pool.ts';
import { iniciarLatidos } from '../comun/latido.ts';
import { alApagar } from '../comun/apagado.ts';
import { tomarExclusion, type ExclusionScheduler } from './exclusion.ts';
import { crearScheduler } from './scheduler.ts';

const config = cargarConfig(process.env);
const logger = crearLogger(config.servicio);
const pool = crearPool(config.pgUrl, { statementTimeoutMs: 5000 });
const detenerLatidos = iniciarLatidos(pool, 'scheduler', config.instancia, config.version, logger, config.heartbeatIntervalMs);
const scheduler = crearScheduler({ db: pool });
let activo = true;
let exclusion: ExclusionScheduler | null = null;

alApagar(logger, async () => {
  activo = false;
  detenerLatidos();
  await exclusion?.soltar();
  await pool.end();
});

async function esperar(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

while (activo) {
  try {
    if (!exclusion?.tieneLock()) {
      exclusion = await tomarExclusion(config.pgUrl, logger, () => undefined);
      if (!exclusion) {
        logger.warn('otro scheduler tiene la exclusión; en espera');
        await esperar(30_000);
        continue;
      }
      logger.info('exclusión del scheduler obtenida');
    }
    const resultado = await scheduler.unaVuelta();
    if (resultado.pendientes || resultado.muertos) logger.info(resultado, 'leases vencidos liberados');
  } catch (error) {
    logger.error({ err: (error as Error).message }, 'vuelta del scheduler falló; reintentando');
  }
  await esperar(30_000);
}
