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
      | 'caso_sin_publicacion' | 'caso_inexistente' | 'solo_admin' | 'bandeja_apagada' | 'revierte_no_vigente'; details?: object };

/** El hash canónico del pedido, sin la clave de idempotencia: es la clave la que identifica el reintento, no
 *  al revés — dos pedidos con distinta clave pero mismo cuerpo son decisiones DISTINTAS, no la misma. */
function hashPedido(p: PedidoDecision): string {
  const { idempotencyKey: _idempotencyKey, ...resto } = p;
  return createHash('sha256').update(canonizar(resto)).digest('hex');
}

export async function decidirCaso(pool: pg.Pool, p: PedidoDecision, o: { bandeja: boolean }): Promise<ResultadoDecision> {
  if (!o.bandeja) return { ok: false, code: 'bandeja_apagada' };

  const hash = hashPedido(p);

  /** Busca una decisión previa con esta clave de idempotencia y arma el resultado de reintento. */
  const buscarPrevia = async (tx: Consultable): Promise<ResultadoDecision | null> => {
    const previa = (await tx.query<{ id: string; hash_peticion: string }>(
      'SELECT id, hash_peticion FROM catalog.identity_decisions WHERE idempotency_key = $1', [p.idempotencyKey])).rows[0];
    if (!previa) return null;
    if (previa.hash_peticion !== hash) return { ok: false, code: 'idempotency_mismatch' };
    // Un reintento devuelve EXACTAMENTE lo que la primera vez devolvió (hallazgo de la segunda opinión de
    // Codex sobre 447126b6/1a7ec9da): no recalcula nada, ni relee el caso — `identity_decision_results` es
    // la única fuente, escrita una sola vez al final de la misma transacción que la insertó (nunca con un
    // UPDATE posterior: append-only real, no una columna reescribible). Si faltara la fila acá, algo rompió
    // la invariante de que decidirCaso siempre la escribe en la MISMA transacción que la decisión — un error
    // explícito es mejor que inventar un resultado.
    const resultado = (await tx.query<{ vinculo: Reconciliacion; version: number }>(
      'SELECT vinculo, version FROM catalog.identity_decision_results WHERE decision_id = $1', [previa.id])).rows[0];
    if (!resultado) throw new Error(`decidirCaso: falta identity_decision_results para la decisión ${previa.id} (idempotency_key ${p.idempotencyKey})`);
    return { ok: true, decisionId: previa.id, version: resultado.version, vinculo: resultado.vinculo };
  };

  return enTransaccion(pool, async (tx) => {
    // Paso 1 (primera pasada, sin candado): resuelve la mayoría de los reintentos rápido, sin bloquear nada.
    // Todavía puede haber una carrera con OTRO decidirCaso concurrente con la MISMA clave (los dos pasan
    // esta lectura antes de que ninguno tome el candado) — por eso se repite el chequeo en el paso 3, ya
    // adentro del candado de cuenta, en vez de dejar que el segundo choque contra el UNIQUE con un 500
    // (hallazgo MEDIO de la segunda opinión de Codex).
    const previa1 = await buscarPrevia(tx);
    if (previa1) return previa1;

    // Paso 2: el caso y la clave de la publicación que gobierna (por representation_id, o la única
    // representación de ML de la variante si el caso cuelga de variant_id).
    const caso = (await tx.query<{
      id: string; company_id: string; variant_id: string | null; representation_id: string | null; estado: string;
    }>('SELECT id, company_id, variant_id, representation_id, estado FROM catalog.identity_cases WHERE id = $1', [p.caseId])).rows[0];
    if (!caso) return { ok: false, code: 'caso_inexistente' };
    const repId = caso.representation_id ?? await (async () => {
      if (!caso.variant_id) return null;
      const reps = (await tx.query<{ id: string }>(
        `SELECT id FROM catalog.external_representations WHERE variant_id = $1 AND canal = 'mercadolibre' AND archivado_en IS NULL`,
        [caso.variant_id])).rows;
      return reps.length === 1 ? reps[0]!.id : null;
    })();
    if (!repId) return { ok: false, code: 'caso_sin_publicacion' };
    // Primera lectura sin candado, sólo para saber en qué cuenta bloquear (channel_account_id no cambia).
    const repCuenta = (await tx.query<{ channel_account_id: string }>(
      'SELECT channel_account_id FROM catalog.external_representations WHERE id = $1', [repId])).rows[0];
    if (!repCuenta) return { ok: false, code: 'caso_sin_publicacion' };

    // Paso 3: candado de cuenta, y ahí sí, de nuevo la idempotencia — esta vez con la garantía de que nadie
    // más con la misma clave puede estar insertando en paralelo (mismo candado de cuenta que toma
    // reconciliarClave/bloquearDecisiones para todo lo demás).
    await bloquearDecisiones(tx, repCuenta.channel_account_id);
    const previa2 = await buscarPrevia(tx);
    if (previa2) return previa2;

    // La representación, ahora sí con FOR UPDATE (ya adentro del candado de cuenta) y validada a fondo:
    // tiene que seguir siendo de ML, vendible, viva y de la MISMA empresa que el caso — nada de esto podía
    // cambiar entre el paso 2 y acá en la práctica (todo se toca bajo el mismo candado de cuenta), pero
    // sin la relectura el caso de una representación archivada ENTRE la lectura y el candado pasaba
    // desapercibido (hallazgo de la segunda opinión de Codex).
    const rep = (await tx.query<{
      channel_account_id: string; recurso: string; variacion_normalizada: string; canal: string; tipo: string;
      archivado_en: Date | null; company_id: string;
    }>('SELECT channel_account_id, recurso, variacion_normalizada, canal, tipo, archivado_en, company_id FROM catalog.external_representations WHERE id = $1 FOR UPDATE', [repId])).rows[0];
    if (!rep || rep.canal !== 'mercadolibre' || rep.tipo !== 'vendible' || rep.archivado_en || rep.company_id !== caso.company_id) {
      return { ok: false, code: 'caso_sin_publicacion' };
    }
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
    // que la marca superada; acá sólo hace falta apuntarle). Si `p.revierte` viene informado, tiene que SER
    // esa vigente: el trigger `identity_decisions_superar_anterior` valida lo mismo y aborta el INSERT con
    // una excepción si no coincide (hallazgo ALTO de Codex: eso volvía un 500, en vez de un resultado
    // tipado), así que se valida acá antes para devolver un código claro sin llegar a la excepción.
    const vigente = (await tx.query<{ id: string }>(
      `SELECT id FROM catalog.identity_decisions
        WHERE channel_account_id = $1 AND recurso = $2 AND variacion_normalizada = $3 AND efecto = 'aplicar' AND superada_en IS NULL`,
      [rep.channel_account_id, rep.recurso, rep.variacion_normalizada])).rows[0];
    if (p.revierte && p.revierte !== vigente?.id) return { ok: false, code: 'revierte_no_vigente' };
    const decisionId = (await tx.query<{ id: string }>(
      `INSERT INTO catalog.identity_decisions
         (company_id, case_id, channel_account_id, recurso, variacion_normalizada, eleccion, variant_id,
          origen, actor, motivo, efecto, expected_version, idempotency_key, hash_peticion, supersede_a)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'humano', $8, $9, 'aplicar', $10, $11, $12, $13) RETURNING id`,
      [caso.company_id, p.caseId, rep.channel_account_id, rep.recurso, rep.variacion_normalizada, p.eleccion,
        p.eleccion === 'vincular' ? p.variantId : null, p.actor, p.motivo ?? null, p.expectedVersion,
        p.idempotencyKey, hash, p.revierte ?? vigente?.id ?? null])).rows[0]!.id;

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

    // Paso 9: el vínculo real lo mueve E2, con la bandeja del contexto (nunca en false acá: si lo estuviera,
    // ya se salió en el paso 0 con bandeja_apagada; pasar `true` fijo en vez de `o.bandeja` funcionaba igual
    // en la práctica, pero atarlo al parámetro es lo correcto — hallazgo de la segunda opinión de Codex).
    const vinculo = await reconciliarClave(
      tx as Consultable, rep.channel_account_id, rep.recurso, rep.variacion_normalizada, `bandeja: ${p.actor}`, { bandeja: o.bandeja });

    // Paso 10: cerrar el caso, y sólo si el vínculo real quedó donde la decisión mandaba — no basta con que
    // `reconciliarClave` haya corrido, porque devuelve 'sin_cambios' tanto cuando ya estaba bien (hay que
    // cerrar igual, si no el caso queda 'decided' abierto para siempre y vuelve a la cola — hallazgo ALTO de
    // Codex) como cuando falló en aplicar lo pedido (ahí NO hay que cerrar, y de hecho ni debería pasar:
    // si no coincide con lo que la decisión mandaba, algo está roto y se aborta toda la transacción en vez
    // de dejar un 'decided' a medio camino).
    //
    // Releo external_representations en vez de confiar en el string de `vinculo`, porque 'sin_cambios' no
    // dice A QUÉ está sin cambios: puede ser que ya estuviera exactamente donde la decisión pedía (cerrar)
    // o que la decisión no haya podido aplicarse (romper).
    const repFinal = (await tx.query<{ variant_id: string | null; omitida_por_decision: boolean }>(
      'SELECT variant_id, omitida_por_decision FROM catalog.external_representations WHERE id = $1', [repId])).rows[0]!;
    let coincide: boolean;
    let motivoCierre = 'decidido en bandeja';
    let estadoFinal = 'verified';
    if (p.eleccion === 'vincular') {
      coincide = repFinal.variant_id === p.variantId && !repFinal.omitida_por_decision;
    } else if (p.eleccion === 'omitir' || p.eleccion === 'mantener_omision') {
      coincide = repFinal.omitida_por_decision;
    } else {
      // sin_candidato: la publicación tiene que haber quedado pendiente, sin SKU asociado a esa variante
      // pendiente (una variante CON sku no es "sin candidato": es de Woo, sencillamente no se decidió).
      const pend = repFinal.variant_id && !repFinal.omitida_por_decision
        ? (await tx.query<{ sku: string | null }>('SELECT sku FROM catalog.sellable_variants WHERE id = $1', [repFinal.variant_id])).rows[0]
        : null;
      coincide = !!pend && pend.sku === null;
      estadoFinal = 'decided'; // sin_candidato nunca pasa a verified: no hay nada verificado, es "no sé".
      motivoCierre = 'sin candidato en catálogo';
    }
    if (!coincide) {
      // No debería pasar nunca en la práctica (reconciliarClave aplica exactamente lo que decisionVigente
      // le manda, y la decisión recién insertada YA es la vigente de esa clave); si pasara, es mejor un
      // rollback completo que un caso 'decided' abierto a medias sin que nadie se entere.
      throw new Error(`decidirCaso: el vínculo de ${rep.recurso} no coincide con la decisión ${p.eleccion} tras reconciliar`);
    }
    // sin_candidato con reconciliarClave: si la publicación YA estaba pendiente sobre OTRA variante que sí
    // tenía SKU, "sin_candidato" no la mueve (arriba `coincide` ya lo habría detectado). Pero si estaba
    // vinculada u omitida y pasa a "pendiente", `reconciliarClave` puede abrir un `sku_pendiente` sobre la
    // variante pendiente nueva: se cierra acá mismo con el mismo motivo, para no reabrir la cola con un caso
    // que el propio decidirCaso ya resolvió como "sin candidato".
    if (p.eleccion === 'sin_candidato' && repFinal.variant_id) {
      await tx.query(
        `UPDATE catalog.identity_cases SET cerrado_en = now(), motivo_cierre = $2
          WHERE variant_id = $1 AND tipo = 'sku_pendiente' AND cerrado_en IS NULL AND id <> $3`,
        [repFinal.variant_id, motivoCierre, p.caseId]);
    }
    await tx.query(
      'UPDATE catalog.identity_cases SET estado = $2, cerrado_en = now(), motivo_cierre = $3 WHERE id = $1',
      [p.caseId, estadoFinal, motivoCierre]);

    // El resultado se INSERTA (nunca UPDATE) en su propia tabla append-only: un reintento con la misma
    // idempotency_key lo lee de ahí, tal cual, sin recalcular nada (hallazgo de la segunda opinión de Codex
    // sobre 1a7ec9da: un UPDATE, aunque fuera sólo de estas dos columnas, dejaba a la app reescribir el
    // resultado de cualquier decisión cuando quisiera).
    await tx.query(
      'INSERT INTO catalog.identity_decision_results (decision_id, vinculo, version) VALUES ($1, $2, $3)',
      [decisionId, vinculo, version]);

    // Paso 11: auditoría con actor, antes/después y correlation_id.
    const correlationId = randomUUID();
    await registrarEvento(tx, {
      companyId: caso.company_id, actorType: 'user', actorId: p.actor, action: 'identidad.decision',
      aggregateType: 'identity_case', aggregateId: p.caseId, correlationId, ...(p.motivo ? { reason: p.motivo } : {}),
      payload: { antes: { version: bloqueado.version, estado: bloqueado.estado }, despues: { version, eleccion: p.eleccion, variantId: p.variantId ?? null },
        revierte: p.revierte ?? null, decisionId },
    });

    return { ok: true, decisionId, version, vinculo };
  });
}
