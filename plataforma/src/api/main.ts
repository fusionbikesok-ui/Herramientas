import { crearLogger } from '../comun/logger.ts';
import { cargarConfig } from '../comun/config.ts';
import { crearPool } from '../db/pool.ts';
import { iniciarLatidos } from '../comun/latido.ts';
import { alApagar } from '../comun/apagado.ts';
import { crearApi } from './app.ts';

const config = cargarConfig(process.env);
const logger = crearLogger(config.servicio);
const pool = crearPool(config.pgUrl, { statementTimeoutMs: 5000 });
const detenerLatidos = iniciarLatidos(pool, 'api', config.instancia, config.version, logger, config.heartbeatIntervalMs);
const app = crearApi({ pool, logger, estadoPgDir: config.estadoPgDir, heartbeatMaxS: config.heartbeatMaxS });
alApagar(logger, async () => { detenerLatidos(); await app.close(); await pool.end(); });
await app.listen({ host: '0.0.0.0', port: config.apiPuerto });
