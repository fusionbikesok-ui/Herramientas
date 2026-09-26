import type pg from 'pg';
import { enTransaccion, type Consultable } from '../db/pool.ts';
import { aplicarAutoSku } from './aplicar-auto-sku.ts';
import { releerParaAutoSku, type ResultadoRelecturaAutoSku } from './relectura-auto-sku.ts';
import type { Relector } from '../reconciliacion/relectura.ts';

export interface EntradaCanario { corridaId: string; bandeja: boolean }
export interface ResumenCanario { procesados: number; vinculados: number; bandeja: number; parked: number; abortado: boolean }
export interface ClasificacionD6 {
  errores: Array<{ tipo: 'corregido_por_jose' | 'parked_sin_resolver'; recurso: string }>;
  noErrores: Record<'redundante' | 'intervention' | 'dejo_de_ser_unico' | 'no_disponible', number>;
  veredicto: 'cero_errores' | 'con_errores' | 'abortado';
}

export async function congelarCanario(pool: pg.Pool, o: { empresa: string; dia: string }): Promise<{ corridaId: string; casos: number; excluidosD5: number }> {
  return enTransaccion(pool, async (tx) => {
    const corrida = (await tx.query<{ id: string }>(
      `INSERT INTO catalog.e3_canario_corridas (company_id, dia) VALUES ($1, $2) RETURNING id`, [o.empresa, o.dia])).rows[0]!;
    const r = await tx.query<{ id: string }>(
      `INSERT INTO catalog.e3_canario_casos (corrida_id, case_id, channel_account_id, recurso, variacion_normalizada, sku_congelado, variant_id_congelada)
       SELECT $1, c.id, er.channel_account_id, er.recurso, er.variacion_normalizada, sv.sku, sv.id
       FROM catalog.identity_cases c JOIN catalog.external_representations er ON er.id = c.representation_id
       JOIN catalog.sellable_variants sv ON sv.id = c.variant_id
       WHERE c.company_id = $2 AND c.tipo = 'sku_pendiente' AND c.cerrado_en IS NULL AND c.estado IN ('actionable','unclassified')
         AND c.detalle->>'d5' IS DISTINCT FROM 'true'
         AND NOT EXISTS (SELECT 1 FROM catalog.identity_decisions d WHERE d.channel_account_id = er.channel_account_id AND d.recurso = er.recurso AND d.variacion_normalizada = er.variacion_normalizada AND d.superada_en IS NULL)
       RETURNING case_id AS id`, [corrida.id, o.empresa]);
    const excluidos = await tx.query<{ n: string }>(`SELECT count(*) n FROM catalog.identity_cases c WHERE c.company_id=$1 AND c.tipo='sku_pendiente' AND c.cerrado_en IS NULL AND c.detalle->>'d5' = 'true'`, [o.empresa]);
    return { corridaId: corrida.id, casos: r.rowCount ?? 0, excluidosD5: Number(excluidos.rows[0]?.n ?? 0) };
  });
}

async function reclamar(pool: pg.Pool, corridaId: string, worker: string): Promise<any | null> {
  return enTransaccion(pool, async (tx) => {
    const fila = (await tx.query(`SELECT * FROM catalog.e3_canario_casos WHERE corrida_id=$1 AND estado IN ('pendiente','parked')
      AND (tomado_hasta IS NULL OR tomado_hasta < now()) ORDER BY case_id FOR UPDATE SKIP LOCKED LIMIT 1`, [corridaId])).rows[0];
    if (!fila) return null;
    return (await tx.query(`UPDATE catalog.e3_canario_casos SET tomado_por=$2, tomado_hasta=now()+interval '2 minutes', intentos=intentos+1 WHERE corrida_id=$1 AND case_id=$3 RETURNING *`, [corridaId, worker, fila.case_id])).rows[0] ?? null;
  });
}

export async function correrCanario(pool: pg.Pool, relector: Relector, o: EntradaCanario): Promise<ResumenCanario> {
  const resumen: ResumenCanario = { procesados: 0, vinculados: 0, bandeja: 0, parked: 0, abortado: false };
  const worker = `canario-${process.pid}`;
  while (!resumen.abortado) {
    const caso = await reclamar(pool, o.corridaId, worker);
    if (!caso) break;
    resumen.procesados++;
    const previo = await pool.query<{ hash: string }>(`SELECT hash_estructura hash FROM catalog.format_observations WHERE channel_account_id=$1 AND recurso=$2 ORDER BY observado_en DESC LIMIT 1`, [caso.channel_account_id, caso.recurso]);
    const lectura = await releerParaAutoSku(relector, { recurso: caso.recurso, variacion: caso.variacion_normalizada, skuCongelado: caso.sku_congelado, hashFormatoPrevio: previo.rows[0]?.hash ?? null });
    if (lectura.tipo === 'abortar') { await enTransaccion(pool, async (tx) => { await tx.query(`UPDATE catalog.e3_canario_corridas SET estado='abortada' WHERE id=$1`, [o.corridaId]); await tx.query(`UPDATE catalog.e3_canario_casos SET estado='pendiente', tomado_por=NULL, tomado_hasta=NULL WHERE corrida_id=$1 AND case_id=$2`, [o.corridaId, caso.case_id]); }); resumen.abortado = true; break; }
    const aplicado = await aplicarAutoSku(pool, { casoId: caso.case_id, cuenta: caso.channel_account_id, recurso: caso.recurso, variacion: caso.variacion_normalizada, skuCongelado: caso.sku_congelado, variantIdCongelada: caso.variant_id_congelada }, lectura as ResultadoRelecturaAutoSku, { bandeja: o.bandeja });
    await pool.query(`UPDATE catalog.e3_canario_casos SET estado=$3, detalle=$4, tomado_por=NULL, tomado_hasta=NULL WHERE corrida_id=$1 AND case_id=$2`, [o.corridaId, caso.case_id, aplicado.resultado === 'vinculado' ? 'vinculado' : aplicado.resultado === 'parked' ? 'parked' : 'bandeja', JSON.stringify(aplicado.detalle ?? {})]);
    if (aplicado.resultado === 'vinculado') resumen.vinculados++; else if (aplicado.resultado === 'parked') resumen.parked++; else resumen.bandeja++;
  }
  return resumen;
}

export async function cerrarCanario(pool: pg.Pool, o: { corridaId: string }): Promise<ClasificacionD6> {
  return enTransaccion(pool, async (tx) => {
    const filas = (await tx.query<{ recurso: string; estado: string }>(`SELECT recurso, estado FROM catalog.e3_canario_casos WHERE corrida_id=$1`, [o.corridaId])).rows;
    const errores = filas.filter((f) => f.estado === 'parked').map((f) => ({ tipo: 'parked_sin_resolver' as const, recurso: f.recurso }));
    const r: ClasificacionD6 = { errores, noErrores: { redundante: 0, intervention: filas.filter((f) => f.estado === 'intervention').length, dejo_de_ser_unico: 0, no_disponible: 0 }, veredicto: errores.length ? 'con_errores' : 'cero_errores' };
    await tx.query(`UPDATE catalog.e3_canario_corridas SET estado='cerrada', cerrado_en=now(), clasificacion=$2 WHERE id=$1`, [o.corridaId, JSON.stringify(r)]);
    return r;
  });
}
