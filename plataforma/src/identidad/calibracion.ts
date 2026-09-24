/*
 * src/identidad/calibracion.ts — E3 corte 1 tarea 7: métricas del motor por engine_version (spec §9).
 *
 * Denominador = la muestra congelada (casos con la verdad conocida: SKU real de una decisión histórica de
 * vincular) MÁS cada decisión humana `vincular` vigente de la ventana. Una decisión `omitir`/`sin_candidato`
 * no es una verdad de SKU, así que no entra a top-1/top-3.
 *   - muestra: se corre el motor puro (`candidatosDe`) contra el catálogo dado, en memoria.
 *   - humanas de la ventana: se comparan con el top-3 que el motor GUARDÓ para ese caso (identity_candidates,
 *     última corrida); si el caso no tiene candidatos guardados, cuenta como fallo del motor.
 * `tiempoMedianoDecisionS` es «tiempo de resolución» (abierto_en → decisión humana), NO tiempo de atención.
 */
import pg from 'pg';
import { candidatosDe, construirWCIndex, ctDesdeApi, type ItemMl } from './candidatos.ts';
import { ENGINE_VERSION } from './motor.ts';
import { normalizarSku } from './sku.ts';

/** Un puntaje ≥ este umbral con el top-1 equivocado es la situación peligrosa para un auto-vínculo. */
export const UMBRAL_PUNTAJE_ALTO = 0.8;
/** Tamaño de la lista para el recall de candidatos sobre la muestra (las humanas usan el top-3 guardado). */
export const RECALL_N = 10;

export interface VerdadMuestra { clave: string; ml: ItemMl; skuVerdad: string | null }
export interface Bloque { n: number; top1: number; top3: number; top1MalAlto: number; recallN: number }
export interface Metricas {
  engineVersion: string;
  /** La comparación con la medición base (53/82 %) es sobre `muestra`; `ventana` y `total` no la diluyen. */
  muestra: Bloque; ventana: Bloque; total: Bloque;
  autoSkuSombra: { total: number; coincideHumana: number; contradiceHumana: number };
  tiempoMedianoDecisionS: number | null;
}
export interface OpcionesCalibracion {
  empresa: string; desde: Date; hasta: Date; muestra: VerdadMuestra[];
  /** Filas del catálogo Woo (sku, nombre, tipo, atributos_json, img) contra las que se corre el motor sobre la muestra. */
  catalogo: any[];
}

interface Acumulador { n: number; top1: number; top3: number; malAlto: number; recall: number }

const vacio = (): Acumulador => ({ n: 0, top1: 0, top3: 0, malAlto: 0, recall: 0 });
const bloque = (a: Acumulador): Bloque => {
  const f = (x: number) => (a.n ? x / a.n : 0);
  return { n: a.n, top1: f(a.top1), top3: f(a.top3), top1MalAlto: f(a.malAlto), recallN: f(a.recall) };
};

export async function calibrar(pool: pg.Pool, o: OpcionesCalibracion): Promise<Metricas> {
  const acc = vacio(); // muestra
  const accV = vacio(); // ventana

  // 1) La muestra congelada, contra el motor puro.
  const indice = construirWCIndex(o.catalogo);
  for (const v of o.muestra) {
    const verdad = normalizarSku(v.skuVerdad);
    if (!verdad) continue;
    const ml: ItemMl = { ...v.ml, _ct: ctDesdeApi(v.ml.color, v.ml.talle) }; // el JSON congelado pierde los Set
    const c = candidatosDe(ml, o.catalogo, indice, RECALL_N);
    const orden = c.map((x) => x.variantId);
    acc.n++;
    const primero = c[0];
    if (normalizarSku(primero?.variantId) === verdad) acc.top1++;
    else if (primero && primero.puntaje >= UMBRAL_PUNTAJE_ALTO) acc.malAlto++;
    if (orden.slice(0, 3).some((x) => normalizarSku(x) === verdad)) acc.top3++;
    if (orden.some((x) => normalizarSku(x) === verdad)) acc.recall++;
  }

  // 2) Las decisiones humanas `vincular` vigentes de la ventana, contra los candidatos que guardó el motor.
  const humanas = (await pool.query<{ id: string; case_id: string; variant_id: string }>(
    `SELECT id, case_id, variant_id FROM catalog.identity_decisions
      WHERE company_id = $1 AND origen = 'humano' AND efecto = 'aplicar' AND eleccion = 'vincular'
        AND superada_en IS NULL AND case_id IS NOT NULL AND creado_en >= $2 AND creado_en < $3`,
    [o.empresa, o.desde, o.hasta])).rows;
  // Los candidatos contra los que se mide son los de la última corrida ANTERIOR (o simultánea) a la decisión:
  // una corrida posterior puede haber visto la verdad ya decidida y no es evidencia de lo que el humano tenía delante.
  if (humanas.length) {
    const cands = (await pool.query<{ decision_id: string; variant_id: string; rank: number; puntaje: number }>(
      `SELECT d.id AS decision_id, c.variant_id, c.rank, c.puntaje
         FROM catalog.identity_decisions d
         JOIN catalog.identity_candidates c ON c.case_id = d.case_id
        WHERE d.id = ANY($1::uuid[])
          AND c.run_id = (SELECT x.run_id FROM catalog.identity_candidates x
                           WHERE x.case_id = d.case_id AND x.creado_en <= d.creado_en
                           ORDER BY x.creado_en DESC, x.id DESC LIMIT 1)
        ORDER BY d.id, c.rank`, [humanas.map((h) => h.id)])).rows;
    const porDecision = new Map<string, typeof cands>();
    for (const c of cands) porDecision.set(c.decision_id, [...(porDecision.get(c.decision_id) ?? []), c]);
    for (const h of humanas) {
      const lista = porDecision.get(h.id) ?? [];
      accV.n++;
      const primero = lista[0];
      if (primero?.variant_id === h.variant_id) accV.top1++;
      else if (primero && primero.puntaje >= UMBRAL_PUNTAJE_ALTO) accV.malAlto++;
      if (lista.slice(0, 3).some((x) => x.variant_id === h.variant_id)) accV.top3++;
      if (lista.some((x) => x.variant_id === h.variant_id)) accV.recall++;
    }
  }

  // 3) auto_sku en sombra de la ventana contra lo que decidió después la humana sobre la misma clave.
  const sombra = (await pool.query<{ total: number; coincide: number; contradice: number }>(
    `SELECT count(*)::int AS total,
            (count(*) FILTER (WHERE h.variant_id = a.variant_id))::int AS coincide,
            (count(*) FILTER (WHERE h.id IS NOT NULL AND h.variant_id IS DISTINCT FROM a.variant_id))::int AS contradice
       FROM catalog.identity_decisions a
       LEFT JOIN LATERAL (SELECT d.id, d.variant_id FROM catalog.identity_decisions d
                           WHERE d.channel_account_id = a.channel_account_id AND d.recurso = a.recurso
                             AND d.variacion_normalizada = a.variacion_normalizada
                             AND d.origen = 'humano' AND d.efecto = 'aplicar' AND d.eleccion = 'vincular' AND d.superada_en IS NULL
                           ORDER BY d.creado_en DESC, d.id DESC LIMIT 1) h ON true
      WHERE a.company_id = $1 AND a.origen = 'auto_sku' AND a.efecto = 'sombra' AND a.creado_en >= $2 AND a.creado_en < $3`,
    [o.empresa, o.desde, o.hasta])).rows[0]!;

  // 4) Tiempo de resolución (abierto_en → decisión humana original, no reversiones).
  const mediana = (await pool.query<{ s: number | null }>(
    `SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM d.creado_en - c.abierto_en)) AS s
       FROM catalog.identity_decisions d JOIN catalog.identity_cases c ON c.id = d.case_id
      WHERE d.company_id = $1 AND d.origen = 'humano' AND d.supersede_a IS NULL AND d.creado_en >= $2 AND d.creado_en < $3`,
    [o.empresa, o.desde, o.hasta])).rows[0]!.s;

  const tot: Acumulador = {
    n: acc.n + accV.n, top1: acc.top1 + accV.top1, top3: acc.top3 + accV.top3, malAlto: acc.malAlto + accV.malAlto, recall: acc.recall + accV.recall,
  };
  return {
    engineVersion: ENGINE_VERSION, muestra: bloque(acc), ventana: bloque(accV), total: bloque(tot),
    autoSkuSombra: { total: sombra.total, coincideHumana: sombra.coincide, contradiceHumana: sombra.contradice },
    tiempoMedianoDecisionS: mediana === null || mediana === undefined ? null : Number(mediana),
  };
}
