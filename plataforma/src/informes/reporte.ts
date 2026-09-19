/*
 * src/informes/reporte.ts — el reporte diario de sombra y su semáforo (E1-REC-01).
 *
 * Todas las métricas se calculan sobre la ventana congelada del día calendario ART, `[desde, hasta)`. No se
 * lee `integrations.shadow_daily_summaries`: mide ventanas móviles de 24 h y se sobrescribe, así que no
 * representa un día cerrado y firmarlo no demostraría nada (hallazgo 17 de la revisión externa).
 *
 * El reporte no consulta el reloj: todo sale de la fecha pedida, así que armar dos veces el mismo día da
 * el mismo contenido. Para eso el estado de cada señal se mira como estaba en el CORTE (06:00 ART del día
 * siguiente, `finished_at`), no como está ahora: si se leyera el estado actual, una señal pendiente que se
 * resuelve más tarde volvería verde un día rojo, y rearmar el día para un reintento cambiaría su hash
 * (revisión de la tanda A). El informe sale a las 07:00 ART, después del corte.
 */
import type pg from 'pg';
import { medianocheArt } from './dia.ts';
import { seccionCatalogo, type SeccionCatalogo } from '../catalogo/conciliacion.ts';
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
  /** Días verdes seguidos, terminando en éste. Cero si este día no es verde: la campaña reinicia. */
  dia_campana: number;
  reporte_anterior: string | null;
  /** E2 T1: los casos del catálogo, como estaban en el corte. No interviene en el semáforo. */
  catalogo?: SeccionCatalogo;
}

// Una señal que al cierre del día no terminó bien es un faltante; `excluded` también, salvo que su motivo
// esté entre los explicados.
const MOTIVOS = new Set<string>(MOTIVOS_EXPLICADOS);
/** Horas después del fin del día en que se congela el estado de las señales y los barridos. */
export const HORAS_CORTE = 6;

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
  const corte = new Date(hasta.getTime() + HORAS_CORTE * 3_600_000);
  const topicos: Record<string, ResumenTopico> = {};
  const de = (topic: string) => (topicos[topic] ??= vacio());

  const senales = await pool.query<{ topic: string; status: string; error_detail: string | null; source: string; cerrada: boolean }>(
    `SELECT topic, status, error_detail, source, (finished_at IS NOT NULL AND finished_at <= $3) AS cerrada
       FROM integrations.reconciliation_signals
      WHERE received_at >= $1 AND received_at < $2`,
    [desde, hasta, corte],
  );
  for (const s of senales.rows) {
    const t = de(s.topic);
    if (s.source === 'webhook_copy') t.senales_legado += 1;
    // Lo que no estaba cerrado al corte cuenta como faltante sin explicar, aunque después se haya resuelto.
    if (s.cerrada && s.status === 'succeeded') { t.senales_nucleo += 1; continue; }
    if (s.cerrada && s.status === 'excluded') t.descartadas += 1;
    t.faltantes += 1;
    if (!s.cerrada || !s.error_detail || !MOTIVOS.has(s.error_detail)) t.faltantes_sin_explicar += 1;
  }

  // Cobertura por defecto: resueltas sobre las que debían resolverse. Un faltante explicado (recurso borrado,
  // fuera de ventana...) no tenía nada que resolver, así que no cuenta como hueco de cobertura; si contara,
  // un día limpio con un borrado legítimo saldría amarillo. En los tópicos barridos manda el barrido del día.
  for (const t of Object.values(topicos)) {
    const debidas = t.senales_nucleo + t.faltantes_sin_explicar;
    t.cobertura = debidas ? t.senales_nucleo / debidas : 1;
  }
  // Sólo los tópicos sin historial consultable (envíos) se aceptan por convergencia: estado remoto igual al
  // proyectado sobre los recursos barridos. Con varios barridos en el día, manda el PEOR: si uno quedó a medias,
  // otro completo no lo tapa (revisión de la tanda A).
  const barridos = await pool.query<{ topic: string; known_resources: number | null; swept: number | null; converged: number | null }>(
    `SELECT topic, known_resources, swept, converged FROM integrations.sweep_runs
      WHERE started_at >= $1 AND started_at < $2 AND strategy = 'convergence'
        AND status = 'succeeded' AND finished_at IS NOT NULL AND finished_at <= $3
      ORDER BY id`,
    [desde, hasta, corte],
  );
  const conBarrido = new Set<string>();
  for (const b of barridos.rows) {
    const t = de(b.topic);
    const cobertura = b.known_resources ? (b.swept ?? 0) / b.known_resources : 1;
    const convergencia = b.swept ? (b.converged ?? 0) / b.swept : 1;
    t.cobertura = conBarrido.has(b.topic) ? Math.min(t.cobertura, cobertura) : cobertura;
    t.convergencia = conBarrido.has(b.topic) ? Math.min(t.convergencia ?? 1, convergencia) : convergencia;
    conBarrido.add(b.topic);
  }
  // Un tópico de convergencia habilitado que no se barrió en el día no tiene convergencia declarada: sin
  // esto, siete días sin barridos pasaban por una campaña limpia.
  const esperados = await pool.query<{ topic: string }>(
    `SELECT DISTINCT topic FROM integrations.reconciliation_cursors WHERE strategy = 'convergence' AND enabled`,
  );
  const sinDeclarar = esperados.rows.map((r) => r.topic).filter((t) => !conBarrido.has(t)).sort();

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
  for (const topic of sinDeclarar) {
    alertas.push({ nivel: 'media', codigo: 'convergencia_no_declarada', mensaje: 'Sin barrido de convergencia en el día', topic });
  }
  if (opciones.manifiesto && !opciones.manifiesto.cadena.integra) {
    alertas.push({ nivel: 'alta', codigo: 'cadena_rota', mensaje: 'La cadena de auditoría está rota' });
  }
  // Las alertas operativas de la plataforma (barrido vencido, corriente incompatible, 429 sostenidos...)
  // tal como quedaron en el resumen de ese día, que el scheduler deja de reescribir al pasar la medianoche.
  const resumen = await pool.query<{ payload: { alertas?: Array<{ id: string; severidad: string; umbral: string }> } }>(
    `SELECT payload FROM integrations.shadow_daily_summaries WHERE summary_date = $1`, [fecha],
  );
  for (const a of resumen.rows[0]?.payload.alertas ?? []) {
    alertas.push({ nivel: a.severidad === 'alta' ? 'alta' : 'media', codigo: a.id, mensaje: a.umbral });
  }
  const semaforo: Semaforo = alertas.some((a) => a.nivel === 'alta') ? 'rojo'
    : alertas.some((a) => a.nivel === 'media') ? 'amarillo' : 'verde';

  // La campaña cuenta días VERDES seguidos, terminando en éste. El diseño §9 exige cobertura 100 % y
  // convergencia declarada los siete días, así que un amarillo también la reinicia, igual que un rojo o un
  // día sin reporte: un hueco no se puede dar por limpio.
  const previos = await pool.query<{ fecha: string; semaforo: Semaforo | null }>(
    `SELECT to_char(fecha, 'YYYY-MM-DD') AS fecha, semaforo FROM informes.entregas
      WHERE tipo = 'reporte' AND fecha < $1 AND estado_aviso = 'avisado'
      ORDER BY fecha DESC`,
    [fecha],
  );
  let diaCampana = 0;
  if (semaforo === 'verde') {
    diaCampana = 1;
    let esperado = sumarDias(fecha, -1);
    for (const p of previos.rows) {
      if (p.fecha !== esperado || p.semaforo !== 'verde') break;
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
    catalogo: await seccionCatalogo(pool, desde, hasta, corte),
  };
}
