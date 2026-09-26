import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { enTransaccion, type Consultable } from '../db/pool.ts';
import { registrarEvento } from '../audit/auditoria.ts';
import { bloquearDecisiones, reconciliarClave } from '../catalogo/decisiones.ts';
import { registrarFormato } from './formato.ts';
import { normalizarSku, skuUnico } from './sku.ts';
import type { ResultadoRelecturaAutoSku } from './relectura-auto-sku.ts';

type Entrada = {
  casoId: string;
  cuenta: string;
  recurso: string;
  variacion: string;
  skuCongelado: string;
  variantIdCongelada: string;
};

type Resultado = {
  resultado: 'vinculado' | 'bandeja' | 'intervention' | 'parked' | 'abortar' | 'ya_resuelto';
  detalle?: object;
};

class ReconciliarDistinto extends Error {}

type Caso = { id: string; company_id: string; estado: string; cerrado_en: Date | null; version: number };

async function evidencia(tx: Consultable, e: Entrada, hash: string | null, campos: object): Promise<void> {
  await tx.query(
    `INSERT INTO catalog.identity_evidence (case_id, fuente, hash, campos)
     VALUES ($1, 'ml', $2, $3)`,
    [e.casoId, hash, JSON.stringify(campos)],
  );
}

async function cerrarComo(tx: Consultable, e: Entrada, estado: 'actionable' | 'intervention', detalle: object): Promise<Resultado> {
  const caso = (await tx.query<Caso>(
    'SELECT id, company_id, estado, cerrado_en, version FROM catalog.identity_cases WHERE id = $1 FOR UPDATE',
    [e.casoId],
  )).rows[0];
  if (!caso || caso.cerrado_en || caso.estado === 'verified') return { resultado: 'ya_resuelto' };
  await evidencia(tx, e, null, detalle);
  await tx.query(
    `UPDATE catalog.identity_cases SET estado = $2, version = version + 1
     WHERE id = $1`,
    [e.casoId, estado],
  );
  return { resultado: estado === 'intervention' ? 'intervention' : 'bandeja', detalle };
}

export async function aplicarAutoSku(
  pool: pg.Pool,
  e: Entrada,
  relectura: ResultadoRelecturaAutoSku,
  o: { bandeja: boolean },
): Promise<Resultado> {
  if (relectura.tipo === 'parked') return { resultado: 'parked', detalle: { motivo: relectura.motivo } };
  if (relectura.tipo === 'abortar') return { resultado: 'abortar', detalle: { status: relectura.status } };

  try {
    return await enTransaccion(pool, async (tx) => {
    await bloquearDecisiones(tx, e.cuenta);
    const caso = (await tx.query<Caso>(
      'SELECT id, company_id, estado, cerrado_en, version FROM catalog.identity_cases WHERE id = $1 FOR UPDATE',
      [e.casoId],
    )).rows[0];
    if (!caso || caso.cerrado_en || caso.estado === 'verified') return { resultado: 'ya_resuelto' };

    const humana = (await tx.query(
      `SELECT 1 FROM catalog.identity_decisions
       WHERE channel_account_id = $1 AND recurso = $2 AND variacion_normalizada = $3
         AND origen = 'humano' AND superada_en IS NULL LIMIT 1`,
      [e.cuenta, e.recurso, e.variacion],
    )).rowCount;
    const aplicada = (await tx.query(
      `SELECT 1 FROM catalog.identity_decisions
       WHERE channel_account_id = $1 AND recurso = $2 AND variacion_normalizada = $3
         AND origen = 'auto_sku' AND efecto = 'aplicar' AND superada_en IS NULL LIMIT 1`,
      [e.cuenta, e.recurso, e.variacion],
    )).rowCount;
    if (humana || aplicada) return { resultado: 'ya_resuelto' };

    if (relectura.tipo === 'no_disponible') {
      const detalle = { motivo: relectura.motivo };
      await evidencia(tx, e, null, detalle);
      await tx.query('UPDATE catalog.identity_cases SET estado = \'actionable\', version = version + 1 WHERE id = $1', [e.casoId]);
      return { resultado: 'bandeja', detalle };
    }
    if (relectura.tipo === 'cambio') {
      const detalle = { que: relectura.que, ...relectura.detalle };
      await evidencia(tx, e, null, detalle);
      await tx.query('UPDATE catalog.identity_cases SET estado = \'intervention\', version = version + 1 WHERE id = $1', [e.casoId]);
      return { resultado: 'intervention', detalle };
    }

    const skuNormalizado = normalizarSku(e.skuCongelado);
    const sku = skuNormalizado === null ? 'ninguna' : await skuUnico(tx, caso.company_id, skuNormalizado);
    if (sku === 'ninguna' || sku === 'varias' || sku.variantId !== e.variantIdCongelada) {
      return cerrarComo(tx, e, 'actionable', { motivo: 'sku_no_unico_o_cambiado' });
    }

    const formato = await registrarFormato(tx, { cuenta: e.cuenta, recurso: e.recurso, estructura: relectura.estructura, versionRemota: null, origen: 'relectura' });
    if (formato.resultado === 'cambio') {
      const detalle = { que: formato.que };
      await evidencia(tx, e, relectura.hashPayload, detalle);
      await tx.query('UPDATE catalog.identity_cases SET estado = \'intervention\', version = version + 1 WHERE id = $1', [e.casoId]);
      return { resultado: 'intervention', detalle };
    }

    const decision = (await tx.query<{ id: string }>(
      `INSERT INTO catalog.identity_decisions
       (company_id, case_id, channel_account_id, recurso, variacion_normalizada, eleccion, variant_id,
        origen, actor, motivo, efecto, engine_version, hash_payload_ml, expected_version, supersede_a)
       VALUES ($1, $2, $3, $4, $5, 'vincular', $6, 'auto_sku', 'plataforma', 'e3 canario: sku exacto',
        'aplicar', 'e3-auto-sku-v1', $7, $8, NULL) RETURNING id`,
      [caso.company_id, e.casoId, e.cuenta, e.recurso, e.variacion, e.variantIdCongelada, relectura.hashPayload, caso.version],
    )).rows[0];
    if (!decision) throw new Error('aplicarAutoSku: no se insertó la decisión');
    const vinculo = await reconciliarClave(tx, e.cuenta, e.recurso, e.variacion, 'e3 canario: sku exacto', { bandeja: o.bandeja, autoSku: 'aplicado' });
    if (vinculo !== 'vinculada') throw new ReconciliarDistinto(vinculo);
    await tx.query('UPDATE catalog.identity_cases SET estado = \'verified\', version = version + 1, cerrado_en = now(), motivo_cierre = \'auto_sku_aplicado\' WHERE id = $1', [e.casoId]);
    await registrarEvento(tx, {
      companyId: caso.company_id, actorType: 'system', actorId: 'plataforma.identidad', action: 'identidad.auto_sku_aplicado',
      aggregateType: 'identity_case', aggregateId: e.casoId, correlationId: randomUUID(), reason: 'e3 canario: sku exacto',
      payload: { antes: { estado: caso.estado, version: caso.version }, despues: { estado: 'verified', version: caso.version + 1 }, decisionId: decision.id },
    });
    return { resultado: 'vinculado' };
    });
  } catch (err) {
    if (err instanceof ReconciliarDistinto) return { resultado: 'parked', detalle: { motivo: 'reconciliar_distinto', vinculo: err.message } };
    throw err;
  }
}
