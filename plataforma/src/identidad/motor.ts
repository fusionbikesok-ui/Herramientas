/*
 * src/identidad/motor.ts — E3 corte 1 tarea 4: motor en sombra.
 *
 * Una corrida sobre los casos abiertos de tipo sku_pendiente/omitida_revisar/sku_inexistente_en_woo:
 *   1. Calcula el top-3 de candidatos (candidatosDe) y lo persiste en identity_candidates.
 *   2. Si el sku_observado (normalizado) resuelve por skuUnico a UNA sola variante, y la clave no
 *      tiene decisión humana vigente ni `omitir` del legado (decisionVigente), inserta una decisión
 *      auto_sku/sombra — NUNCA llama a reconciliarClave (D2: este corte no aplica auto-vínculo,
 *      sólo lo anota para la calibración de la tarea 7). Idempotente: si ya hay una auto_sku vigente
 *      con la MISMA variante para esa clave, no inserta de nuevo.
 *
 * Fuente de datos (spec del plan): título de catalog.product_models, color/talle de
 * catalog.model_attributes (ya persistidos por E2, T2 de la 0014) — NUNCA del inbox cifrado. Si un
 * caso necesitara un dato que sólo está ahí, el motor no lo descifra: lo deja sin candidatos en vez
 * de inventar un atajo.
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { decisionVigente } from './autoridad.ts';
import { candidatosDe, construirWCIndex, ctDesdeApi, type IndiceWoo, type ItemMl, type ItemWoo } from './candidatos.ts';
import { normalizarSku, skuUnico } from './sku.ts';
import type { Consultable } from '../db/pool.ts';
import { enTransaccion } from '../db/pool.ts';

export const ENGINE_VERSION = 'e3-motor-1';

export interface Logger { info(msg: string, meta?: object): void; warn(msg: string, meta?: object): void; error(msg: string, meta?: object): void; }

const TIPOS_ABIERTOS = ['sku_pendiente', 'omitida_revisar', 'sku_inexistente_en_woo'] as const;

interface CasoAbierto {
  id: string; company_id: string; variant_id: string | null; representation_id: string | null; tipo: string;
}
interface RepresentacionCaso {
  id: string; channel_account_id: string; recurso: string; variacion_normalizada: string; sku_observado: string | null; model_id: string | null;
}

/** Arma el índice del catálogo Woo (candidato universo) de una empresa, una sola vez por corrida. */
async function indiceWoo(tx: Consultable, empresa: string): Promise<IndiceWoo> {
  const filas = (await tx.query<{ sku: string; nombre: string; tipo: string; atributos_json: string | null; img: string | null }>(
    `SELECT sv.sku AS sku, pm.titulo AS nombre,
            CASE WHEN pm.origen = 'woo_padre' THEN 'variation' ELSE 'simple' END AS tipo,
            NULL::text AS atributos_json, NULL::text AS img
       FROM catalog.sellable_variants sv
       JOIN catalog.product_models pm ON pm.id = sv.model_id
      WHERE sv.company_id = $1 AND sv.sku IS NOT NULL AND sv.archivado_en IS NULL
        AND pm.origen IN ('woo_padre', 'woo_simple') AND pm.archivado_en IS NULL`,
    [empresa])).rows;
  // El atributo_json estructurado no existe del lado plataforma (E2 lo partió en model_attributes,
  // no lo conserva crudo) — construirWC cae sola al fallback por título cuando atributos_json es
  // null, que es exactamente lo que corresponde acá (mismo camino que un WC sin atributos_json real).
  return construirWCIndex(filas);
}

/** El ItemMl de candidatosDe para una representación de ML: título propio + color/talle de model_attributes. */
async function itemMlDe(tx: Consultable, rep: RepresentacionCaso): Promise<ItemMl | null> {
  if (!rep.model_id) return null;
  const modelo = (await tx.query<{ titulo: string }>(
    'SELECT titulo FROM catalog.product_models WHERE id = $1', [rep.model_id])).rows[0];
  if (!modelo) return null;
  const atributos = (await tx.query<{ nombre_normalizado: string; valor: string }>(
    `SELECT nombre_normalizado, valor FROM catalog.model_attributes
      WHERE representation_id = $1 AND nombre_normalizado IN ('color', 'talle') AND vigente_hasta IS NULL`,
    [rep.id])).rows;
  const color = atributos.filter((a) => a.nombre_normalizado === 'color').map((a) => a.valor).join(' ');
  const talle = atributos.filter((a) => a.nombre_normalizado === 'talle').map((a) => a.valor).join(' ');
  const ct = ctDesdeApi(color, talle);
  return { ml_title: modelo.titulo, ml_es_variante: ct.colores.size > 0 || ct.talles.size > 0, ml_variations: '', _ct: ct };
}

/** La representación gobernante del caso: la propia si la tiene, o la única de ML viva de su variante. */
async function representacionDe(tx: Consultable, caso: CasoAbierto): Promise<RepresentacionCaso | null> {
  if (caso.representation_id) {
    return (await tx.query<RepresentacionCaso>(
      `SELECT id, channel_account_id, recurso, variacion_normalizada, sku_observado, model_id
         FROM catalog.external_representations WHERE id = $1 AND canal = 'mercadolibre' AND archivado_en IS NULL`,
      [caso.representation_id])).rows[0] ?? null;
  }
  if (!caso.variant_id) return null;
  const reps = (await tx.query<RepresentacionCaso>(
    `SELECT id, channel_account_id, recurso, variacion_normalizada, sku_observado, model_id
       FROM catalog.external_representations WHERE variant_id = $1 AND canal = 'mercadolibre' AND archivado_en IS NULL`,
    [caso.variant_id])).rows;
  return reps.length === 1 ? reps[0]! : null;
}

/**
 * La auto_sku en sombra vigente de esta clave, si hay. Idempotencia del paso 2: si apunta a la MISMA variante no se
 * anota otra vez; si apunta a otra (el SKU pasó a resolver distinto) la nueva la supera — el UNIQUE parcial de
 * (clave, efecto) no admite dos vigentes y un 23505 abortaría la corrida entera.
 */
async function autoSkuVigente(tx: Consultable, cuenta: string, recurso: string, variacion: string): Promise<{ id: string; variant_id: string | null } | undefined> {
  return (await tx.query<{ id: string; variant_id: string | null }>(
    `SELECT id, variant_id FROM catalog.identity_decisions
      WHERE channel_account_id = $1 AND recurso = $2 AND variacion_normalizada = $3
        AND origen = 'auto_sku' AND efecto = 'sombra' AND superada_en IS NULL`,
    [cuenta, recurso, variacion])).rows[0];
}

async function correrCaso(tx: Consultable, caso: CasoAbierto, empresa: string, indice: IndiceWoo, runId: string, log: Logger): Promise<{ autoSku: boolean }> {
  const rep = await representacionDe(tx, caso);
  if (!rep) return { autoSku: false }; // sin publicación viva que gobierne: nada que el motor pueda anotar hoy.

  // Paso 1: candidatos, siempre que haya con qué calcularlos (título propio).
  const ml = await itemMlDe(tx, rep);
  if (ml) {
    const candidatos = candidatosDe(ml, [], indice, 3);
    if (candidatos.length) {
      const skus = candidatos.map((c) => c.variantId);
      const variantesPorSku = new Map((await tx.query<{ id: string; sku: string }>(
        `SELECT id, sku FROM catalog.sellable_variants WHERE company_id = $1 AND sku = ANY($2) AND archivado_en IS NULL`,
        [empresa, skus])).rows.map((v) => [v.sku, v.id]));
      for (const c of candidatos) {
        const variantId = variantesPorSku.get(c.variantId);
        if (!variantId) continue; // el candidato del motor Woo no tiene variante propia todavía (pendiente): no hay a qué apuntar el FK.
        await tx.query(
          `INSERT INTO catalog.identity_candidates (case_id, run_id, variant_id, rank, puntaje, explicacion, fuentes, engine_version)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [caso.id, runId, variantId, c.rank, c.puntaje, JSON.stringify(c.explicacion), ['motor'], ENGINE_VERSION]);
      }
    }
  } else {
    log.warn('identidad.motor: caso sin título propio (model_id ausente), sin candidatos', { caso: caso.id });
  }

  // Paso 2: auto-SKU en sombra.
  const skuNorm = normalizarSku(rep.sku_observado);
  const resuelto = skuNorm ? await skuUnico(tx, empresa, skuNorm) : 'ninguna';
  const vigente = await decisionVigente(tx, rep.channel_account_id, rep.recurso, rep.variacion_normalizada, { bandeja: true });

  // Marca D5 (enmienda de Codex sobre el plan): un caso omitida_revisar cuya clave tiene un `omitir`
  // vigente del legado, con SKU observado que ahora resuelve único, es una omisión vieja que el motor
  // no puede levantar solo (D2: sin auto-vínculo aplicado este corte) pero sí puede señalar para que
  // una persona la revise con prioridad — `detalle.d5=true`. UPDATE idempotente (no reescribe si ya
  // coincide) y se QUITA si el SKU deja de ser único (la marca no es un hecho permanente del caso).
  if (caso.tipo === 'omitida_revisar') {
    const esD5 = resuelto !== 'ninguna' && resuelto !== 'varias' && !!vigente && vigente.fuente === 'legado' && vigente.accion === 'omitir';
    await tx.query(
      `UPDATE catalog.identity_cases SET detalle = CASE WHEN $2 THEN detalle || '{"d5":true}'::jsonb ELSE detalle - 'd5' END
        WHERE id = $1 AND COALESCE((detalle->>'d5')::boolean, false) IS DISTINCT FROM $2`,
      [caso.id, esD5]);
  }

  if (resuelto === 'ninguna' || resuelto === 'varias') return { autoSku: false };
  if (vigente && (vigente.fuente === 'humano' || (vigente.fuente === 'legado' && vigente.accion === 'omitir'))) return { autoSku: false };

  const previa = await autoSkuVigente(tx, rep.channel_account_id, rep.recurso, rep.variacion_normalizada);
  if (previa && previa.variant_id === resuelto.variantId) return { autoSku: false };

  await tx.query(
    `INSERT INTO catalog.identity_decisions
       (company_id, case_id, channel_account_id, recurso, variacion_normalizada, eleccion, variant_id,
        origen, actor, efecto, engine_version, supersede_a)
     VALUES ($1, $2, $3, $4, $5, 'vincular', $6, 'auto_sku', 'identidad.motor', 'sombra', $7, $8)`,
    [empresa, caso.id, rep.channel_account_id, rep.recurso, rep.variacion_normalizada, resuelto.variantId, ENGINE_VERSION, previa?.id ?? null]);
  return { autoSku: true };
}

export async function correrMotor(pool: pg.Pool, o: { empresa: string; limite: number; log: Logger }): Promise<{ casos: number; autoSku: number }> {
  const runId = randomUUID();
  return enTransaccion(pool, async (tx) => {
    const casos = (await tx.query<CasoAbierto>(
      `SELECT id, company_id, variant_id, representation_id, tipo FROM catalog.identity_cases
        WHERE company_id = $1 AND cerrado_en IS NULL AND tipo = ANY($2)
        ORDER BY abierto_en ASC LIMIT $3`,
      [o.empresa, TIPOS_ABIERTOS, o.limite])).rows;
    if (!casos.length) return { casos: 0, autoSku: 0 };

    const indice = await indiceWoo(tx, o.empresa);
    let autoSku = 0;
    for (const caso of casos) {
      const r = await correrCaso(tx, caso, o.empresa, indice, runId, o.log);
      if (r.autoSku) autoSku++;
    }
    return { casos: casos.length, autoSku };
  });
}
