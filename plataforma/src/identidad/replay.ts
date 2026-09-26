/*
 * src/identidad/replay.ts — E3 corte 3 tarea 7: replay previo al canario (spec §7.2). Sólo lectura.
 *
 * `autoSkuVsHumano` mide el error D6 tipo 2 sobre la ventana: claves con una auto_sku Y una decisión humana
 * vigente (vincular / sin_candidato / omitir / mantener_omision). Su denominador es DISTINTO al de `calibrar()`
 * (que descarta omitir/sin_candidato porque no son verdad de SKU): acá una humana "no es ninguna" contradice
 * cualquier auto_sku. Sin decisión humana la clave no entra; un apartado no es decisión y no está en
 * identity_decisions.
 */
import pg from 'pg';
import { calibrar, type Metricas, type OpcionesCalibracion } from './calibracion.ts';

export interface ResultadoReplay {
  calibracion: Metricas;
  autoSkuVsHumano: { coinciden: number; difieren: Array<{ recurso: string; autoSku: string; humano: string }> };
  veredicto: 'apto' | 'no_apto';
}

export async function replay(pool: pg.Pool, o: OpcionesCalibracion): Promise<ResultadoReplay> {
  const calibracion = await calibrar(pool, o);
  const filas = (await pool.query<{ recurso: string; auto_variant: string; eleccion: string; humano_variant: string | null }>(
    `SELECT a.recurso, a.variant_id AS auto_variant, h.eleccion, h.variant_id AS humano_variant
       FROM (SELECT DISTINCT ON (channel_account_id, recurso, variacion_normalizada) *
               FROM catalog.identity_decisions
              WHERE company_id = $1 AND origen = 'auto_sku' AND eleccion = 'vincular' AND variant_id IS NOT NULL
              ORDER BY channel_account_id, recurso, variacion_normalizada, creado_en DESC) a
       JOIN catalog.identity_decisions h
         ON h.channel_account_id = a.channel_account_id AND h.recurso = a.recurso AND h.variacion_normalizada = a.variacion_normalizada
        AND h.origen = 'humano' AND h.efecto = 'aplicar' AND h.superada_en IS NULL
        AND h.eleccion IN ('vincular', 'sin_candidato', 'omitir', 'mantener_omision')
        AND h.creado_en >= $2 AND h.creado_en < $3
      ORDER BY a.recurso`, [o.empresa, o.desde, o.hasta])).rows;
  const difieren: ResultadoReplay['autoSkuVsHumano']['difieren'] = [];
  let coinciden = 0;
  for (const f of filas) {
    if (f.eleccion === 'vincular' && f.humano_variant === f.auto_variant) coinciden++;
    else difieren.push({ recurso: f.recurso, autoSku: f.auto_variant, humano: f.eleccion === 'vincular' ? f.humano_variant! : f.eleccion });
  }
  return { calibracion, autoSkuVsHumano: { coinciden, difieren }, veredicto: difieren.length === 0 ? 'apto' : 'no_apto' };
}
