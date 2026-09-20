import type pg from 'pg';

/**
 * Revive señales `dead_lettered` cuyo `error_detail` matchea `causa`, una por recurso (`DISTINCT ON`) y sólo
 * si ese recurso no tiene ya una señal activa: el índice único parcial `reconciliation_signals_un_activa`
 * (pending/claimed/retryable) aborta la transacción entera ante cualquier violación, así que hay que evitarla
 * de antemano en vez de reintentar fila por fila.
 *
 * `available_at` se escalona con `offsetBaseS * posición` para no golpear el canal de una sola vez; el
 * llamador decide el ritmo (ver revivir-senales.mjs, que lo recibe como `--rpm`).
 */
export interface RevivirOpciones {
  causaLike: string;
  /** Si se pasa, sólo revive señales de este tópico (p. ej. 'ml.orders'). Sin él, no filtra por tópico. */
  topic?: string;
  limite: number;
  offsetBaseS: number;
  dryRun: boolean;
}

export interface SenalRevivida {
  id: string;
  channelAccountId: string;
  topic: string;
  resourceId: string;
  attemptsPrevios: number;
}

export async function revivirSenalesMuertas(pool: pg.Pool, opciones: RevivirOpciones): Promise<SenalRevivida[]> {
  const { causaLike, topic, limite, offsetBaseS, dryRun } = opciones;
  // El filtro de tópico es independiente del NOT EXISTS: éste mira si EL RECURSO tiene una señal activa
  // (en su propio tópico, vía `a.topic = s.topic`), no si el subconjunto que se está reviviendo la tiene.
  // Acotar por tópico no vuelve redundante esa protección.
  const params: unknown[] = topic !== undefined ? [causaLike, topic, limite] : [causaLike, limite];
  const candidatas = await pool.query<{
    id: string; channel_account_id: string; topic: string; resource_id: string; attempts: number;
  }>(
    `SELECT DISTINCT ON (s.channel_account_id, s.topic, s.resource_id)
            s.id, s.channel_account_id, s.topic, s.resource_id, s.attempts
       FROM integrations.reconciliation_signals s
      WHERE s.status = 'dead_lettered' AND s.error_detail LIKE $1
        ${topic !== undefined ? 'AND s.topic = $2' : ''}
        AND NOT EXISTS (
              SELECT 1 FROM integrations.reconciliation_signals a
               WHERE a.channel_account_id = s.channel_account_id AND a.topic = s.topic
                 AND a.resource_id = s.resource_id AND a.status IN ('pending','claimed','retryable'))
      ORDER BY s.channel_account_id, s.topic, s.resource_id, s.id
      LIMIT $${topic !== undefined ? 3 : 2}`,
    params,
  );
  const filas = candidatas.rows.map((f) => ({
    id: f.id, channelAccountId: f.channel_account_id, topic: f.topic, resourceId: f.resource_id,
    attemptsPrevios: f.attempts,
  }));
  if (dryRun || filas.length === 0) return filas;

  await pool.query(
    `UPDATE integrations.reconciliation_signals s
        SET status = 'pending', attempts = 0, error_detail = NULL, finished_at = NULL,
            lease_token = NULL, lease_until = NULL, worker_id = NULL,
            available_at = now() + make_interval(secs => c.offset_s)
       FROM (SELECT unnest($1::bigint[]) AS id, unnest($2::int[]) AS offset_s) c
      WHERE s.id = c.id`,
    [filas.map((f) => f.id), filas.map((_, i) => i * offsetBaseS)],
  );
  return filas;
}
