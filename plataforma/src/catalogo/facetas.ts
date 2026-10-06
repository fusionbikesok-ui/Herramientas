/*
 * src/catalogo/facetas.ts — facetas de un modelo decididas por nosotros (`catalog.model_facets`, migración 0018).
 * Ver el encabezado de la migración: NO son `model_attributes`, porque la ingestión cierra lo que el canal no repite.
 */
import type { Consultable } from '../db/pool.ts';

export type OrigenFaceta = 'regla_categoria' | 'persona';

export interface FacetaNueva {
  empresa: string; modelo: string; faceta: string; valor: string;
  origen: OrigenFaceta; motivo: string; decididoPor: string;
}

/**
 * Escribe la faceta de un modelo. Un solo valor vigente por (empresa, modelo, faceta): el mismo valor no hace
 * nada, uno distinto cierra el anterior y abre otro (queda la historia). Devuelve false si ya estaba igual.
 */
export async function escribirFaceta(tx: Consultable, f: FacetaNueva): Promise<boolean> {
  const previa = (await tx.query<{ valor: string }>(
    `SELECT valor FROM catalog.model_facets
      WHERE company_id = $1 AND model_id = $2 AND faceta = $3 AND vigente_hasta IS NULL`,
    [f.empresa, f.modelo, f.faceta])).rows[0];
  if (previa?.valor === f.valor) return false;
  if (previa) {
    await tx.query(
      `UPDATE catalog.model_facets SET vigente_hasta = now()
        WHERE company_id = $1 AND model_id = $2 AND faceta = $3 AND vigente_hasta IS NULL`,
      [f.empresa, f.modelo, f.faceta]);
  }
  // Blanco explícito, nunca pelado: lo único tolerable es que otra transacción haya escrito lo mismo.
  await tx.query(
    `INSERT INTO catalog.model_facets (company_id, model_id, faceta, valor, origen, motivo, decidido_por)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (company_id, model_id, faceta) WHERE vigente_hasta IS NULL DO NOTHING`,
    [f.empresa, f.modelo, f.faceta, f.valor, f.origen, f.motivo, f.decididoPor]);
  return true;
}

export async function facetasVigentes(
  tx: Consultable, empresa: string, faceta: string,
): Promise<Array<{ modelo: string; valor: string; origen: string }>> {
  return (await tx.query<{ modelo: string; valor: string; origen: string }>(
    `SELECT model_id AS modelo, valor, origen FROM catalog.model_facets
      WHERE company_id = $1 AND faceta = $2 AND vigente_hasta IS NULL ORDER BY model_id`, [empresa, faceta])).rows;
}
