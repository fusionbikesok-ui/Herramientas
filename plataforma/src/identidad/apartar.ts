/*
 * src/identidad/apartar.ts — Rediseño de la bandeja, Tarea 1: «No estoy seguro» aparta un caso sin
 * decidirlo. No es una decisión: no escribe `identity_decisions` ni toca el vínculo real (contraste con
 * decidirCaso en decidir.ts), y por eso `calibracion.ts` (que sólo lee `identity_decisions`) nunca lo ve.
 *
 * Mismo patrón que decidirCaso: `SELECT ... FOR UPDATE` del caso dentro de una transacción, versión
 * esperada exacta (version_conflict si no coincide) e idempotencia real por clave, guardada en
 * `catalog.identity_case_marks` (migración 0022) para que un reintento con la MISMA clave devuelva el
 * mismo resultado sin volver a subir la versión ni auditar de nuevo.
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { registrarEvento } from '../audit/auditoria.ts';
import { enTransaccion, type Consultable } from '../db/pool.ts';

export interface PedidoMarca { caseId: string; expectedVersion: number; actor: string; motivo?: string; idempotencyKey: string }

export type ResultadoMarca =
  | { ok: true; version: number }
  | { ok: false; code: 'version_conflict' | 'caso_cerrado' | 'caso_inexistente' | 'no_apartado' };

/** Busca una marca previa con esta clave de idempotencia, para ESTE caso y ESTA acción (la clave sola no
 *  alcanza: reusada para otro caso u otra acción no debe devolver un resultado ajeno). Si existe, es el
 *  resultado del reintento (no se vuelve a tocar la fila del caso ni a auditar). */
async function buscarMarcaPrevia(tx: Consultable, idempotencyKey: string, caseId: string, accion: 'apartar' | 'desapartar'): Promise<ResultadoMarca | null> {
  const previa = (await tx.query<{ version: number }>(
    'SELECT version FROM catalog.identity_case_marks WHERE idempotency_key = $1 AND case_id = $2 AND accion = $3',
    [idempotencyKey, caseId, accion])).rows[0];
  return previa ? { ok: true, version: previa.version } : null;
}

export async function apartarCaso(pool: pg.Pool, p: PedidoMarca): Promise<ResultadoMarca> {
  return enTransaccion(pool, async (tx) => {
    // Primera pasada, sin candado: resuelve la mayoría de los reintentos rápido. Todavía puede haber una
    // carrera con OTRO apartarCaso concurrente con la MISMA clave (los dos pasan esta lectura antes de que
    // ninguno tome el FOR UPDATE) — por eso se repite el chequeo después del candado, igual que decidirCaso.
    const previaSinCandado = await buscarMarcaPrevia(tx, p.idempotencyKey, p.caseId, 'apartar');
    if (previaSinCandado) return previaSinCandado;

    const caso = (await tx.query<{ version: number; cerrado_en: Date | null; company_id: string }>(
      'SELECT version, cerrado_en, company_id FROM catalog.identity_cases WHERE id = $1 FOR UPDATE', [p.caseId])).rows[0];
    if (!caso) return { ok: false, code: 'caso_inexistente' };
    const previa = await buscarMarcaPrevia(tx, p.idempotencyKey, p.caseId, 'apartar');
    if (previa) return previa;
    if (caso.version !== p.expectedVersion) return { ok: false, code: 'version_conflict' };
    if (caso.cerrado_en) return { ok: false, code: 'caso_cerrado' };

    const version = caso.version + 1;
    await tx.query(
      `UPDATE catalog.identity_cases SET apartado_en = now(), apartado_por = $2, apartado_motivo = $3, version = $4 WHERE id = $1`,
      [p.caseId, p.actor, p.motivo ?? null, version]);
    await tx.query(
      'INSERT INTO catalog.identity_case_marks (idempotency_key, case_id, accion, version) VALUES ($1, $2, $3, $4)',
      [p.idempotencyKey, p.caseId, 'apartar', version]);
    await registrarEvento(tx, {
      companyId: caso.company_id, actorType: 'user', actorId: p.actor, action: 'identidad.caso_apartado',
      aggregateType: 'identity_case', aggregateId: p.caseId, correlationId: randomUUID(),
      ...(p.motivo ? { reason: p.motivo } : {}),
      payload: { antes: { version: caso.version }, despues: { version } },
    });
    return { ok: true, version };
  });
}

export async function desapartarCaso(pool: pg.Pool, p: PedidoMarca): Promise<ResultadoMarca> {
  return enTransaccion(pool, async (tx) => {
    const previaSinCandado = await buscarMarcaPrevia(tx, p.idempotencyKey, p.caseId, 'desapartar');
    if (previaSinCandado) return previaSinCandado;

    const caso = (await tx.query<{ version: number; apartado_en: Date | null; company_id: string }>(
      'SELECT version, apartado_en, company_id FROM catalog.identity_cases WHERE id = $1 FOR UPDATE', [p.caseId])).rows[0];
    if (!caso) return { ok: false, code: 'caso_inexistente' };
    const previa = await buscarMarcaPrevia(tx, p.idempotencyKey, p.caseId, 'desapartar');
    if (previa) return previa;
    if (caso.version !== p.expectedVersion) return { ok: false, code: 'version_conflict' };
    if (!caso.apartado_en) return { ok: false, code: 'no_apartado' };

    const version = caso.version + 1;
    await tx.query(
      `UPDATE catalog.identity_cases SET apartado_en = NULL, apartado_por = NULL, apartado_motivo = NULL, version = $2 WHERE id = $1`,
      [p.caseId, version]);
    await tx.query(
      'INSERT INTO catalog.identity_case_marks (idempotency_key, case_id, accion, version) VALUES ($1, $2, $3, $4)',
      [p.idempotencyKey, p.caseId, 'desapartar', version]);
    await registrarEvento(tx, {
      companyId: caso.company_id, actorType: 'user', actorId: p.actor, action: 'identidad.caso_desapartado',
      aggregateType: 'identity_case', aggregateId: p.caseId, correlationId: randomUUID(),
      ...(p.motivo ? { reason: p.motivo } : {}),
      payload: { antes: { version: caso.version }, despues: { version } },
    });
    return { ok: true, version };
  });
}
