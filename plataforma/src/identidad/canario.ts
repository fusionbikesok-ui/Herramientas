import type pg from 'pg';
import { enTransaccion, type Consultable } from '../db/pool.ts';
import { aplicarAutoSku } from './aplicar-auto-sku.ts';
import { releerParaAutoSku, type ResultadoRelecturaAutoSku } from './relectura-auto-sku.ts';
import type { Relector } from '../reconciliacion/relectura.ts';

export interface EntradaCanario { corridaId: string; bandeja: boolean; esperar?: (ms: number) => Promise<void> }
export interface ResumenCanario { procesados: number; vinculados: number; bandeja: number; parked: number; abortado: boolean }
export interface ClasificacionD6 {
  errores: Array<{ tipo: 'corregido_por_jose' | 'parked_sin_resolver'; recurso: string }>;
  noErrores: Record<'redundante' | 'intervention' | 'dejo_de_ser_unico' | 'no_disponible', number>;
  veredicto: 'cero_errores' | 'con_errores' | 'abortado' | 'incompleto';
}

export async function congelarCanario(pool: pg.Pool, o: { empresa: string; dia: string }): Promise<{ corridaId: string; casos: number; excluidosD5: number }> {
  return enTransaccion(pool, async (tx) => {
    const corrida = (await tx.query<{ id: string }>(
      `INSERT INTO catalog.e3_canario_corridas (company_id, dia) VALUES ($1, $2) RETURNING id`, [o.empresa, o.dia])).rows[0]!;
    // Candidatos: sku_pendiente abiertos con auto_sku/sombra vigente (destino y SKU salen de esa decisión), con UNA sola
    // representación ML viva, sin decisión humana/legado vigente sobre la clave y sin D5.
    const r = await tx.query<{ id: string }>(
      `INSERT INTO catalog.e3_canario_casos (corrida_id, case_id, channel_account_id, recurso, variacion_normalizada, sku_congelado, variant_id_congelada)
       SELECT $1, c.id, er.channel_account_id, er.recurso, er.variacion_normalizada, sv.sku, sv.id
       FROM catalog.identity_cases c
       JOIN catalog.external_representations er ON er.variant_id = c.variant_id AND er.canal = 'mercadolibre' AND er.archivado_en IS NULL
       JOIN catalog.identity_decisions s ON s.channel_account_id = er.channel_account_id AND s.recurso = er.recurso
         AND s.variacion_normalizada = er.variacion_normalizada AND s.origen = 'auto_sku' AND s.efecto = 'sombra' AND s.superada_en IS NULL AND s.variant_id IS NOT NULL
       JOIN catalog.sellable_variants sv ON sv.id = s.variant_id AND sv.sku IS NOT NULL
       WHERE c.company_id = $2 AND c.tipo = 'sku_pendiente' AND c.cerrado_en IS NULL AND c.estado IN ('actionable','unclassified')
         AND c.detalle->>'d5' IS DISTINCT FROM 'true'
         AND (SELECT count(*) FROM catalog.external_representations x WHERE x.variant_id = c.variant_id AND x.canal = 'mercadolibre' AND x.archivado_en IS NULL) = 1
         AND (SELECT count(*) FROM catalog.sellable_variants y WHERE y.company_id = $2 AND y.sku = sv.sku) = 1
         AND NOT EXISTS (SELECT 1 FROM catalog.identity_decisions d WHERE d.channel_account_id = er.channel_account_id AND d.recurso = er.recurso
           AND d.variacion_normalizada = er.variacion_normalizada AND d.origen = 'humano' AND d.superada_en IS NULL)
         AND NOT EXISTS (SELECT 1 FROM catalog.matcher_decisions m WHERE m.channel_account_id = er.channel_account_id AND m.recurso = er.recurso
           AND m.variacion_normalizada = er.variacion_normalizada AND m.vigente_hasta IS NULL)
       RETURNING case_id AS id`, [corrida.id, o.empresa]);
    const excluidos = await tx.query<{ n: string }>(`SELECT count(*) n FROM catalog.identity_cases c WHERE c.company_id=$1 AND c.tipo='sku_pendiente' AND c.cerrado_en IS NULL AND c.detalle->>'d5' = 'true'`, [o.empresa]);
    return { corridaId: corrida.id, casos: r.rowCount ?? 0, excluidosD5: Number(excluidos.rows[0]?.n ?? 0) };
  });
}

async function reclamar(pool: pg.Pool, corridaId: string, worker: string, yaVistos: string[]): Promise<any | null> {
  return enTransaccion(pool, async (tx) => {
    const fila = (await tx.query(`SELECT * FROM catalog.e3_canario_casos WHERE corrida_id=$1 AND estado IN ('pendiente','parked')
      AND (tomado_hasta IS NULL OR tomado_hasta < now()) AND case_id <> ALL($2::uuid[]) ORDER BY case_id FOR UPDATE SKIP LOCKED LIMIT 1`, [corridaId, yaVistos])).rows[0];
    if (!fila) return null;
    return (await tx.query(`UPDATE catalog.e3_canario_casos SET tomado_por=$2, tomado_hasta=now()+interval '2 minutes', intentos=intentos+1 WHERE corrida_id=$1 AND case_id=$3 RETURNING *`, [corridaId, worker, fila.case_id])).rows[0] ?? null;
  });
}

export async function correrCanario(pool: pg.Pool, relector: Relector, o: EntradaCanario): Promise<ResumenCanario> {
  const resumen: ResumenCanario = { procesados: 0, vinculados: 0, bandeja: 0, parked: 0, abortado: false };
  const worker = `canario-${process.pid}`;
  const abierta = (await pool.query(`SELECT 1 FROM catalog.e3_canario_corridas WHERE id=$1 AND estado='abierta'`, [o.corridaId])).rowCount;
  if (!abierta) return { ...resumen, abortado: true };
  const vistos: string[] = []; // un caso parked se reintenta en la PRÓXIMA corrida, no en un bucle de ésta
  while (!resumen.abortado) {
    const caso = await reclamar(pool, o.corridaId, worker, vistos);
    if (caso) vistos.push(caso.case_id);
    if (!caso) break;
    resumen.procesados++;
    const previo = await pool.query<{ hash: string }>(`SELECT hash_estructura hash FROM catalog.format_observations WHERE channel_account_id=$1 AND recurso=$2 ORDER BY observado_en DESC LIMIT 1`, [caso.channel_account_id, caso.recurso]);
    const lectura = await releerParaAutoSku(relector, { recurso: caso.recurso, variacion: caso.variacion_normalizada, skuCongelado: caso.sku_congelado, hashFormatoPrevio: previo.rows[0]?.hash ?? null }, o.esperar ? { esperar: o.esperar } : {});
    if (lectura.tipo === 'abortar') { await enTransaccion(pool, async (tx) => { await tx.query(`UPDATE catalog.e3_canario_corridas SET estado='abortada' WHERE id=$1`, [o.corridaId]); await tx.query(`UPDATE catalog.e3_canario_casos SET estado='pendiente', tomado_por=NULL, tomado_hasta=NULL WHERE corrida_id=$1 AND case_id=$2`, [o.corridaId, caso.case_id]); }); resumen.abortado = true; break; }
    const aplicado = await aplicarAutoSku(pool, { casoId: caso.case_id, cuenta: caso.channel_account_id, recurso: caso.recurso, variacion: caso.variacion_normalizada, skuCongelado: caso.sku_congelado, variantIdCongelada: caso.variant_id_congelada }, lectura as ResultadoRelecturaAutoSku, { bandeja: o.bandeja });
    await pool.query(`UPDATE catalog.e3_canario_casos SET estado=$3, detalle=$4, tomado_por=NULL, tomado_hasta=NULL WHERE corrida_id=$1 AND case_id=$2 AND tomado_por=$5`, [o.corridaId, caso.case_id, aplicado.resultado === 'abortar' ? 'pendiente' : aplicado.resultado, JSON.stringify(aplicado.detalle ?? {}), worker]);
    if (aplicado.resultado === 'vinculado') resumen.vinculados++; else if (aplicado.resultado === 'parked') resumen.parked++; else resumen.bandeja++;
  }
  return resumen;
}

export async function cerrarCanario(pool: pg.Pool, o: { corridaId: string }): Promise<ClasificacionD6> {
  return enTransaccion(pool, async (tx) => {
    const corrida = (await tx.query<{ estado: string; congelado_en: Date }>(`SELECT estado, congelado_en FROM catalog.e3_canario_corridas WHERE id=$1 FOR UPDATE`, [o.corridaId])).rows[0];
    if (!corrida) throw new Error('canario: corrida inexistente');
    if (corrida.estado === 'cerrada') throw new Error('canario: la corrida ya está cerrada');
    const filas = (await tx.query<{ recurso: string; estado: string; detalle: { motivo?: string } | null; humana: string | null; variant_id_congelada: string }>(
      `SELECT k.recurso, k.estado, k.detalle, k.variant_id_congelada,
              (SELECT d.variant_id FROM catalog.identity_decisions d
                WHERE d.channel_account_id = k.channel_account_id AND d.recurso = k.recurso AND d.variacion_normalizada = k.variacion_normalizada
                  AND d.origen = 'humano' AND d.efecto = 'aplicar' AND d.eleccion = 'vincular' AND d.creado_en >= $2
                ORDER BY d.creado_en DESC LIMIT 1) AS humana
         FROM catalog.e3_canario_casos k WHERE k.corrida_id = $1`, [o.corridaId, corrida.congelado_en])).rows;
    const errores: ClasificacionD6['errores'] = [];
    const noErrores = { redundante: 0, intervention: 0, dejo_de_ser_unico: 0, no_disponible: 0 };
    for (const f of filas) {
      if (f.humana && f.humana !== f.variant_id_congelada) errores.push({ tipo: 'corregido_por_jose', recurso: f.recurso });
      else if (f.humana) noErrores.redundante++;
      else if (f.estado === 'parked') errores.push({ tipo: 'parked_sin_resolver', recurso: f.recurso });
      else if (f.estado === 'intervention') noErrores.intervention++;
      else if (f.estado === 'bandeja') { if (f.detalle?.motivo === 'sku_no_unico_o_cambiado') noErrores.dejo_de_ser_unico++; else noErrores.no_disponible++; }
    }
    const pendientes = filas.filter((f) => f.estado === 'pendiente').length;
    // Con casos sin procesar no hay veredicto D6 posible: no se cierra (cero_errores sería un falso positivo).
    if (pendientes > 0 && corrida.estado !== 'abortada') return { errores, noErrores, veredicto: 'incompleto' };
    const veredicto = corrida.estado === 'abortada' ? 'abortado' : errores.length ? 'con_errores' : 'cero_errores';
    const r: ClasificacionD6 = { errores, noErrores, veredicto };
    await tx.query(`UPDATE catalog.e3_canario_corridas SET estado = CASE WHEN estado = 'abortada' THEN estado ELSE 'cerrada' END, cerrado_en = now(), clasificacion = $2 WHERE id = $1`, [o.corridaId, JSON.stringify(r)]);
    return r;
  });
}
