/*
 * src/catalogo/conciliacion.ts — qué dice el catálogo de sí mismo: denominadores, cruces y hash (§8 del diseño).
 *
 * Es la base de la sección de catálogo del reporte diario firmado (decisión de José) y de la ruta
 * GET /api/v2/catalog/reconciliation. Todo sale de la base, sin llamar a ningún canal.
 *
 * Los cruces son conjunto por conjunto, no "todo tiene decisión y viceversa" (que contradice los pendientes):
 *   1. decisión vigente confirmar/asignar      ↔ la publicación cuelga de la variante de ese SKU
 *   2. publicación de ML sin decisión vigente  ↔ variante pendiente con caso sku_pendiente abierto
 *   3. decisión vigente omitir                 ↔ publicación omitida con caso omitida_revisar abierto
 *   4. decisión a un SKU que no está en Woo    ↔ caso sku_inexistente_en_woo abierto
 * Un cruce con discrepancias no es un error de datos del negocio: es el catálogo diciendo que algo no se aplicó.
 *
 * El hash: SHA-256 del JSON canónico de representaciones, variantes y decisiones vigentes, ordenadas por clave
 * natural y SIN ids generados ni marcas de tiempo. Dos lecturas del mismo estado dan el mismo hash.
 */
import { createHash } from 'node:crypto';
import type { Consultable } from '../db/pool.ts';
import { canonizar } from '../informes/jcs.ts';

export interface Cruce { total: number; discrepan: number }

export interface Conciliacion {
  representaciones: Array<{ canal: string; tipo: string; estado: string; n: number }>;
  variantes: { con_sku: number; pendientes: number; archivadas: number };
  modelos: Array<{ origen: string; n: number }>;
  casos_abiertos: Array<{ tipo: string; prioridad: string; n: number; nuevos_24h: number }>;
  cruces: { decisiones_vinculadas: Cruce; sin_decision_pendientes: Cruce; omitidas: Cruce; sku_inexistente: Cruce };
  ultima_copia: { tipo: string; confirmada_en: string; resultado: unknown } | null;
  hash: string;
}

/** Estado remoto → grupo del denominador. Lo que no es ni activo ni pausado ni cerrado se cuenta como "otro". */
const GRUPO = `CASE WHEN r.archivado_en IS NOT NULL THEN 'cerrado'
                    WHEN r.estado_remoto IN ('active', 'publish') THEN 'activo'
                    WHEN r.estado_remoto IN ('paused', 'draft', 'private', 'pending') THEN 'pausado'
                    WHEN r.estado_remoto IN ('closed', 'trash') THEN 'cerrado'
                    ELSE 'otro' END`;

export async function conciliarCatalogo(db: Consultable, ahora: Date): Promise<Conciliacion> {
  const representaciones = (await db.query<{ canal: string; tipo: string; estado: string; n: number }>(
    `SELECT r.canal, r.tipo, ${GRUPO} AS estado, count(*)::int AS n FROM catalog.external_representations r
      GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`)).rows;
  const variantes = (await db.query<Conciliacion['variantes']>(
    `SELECT count(*) FILTER (WHERE sku IS NOT NULL AND archivado_en IS NULL)::int AS con_sku,
            count(*) FILTER (WHERE sku IS NULL AND archivado_en IS NULL)::int AS pendientes,
            count(*) FILTER (WHERE archivado_en IS NOT NULL)::int AS archivadas
       FROM catalog.sellable_variants`)).rows[0]!;
  const modelos = (await db.query<{ origen: string; n: number }>(
    'SELECT origen, count(*)::int AS n FROM catalog.product_models WHERE archivado_en IS NULL GROUP BY 1 ORDER BY 1')).rows;
  const casos = (await db.query<Conciliacion['casos_abiertos'][number]>(
    `SELECT tipo, prioridad, count(*)::int AS n,
            count(*) FILTER (WHERE abierto_en > $1::timestamptz - interval '24 hours')::int AS nuevos_24h
       FROM catalog.identity_cases WHERE cerrado_en IS NULL GROUP BY 1, 2 ORDER BY 1, 2`, [ahora.toISOString()])).rows;

  const cruce = async (sql: string): Promise<Cruce> => (await db.query<Cruce>(sql)).rows[0]!;
  const decisionesVinculadas = await cruce(`
    SELECT count(*)::int AS total,
           count(*) FILTER (WHERE r.id IS NULL OR v.sku IS DISTINCT FROM d.sku)::int AS discrepan
      FROM catalog.matcher_decisions d
      LEFT JOIN catalog.external_representations r ON r.channel_account_id = d.channel_account_id
       AND r.recurso = d.recurso AND r.variacion_normalizada = d.variacion_normalizada AND r.tipo = 'vendible'
      LEFT JOIN catalog.sellable_variants v ON v.id = r.variant_id
     WHERE d.vigente_hasta IS NULL AND d.accion IN ('confirmar', 'asignar')
       AND EXISTS (SELECT 1 FROM catalog.sellable_variants x WHERE x.company_id = d.company_id AND x.sku = d.sku)`);
  const sinDecision = await cruce(`
    SELECT count(*)::int AS total,
           count(*) FILTER (WHERE v.sku IS NOT NULL OR v.id IS NULL OR NOT EXISTS (
             SELECT 1 FROM catalog.identity_cases c WHERE c.variant_id = v.id AND c.tipo = 'sku_pendiente' AND c.cerrado_en IS NULL)
           )::int AS discrepan
      FROM catalog.external_representations r
      LEFT JOIN catalog.sellable_variants v ON v.id = r.variant_id
     WHERE r.canal = 'mercadolibre' AND r.tipo = 'vendible' AND r.archivado_en IS NULL
       AND NOT EXISTS (SELECT 1 FROM catalog.matcher_decisions d WHERE d.channel_account_id = r.channel_account_id
             AND d.recurso = r.recurso AND d.variacion_normalizada = r.variacion_normalizada AND d.vigente_hasta IS NULL)`);
  const omitidas = await cruce(`
    SELECT count(*)::int AS total,
           count(*) FILTER (WHERE r.id IS NULL OR NOT r.omitida_por_decision OR NOT EXISTS (
             SELECT 1 FROM catalog.identity_cases c WHERE c.representation_id = r.id AND c.tipo = 'omitida_revisar' AND c.cerrado_en IS NULL)
           )::int AS discrepan
      FROM catalog.matcher_decisions d
      LEFT JOIN catalog.external_representations r ON r.channel_account_id = d.channel_account_id
       AND r.recurso = d.recurso AND r.variacion_normalizada = d.variacion_normalizada AND r.tipo = 'vendible'
     WHERE d.vigente_hasta IS NULL AND d.accion = 'omitir'`);
  const inexistente = await cruce(`
    SELECT count(*)::int AS total,
           count(*) FILTER (WHERE r.id IS NULL OR NOT EXISTS (
             SELECT 1 FROM catalog.identity_cases c WHERE c.variant_id = r.variant_id AND c.tipo = 'sku_inexistente_en_woo' AND c.cerrado_en IS NULL)
           )::int AS discrepan
      FROM catalog.matcher_decisions d
      LEFT JOIN catalog.external_representations r ON r.channel_account_id = d.channel_account_id
       AND r.recurso = d.recurso AND r.variacion_normalizada = d.variacion_normalizada AND r.tipo = 'vendible'
     WHERE d.vigente_hasta IS NULL AND d.accion IN ('confirmar', 'asignar')
       AND NOT EXISTS (SELECT 1 FROM catalog.sellable_variants x WHERE x.company_id = d.company_id AND x.sku = d.sku)`);

  const copia = (await db.query<{ tipo: string; confirmada_en: Date; resultado: unknown }>(
    "SELECT tipo, confirmada_en, resultado FROM catalog.copias WHERE estado = 'confirmada' ORDER BY confirmada_en DESC LIMIT 1")).rows[0];

  return {
    representaciones, variantes, modelos, casos_abiertos: casos,
    cruces: { decisiones_vinculadas: decisionesVinculadas, sin_decision_pendientes: sinDecision, omitidas, sku_inexistente: inexistente },
    ultima_copia: copia ? { tipo: copia.tipo, confirmada_en: copia.confirmada_en.toISOString(), resultado: copia.resultado } : null,
    hash: await hashCatalogo(db),
  };
}

/** SHA-256 del estado del catálogo, sin ids ni tiempos: la variante se nombra por su SKU o por su publicación. */
export async function hashCatalogo(db: Consultable): Promise<string> {
  const reps = (await db.query(
    `SELECT r.canal, r.recurso, r.variacion_normalizada, r.tipo, r.omitida_por_decision, r.sku_observado,
            r.user_product_id, r.archivado_en IS NOT NULL AS archivada, m.origen, m.clave_origen, v.sku
       FROM catalog.external_representations r
       LEFT JOIN catalog.product_models m ON m.id = r.model_id
       LEFT JOIN catalog.sellable_variants v ON v.id = r.variant_id
      ORDER BY r.canal, r.recurso, r.variacion_normalizada`)).rows;
  const decisiones = (await db.query(
    `SELECT recurso, variacion_normalizada, accion, sku, actor FROM catalog.matcher_decisions
      WHERE vigente_hasta IS NULL ORDER BY recurso, variacion_normalizada`)).rows;
  const skus = (await db.query('SELECT sku FROM catalog.sellable_variants WHERE sku IS NOT NULL ORDER BY sku')).rows;
  return createHash('sha256').update(canonizar({ representaciones: reps, decisiones, skus })).digest('hex');
}

/** La sección de catálogo del reporte diario firmado (decisión de José: los casos se ven ahí). */
export interface SeccionCatalogo {
  casos_abiertos: Array<{ tipo: string; prioridad: string; n: number }>;
  casos_nuevos: Array<{ tipo: string; n: number }>;
  casos_cerrados: number;
  /** La última copia del matcher confirmada antes del corte: si cambió algo, un evento se perdió. */
  ultima_copia: { tipo: string; confirmada_en: string; resultado: unknown } | null;
}

/**
 * Como estaba el catálogo en el CORTE, no ahora: el reporte está firmado y armar dos veces el mismo día tiene
 * que dar lo mismo. Un caso cerrado después del corte cuenta como abierto ese día. No toca el semáforo: ése es
 * de la campaña de E1.
 */
export async function seccionCatalogo(db: Consultable, desde: Date, hasta: Date, corte: Date): Promise<SeccionCatalogo> {
  const abiertos = (await db.query<{ tipo: string; prioridad: string; n: number }>(
    `SELECT tipo, prioridad, count(*)::int AS n FROM catalog.identity_cases
      WHERE abierto_en < $1 AND (cerrado_en IS NULL OR cerrado_en >= $1) GROUP BY 1, 2 ORDER BY 1, 2`, [corte])).rows;
  const nuevos = (await db.query<{ tipo: string; n: number }>(
    `SELECT tipo, count(*)::int AS n FROM catalog.identity_cases WHERE abierto_en >= $1 AND abierto_en < $2 GROUP BY 1 ORDER BY 1`,
    [desde, hasta])).rows;
  const cerrados = (await db.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM catalog.identity_cases WHERE cerrado_en >= $1 AND cerrado_en < $2', [desde, hasta])).rows[0]!.n;
  const copia = (await db.query<{ tipo: string; confirmada_en: Date; resultado: unknown }>(
    `SELECT tipo, confirmada_en, resultado FROM catalog.copias WHERE estado = 'confirmada' AND confirmada_en < $1
      ORDER BY confirmada_en DESC, tipo LIMIT 1`, [corte])).rows[0];
  return {
    casos_abiertos: abiertos, casos_nuevos: nuevos, casos_cerrados: cerrados,
    ultima_copia: copia ? { tipo: copia.tipo, confirmada_en: copia.confirmada_en.toISOString(), resultado: copia.resultado } : null,
  };
}
