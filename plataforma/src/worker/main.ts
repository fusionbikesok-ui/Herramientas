import { cargarConfig } from '../comun/config.ts';
import { crearLogger } from '../comun/logger.ts';
import { crearPool } from '../db/pool.ts';
import { iniciarLatidos } from '../comun/latido.ts';
import { alApagar } from '../comun/apagado.ts';

const config = cargarConfig(process.env);
const logger = crearLogger(config.servicio);
const pool = crearPool(config.pgUrl, { statementTimeoutMs: 5000 });
const detenerLatidos = iniciarLatidos(pool, 'worker', config.instancia, config.version, logger, config.heartbeatIntervalMs);
// El tramo 1 no registra procesadores ni toca canales. Mantiene el servicio observable y listo
// para que el tramo 2 agregue procesadores explícitos, sin reclamar mensajes que no sabe resolver.
const espera = setInterval(() => undefined, 5_000);
alApagar(logger, async () => { clearInterval(espera); detenerLatidos(); await pool.end(); });
