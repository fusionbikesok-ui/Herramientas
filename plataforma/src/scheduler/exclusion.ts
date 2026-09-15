import pg from 'pg';
import type pino from 'pino';

export interface ExclusionScheduler {
  tieneLock(): boolean;
  soltar(): Promise<void>;
}

const LOCK = "hashtextextended('plataforma.scheduler', 0)";

/**
 * Obtiene la exclusión de sesión del scheduler. No usa el pool: un advisory
 * lock de sesión sólo conserva su semántica mientras viva esta conexión.
 */
export async function tomarExclusion(
  url: string,
  logger: pino.Logger,
  alPerder: () => void,
): Promise<ExclusionScheduler | null> {
  const cliente = new pg.Client({ connectionString: url, application_name: 'plataforma-scheduler-lock' });
  await cliente.connect();
  const resultado = await cliente.query<{ ok: boolean }>(`SELECT pg_try_advisory_lock(${LOCK}) AS ok`);
  if (!resultado.rows[0]?.ok) {
    await cliente.end();
    return null;
  }

  let vigente = true;
  const perder = (motivo: string) => {
    if (!vigente) return;
    vigente = false;
    logger.error({ motivo }, 'se perdió la exclusión del scheduler');
    alPerder();
  };
  cliente.on('error', (error) => perder(error.message));
  cliente.on('end', () => perder('conexión cerrada'));

  return {
    tieneLock: () => vigente,
    async soltar(): Promise<void> {
      if (!vigente) return;
      vigente = false;
      await cliente.query(`SELECT pg_advisory_unlock(${LOCK})`).catch(() => undefined);
      await cliente.end().catch(() => undefined);
    },
  };
}
