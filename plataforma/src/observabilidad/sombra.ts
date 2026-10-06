import type pg from 'pg';
import type { Consultable } from '../db/pool.ts';

/**
 * Métricas y alertas de la sombra del lado de la plataforma (E1 T3 §11, corte C8). Las del recibo y la
 * cola viven en el legado (`lib/metricasSombra.js`), porque son las que tienen que sobrevivir a una
 * caída de PostgreSQL. Ninguna métrica lleva PII: sólo conteos, edades y tópicos.
 *
 * Cada alerta declara umbral, responsable y runbook; el SOP (`docs/superpowers/specs/e1/sop-sombra.md`)
 * y el test de cada alerta son la evidencia reproducible que pide el gate.
 */
export interface MetricasPlataforma {
  medido_en: string;
  senales: {
    activas: number; pendientes: number; reintentables: number; reclamadas: number;
    edad_max_activa_s: number;
    ultimas_24h: { resueltas: number; excluidas: number; muertas: number; con_resultado: number; sin_baja: number; barridos_disparados: number };
    reintentos_429_30min: number;
    sin_observacion_24h: number;
  };
  barridos: { vencidos: Array<{ topic: string; cursor_kind: string; atraso_s: number }>; incompatibles: number; fallos_429_30min: number };
}

export interface Alerta {
  id: string;
  severidad: 'alta' | 'media';
  responsable: 'operaciones' | 'desarrollo';
  umbral: string;
  valor: number;
  runbook: string;
}

export const UMBRALES = Object.freeze({
  SENAL_EDAD_MAX_S: 15 * 60,
  RAFAGA_429_30MIN: 10,
});

const numero = (v: unknown): number => Number(v ?? 0);

export async function medirPlataforma(db: Consultable, ahora: Date = new Date()): Promise<MetricasPlataforma> {
  const s = (await db.query<Record<string, string>>(
    `SELECT
       count(*) FILTER (WHERE status IN ('pending','claimed','retryable')) activas,
       count(*) FILTER (WHERE status='pending') pendientes,
       count(*) FILTER (WHERE status='retryable') reintentables,
       count(*) FILTER (WHERE status='claimed') reclamadas,
       coalesce(extract(epoch FROM $1::timestamptz - min(received_at) FILTER (WHERE status IN ('pending','claimed','retryable'))), 0)::bigint edad,
       count(*) FILTER (WHERE status='succeeded' AND finished_at >= $1::timestamptz - interval '24 hours') resueltas,
       count(*) FILTER (WHERE status='excluded' AND finished_at >= $1::timestamptz - interval '24 hours') excluidas,
       count(*) FILTER (WHERE status='dead_lettered' AND finished_at >= $1::timestamptz - interval '24 hours') muertas,
       count(*) FILTER (WHERE status='succeeded' AND error_detail IN ('enqueued','duplicate','stale') AND finished_at >= $1::timestamptz - interval '24 hours') con_resultado,
       count(*) FILTER (WHERE status='succeeded' AND error_detail='not_found:sin_baja' AND finished_at >= $1::timestamptz - interval '24 hours') sin_baja,
       count(*) FILTER (WHERE status='succeeded' AND error_detail='sweep_triggered' AND finished_at >= $1::timestamptz - interval '24 hours') barridos_disparados,
       count(*) FILTER (WHERE error_detail LIKE '%HTTP_429%' AND coalesce(finished_at, available_at) >= $1::timestamptz - interval '30 minutes') r429
     FROM integrations.reconciliation_signals`, [ahora])).rows[0]!;
  // Una señal cerrada "con resultado" tiene que haber dejado observación: si no, el resultado se perdió
  // o la señal se cerró sin explicación.
  const sinObservacion = (await db.query<{ n: string }>(
    `SELECT count(*) n FROM integrations.reconciliation_signals s
      WHERE s.status='succeeded' AND s.error_detail IN ('enqueued','duplicate','stale')
        AND s.finished_at >= $1::timestamptz - interval '24 hours'
        AND NOT EXISTS (SELECT 1 FROM integrations.resource_observations o
          WHERE o.channel_account_id=s.channel_account_id AND o.topic=s.topic AND o.resource_id=s.resource_id)`, [ahora])).rows[0]!.n;
  // Vencido: sin éxito en dos intervalos desde el último éxito o, si nunca tuvo, desde su primera corrida.
  const vencidos = (await db.query<{ topic: string; cursor_kind: string; atraso_s: string }>(
    `SELECT c.topic, c.cursor_kind,
            extract(epoch FROM $1::timestamptz - coalesce(c.last_success_at, r.primera))::bigint - 2 * c.interval_seconds atraso_s
       FROM integrations.reconciliation_cursors c
       LEFT JOIN LATERAL (SELECT min(scheduled_for) primera FROM integrations.sweep_runs s
                           WHERE s.channel_account_id=c.channel_account_id AND s.topic=c.topic AND s.cursor_kind=c.cursor_kind) r ON true
      WHERE c.enabled AND coalesce(c.last_success_at, r.primera) < $1::timestamptz - make_interval(secs => 2 * c.interval_seconds)
      ORDER BY 3 DESC, 1, 2`, [ahora])).rows;
  const incompatibles = (await db.query<{ n: string }>(
    `SELECT count(*) n FROM integrations.reconciliation_cursors c JOIN core.channel_accounts a ON a.id=c.channel_account_id
      WHERE c.enabled AND ((a.channel='mercadolibre' AND c.topic NOT LIKE 'ml.%') OR (a.channel='woocommerce' AND c.topic NOT LIKE 'woo.%'))`)).rows[0]!.n;
  const fallos429 = (await db.query<{ n: string }>(
    `SELECT count(*) n FROM integrations.sweep_runs WHERE error_detail LIKE '%HTTP_429%'
      AND coalesce(finished_at, available_at, started_at) >= $1::timestamptz - interval '30 minutes'`, [ahora])).rows[0]!.n;
  return {
    medido_en: ahora.toISOString(),
    senales: {
      activas: numero(s.activas), pendientes: numero(s.pendientes), reintentables: numero(s.reintentables), reclamadas: numero(s.reclamadas),
      edad_max_activa_s: numero(s.edad),
      ultimas_24h: {
        resueltas: numero(s.resueltas), excluidas: numero(s.excluidas), muertas: numero(s.muertas),
        con_resultado: numero(s.con_resultado), sin_baja: numero(s.sin_baja), barridos_disparados: numero(s.barridos_disparados),
      },
      reintentos_429_30min: numero(s.r429),
      sin_observacion_24h: numero(sinObservacion),
    },
    barridos: {
      vencidos: vencidos.map((v) => ({ topic: v.topic, cursor_kind: v.cursor_kind, atraso_s: numero(v.atraso_s) })),
      incompatibles: numero(incompatibles),
      fallos_429_30min: numero(fallos429),
    },
  };
}

const SOP = 'docs/superpowers/specs/e1/sop-sombra.md';

export function evaluarAlertasPlataforma(m: MetricasPlataforma): Alerta[] {
  const alertas: Alerta[] = [];
  const si = (cond: boolean, a: Alerta) => { if (cond) alertas.push(a); };
  si(m.senales.edad_max_activa_s > UMBRALES.SENAL_EDAD_MAX_S, {
    id: 'senal_vieja', severidad: 'alta', responsable: 'operaciones', umbral: 'señal activa > 15 min',
    valor: m.senales.edad_max_activa_s, runbook: `${SOP}#senal-vieja`,
  });
  si(m.barridos.vencidos.length > 0, {
    id: 'barrido_vencido', severidad: 'alta', responsable: 'operaciones', umbral: 'corriente sin éxito en 2 intervalos',
    valor: m.barridos.vencidos.length, runbook: `${SOP}#barrido-vencido`,
  });
  si(m.barridos.incompatibles > 0, {
    id: 'corriente_incompatible', severidad: 'alta', responsable: 'desarrollo', umbral: 'corriente habilitada de otro canal > 0',
    valor: m.barridos.incompatibles, runbook: `${SOP}#corriente-incompatible`,
  });
  const rafaga = m.senales.reintentos_429_30min + m.barridos.fallos_429_30min;
  si(rafaga >= UMBRALES.RAFAGA_429_30MIN, {
    id: 'http_429_sostenido', severidad: 'media', responsable: 'operaciones', umbral: `≥ ${UMBRALES.RAFAGA_429_30MIN} respuestas 429 en 30 min`,
    valor: rafaga, runbook: `${SOP}#http-429`,
  });
  si(m.senales.sin_observacion_24h > 0, {
    id: 'senal_sin_observacion', severidad: 'alta', responsable: 'desarrollo', umbral: 'señal con resultado sin observación > 0',
    valor: m.senales.sin_observacion_24h, runbook: `${SOP}#senal-sin-observacion`,
  });
  si(m.senales.ultimas_24h.muertas > 0, {
    id: 'senal_dead_letter', severidad: 'media', responsable: 'desarrollo', umbral: 'señal en dead letter en 24 h > 0',
    valor: m.senales.ultimas_24h.muertas, runbook: `${SOP}#senal-dead-letter`,
  });
  return alertas;
}

/** Guarda (o reemplaza) el resumen del día en hora de Argentina. */
export async function guardarResumenDiario(db: Consultable, ahora: Date = new Date()): Promise<string> {
  const m = await medirPlataforma(db, ahora);
  const r = await db.query<{ dia: string }>(
    `INSERT INTO integrations.shadow_daily_summaries(summary_date, payload)
     VALUES ((($1::timestamptz) AT TIME ZONE 'America/Argentina/Buenos_Aires')::date, $2::jsonb)
     ON CONFLICT (summary_date) DO UPDATE SET payload=excluded.payload, generated_at=now()
     RETURNING summary_date::text dia`,
    [ahora, JSON.stringify({ metricas: m, alertas: evaluarAlertasPlataforma(m) })],
  );
  return r.rows[0]!.dia;
}

/** Leases de señales vencidos: vuelven a `retryable` (o `dead_lettered` si agotaron intentos). */
export async function liberarSenalesVencidas(db: pg.Pool): Promise<{ reintentables: number; muertas: number }> {
  const r = await db.query<{ status: string }>(
    `UPDATE integrations.reconciliation_signals SET
       status=CASE WHEN attempts>=max_attempts THEN 'dead_lettered' ELSE 'retryable' END,
       finished_at=CASE WHEN attempts>=max_attempts THEN now() ELSE NULL END,
       error_detail=CASE WHEN attempts>=max_attempts THEN 'lease_vencido' ELSE error_detail END,
       available_at=now(), lease_token=NULL, lease_until=NULL, worker_id=NULL
     WHERE status='claimed' AND lease_until<=now() RETURNING status`,
  );
  return { reintentables: r.rows.filter((f) => f.status === 'retryable').length, muertas: r.rows.filter((f) => f.status === 'dead_lettered').length };
}
