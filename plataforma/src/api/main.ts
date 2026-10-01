import { crearLogger } from '../comun/logger.ts';
import { cargarConfig } from '../comun/config.ts';
import { crearPool } from '../db/pool.ts';
import { iniciarLatidos } from '../comun/latido.ts';
import { alApagar } from '../comun/apagado.ts';
import { crearApi } from './app.ts';
import { cargarKeyring } from '../seguridad/keyring.ts';
import { crearOrigenes } from '../seguridad/interna.ts';
import { cargarRegistro, contrastarCuentas } from '../reconciliacion/registro.ts';

const config = cargarConfig(process.env);
const logger = crearLogger(config.servicio);
const pool = crearPool(config.pgUrl, { statementTimeoutMs: 5000 });
const detenerLatidos = iniciarLatidos(pool, 'api', config.instancia, config.version, logger, config.heartbeatIntervalMs);
const senales = config.senales
  ? { keyring: cargarKeyring(config.senales.keyringFile), origenes: crearOrigenes(config.senales.origenes), cuentas: config.senales.cuentas }
  : undefined;
// Las cuentas que acepta la API tienen que ser las mismas que consume el worker. El 2026-09-17 faltaba la de ML
// y se rechazaron todas sus señales durante cinco horas sin que nadie lo notara: mejor no arrancar.
if (senales) {
  // Variable propia de la API: `BARRIDOS_REGISTRO_FILE` activa en `cargarConfig` la configuración completa de
  // barridos, que exige su keyring, y la API no arrancaba (verificado en producción el 2026-09-18).
  const registroFile = process.env.SENALES_REGISTRO_FILE;
  if (registroFile) {
    const diferencias = contrastarCuentas(senales.cuentas, cargarRegistro(registroFile));
    if (diferencias.length) {
      logger.fatal({ diferencias }, 'SENALES_CUENTAS y el registro del worker no coinciden: la API no arranca');
      throw new Error(`SENALES_CUENTAS y el registro del worker no coinciden: ${diferencias.join('; ')}`);
    }
  } else {
    logger.warn('sin SENALES_REGISTRO_FILE: no se puede comprobar que SENALES_CUENTAS coincida con el registro del worker');
  }
}
const app = crearApi({
  pool, logger, estadoPgDir: config.estadoPgDir, heartbeatMaxS: config.heartbeatMaxS,
  bandejaCatalogo: config.bandeja, flagsAutoSku: config.flagsAutoSku, ...(senales ? { senales } : {}),
});
alApagar(logger, async () => { detenerLatidos(); await app.close(); await pool.end(); });
await app.listen({ host: '0.0.0.0', port: config.apiPuerto });
