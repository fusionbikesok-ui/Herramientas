import type pg from 'pg';
import type { Consultable } from '../db/pool.ts';

/** Señal reclamada con lease (E1 T3 C6). */
export interface SenalReclamada {
  id: string;
  channelAccountId: string;
  topic: string;
  resourceId: string;
  source: 'webhook_copy' | 'ml_missed_feed';
  token: string;
  workerId: string;
  attempts: number;
  maxAttempts: number;
  correlationId: string;
}

export interface ObjetivoSenal { channelAccountId: string; topic: string }

const LEASE_VIGENTE = `id=$1 AND status='claimed' AND lease_token=$2 AND worker_id=$3 AND lease_until>now()`;
const BACKOFF_BASE_S = 10;
const BACKOFF_MAX_S = 900;

/** Reclama señales sólo de las cuentas y tópicos que el worker sabe releer. */
export async function reclamarSenales(
  pool: pg.Pool, workerId: string, objetivos: readonly ObjetivoSenal[], cantidad: number, leaseSegundos = 60,
): Promise<SenalReclamada[]> {
  if (!objetivos.length || cantidad < 1) return [];
  const r = await pool.query<{
    id: string; channel_account_id: string; topic: string; resource_id: string; source: SenalReclamada['source'];
    lease_token: string; attempts: number; max_attempts: number; correlation_id: string;
  }>(
    `WITH objetivos AS (SELECT * FROM unnest($1::uuid[],$2::text[]) AS o(channel_account_id,topic)),
       candidatas AS (
       SELECT s.id FROM integrations.reconciliation_signals s JOIN objetivos o
              ON o.channel_account_id=s.channel_account_id AND o.topic=s.topic
        WHERE s.status IN ('pending','retryable') AND s.available_at<=now()
        ORDER BY s.available_at,s.id LIMIT $3 FOR UPDATE OF s SKIP LOCKED)
     UPDATE integrations.reconciliation_signals s
        SET status='claimed',lease_token=uuidv7(),lease_until=now()+make_interval(secs=>$4),worker_id=$5,attempts=s.attempts+1
       FROM candidatas c WHERE s.id=c.id
     RETURNING s.id,s.channel_account_id,s.topic,s.resource_id,s.source,s.lease_token,s.attempts,s.max_attempts,s.correlation_id`,
    [objetivos.map((o) => o.channelAccountId), objetivos.map((o) => o.topic), cantidad, leaseSegundos, workerId],
  );
  return r.rows.map((f) => ({
    id: f.id, channelAccountId: f.channel_account_id, topic: f.topic, resourceId: f.resource_id, source: f.source,
    token: f.lease_token, workerId, attempts: f.attempts, maxAttempts: f.max_attempts, correlationId: f.correlation_id,
  }));
}

/**
 * Cierra la señal si el lease sigue siendo de este worker. Devuelve false si lo perdió: quien llama
 * dentro de una transacción debe revertir lo que escribió.
 */
export async function cerrarSenal(
  db: Consultable, s: SenalReclamada, estado: 'succeeded' | 'excluded', detalle: string | null = null,
): Promise<boolean> {
  const r = await db.query(
    `UPDATE integrations.reconciliation_signals SET status=$4,error_detail=$5,finished_at=now(),
       lease_token=NULL,lease_until=NULL,worker_id=NULL,deferred_since=NULL
     WHERE ${LEASE_VIGENTE}`,
    [s.id, s.token, s.workerId, estado, detalle],
  );
  return r.rowCount === 1;
}

/**
 * Falla una señal: reintentable con backoff exponencial acotado (o `Retry-After`), o `dead_lettered` si es
 * terminal o agotó intentos. El detalle es un código normalizado, nunca un cuerpo remoto.
 */
export async function fallarSenal(
  db: Consultable, s: SenalReclamada, detalle: string, opciones: { terminal?: boolean; retryAfterS?: number } = {},
): Promise<'retryable' | 'dead_lettered' | 'lease_perdido'> {
  const muerta = opciones.terminal === true || s.attempts >= s.maxAttempts;
  const espera = opciones.retryAfterS ?? Math.min(BACKOFF_MAX_S, BACKOFF_BASE_S * 2 ** Math.max(0, s.attempts - 1));
  const r = await db.query(
    `UPDATE integrations.reconciliation_signals SET
       status=$4,error_detail=$5,
       available_at=CASE WHEN $4='retryable' THEN now()+make_interval(secs=>$6) ELSE available_at END,
       finished_at=CASE WHEN $4='dead_lettered' THEN now() ELSE NULL END,
       lease_token=NULL,lease_until=NULL,worker_id=NULL
     WHERE ${LEASE_VIGENTE}`,
    [s.id, s.token, s.workerId, muerta ? 'dead_lettered' : 'retryable', detalle.slice(0, 200), espera],
  );
  if (r.rowCount !== 1) return 'lease_perdido';
  return muerta ? 'dead_lettered' : 'retryable';
}

/** Tope de edad y código, iguales a los de `corridas.ts` (spec §2.4): mismo criterio para corridas y señales. */
export const CUPO_SOMBRA_DIFERIDO_MAX_MIN_DEFAULT = 30;
export const CODIGO_CUPO_SOMBRA_AGOTADO = 'CUPO_SOMBRA_AGOTADO';

/**
 * Diferimiento por cupo sombra agotado para señales (spec §2.4): hermana de `diferirCorridaPorCupo` en
 * `corridas.ts`. Vuelve a `retryable` (no `dead_lettered`), no consume intento, y usa el `retryAfter` real.
 * `deferred_since` se fija sólo la primera vez y se limpia al agotar el tope de edad (cae a `fallarSenal`
 * con el código `CUPO_SOMBRA_AGOTADO`, consumiendo intento) o al cerrarse con éxito (`cerrarSenal`).
 */
export async function diferirSenalPorCupo(
  db: Consultable, s: SenalReclamada, retryAfterSegundos: number,
  opciones: { maxDiferidoMin?: number } = {},
): Promise<'retryable' | 'dead_lettered' | 'lease_perdido'> {
  const maxMin = opciones.maxDiferidoMin ?? CUPO_SOMBRA_DIFERIDO_MAX_MIN_DEFAULT;
  const estado = await db.query<{ deferred_since: Date | null }>(
    `SELECT deferred_since FROM integrations.reconciliation_signals WHERE ${LEASE_VIGENTE}`,
    [s.id, s.token, s.workerId],
  );
  if (estado.rowCount !== 1) return 'lease_perdido';
  const desde = estado.rows[0]!.deferred_since;
  const agotoElTope = desde !== null && Date.now() - desde.getTime() > maxMin * 60_000;
  if (agotoElTope) {
    await db.query(`UPDATE integrations.reconciliation_signals SET deferred_since=NULL WHERE id=$1`, [s.id]);
    return fallarSenal(db, s, CODIGO_CUPO_SOMBRA_AGOTADO, { retryAfterS: retryAfterSegundos });
  }
  const r = await db.query(
    `UPDATE integrations.reconciliation_signals SET status='retryable',
       available_at=now()+make_interval(secs=>$4),
       deferred_since=COALESCE(deferred_since,now()),
       attempts=greatest(attempts-1,0),lease_token=NULL,lease_until=NULL,worker_id=NULL
     WHERE ${LEASE_VIGENTE}`,
    [s.id, s.token, s.workerId, retryAfterSegundos],
  );
  return r.rowCount === 1 ? 'retryable' : 'lease_perdido';
}
