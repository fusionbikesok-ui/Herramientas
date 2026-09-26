/*
 * src/catalogo/copias.ts — cómo llegan al catálogo las decisiones del matcher y los casos de identidad del
 * legado: una copia consistente en tandas, y después eventos sueltos.
 *
 * Por qué en tandas con confirmación final: una tanda intermedia no permite distinguir "esta decisión ya no
 * existe" de "todavía no llegó". Los lotes van a staging y sólo `confirmarCopia`, con el conteo y el hash de
 * todas las filas, cierra lo que falta y abre lo nuevo, en UNA transacción. Una copia sin confirmar no cambia
 * nada del catálogo.
 *
 * La regla del corte: la copia es una foto del legado en un instante. Una decisión que llegó por evento
 * DESPUÉS de ese instante es más nueva que la foto, y la copia no la pisa ni la cierra. Por eso el orden de
 * puesta en producción captura los eventos antes de tomar la copia (plan, tarea 14, pasos 4 a 6).
 *
 * El hash es SHA-256 del JSON canónico (RFC 8785) de las filas ordenadas por su clave: no depende del orden
 * en que el legado mandó los lotes, y el legado lo puede calcular igual.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { Consultable } from '../db/pool.ts';
import { registrarEvento } from '../audit/auditoria.ts';
import { canonizar } from '../informes/jcs.ts';
import { bloquearDecisiones, reconciliarClave, type OpcionesAutoridad } from './decisiones.ts';

export type Accion = 'confirmar' | 'asignar' | 'omitir';

/** Una decisión del matcher tal como la copia el legado. */
export interface FilaDecision {
  recurso: string;
  variacion: string;
  sku: string | null;
  accion: Accion;
  /** 'sistema' para la autoasignación por SKU y la corrección de Guardia (decisión de José). */
  actor: 'persona' | 'sistema';
  motivo: string | null;
  confirmado_por: string | null;
  actualizado_en_legado: string | null;
}

/** Un caso pendiente o urgente de `identidad_casos` del legado. */
export interface FilaIdentidad {
  caso_legado: string;
  recurso: string;
  variacion: string;
  prioridad: 'normal' | 'urgente';
  detalle: Record<string, unknown>;
}

export type TipoCopia = 'matcher' | 'identidad';

export type CodigoCopia = 'copia_inexistente' | 'copia_cerrada' | 'lote_repetido' | 'copia_incompleta' | 'hash_distinto';

export class ErrorCopia extends Error {
  override name = 'ErrorCopia';
  readonly codigo: CodigoCopia;
  constructor(codigo: CodigoCopia, mensaje: string) {
    super(mensaje);
    this.codigo = codigo;
  }
}

const claveDe = (f: { recurso: string; variacion: string }) => `${f.recurso}\u0000${f.variacion}`;

/** El hash que el legado tiene que mandar al abrir la copia. */
export function hashFilas(filas: readonly (FilaDecision | FilaIdentidad)[]): string {
  const ordenadas = [...filas].sort((a, b) => (claveDe(a) < claveDe(b) ? -1 : claveDe(a) > claveDe(b) ? 1 : 0));
  return createHash('sha256').update(canonizar(ordenadas)).digest('hex');
}

export async function abrirCopia(db: Consultable, o: {
  empresa: string; tipo: TipoCopia; totalEsperado: number; hashEsperado: string; corte: string;
}): Promise<string> {
  return (await db.query<{ id: string }>(
    `INSERT INTO catalog.copias (company_id, tipo, total_esperado, hash_esperado, corte) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [o.empresa, o.tipo, o.totalEsperado, o.hashEsperado, o.corte])).rows[0]!.id;
}

async function copiaAbierta(db: Consultable, copia: string, bloquear: boolean) {
  const c = (await db.query<{ estado: string; tipo: TipoCopia; total_esperado: number; hash_esperado: string; corte: Date; company_id: string }>(
    `SELECT estado, tipo, total_esperado, hash_esperado, corte, company_id FROM catalog.copias WHERE id = $1 ${bloquear ? 'FOR UPDATE' : ''}`,
    [copia])).rows[0];
  if (!c) throw new ErrorCopia('copia_inexistente', `no existe la copia ${copia}`);
  return c;
}

export async function recibirLote(db: Consultable, copia: string, numero: number, filas: unknown[]): Promise<void> {
  const c = await copiaAbierta(db, copia, false);
  if (c.estado !== 'abierta') throw new ErrorCopia('copia_cerrada', `la copia ${copia} está ${c.estado}`);
  const r = await db.query(
    `INSERT INTO catalog.copias_lotes (copy_id, numero, filas) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
    [copia, numero, JSON.stringify(filas)]);
  // El mismo lote dos veces es un reintento del legado: se acepta si es idéntico, y si no, es un error suyo.
  if (!r.rowCount) {
    const igual = (await db.query<{ igual: boolean }>(
      'SELECT filas = $3::jsonb AS igual FROM catalog.copias_lotes WHERE copy_id = $1 AND numero = $2',
      [copia, numero, JSON.stringify(filas)])).rows[0]!.igual;
    if (!igual) throw new ErrorCopia('lote_repetido', `el lote ${numero} ya llegó con otro contenido`);
  }
}

export interface ResultadoConfirmacion {
  yaConfirmada: boolean;
  abiertas: number;
  cerradas: number;
  sinCambios: number;
  /** Filas que no se aplicaron porque un evento posterior al corte ya decidió esa clave. */
  masNuevasQueLaCopia: number;
  /** Sólo identidad: casos del legado cuya publicación todavía no está en el catálogo. */
  sinRepresentacion: number;
}

/** Verifica y aplica la copia. Debe llamarse dentro de una transacción: todo o nada. */
export async function confirmarCopia(
  tx: Consultable, copia: string, cuenta: string, o: OpcionesAutoridad,
): Promise<ResultadoConfirmacion> {
  const c = await copiaAbierta(tx, copia, true);
  const vacio: ResultadoConfirmacion = { yaConfirmada: false, abiertas: 0, cerradas: 0, sinCambios: 0, masNuevasQueLaCopia: 0, sinRepresentacion: 0 };
  if (c.estado === 'confirmada') return { ...vacio, yaConfirmada: true };
  if (c.estado !== 'abierta') throw new ErrorCopia('copia_cerrada', `la copia ${copia} está ${c.estado}`);

  const lotes = (await tx.query<{ numero: number; filas: unknown[] }>(
    'SELECT numero, filas FROM catalog.copias_lotes WHERE copy_id = $1 ORDER BY numero', [copia])).rows;
  // Los lotes tienen que ser 1..N sin huecos: un hueco es un lote que se perdió en el camino.
  if (lotes.some((l, i) => l.numero !== i + 1)) throw new ErrorCopia('copia_incompleta', 'falta al menos un lote intermedio');
  const filas = lotes.flatMap((l) => l.filas) as (FilaDecision | FilaIdentidad)[];
  if (filas.length !== c.total_esperado) {
    throw new ErrorCopia('copia_incompleta', `llegaron ${filas.length} filas de ${c.total_esperado}`);
  }
  if (hashFilas(filas) !== c.hash_esperado) throw new ErrorCopia('hash_distinto', 'el hash de las filas no coincide con el anunciado');

  const r = c.tipo === 'matcher'
    ? await aplicarDecisiones(tx, c.company_id, cuenta, copia, c.corte, filas as FilaDecision[], o)
    : await aplicarIdentidad(tx, c.company_id, cuenta, filas as FilaIdentidad[]);
  const resultado = { ...vacio, ...r };
  await tx.query("UPDATE catalog.copias SET estado = 'confirmada', confirmada_en = now(), resultado = $2 WHERE id = $1",
    [copia, JSON.stringify(resultado)]);
  return resultado;
}

interface Vigente { id: string; recurso: string; variacion_normalizada: string; accion: string; sku: string | null; origen: string; vigente_desde: Date }

async function aplicarDecisiones(
  tx: Consultable, empresa: string, cuenta: string, copia: string, corte: Date, filas: FilaDecision[],
  o: OpcionesAutoridad,
): Promise<Partial<ResultadoConfirmacion>> {
  await bloquearDecisiones(tx, cuenta);
  const vigentes = new Map((await tx.query<Vigente>(
    `SELECT id, recurso, variacion_normalizada, accion, sku, origen, vigente_desde FROM catalog.matcher_decisions
      WHERE channel_account_id = $1 AND vigente_hasta IS NULL FOR UPDATE`, [cuenta])).rows
    .map((v) => [`${v.recurso}\u0000${v.variacion_normalizada}`, v]));
  const r = { abiertas: 0, cerradas: 0, sinCambios: 0, masNuevasQueLaCopia: 0 };
  const posteriorAlCorte = (v: Vigente) => v.origen === 'evento' && v.vigente_desde > corte;
  const cerrar = (id: string, motivo: string) => tx.query(
    'UPDATE catalog.matcher_decisions SET vigente_hasta = now(), motivo_cierre = $2 WHERE id = $1', [id, motivo]);

  const enCopia = new Set<string>();
  // Claves cuya decisión vigente cambió: al final se reconcilia el vínculo de cada una (tarea 8).
  const cambiadas: { recurso: string; variacion: string }[] = [];
  for (const f of filas) {
    const clave = claveDe(f);
    enCopia.add(clave);
    const v = vigentes.get(clave);
    if (v && posteriorAlCorte(v)) { r.masNuevasQueLaCopia++; continue; }
    if (v && v.accion === f.accion && v.sku === f.sku) { r.sinCambios++; continue; }
    if (v) { await cerrar(v.id, `reemplazada por la copia ${copia}`); r.cerradas++; }
    await insertarDecision(tx, empresa, cuenta, f, 'copia', copia, null);
    r.abiertas++;
    cambiadas.push({ recurso: f.recurso, variacion: f.variacion });
  }
  for (const [clave, v] of vigentes) {
    if (enCopia.has(clave)) continue;
    if (posteriorAlCorte(v)) { r.masNuevasQueLaCopia++; continue; }
    await cerrar(v.id, `ausente en la copia ${copia}`);
    r.cerradas++;
    cambiadas.push({ recurso: v.recurso, variacion: v.variacion_normalizada });
  }
  for (const c of cambiadas) await reconciliarClave(tx, cuenta, c.recurso, c.variacion, `copia ${copia}`, o);
  return r;
}

async function insertarDecision(
  tx: Consultable, empresa: string, cuenta: string, f: FilaDecision, origen: 'copia' | 'evento', copia: string | null,
  vigenteDesde: string | null,
): Promise<void> {
  await tx.query(
    `INSERT INTO catalog.matcher_decisions
       (company_id, channel_account_id, canal, recurso, variacion_normalizada, sku, accion, origen, actor, motivo,
        confirmado_por, actualizado_en_legado, copy_id, vigente_desde)
     VALUES ($1, $2, 'mercadolibre', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, COALESCE($13::timestamptz, now()))`,
    [empresa, cuenta, f.recurso, f.variacion, f.sku, f.accion, origen, f.actor, f.motivo, f.confirmado_por,
      f.actualizado_en_legado, copia, vigenteDesde]);
}

async function aplicarIdentidad(
  tx: Consultable, empresa: string, cuenta: string, filas: FilaIdentidad[],
): Promise<Partial<ResultadoConfirmacion>> {
  const r = { abiertas: 0, cerradas: 0, sinCambios: 0, sinRepresentacion: 0 };
  const vistos = new Set<string>();
  for (const f of filas) {
    vistos.add(f.caso_legado);
    const rep = (await tx.query<{ id: string }>(
      `SELECT id FROM catalog.external_representations
        WHERE channel_account_id = $1 AND recurso = $2 AND variacion_normalizada = $3`, [cuenta, f.recurso, f.variacion])).rows[0];
    // Sin representación todavía no hay a qué colgar el caso. No se pierde: la próxima copia lo vuelve a
    // traer y para entonces el proyector ya habrá visto la publicación. Se cuenta para el reporte.
    if (!rep) { r.sinRepresentacion++; continue; }
    const detalle = { ...f.detalle, caso_legado: f.caso_legado };
    const actual = (await tx.query<{ id: string; prioridad: string; detalle: Record<string, unknown> }>(
      `SELECT id, prioridad, detalle FROM catalog.identity_cases
        WHERE representation_id = $1 AND tipo = 'identidad_legado' AND cerrado_en IS NULL AND detalle->>'caso_legado' = $2
        FOR UPDATE`, [rep.id, f.caso_legado])).rows[0];
    if (!actual) {
      await tx.query(
        `INSERT INTO catalog.identity_cases (company_id, tipo, prioridad, representation_id, detalle)
         VALUES ($1, 'identidad_legado', $2, $3, $4)`, [empresa, f.prioridad, rep.id, JSON.stringify(detalle)]);
      r.abiertas++;
    } else if (actual.prioridad !== f.prioridad || JSON.stringify(canonizar(actual.detalle)) !== JSON.stringify(canonizar(detalle))) {
      // Antes un ON CONFLICT DO NOTHING: un cambio de clasificación o de prioridad nunca llegaba (hallazgo medio).
      await tx.query('UPDATE catalog.identity_cases SET prioridad = $2, detalle = $3 WHERE id = $1', [actual.id, f.prioridad, JSON.stringify(detalle)]);
      r.cerradas++; r.abiertas++;
    } else r.sinCambios++;
  }
  // Un caso del legado que ya no viene en la copia se resolvió allá.
  const abiertos = (await tx.query<{ id: string; caso: string }>(
    `SELECT c.id, c.detalle->>'caso_legado' AS caso FROM catalog.identity_cases c
       JOIN catalog.external_representations r ON r.id = c.representation_id
      WHERE c.tipo = 'identidad_legado' AND c.cerrado_en IS NULL AND r.channel_account_id = $1`, [cuenta])).rows;
  for (const a of abiertos) {
    if (vistos.has(a.caso)) continue;
    await tx.query("UPDATE catalog.identity_cases SET cerrado_en = now(), motivo_cierre = 'resuelto en el legado' WHERE id = $1", [a.id]);
    r.cerradas++;
  }
  return r;
}

/** Un cambio suelto del matcher, emitido por la outbox del legado en el momento en que ocurrió. */
export interface EventoDecision {
  evento_id: string;
  recurso: string;
  variacion: string;
  /** 'revocar' borra la decisión en el legado: acá se cierra la vigente y no se abre otra. */
  accion: Accion | 'revocar';
  sku: string | null;
  actor: 'persona' | 'sistema';
  motivo: string | null;
  confirmado_por: string | null;
  ocurrido_en: string;
}

export type ResultadoEvento = 'aplicado' | 'repetido' | 'viejo';

/**
 * Aplica un evento. Debe llamarse dentro de una transacción.
 *
 * `o.bandeja`: si la clave del evento tiene una decisión HUMANA vigente de E3 (`identity_decisions`,
 * origen='humano', efecto='aplicar'), la decisión del legado se guarda igual (queda como historia, y
 * decisionVigente la usa si algún día la humana se revierte), pero NO se llama a reconciliarClave: el
 * vínculo actual (el que puso la humana) no cambia. En cambio se abre `decision_en_conflicto` sobre la
 * representación, para que una persona revise la discrepancia. `ON CONFLICT DO NOTHING` del INSERT hace
 * que reenviar el mismo evento (incluso ya con `nuevo.rowCount` en 0 por el idempotency de arriba, o con
 * un evento_id distinto pero la misma clave) no abra un segundo caso: el índice único parcial de
 * `identity_cases` (representation_id, tipo, …) ya existe desde 0013 y lo evita.
 */
export async function aplicarEvento(
  tx: Consultable, empresa: string, cuenta: string, e: EventoDecision, o: OpcionesAutoridad,
): Promise<ResultadoEvento> {
  await bloquearDecisiones(tx, cuenta);
  const nuevo = await tx.query('INSERT INTO catalog.eventos_recibidos (evento_id) VALUES ($1) ON CONFLICT DO NOTHING', [e.evento_id]);
  if (!nuevo.rowCount) return 'repetido';
  const v = (await tx.query<{ id: string; vigente_desde: Date }>(
    `SELECT id, vigente_desde FROM catalog.matcher_decisions
      WHERE channel_account_id = $1 AND recurso = $2 AND variacion_normalizada = $3 AND vigente_hasta IS NULL FOR UPDATE`,
    [cuenta, e.recurso, e.variacion])).rows[0];
  // Un evento más viejo que la decisión vigente llegó tarde: aplicarlo volvería atrás una decisión posterior.
  if (v && v.vigente_desde > new Date(e.ocurrido_en)) return 'viejo';
  if (v) {
    await tx.query('UPDATE catalog.matcher_decisions SET vigente_hasta = now(), motivo_cierre = $2 WHERE id = $1',
      [v.id, e.accion === 'revocar' ? `revocada en el legado${e.motivo ? `: ${e.motivo}` : ''}` : `reemplazada por el evento ${e.evento_id}`]);
  }
  if (e.accion !== 'revocar') {
    await insertarDecision(tx, empresa, cuenta, {
      recurso: e.recurso, variacion: e.variacion, sku: e.sku, accion: e.accion, actor: e.actor, motivo: e.motivo,
      confirmado_por: e.confirmado_por, actualizado_en_legado: e.ocurrido_en,
    }, 'evento', null, e.ocurrido_en);
  }

  if (o.bandeja) {
    const humana = (await tx.query<{ id: string; eleccion: string; variant_id: string | null }>(
      `SELECT id, eleccion, variant_id FROM catalog.identity_decisions
        WHERE channel_account_id = $1 AND recurso = $2 AND variacion_normalizada = $3
          AND origen = 'humano' AND efecto = 'aplicar' AND superada_en IS NULL`,
      [cuenta, e.recurso, e.variacion])).rows[0];
    if (humana) {
      const rep = (await tx.query<{ id: string; company_id: string; variant_id: string | null }>(
        `SELECT id, company_id, variant_id FROM catalog.external_representations
          WHERE channel_account_id = $1 AND recurso = $2 AND variacion_normalizada = $3`,
        [cuenta, e.recurso, e.variacion])).rows[0];
      if (rep) {
        // Redundante, spec §7.3: si el evento del legado ya coincide con lo que la humana decidió (el mismo
        // SKU resuelve al mismo variant_id que ya tiene la publicación, u omitir/mantener_omision con la
        // humana también en omitir), no hay discrepancia que revisar — no se abre decision_en_conflicto.
        let redundante = false;
        if ((e.accion === 'confirmar' || e.accion === 'asignar') && humana.eleccion === 'vincular' && e.sku) {
          const destino = (await tx.query<{ id: string }>(
            'SELECT id FROM catalog.sellable_variants WHERE company_id = $1 AND sku = $2', [rep.company_id, e.sku])).rows[0];
          redundante = !!destino && destino.id === humana.variant_id && destino.id === rep.variant_id;
        } else if (e.accion === 'omitir' && (humana.eleccion === 'omitir' || humana.eleccion === 'mantener_omision')) {
          redundante = true;
        }
        if (!redundante) {
          await tx.query(
            `INSERT INTO catalog.identity_cases (company_id, tipo, estado, prioridad, representation_id, detalle)
             VALUES ($1, 'decision_en_conflicto', 'conflict', 'urgente', $2, $3) ON CONFLICT DO NOTHING`,
            [rep.company_id, rep.id, JSON.stringify({ legado: { accion: e.accion, sku: e.sku }, e3: humana.id })]);
          // El evento de auditoría se registra en CADA aplicación, incluso reenvíos del mismo evento_id que ya
          // no abren un segundo caso (el ON CONFLICT de arriba es sobre el caso, no sobre esto): la auditoría
          // es el registro de "qué pasó", y un reenvío es un hecho real que ocurrió de nuevo, no un duplicado
          // a suprimir — a diferencia del caso, que es "hay algo por revisar" y sólo debe existir una vez.
          await registrarEvento(tx, {
            companyId: rep.company_id, actorType: 'system', actorId: 'plataforma.identidad',
            action: 'identidad.conflicto_legado', aggregateType: 'external_representation', aggregateId: rep.id,
            correlationId: randomUUID(), reason: `evento ${e.evento_id} sobre clave con decisión humana ${humana.id}`,
            payload: { recurso: e.recurso, variacion: e.variacion, legado: { accion: e.accion, sku: e.sku }, decisionHumanaId: humana.id },
          });
        }
      }
      return 'aplicado';
    }
  }

  await reconciliarClave(tx, cuenta, e.recurso, e.variacion, `evento ${e.evento_id}`, o);
  return 'aplicado';
}

/** Un cambio de estado de un caso de `identidad_casos` del legado, emitido por su trigger de outbox. */
export interface EventoIdentidad {
  evento_id: string;
  caso_legado: string;
  recurso: string;
  variacion: string;
  prioridad: 'normal' | 'urgente';
  /** Pendiente, urgente, tomado o en intervención en el legado. */
  abierto: boolean;
  detalle: Record<string, unknown>;
  ocurrido_en: string;
}

/**
 * Abre, actualiza o cierra el caso `identidad_legado` de esa publicación. Si la publicación todavía no está en
 * el catálogo no hay a qué colgarlo: se registra como recibido y la copia diaria lo trae cuando exista.
 */
export async function aplicarEventoIdentidad(tx: Consultable, empresa: string, cuenta: string, e: EventoIdentidad): Promise<ResultadoEvento | 'sin_representacion'> {
  const nuevo = await tx.query('INSERT INTO catalog.eventos_recibidos (evento_id) VALUES ($1) ON CONFLICT DO NOTHING', [e.evento_id]);
  if (!nuevo.rowCount) return 'repetido';
  const rep = (await tx.query<{ id: string }>(
    `SELECT id FROM catalog.external_representations WHERE channel_account_id = $1 AND recurso = $2 AND variacion_normalizada = $3`,
    [cuenta, e.recurso, e.variacion])).rows[0];
  if (!rep) return 'sin_representacion';
  // Por caso del legado: una publicación puede tener varios abiertos a la vez (uno por dirección).
  const actual = (await tx.query<{ id: string; abierto_en: Date }>(
    `SELECT id, abierto_en FROM catalog.identity_cases
      WHERE representation_id = $1 AND tipo = 'identidad_legado' AND cerrado_en IS NULL AND detalle->>'caso_legado' = $2
      FOR UPDATE`, [rep.id, e.caso_legado])).rows[0];
  if (actual && actual.abierto_en > new Date(e.ocurrido_en)) return 'viejo';
  if (!e.abierto) {
    if (actual) await tx.query("UPDATE catalog.identity_cases SET cerrado_en = now(), motivo_cierre = 'resuelto en el legado' WHERE id = $1", [actual.id]);
    return 'aplicado';
  }
  const detalle = JSON.stringify({ ...e.detalle, caso_legado: e.caso_legado });
  if (actual) {
    await tx.query('UPDATE catalog.identity_cases SET prioridad = $2, detalle = $3 WHERE id = $1', [actual.id, e.prioridad, detalle]);
  } else {
    await tx.query(
      `INSERT INTO catalog.identity_cases (company_id, tipo, prioridad, representation_id, detalle)
       VALUES ($1, 'identidad_legado', $2, $3, $4)`, [empresa, e.prioridad, rep.id, detalle]);
  }
  return 'aplicado';
}
