/*
 * src/identidad/modelo-ml.ts — de dónde sale el título OBSERVADO de una publicación de ML (E3 corte 1).
 *
 * La representación vendible de ML no guarda título (en producción su model_id es NULL). El título que ML
 * muestra vive en un modelo de origen ml_* (product_models.origen ml_simple / ml_clasico), al que se llega por:
 *   (a) el model_id propio de la representación, si es ml_*;
 *   (b) el modelo de la representación «contenedor» de ML con el mismo (cuenta, recurso);
 *   (c) el modelo de su variante, SÓLO si es ml_*.
 * Nunca un modelo woo_*: si la variante ya está vinculada a Woo, ese título es NUESTRO y usarlo haría que el
 * top-1 acertara por construcción (fuga de la verdad que infla la calibración). Si (b) y (c) existen y difieren,
 * gana el contenedor, que es lo que se ve hoy en ML.
 */
import type { Consultable } from '../db/pool.ts';

export type FuenteModeloMl = 'propio' | 'contenedor' | 'variante';

/** Expresión SQL del model_id de ML de la representación `r` (alias con columnas model_id, channel_account_id, recurso, variant_id). */
export const modeloMlSql = (r: string) => `COALESCE(
  (SELECT pm.id FROM catalog.product_models pm WHERE pm.id = ${r}.model_id AND pm.origen LIKE 'ml\\_%'),
  (SELECT k.model_id FROM catalog.external_representations k JOIN catalog.product_models pm ON pm.id = k.model_id
    WHERE k.canal = 'mercadolibre' AND k.tipo = 'contenedor' AND k.channel_account_id = ${r}.channel_account_id
      AND k.recurso = ${r}.recurso AND k.archivado_en IS NULL AND pm.origen LIKE 'ml\\_%'
    ORDER BY k.creado_en DESC, k.id LIMIT 1),
  (SELECT pm.id FROM catalog.sellable_variants v JOIN catalog.product_models pm ON pm.id = v.model_id
    WHERE v.id = ${r}.variant_id AND pm.origen LIKE 'ml\\_%'))`;

export interface ModeloMl { modeloId: string; fuente: FuenteModeloMl; /** contenedor y variante existen y sus títulos difieren */ difiere: boolean }

interface RepModelo { model_id: string | null; channel_account_id: string; recurso: string; variant_id: string | null }

export async function modeloMlDe(tx: Consultable, rep: RepModelo): Promise<ModeloMl | null> {
  const filas = (await tx.query<{ propio: string | null; contenedor: string | null; variante: string | null; t_contenedor: string | null; t_variante: string | null }>(
    `SELECT
       (SELECT pm.id FROM catalog.product_models pm WHERE pm.id = $1 AND pm.origen LIKE 'ml\\_%') AS propio,
       c.model_id AS contenedor, c.titulo AS t_contenedor, vv.id AS variante, vv.titulo AS t_variante
     FROM (SELECT 1) x
     LEFT JOIN LATERAL (SELECT k.model_id, pm.titulo FROM catalog.external_representations k JOIN catalog.product_models pm ON pm.id = k.model_id
                         WHERE k.canal = 'mercadolibre' AND k.tipo = 'contenedor' AND k.channel_account_id = $2 AND k.recurso = $3
                           AND k.archivado_en IS NULL AND pm.origen LIKE 'ml\\_%' ORDER BY k.creado_en DESC, k.id LIMIT 1) c ON true
     LEFT JOIN LATERAL (SELECT pm.id, pm.titulo FROM catalog.sellable_variants v JOIN catalog.product_models pm ON pm.id = v.model_id
                         WHERE v.id = $4 AND pm.origen LIKE 'ml\\_%') vv ON true`,
    [rep.model_id, rep.channel_account_id, rep.recurso, rep.variant_id])).rows[0]!;
  const difiere = !!filas.contenedor && !!filas.variante && filas.t_contenedor !== filas.t_variante;
  if (filas.propio) return { modeloId: filas.propio, fuente: 'propio', difiere };
  if (filas.contenedor) return { modeloId: filas.contenedor, fuente: 'contenedor', difiere };
  if (filas.variante) return { modeloId: filas.variante, fuente: 'variante', difiere };
  return null;
}
