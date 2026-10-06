/*
 * src/informes/entregas.ts — quién tiene derecho a firmar, subir y avisar cada artefacto.
 *
 * La clave primaria por fecha evita dos filas, pero no dos PUT a B2 ni dos emails: entre el efecto y su
 * registro hay una ventana. Cada efecto se reclama con un testigo (`lease`) que se verifica en el UPDATE
 * posterior; si cambió, el proceso viejo se detiene sin escribir (hallazgos 2 y 3 de la revisión externa).
 *
 * `ahora` es obligatorio en las cuatro funciones y no tiene valor por omisión: ni `new Date()` ni el
 * instante del reclamo. Con un default basado en el instante del reclamo, `lease_hasta > ahora` se vuelve
 * `(ahora + leaseMs) > ahora`, siempre verdadero, y un proceso con el permiso vencido de verdad puede seguir
 * escribiendo mientras nadie le reclame la fila (hallazgo crítico de la revisión del 2026-09-17). El
 * orquestador (tarea 10) inyecta el reloj una sola vez, arriba de la pila, y lo pasa a todas.
 */
import { randomUUID } from 'node:crypto';
import type { Consultable } from '../db/pool.ts';

export type TipoEntrega = 'manifiesto' | 'reporte';
export type EstadoDeposito = 'generado' | 'firmado' | 'subido';
export type EstadoAviso = 'pendiente' | 'avisado';
export interface Reclamo { tipo: TipoEntrega; fecha: string; testigo: string; deposito: EstadoDeposito; aviso: EstadoAviso }

/** Cuánto dura el permiso de una entrega. El depósito acota su timeout contra esto: un pedido en vuelo que
 *  sobreviva al permiso deja que otro proceso repita el efecto (una segunda versión inmutable en B2). */
export const LEASE_MS = 10 * 60_000;
const HORAS_INCIDENTE = 24;
const ANTERIOR: Record<Exclude<EstadoDeposito, 'generado'>, EstadoDeposito> = { firmado: 'generado', subido: 'firmado' };
const DATOS_PERMITIDOS = new Set(['kid', 'ruta_pendiente', 'b2_object_key', 'b2_version_id', 'retention_until', 'semaforo']);

export async function reclamar(
  db: Consultable, tipo: TipoEntrega, fecha: string,
  opciones: { hash: string; ahora: Date; leaseMs?: number },
): Promise<Reclamo | null> {
  const { ahora } = opciones;
  const testigo = randomUUID();
  const hasta = new Date(ahora.getTime() + (opciones.leaseMs ?? LEASE_MS));
  const r = await db.query<{ estado_deposito: EstadoDeposito; estado_aviso: EstadoAviso }>(
    `INSERT INTO informes.entregas (tipo, fecha, hash_contenido, testigo, lease_hasta)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (tipo, fecha) DO UPDATE
       SET testigo = $4, lease_hasta = $5
       WHERE informes.entregas.hash_contenido = $3
         AND NOT (informes.entregas.estado_deposito = 'subido' AND informes.entregas.estado_aviso = 'avisado')
         AND (informes.entregas.lease_hasta IS NULL OR informes.entregas.lease_hasta <= $6)
     RETURNING estado_deposito, estado_aviso`,
    [tipo, fecha, opciones.hash, testigo, hasta, ahora],
  );
  const fila = r.rows[0];
  if (fila) return { tipo, fecha, testigo, deposito: fila.estado_deposito, aviso: fila.estado_aviso };
  // Puede haber sido el lease de otro, o un contenido distinto para el mismo día: eso último se anota, porque
  // significa que alguien va a subir algo que no corresponde al sobre ya firmado.
  await db.query(
    `UPDATE informes.entregas SET ultimo_error = 'hash distinto del ya firmado para este día'
      WHERE tipo = $1 AND fecha = $2 AND hash_contenido <> $3`,
    [tipo, fecha, opciones.hash],
  );
  return null;
}

export async function avanzarDeposito(
  db: Consultable, reclamo: Reclamo, estado: Exclude<EstadoDeposito, 'generado'>,
  datos: Record<string, unknown>, ahora: Date,
): Promise<boolean> {
  const extra = Object.keys(datos).filter((k) => DATOS_PERMITIDOS.has(k));
  const columna = estado === 'firmado' ? 'firmado_en' : 'subido_en';
  const valores = [reclamo.tipo, reclamo.fecha, reclamo.testigo, estado, ANTERIOR[estado], ahora, ...extra.map((k) => datos[k])];
  const asignaciones = extra.map((k, i) => `${k} = $${7 + i}`).join(', ');
  const r = await db.query(
    `UPDATE informes.entregas
        SET estado_deposito = $4, ${columna} = $6${asignaciones ? `, ${asignaciones}` : ''}
      WHERE tipo = $1 AND fecha = $2 AND testigo = $3
        AND estado_deposito = $5 AND lease_hasta > $6`,
    valores,
  );
  return (r.rowCount ?? 0) === 1;
}

export async function avanzarAviso(db: Consultable, reclamo: Reclamo, ahora: Date): Promise<boolean> {
  const r = await db.query(
    `UPDATE informes.entregas SET estado_aviso = 'avisado', avisado_en = $4
      WHERE tipo = $1 AND fecha = $2 AND testigo = $3 AND estado_aviso = 'pendiente' AND lease_hasta > $4`,
    [reclamo.tipo, reclamo.fecha, reclamo.testigo, ahora],
  );
  return (r.rowCount ?? 0) === 1;
}

export async function anotarFallo(
  db: Consultable, reclamo: Reclamo, cual: 'deposito' | 'aviso', error: string, ahora: Date,
): Promise<void> {
  const columna = cual === 'deposito' ? 'intentos_deposito' : 'intentos_aviso';
  // También exige el lease vigente: un dueño vencido no sigue contando intentos ni pisando el error de
  // quien haya reclamado la fila después (hallazgo menor de la revisión del 2026-09-17). A diferencia de la
  // primera versión, no libera el lease: el mismo dueño puede seguir reintentando dentro de su ventana.
  // Esto significa que, tras un fallo, el reintento tiene que esperar a que venza el lease vigente (10
  // minutos por omisión) antes de que reclamar() vuelva a admitir esta fila — no hay forma de retomarla
  // antes salvo con el mismo testigo. Es aceptable: reintentar contra un B2 o un SMTP caído a los pocos
  // segundos no sirve de nada. Si la tarea 10 necesita un reintento más ágil que esos 10 minutos, hay que
  // decidirlo explícitamente (por ejemplo, un `leaseMs` de reclamo más corto para el camino de reintento),
  // no asumirlo acá.
  await db.query(
    `UPDATE informes.entregas SET ${columna} = ${columna} + 1, ultimo_error = $4
      WHERE tipo = $1 AND fecha = $2 AND testigo = $3 AND lease_hasta > $5`,
    [reclamo.tipo, reclamo.fecha, reclamo.testigo, error.slice(0, 500), ahora],
  );
}

export async function pendientesVencidas(
  db: Consultable, ahora: Date, horas: number = HORAS_INCIDENTE,
): Promise<Array<{ tipo: string; fecha: string; estado_deposito: string; estado_aviso: string; intentos_deposito: number }>> {
  const r = await db.query<{ tipo: string; fecha: string; estado_deposito: string; estado_aviso: string; intentos_deposito: number }>(
    `SELECT tipo, to_char(fecha, 'YYYY-MM-DD') AS fecha, estado_deposito, estado_aviso, intentos_deposito
       FROM informes.entregas
      WHERE estado_deposito <> 'subido' AND generado_en <= $1::timestamptz - make_interval(hours => $2)
      ORDER BY fecha`,
    [ahora, horas],
  );
  return r.rows;
}
