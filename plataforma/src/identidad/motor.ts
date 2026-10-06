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
import { tituloMlDe } from './modelo-ml.ts';
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
  id: string; channel_account_id: string; recurso: string; variacion_normalizada: string; sku_observado: string | null; model_id: string | null; variant_id: string | null;
  titulo_observado: string | null;
}
/** Contadores de una corrida (se loguean al final; el retorno de correrMotor no cambia). */
interface Contadores { sinTituloMl: number; contenedorDifiereVariante: number; porFuente: Record<string, number> }

/** Arma el índice del catálogo Woo (candidato universo) de una empresa, una sola vez por corrida. */
/**
 * `atributos_crudos.attributes` de la representación Woo VIVA vinculada a la variante — NUNCA de una
 * representación ML, aunque esté vinculada a la misma variante (sería fuga de la verdad: el candidato
 * acertaría por construcción contra el dato que ya lo señala). El shape ({name, option}[]) es el mismo
 * que arma el legado y el que espera extraerAtributosDeAttrsWC del lado Woo real, así que se pasa tal cual.
 * Si no hay representación Woo o no trae `attributes`, la fila sigue sin atributos_json (fallback por
 * título de construirWC, como antes de este cambio).
 */
async function indiceWoo(tx: Consultable, empresa: string): Promise<IndiceWoo> {
  const filas = (await tx.query<{ sku: string; nombre: string; tipo: string; atributos_json: string | null; img: string | null }>(
    `SELECT sv.sku AS sku, pm.titulo AS nombre,
            CASE WHEN pm.origen = 'woo_padre' THEN 'variation' ELSE 'simple' END AS tipo,
            (SELECT (r.atributos_crudos->'attributes')::text FROM catalog.external_representations r
              WHERE r.canal = 'woocommerce' AND r.variant_id = sv.id AND r.archivado_en IS NULL
                AND jsonb_typeof(r.atributos_crudos->'attributes') = 'array'
              ORDER BY r.creado_en DESC LIMIT 1) AS atributos_json,
            NULL::text AS img
       FROM catalog.sellable_variants sv
       JOIN catalog.product_models pm ON pm.id = sv.model_id
      WHERE sv.company_id = $1 AND sv.sku IS NOT NULL AND sv.archivado_en IS NULL
        AND pm.origen IN ('woo_padre', 'woo_simple') AND pm.archivado_en IS NULL`,
    [empresa])).rows;
  return construirWCIndex(filas);
}

/** El ItemMl de candidatosDe para una representación de ML: título propio + color/talle de model_attributes. */
async function itemMlDe(tx: Consultable, rep: RepresentacionCaso, cont: Contadores): Promise<ItemMl | null> {
  const t = await tituloMlDe(tx, rep);
  if (!t) return null;
  cont.porFuente[t.fuente] = (cont.porFuente[t.fuente] ?? 0) + 1;
  if (t.difiere) cont.contenedorDifiereVariante++;
  const atributos = (await tx.query<{ nombre_normalizado: string; valor: string }>(
    `SELECT nombre_normalizado, valor FROM catalog.model_attributes
      WHERE representation_id = $1 AND nombre_normalizado IN ('color', 'talle') AND vigente_hasta IS NULL`,
    [rep.id])).rows;
  const color = atributos.filter((a) => a.nombre_normalizado === 'color').map((a) => a.valor).join(' ');
  const talle = atributos.filter((a) => a.nombre_normalizado === 'talle').map((a) => a.valor).join(' ');
  const ct = ctDesdeApi(color, talle);
  return { ml_title: t.titulo, ml_es_variante: ct.colores.size > 0 || ct.talles.size > 0, ml_variations: '', _ct: ct };
}

/** La representación gobernante del caso: la propia si la tiene, o la única de ML viva de su variante. */
async function representacionDe(tx: Consultable, caso: CasoAbierto): Promise<RepresentacionCaso | null> {
  if (caso.representation_id) {
    return (await tx.query<RepresentacionCaso>(
      `SELECT id, channel_account_id, recurso, variacion_normalizada, sku_observado, model_id, variant_id, titulo_observado
         FROM catalog.external_representations WHERE id = $1 AND canal = 'mercadolibre' AND archivado_en IS NULL`,
      [caso.representation_id])).rows[0] ?? null;
  }
  if (!caso.variant_id) return null;
  const reps = (await tx.query<RepresentacionCaso>(
    `SELECT id, channel_account_id, recurso, variacion_normalizada, sku_observado, model_id, variant_id, titulo_observado
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

/**
 * Marca los casos como procesados por esta versión del motor, HAYA O NO candidatos (un caso sin título o sin publicación
 * también tiene que salir del frente de la cola). Un solo UPDATE para todos, justo antes del COMMIT: la corrida es una
 * transacción larga y marcar caso por caso dejaría el lock de fila del primero hasta el final, frenando una decisión de la
 * bandeja. Con merge de jsonb: no toca version, estado ni
 * abierto_en, así una decisión de la bandeja con expected_version tomada antes de la corrida no da version_conflict.
 * `corrido_en` es texto ISO en UTC, que ordena igual que el tiempo.
 */
async function marcarCorridos(tx: Consultable, casoIds: string[]): Promise<void> {
  if (!casoIds.length) return;
  await tx.query(
    `UPDATE catalog.identity_cases
        SET detalle = detalle || jsonb_build_object('motor', jsonb_build_object(
              'engine', $2::text, 'corrido_en', to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')))
      WHERE id = ANY($1::uuid[])`, [casoIds, ENGINE_VERSION]);
}

function estable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(estable).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${estable((v as Record<string, unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(v);
}

/** ¿El top-3 de esta corrida es idéntico al de la última corrida guardada del caso (misma versión del motor)? */
async function mismoTop3(tx: Consultable, casoId: string, nuevo: { variantId: string; rank: number; puntaje: number; explicacion: unknown }[]): Promise<boolean> {
  const previas = (await tx.query<{ variant_id: string; rank: number; puntaje: string; explicacion: unknown; engine_version: string }>(
    `SELECT variant_id, rank, puntaje, explicacion, engine_version FROM catalog.identity_candidates
      WHERE case_id = $1 AND run_id = (SELECT run_id FROM catalog.identity_candidates WHERE case_id = $1 ORDER BY creado_en DESC, rank ASC LIMIT 1)
      ORDER BY rank`, [casoId])).rows;
  if (previas.length !== nuevo.length) return false;
  return previas.every((p, i) => p.engine_version === ENGINE_VERSION && p.variant_id === nuevo[i]!.variantId && p.rank === nuevo[i]!.rank
    && Number(p.puntaje) === Number(nuevo[i]!.puntaje) && estable(p.explicacion) === estable(JSON.parse(JSON.stringify(nuevo[i]!.explicacion))));
}

async function procesarCaso(tx: Consultable, caso: CasoAbierto, empresa: string, indice: IndiceWoo, runId: string, log: Logger, cont: Contadores): Promise<{ autoSku: boolean }> {
  const rep = await representacionDe(tx, caso);
  if (!rep) return { autoSku: false }; // sin publicación viva que gobierne: nada que el motor pueda anotar hoy.

  // Paso 1: candidatos, siempre que haya con qué calcularlos (título propio).
  const ml = await itemMlDe(tx, rep, cont);
  if (ml) {
    const candidatos = candidatosDe(ml, [], indice, 3);
    if (candidatos.length) {
      const skus = candidatos.map((c) => c.variantId);
      const variantesPorSku = new Map((await tx.query<{ id: string; sku: string }>(
        `SELECT id, sku FROM catalog.sellable_variants WHERE company_id = $1 AND sku = ANY($2) AND archivado_en IS NULL`,
        [empresa, skus])).rows.map((v) => [v.sku, v.id]));
      const aGuardar = candidatos.flatMap((c) => {
        const variantId = variantesPorSku.get(c.variantId);
        return variantId ? [{ ...c, variantId }] : []; // el candidato del motor Woo sin variante propia todavía (pendiente): no hay a qué apuntar el FK.
      });
      if (!(await mismoTop3(tx, caso.id, aGuardar))) for (const c of aGuardar) {
        const variantId = c.variantId;
        await tx.query(
          `INSERT INTO catalog.identity_candidates (case_id, run_id, variant_id, rank, puntaje, explicacion, fuentes, engine_version)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [caso.id, runId, variantId, c.rank, c.puntaje, JSON.stringify(c.explicacion), ['motor'], ENGINE_VERSION]);
      }
    }
  } else {
    cont.sinTituloMl++;
    log.warn('identidad.motor: sin_titulo_ml (ninguna fuente de título observado de ML), sin candidatos', { codigo: 'sin_titulo_ml', caso: caso.id, tipo: caso.tipo });
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
        ORDER BY COALESCE(CASE WHEN detalle->'motor'->>'engine' = $4 THEN detalle->'motor'->>'corrido_en' END, '') ASC, abierto_en ASC
        LIMIT $3`,
      [o.empresa, TIPOS_ABIERTOS, o.limite, ENGINE_VERSION])).rows;
    if (!casos.length) return { casos: 0, autoSku: 0 };

    const indice = await indiceWoo(tx, o.empresa);
    let autoSku = 0;
    const cont: Contadores = { sinTituloMl: 0, contenedorDifiereVariante: 0, porFuente: {} };
    for (const caso of casos) {
      const r = await procesarCaso(tx, caso, o.empresa, indice, runId, o.log, cont);
      if (r.autoSku) autoSku++;
    }
    await marcarCorridos(tx, casos.map((c) => c.id));
    o.log.info('identidad.motor: resumen de la corrida', { casos: casos.length, sin_titulo_ml: cont.sinTituloMl, contenedor_difiere_variante: cont.contenedorDifiereVariante, fuente_titulo: cont.porFuente });
    return { casos: casos.length, autoSku };
  });
}
