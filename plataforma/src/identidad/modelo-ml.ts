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
 *
 * Un ítem de ML sin variaciones ya vinculado a una variante de Woo no cae en (a)/(b)/(c): no tiene modelo
 * propio (aplicar.ts no crea uno vacío a propósito) ni contenedor (sólo ml_clasico lo genera) y su variante
 * es woo_*, no ml_*. Para ese caso existe `external_representations.titulo_observado` (revisión de opt-16
 * sobre el intento anterior, 5cb02ef5, que sí creaba el modelo): el texto del último payload de ML para ESA
 * representación puntual, como último fallback de sólo lectura. No es un modelo, no entra en la clasificación
 * D26/D27 ni en hashCatalogo, y (a)/(b)/(c) lo pisan solos en cuanto exista alguno.
 */
import type { Consultable } from '../db/pool.ts';

export type FuenteModeloMl = 'propio' | 'contenedor' | 'variante';
export type FuenteTituloMl = FuenteModeloMl | 'observado';

/** Expresión SQL del model_id de ML de la representación `r` (alias con columnas model_id, channel_account_id, recurso, variant_id). */
export const modeloMlSql = (r: string) => `COALESCE(
  (SELECT pm.id FROM catalog.product_models pm WHERE pm.id = ${r}.model_id AND pm.origen LIKE 'ml\\_%'),
  (SELECT k.model_id FROM catalog.external_representations k JOIN catalog.product_models pm ON pm.id = k.model_id
    WHERE k.canal = 'mercadolibre' AND k.tipo = 'contenedor' AND k.channel_account_id = ${r}.channel_account_id
      AND k.recurso = ${r}.recurso AND k.archivado_en IS NULL AND pm.origen LIKE 'ml\\_%'
    ORDER BY k.creado_en DESC, k.id LIMIT 1),
  (SELECT pm.id FROM catalog.sellable_variants v JOIN catalog.product_models pm ON pm.id = v.model_id
    WHERE v.id = ${r}.variant_id AND pm.origen LIKE 'ml\\_%'))`;

/** Expresión SQL del título OBSERVADO de ML de `r`: modeloMlSql resuelto a título, con titulo_observado como
 *  último fallback (nunca hay modelo Y titulo_observado a la vez con valor útil: ver comentario de arriba). */
export const tituloMlSql = (r: string) => `COALESCE(
  (SELECT pm.titulo FROM catalog.product_models pm WHERE pm.id = ${modeloMlSql(r)}),
  ${r}.titulo_observado)`;

export interface ModeloMl { modeloId: string; fuente: FuenteModeloMl; /** contenedor y variante existen y sus títulos difieren */ difiere: boolean }
export interface TituloMl { titulo: string; fuente: FuenteTituloMl; /** ver ModeloMl.difiere; false cuando fuente es 'observado' (no hay modelo, nada que comparar) */ difiere: boolean }

interface RepModelo { model_id: string | null; channel_account_id: string; recurso: string; variant_id: string | null }
interface RepTitulo extends RepModelo { titulo_observado?: string | null }

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

/** Título observado de ML de `rep`: modeloMlDe resuelto a título y, si no hay modelo (ítem sin variaciones ya
 *  vinculado a Woo), `rep.titulo_observado` como último fallback. `rep` debe traer esa columna ya seleccionada
 *  (no la vuelve a pedir acá) porque el caller ya suele tenerla en la misma fila. */
export async function tituloMlDe(tx: Consultable, rep: RepTitulo): Promise<TituloMl | null> {
  const m = await modeloMlDe(tx, rep);
  if (m) {
    const fila = (await tx.query<{ titulo: string }>('SELECT titulo FROM catalog.product_models WHERE id = $1', [m.modeloId])).rows[0];
    if (fila) return { titulo: fila.titulo, fuente: m.fuente, difiere: m.difiere };
  }
  if (rep.titulo_observado) return { titulo: rep.titulo_observado, fuente: 'observado', difiere: false };
  return null;
}
