/*
 * src/identidad/sku.ts — E3 corte 1 tarea 4: normalización y resolución de SKU exacto.
 *
 * normalizarSku no valida forma (eso lo hace el CHECK de sellable_variants, `^FB-[0-9]+$`):
 * sólo homogeneiza mayúsculas y espacios para que la comparación textual del motor no falle por
 * ruido de captura ("fb-12" vs "FB-12", espacios sobrantes de un campo de texto libre). Un SKU
 * observado que no matchea el patrón canónico simplemente no encuentra variante en skuUnico —
 * no es un error de normalizarSku, es el comportamiento correcto (no inventar un vínculo).
 */
import type { Consultable } from '../db/pool.ts';

export function normalizarSku(s: string | null | undefined): string | null {
  if (s == null) return null;
  const t = s.trim().toUpperCase().replace(/\s+/g, ' ');
  return t === '' ? null : t;
}

export type ResultadoSkuUnico = { variantId: string } | 'ninguna' | 'varias';

// Sólo variantes vivas (no archivadas) de la MISMA empresa: un SKU archivado o de otra empresa
// no cuenta como candidato — evita que el motor vincule contra una variante que ya no existe
// comercialmente o que pertenece a otro catálogo.
export async function skuUnico(tx: Consultable, empresa: string, skuNorm: string): Promise<ResultadoSkuUnico> {
  const filas = (await tx.query<{ id: string }>(
    `SELECT id FROM catalog.sellable_variants
      WHERE company_id = $1 AND sku = $2 AND archivado_en IS NULL`,
    [empresa, skuNorm])).rows;
  if (filas.length === 0) return 'ninguna';
  if (filas.length > 1) return 'varias'; // no debería pasar (sellable_variants_un_sku es único), pero no se asume
  return { variantId: filas[0]!.id };
}
