/*
 * src/informes/reporte.ts — el reporte diario de sombra y su semáforo (E1-REC-01).
 *
 * Todas las métricas se calculan sobre la ventana congelada del día calendario ART, `[desde, hasta)`. No se
 * lee `integrations.shadow_daily_summaries`: mide ventanas móviles de 24 h y se sobrescribe, así que no
 * representa un día cerrado y firmarlo no demostraría nada (hallazgo 17 de la revisión externa).
 *
 * El reporte no consulta el reloj: todo sale de la fecha pedida, así que armar dos veces el mismo día da
 * el mismo contenido.
 */
import type pg from 'pg';
import { medianocheArt } from './dia.ts';
import type { Manifiesto } from './manifiesto.ts';

/** Las únicas causas que cuentan como explicación: quedaron registradas por el sistema. No hay manual. */
export const MOTIVOS_EXPLICADOS = ['recurso_borrado', 'fuera_de_ventana', 'sin_historial', 'descartada_contada'] as const;

export interface ResumenTopico {
  senales_legado: number;
  senales_nucleo: number;
  faltantes: number;
  faltantes_sin_explicar: number;
  cobertura: number;
  convergencia: number | null;
  descartadas: number;
}

export interface Alerta { nivel: 'baja' | 'media' | 'alta'; codigo: string; mensaje: string; topic?: string }

export type Semaforo = 'verde' | 'amarillo' | 'rojo';

export interface Reporte {
  tipo: 'reporte';
  fecha: string;
  ventana: { desde: string; hasta: string };
  topicos: Record<string, ResumenTopico>;
  faltantes_sin_explicar: number;
  alertas: Alerta[];
  semaforo: Semaforo;
  /** Días seguidos, terminando en éste, que no fueron rojos. Cero si este día es rojo: la campaña reinicia. */
  dia_campana: number;
  reporte_anterior: string | null;
}

// Una señal que al cierre del día no terminó bien es un faltante; `excluded` también, salvo que su motivo
// esté entre los explicados.
const SIN_RESULTADO = new Set(['dead_lettered', 'retryable', 'pending', 'claimed', 'excluded']);
const MOTIVOS = new Set<string>(MOTIVOS_EXPLICADOS);

function vacio(): ResumenTopico {
  return { senales_legado: 0, senales_nucleo: 0, faltantes: 0, faltantes_sin_explicar: 0, cobertura: 1, convergencia: null, descartadas: 0 };
}

function sumarDias(fecha: string, dias: number): string {
  const d = new Date(`${fecha}T12:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

export async function armarReporte(
  pool: pg.Pool, fecha: string, opciones: { manifiesto?: Manifiesto } = {},
): Promise<Reporte> {
  const desde = medianocheArt(fecha);
  const hasta = medianocheArt(sumarDias(fecha, 1));
  const topicos: Record<string, ResumenTopico> = {};
  const de = (topic: string) => (topicos[topic] ??= vacio());

  const senales = await pool.query<{ topic: string; status: string; error_detail: string | null; source: string }>(
    `SELECT topic, status, error_detail, source FROM integrations.reconciliation_signals
      WHERE received_at >= $1 AND received_at < $2`,
    [desde, hasta],
  );
  for (const s of senales.rows) {
    const t = de(s.topic);
    if (s.source === 'webhook_copy') t.senales_legado += 1;
    if (s.status === 'succeeded') t.senales_nucleo += 1;
    if (s.status === 'excluded') t.descartadas += 1;
    if (SIN_RESULTADO.has(s.status)) {
      t.faltantes += 1;
      if (!s.error_detail || !MOTIVOS.has(s.error_detail)) t.faltantes_sin_explicar += 1;
    }
  }

  // Cobertura por defecto: resueltas sobre las que debían resolverse. Un faltante explicado (recurso borrado,
  // fuera de ventana...) no tenía nada que resolver, así que no cuenta como hueco de cobertura; si contara,
  // un día limpio con un borrado legítimo saldría amarillo. En los tópicos barridos manda el barrido del día.
  for (const t of Object.values(topicos)) {
    const debidas = t.senales_nucleo + t.faltantes_sin_explicar;
    t.cobertura = debidas ? t.senales_nucleo / debidas : 1;
  }
  const barridos = await pool.query<{
    topic: string; strategy: string; known_resources: number | null; swept: number | null; converged: number | null;
  }>(
    `SELECT topic, strategy, known_resources, swept, converged FROM integrations.sweep_runs
      WHERE started_at >= $1 AND started_at < $2 AND status = 'succeeded'`,
    [desde, hasta],
  );
  for (const b of barridos.rows) {
    // Sólo los tópicos sin historial consultable (envíos) se aceptan por convergencia: estado remoto igual
    // al proyectado sobre los recursos barridos.
    if (b.strategy !== 'convergence') continue;
    const t = de(b.topic);
    t.cobertura = b.known_resources ? (b.swept ?? 0) / b.known_resources : 1;
    t.convergencia = b.swept ? (b.converged ?? 0) / b.swept : null;
  }

  const faltantesSinExplicar = Object.values(topicos).reduce((n, t) => n + t.faltantes_sin_explicar, 0);
  const alertas: Alerta[] = [];
  if (faltantesSinExplicar) {
    alertas.push({ nivel: 'alta', codigo: 'faltantes_sin_explicar', mensaje: `${faltantesSinExplicar} faltantes sin explicación` });
  }
  for (const [topic, t] of Object.entries(topicos)) {
    if (t.convergencia !== null && t.convergencia < 1) {
      alertas.push({ nivel: 'media', codigo: 'convergencia_incompleta', mensaje: 'Convergencia incompleta', topic });
    }
    if (t.cobertura < 1) alertas.push({ nivel: 'media', codigo: 'cobertura_incompleta', mensaje: 'Cobertura incompleta', topic });
  }
  if (opciones.manifiesto && !opciones.manifiesto.cadena.integra) {
    alertas.push({ nivel: 'alta', codigo: 'cadena_rota', mensaje: 'La cadena de auditoría está rota' });
  }
  const semaforo: Semaforo = alertas.some((a) => a.nivel === 'alta') ? 'rojo'
    : alertas.some((a) => a.nivel === 'media') ? 'amarillo' : 'verde';

  // La campaña cuenta días seguidos que no fueron rojos, terminando en éste. Un rojo la reinicia, y un día
  // sin reporte también: un hueco no se puede dar por limpio (diseño §9).
  const previos = await pool.query<{ fecha: string; semaforo: Semaforo | null }>(
    `SELECT to_char(fecha, 'YYYY-MM-DD') AS fecha, semaforo FROM informes.entregas
      WHERE tipo = 'reporte' AND fecha < $1 AND estado_aviso = 'avisado'
      ORDER BY fecha DESC`,
    [fecha],
  );
  let diaCampana = 0;
  if (semaforo !== 'rojo') {
    diaCampana = 1;
    let esperado = sumarDias(fecha, -1);
    for (const p of previos.rows) {
      if (p.fecha !== esperado || p.semaforo === 'rojo' || p.semaforo === null) break;
      diaCampana += 1;
      esperado = sumarDias(esperado, -1);
    }
  }

  return {
    tipo: 'reporte', fecha,
    ventana: { desde: desde.toISOString(), hasta: hasta.toISOString() },
    topicos, faltantes_sin_explicar: faltantesSinExplicar, alertas, semaforo,
    dia_campana: diaCampana,
    reporte_anterior: previos.rows[0]?.fecha ?? null,
  };
}
