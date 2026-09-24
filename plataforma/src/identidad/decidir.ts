/*
 * src/identidad/decidir.ts — E3 corte 1 tarea 3: decidirCaso, el servicio de decisión de la bandeja.
 *
 * Un caso (`identity_cases`) representa "hay algo por revisar" sobre una publicación de ML. Decidir escribe
 * una fila append-only en `identity_decisions` (spec E3 §4, plan tarea 1) y deja que `reconciliarClave` (E2)
 * mueva el vínculo real: acá no se toca `external_representations` directamente.
 *
 * version_conflict, no partial effect: todo el flujo vive en una sola transacción con `SELECT ... FOR UPDATE`
 * del caso, así que dos decisiones concurrentes sobre el mismo `expectedVersion` nunca dejan efectos parciales:
 * una gana, la otra ve la versión ya subida y aborta antes de escribir nada (foco de revisión #1).
 *
 * Idempotencia real: `idempotency_key` es UNIQUE en la base, así que un reintento con la MISMA clave y el
 * MISMO cuerpo (mismo hash canónico) devuelve el resultado ya guardado sin volver a decidir; con la misma
 * clave y otro cuerpo, `idempotency_mismatch` (foco de revisión #2).
 */
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { registrarEvento } from '../audit/auditoria.ts';
import { bloquearDecisiones, reconciliarClave, type Reconciliacion } from '../catalogo/decisiones.ts';
import { enTransaccion, type Consultable } from '../db/pool.ts';
import { canonizar } from '../informes/jcs.ts';

export interface PedidoDecision {
  caseId: string; expectedVersion: number;
  eleccion: 'vincular' | 'omitir' | 'mantener_omision' | 'sin_candidato';
  variantId?: string; actor: string; esAdmin: boolean; motivo?: string; idempotencyKey: string; revierte?: string;
}

export type ResultadoDecision =
  | { ok: true; decisionId: string; version: number; vinculo: Reconciliacion }
  | { ok: false; code: 'version_conflict' | 'idempotency_mismatch' | 'variante_invalida' | 'caso_cerrado'
      | 'caso_sin_publicacion' | 'solo_admin' | 'bandeja_apagada'; details?: object };

/** El hash canónico del pedido, sin la clave de idempotencia: es la clave la que identifica el reintento, no
 *  al revés — dos pedidos con distinta clave pero mismo cuerpo son decisiones DISTINTAS, no la misma. */
function hashPedido(p: PedidoDecision): string {
  const { idempotencyKey: _idempotencyKey, ...resto } = p;
  return createHash('sha256').update(canonizar(resto)).digest('hex');
}

export async function decidirCaso(pool: pg.Pool, p: PedidoDecision, o: { bandeja: boolean }): Promise<ResultadoDecision> {
  if (!o.bandeja) return { ok: false, code: 'bandeja_apagada' };

  return enTransaccion(pool, async (tx) => {
    // Paso 1: idempotencia. Si la clave ya existe, el hash del pedido decide si es un reintento (devolver lo
    // mismo) o un choque (otro cuerpo bajo la misma clave).
    const previa = (await tx.query<{ id: string; hash_peticion: string; case_id: string }>(
      'SELECT id, hash_peticion, case_id FROM catalog.identity_decisions WHERE idempotency_key = $1', [p.idempotencyKey])).rows[0];
    const hash = hashPedido(p);
    if (previa) {
      if (previa.hash_peticion !== hash) return { ok: false, code: 'idempotency_mismatch' };
      const caso = (await tx.query<{ version: number }>('SELECT version FROM catalog.identity_cases WHERE id = $1', [previa.case_id])).rows[0]!;
      // El resultado de un reintento reporta el estado actual (no el `vinculo` original, que no se guardó):
      // 'sin_cambios' es correcto porque, de haber cambiado algo, ya cambió en el intento original.
      return { ok: true, decisionId: previa.id, version: caso.version, vinculo: 'sin_cambios' };
    }

    // Paso 2: el caso y la clave de la publicación que gobierna (por representation_id, o la única
    // representación de ML de la variante si el caso cuelga de variant_id).
    const caso = (await tx.query<{
      id: string; company_id: string; variant_id: string | null; representation_id: string | null; estado: string;
    }>('SELECT id, company_id, variant_id, representation_id, estado FROM catalog.identity_cases WHERE id = $1', [p.caseId])).rows[0];
    if (!caso) return { ok: false, code: 'caso_sin_publicacion' };
    const repId = caso.representation_id ?? await (async () => {
      if (!caso.variant_id) return null;
      const reps = (await tx.query<{ id: string }>(
        `SELECT id FROM catalog.external_representations WHERE variant_id = $1 AND canal = 'mercadolibre' AND archivado_en IS NULL`,
        [caso.variant_id])).rows;
      return reps.length === 1 ? reps[0]!.id : null;
    })();
    if (!repId) return { ok: false, code: 'caso_sin_publicacion' };
    const rep = (await tx.query<{ channel_account_id: string; recurso: string; variacion_normalizada: string }>(
      'SELECT channel_account_id, recurso, variacion_normalizada FROM catalog.external_representations WHERE id = $1', [repId])).rows[0];
    if (!rep) return { ok: false, code: 'caso_sin_publicacion' };

    // Paso 3: candado de cuenta y fila del caso.
    await bloquearDecisiones(tx, rep.channel_account_id);
    const bloqueado = (await tx.query<{ version: number; estado: string; cerrado_en: Date | null }>(
      'SELECT version, estado, cerrado_en FROM catalog.identity_cases WHERE id = $1 FOR UPDATE', [p.caseId])).rows[0]!;

    // Paso 4: versión esperada. Un caso cerrado sin revertir no admite una decisión nueva encima (ya está
    // resuelto); revertir sí puede reabrir uno cerrado, así que ese chequeo va después del de admin.
    if (bloqueado.version !== p.expectedVersion) return { ok: false, code: 'version_conflict', details: { version_actual: bloqueado.version } };
    if (bloqueado.cerrado_en && !p.revierte) return { ok: false, code: 'caso_cerrado' };

    // Paso 5: la variante elegida, si hay una, tiene que ser de la misma empresa y estar viva.
    if (p.eleccion === 'vincular') {
      if (!p.variantId) return { ok: false, code: 'variante_invalida' };
      const v = (await tx.query<{ company_id: string; archivado_en: Date | null }>(
        'SELECT company_id, archivado_en FROM catalog.sellable_variants WHERE id = $1', [p.variantId])).rows[0];
      if (!v || v.company_id !== caso.company_id || v.archivado_en) return { ok: false, code: 'variante_invalida' };
    }

    // Paso 6: revertir es cosa de administración.
    if (p.revierte && !p.esAdmin) return { ok: false, code: 'solo_admin' };

    // Paso 7: la decisión vigente actual de esa clave (para supersede_a — la propia tabla trae el trigger
    // que la marca superada; acá sólo hace falta apuntarle).
    const vigente = (await tx.query<{ id: string }>(
      `SELECT id FROM catalog.identity_decisions
        WHERE channel_account_id = $1 AND recurso = $2 AND variacion_normalizada = $3 AND efecto = 'aplicar' AND superada_en IS NULL`,
      [rep.channel_account_id, rep.recurso, rep.variacion_normalizada])).rows[0];
    const decision = (await tx.query<{ id: string }>(
      `INSERT INTO catalog.identity_decisions
         (company_id, case_id, channel_account_id, recurso, variacion_normalizada, eleccion, variant_id,
          origen, actor, motivo, efecto, expected_version, idempotency_key, hash_peticion, supersede_a)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'humano', $8, $9, 'aplicar', $10, $11, $12, $13) RETURNING id`,
      [caso.company_id, p.caseId, rep.channel_account_id, rep.recurso, rep.variacion_normalizada, p.eleccion,
        p.eleccion === 'vincular' ? p.variantId : null, p.actor, p.motivo ?? null, p.expectedVersion,
        p.idempotencyKey, hash, p.revierte ?? vigente?.id ?? null])).rows[0]!;

    // Paso 8: sube la versión del caso; queda 'decided' hasta que el paso 10 confirme que el vínculo real
    // se movió (si `reconciliarClave` no cambia nada, el caso se queda en 'decided', no en 'verified').
    // Al mismo tiempo se fija `representation_id` (si el caso colgaba de `variant_id`): decidir puede mover
    // el vínculo a otra variante, y una decisión futura (p.ej. un revert) tiene que seguir encontrando la
    // MISMA publicación, no volver a derivarla de `variant_id` una vez que éste ya no le pertenece.
    const version = bloqueado.version + 1;
    // Revertir reabre un caso cerrado: la decisión anterior deja de ser la última palabra.
    await tx.query(
      `UPDATE catalog.identity_cases SET version = $2, estado = 'decided', representation_id = COALESCE(representation_id, $3)
        ${p.revierte ? ', cerrado_en = NULL, motivo_cierre = NULL' : ''} WHERE id = $1`,
      [p.caseId, version, repId]);

    // Paso 9: el vínculo real lo mueve E2, con la misma bandeja (siempre true acá: si estuviera apagada, ya
    // se salió en el paso 0 con bandeja_apagada).
    const vinculo = await reconciliarClave(
      tx as Consultable, rep.channel_account_id, rep.recurso, rep.variacion_normalizada, `bandeja: ${p.actor}`, { bandeja: true });

    // Paso 10: si el vínculo quedó donde la decisión mandaba, el caso pasa a verified.
    if (vinculo === 'vinculada' || vinculo === 'omitida') {
      await tx.query(
        "UPDATE catalog.identity_cases SET estado = 'verified', cerrado_en = now(), motivo_cierre = 'decidido en bandeja' WHERE id = $1",
        [p.caseId]);
    }

    // Paso 11: auditoría con actor, antes/después y correlation_id.
    const correlationId = randomUUID();
    await registrarEvento(tx, {
      companyId: caso.company_id, actorType: 'user', actorId: p.actor, action: 'identidad.decision',
      aggregateType: 'identity_case', aggregateId: p.caseId, correlationId, ...(p.motivo ? { reason: p.motivo } : {}),
      payload: { antes: { version: bloqueado.version, estado: bloqueado.estado }, despues: { version, eleccion: p.eleccion, variantId: p.variantId ?? null },
        revierte: p.revierte ?? null, decisionId: decision.id },
    });

    return { ok: true, decisionId: decision.id, version, vinculo };
  });
}
