import type pg from 'pg';
import { ErrorLeaseVencido } from '../colas/errores.ts';
import { enTransaccion } from '../db/pool.ts';

export interface CorridaReclamada {
  id: string;
  channelAccountId: string;
  topic: string;
  cursorKind: string;
  strategy: 'enumerable' | 'convergence';
  token: string;
  attempts: number;
  maxAttempts: number;
  cursorBefore: Record<string, unknown> | null;
  cursorVersion: number;
  correlationId: string;
  workerId: string;
}

export async function materializarCorridas(pool: pg.Pool, ahora = new Date()): Promise<number> {
  return enTransaccion(pool, async (tx) => {
    const r = await tx.query<{
      channel_account_id: string; topic: string; cursor_kind: string;
      strategy: 'enumerable' | 'convergence'; cursor_value: Record<string, unknown> | null;
      next_run_at: Date; interval_seconds: number;
    }>(
      `SELECT channel_account_id,topic,cursor_kind,strategy,cursor_value,next_run_at,interval_seconds
         FROM integrations.reconciliation_cursors
        WHERE enabled AND next_run_at <= $1
        ORDER BY next_run_at,channel_account_id,topic,cursor_kind FOR UPDATE SKIP LOCKED`,
      [ahora],
    );
    let creadas = 0;
    for (const c of r.rows) {
      const insertada = await tx.query(
        `INSERT INTO integrations.sweep_runs
           (channel_account_id,topic,cursor_kind,strategy,scheduled_for,available_at,cursor_before,correlation_id)
         VALUES ($1,$2,$3,$4,$5,$5,$6,uuidv7())
         ON CONFLICT (channel_account_id,topic,cursor_kind)
           WHERE status IN ('pending','claimed','retryable') DO NOTHING`,
        [c.channel_account_id, c.topic, c.cursor_kind, c.strategy, c.next_run_at, c.cursor_value],
      );
      creadas += insertada.rowCount ?? 0;
      await tx.query(
        `UPDATE integrations.reconciliation_cursors
            SET next_run_at=next_run_at+make_interval(secs=>interval_seconds*
              (floor(extract(epoch FROM ($1::timestamptz-next_run_at))/interval_seconds)::int+1))
          WHERE channel_account_id=$2 AND topic=$3 AND cursor_kind=$4`,
        [ahora, c.channel_account_id, c.topic, c.cursor_kind],
      );
    }
    return creadas;
  });
}

export async function reclamarCorridas(
  pool: pg.Pool, workerId: string, topics: readonly string[], cantidad: number, leaseSegundos = 60,
): Promise<CorridaReclamada[]> {
  if (!topics.length || cantidad < 1) return [];
  const r = await pool.query<{
    id: string; channel_account_id: string; topic: string; cursor_kind: string;
    strategy: 'enumerable' | 'convergence'; lease_token: string; attempts: number;
    max_attempts: number; cursor_before: Record<string, unknown> | null;
    cursor_version: number; correlation_id: string;
  }>(
    `WITH candidatas AS (
       SELECT id FROM integrations.sweep_runs
        WHERE status IN ('pending','retryable') AND available_at<=now() AND topic=ANY($1)
        ORDER BY available_at,id LIMIT $2 FOR UPDATE SKIP LOCKED)
     UPDATE integrations.sweep_runs r
        SET status='claimed',lease_token=uuidv7(),lease_until=now()+make_interval(secs=>$3),
            worker_id=$4,attempts=r.attempts+1
       FROM candidatas c,integrations.reconciliation_cursors rc
      WHERE r.id=c.id AND rc.channel_account_id=r.channel_account_id
        AND rc.topic=r.topic AND rc.cursor_kind=r.cursor_kind AND rc.enabled
     RETURNING r.id,r.channel_account_id,r.topic,r.cursor_kind,r.strategy,r.lease_token,
       r.attempts,r.max_attempts,r.cursor_before,rc.version AS cursor_version,r.correlation_id`,
    [topics, cantidad, leaseSegundos, workerId],
  );
  return r.rows.map((f) => ({
    id: f.id, channelAccountId: f.channel_account_id, topic: f.topic, cursorKind: f.cursor_kind,
    strategy: f.strategy, token: f.lease_token, attempts: f.attempts, maxAttempts: f.max_attempts,
    cursorBefore: f.cursor_before, cursorVersion: f.cursor_version,
    correlationId: f.correlation_id, workerId,
  }));
}

const LEASE_VIGENTE = `id=$1 AND status='claimed' AND lease_token=$2 AND worker_id=$3 AND lease_until>now()`;

export async function renovarLeaseCorrida(pool: pg.Pool, corrida: CorridaReclamada, leaseSegundos = 60): Promise<void> {
  const r = await pool.query(
    `UPDATE integrations.sweep_runs SET lease_until=now()+make_interval(secs=>$4) WHERE ${LEASE_VIGENTE}`,
    [corrida.id, corrida.token, corrida.workerId, leaseSegundos],
  );
  if (r.rowCount !== 1) throw new ErrorLeaseVencido(`lease vencido o ajeno para sweep#${corrida.id}`);
}

export async function completarCorrida(
  pool: pg.Pool, corrida: CorridaReclamada, cursorAfter: Record<string, unknown>,
  antesDeCerrar?: (tx: pg.PoolClient) => Promise<void>,
): Promise<'succeeded' | 'partial'> {
  return enTransaccion(pool, async (tx) => {
    const run = await tx.query(
      `SELECT 1 FROM integrations.sweep_runs WHERE ${LEASE_VIGENTE} FOR UPDATE`,
      [corrida.id, corrida.token, corrida.workerId],
    );
    if (run.rowCount !== 1) throw new ErrorLeaseVencido(`lease vencido o ajeno para sweep#${corrida.id}`);
    const cursor = await tx.query(
      `UPDATE integrations.reconciliation_cursors SET cursor_value=$1,last_success_at=now(),version=version+1
        WHERE channel_account_id=$2 AND topic=$3 AND cursor_kind=$4 AND version=$5`,
      [cursorAfter, corrida.channelAccountId, corrida.topic, corrida.cursorKind, corrida.cursorVersion],
    );
    const estado = cursor.rowCount === 1 ? 'succeeded' : 'partial';
    if (estado === 'succeeded') await antesDeCerrar?.(tx);
    await tx.query(
      `UPDATE integrations.sweep_runs SET status=$2,finished_at=now(),cursor_after=$3,
       lease_token=NULL,lease_until=NULL,worker_id=NULL WHERE id=$1`,
      [corrida.id, estado, cursorAfter],
    );
    return estado;
  });
}

export function demoraReintentoSegundos(intento: number, azar: () => number = Math.random, retryAfter?: number): number {
  if (retryAfter !== undefined && Number.isFinite(retryAfter) && retryAfter >= 0) return Math.min(300, Math.ceil(retryAfter));
  const base = Math.min(900, 30 * 2 ** Math.max(0, intento - 1));
  return Math.max(1, Math.round(base * (0.8 + 0.4 * azar())));
}

export async function fallarCorrida(
  pool: pg.Pool, corrida: CorridaReclamada, errorCode: string,
  retryAfter?: number, azar: () => number = Math.random, reintentable = true,
): Promise<'retryable' | 'failed'> {
  const estado = reintentable && corrida.attempts < corrida.maxAttempts ? 'retryable' : 'failed';
  const demora = demoraReintentoSegundos(corrida.attempts, azar, retryAfter);
  const r = await pool.query(
    `UPDATE integrations.sweep_runs SET status=$4,
       finished_at=CASE WHEN $4='failed' THEN now() ELSE NULL END,
       available_at=CASE WHEN $4='retryable' THEN now()+make_interval(secs=>$5) ELSE available_at END,
       error_detail=$6,lease_token=NULL,lease_until=NULL,worker_id=NULL
     WHERE ${LEASE_VIGENTE}`,
    [corrida.id, corrida.token, corrida.workerId, estado, demora, errorCode.slice(0, 200)],
  );
  if (r.rowCount !== 1) throw new ErrorLeaseVencido(`lease vencido o ajeno para sweep#${corrida.id}`);
  return estado;
}

export async function soltarCorridaPorApagado(pool: pg.Pool, corrida: CorridaReclamada): Promise<void> {
  await pool.query(
    `UPDATE integrations.sweep_runs SET status='pending',lease_token=NULL,lease_until=NULL,
     worker_id=NULL,attempts=greatest(attempts-1,0)
     WHERE id=$1 AND status='claimed' AND lease_token=$2 AND worker_id=$3`,
    [corrida.id, corrida.token, corrida.workerId],
  );
}

export async function liberarCorridasVencidas(pool: pg.Pool): Promise<{ pendientes: number; fallidas: number }> {
  const r = await pool.query<{ status: 'pending' | 'failed' }>(
    `UPDATE integrations.sweep_runs SET
       status=CASE WHEN attempts>=max_attempts THEN 'failed' ELSE 'pending' END,
       finished_at=CASE WHEN attempts>=max_attempts THEN now() ELSE NULL END,
       lease_token=NULL,lease_until=NULL,worker_id=NULL
     WHERE status='claimed' AND lease_until<=now() RETURNING status`,
  );
  return {
    pendientes: r.rows.filter((f) => f.status === 'pending').length,
    fallidas: r.rows.filter((f) => f.status === 'failed').length,
  };
}
