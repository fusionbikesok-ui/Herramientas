/*
 * src/catalogo/aplicar.ts — escribir una proyección en el catálogo, dentro de la transacción del proyector.
 *
 * Las proyecciones (`woo.ts`, `ml.ts`) dicen lo que el canal muestra. Acá se decide qué significa, con el
 * contexto que sólo tiene la base: qué SKU ya está tomado, qué decidió el matcher, qué versión ya se vio.
 *
 * Invariantes:
 *   - Una versión remota más vieja que la ya vista no pisa nada (los mensajes pueden llegar desordenados).
 *   - Lo que no se puede decidir es un caso con su objeto, nunca un descarte ni una suposición.
 *   - Un SKU canónico se asigna sólo si nadie más lo tiene ni lo muestra; si no, caso.
 *   - La identidad de ML sale de las decisiones del matcher, no de lo que ML muestra.
 *   - Una representación ya vinculada no se re-vincula acá: mover una publicación de una variante a otra es
 *     una fusión o una revocación, y eso lo hace `decisiones.ts` (tarea 8), con su evento y su auditoría.
 */
import type { Consultable } from '../db/pool.ts';
import { bloquearDecisiones, reconciliarSku } from './decisiones.ts';
import type { OrigenModelo, Proyeccion, RepresentacionObservada, SkuObservado } from './intenciones.ts';

export type Canal = 'woocommerce' | 'mercadolibre';

export interface ContextoAplicacion {
  tx: Consultable;
  cuenta: string;
  canal: Canal;
  /** La versión remota del mensaje: ISO de la fecha de modificación, comparable como texto. */
  versionRemota: string;
}

export interface ResumenAplicacion {
  representaciones: number;
  /** Representaciones que no se tocaron porque ya había una versión más nueva. */
  viejas: number;
  casosAbiertos: string[];
}

export type TipoCaso =
  | 'sku_pendiente' | 'omitida_revisar' | 'sku_inexistente_en_woo' | 'woo_sin_sku'
  | 'woo_sku_duplicado' | 'woo_sku_no_canonico' | 'user_product_divergente' | 'atributo_divergente';

/** Casos que una observación de Woo puede abrir y, cuando el SKU queda bien, cerrar. */
const CASOS_SKU_WOO: TipoCaso[] = ['woo_sin_sku', 'woo_sku_no_canonico', 'woo_sku_duplicado', 'sku_pendiente'];

interface RepExistente {
  id: string; variant_id: string | null; version_remota: string | null; omitida_por_decision: boolean;
}

const textoSku = (s: SkuObservado): string | null => ('valor' in s ? s.valor : null);

export async function aplicarProyeccion(ctx: ContextoAplicacion, p: Proyeccion): Promise<ResumenAplicacion> {
  const { tx } = ctx;
  const empresa = (await tx.query<{ company_id: string }>(
    'SELECT company_id FROM core.channel_accounts WHERE id = $1', [ctx.cuenta])).rows[0]?.company_id;
  if (!empresa) throw new Error(`cuenta de canal inexistente: ${ctx.cuenta}`);
  const resumen: ResumenAplicacion = { representaciones: 0, viejas: 0, casosAbiertos: [] };

  // Serializa por recurso ANTES de tocar cualquier fila (hallazgo crítico de la revisión de la implementación):
  // dos mensajes de un recurso NUEVO (el bootstrap y un barrido, por ejemplo) no encuentran fila que bloquear,
  // crean cada uno su variante y compiten en el upsert; el más viejo podía pisar al más nuevo y dejar una variante
  // huérfana. Orden de candados: recurso → filas de la representación → decisiones → variantes. Los eventos del
  // matcher no toman éste, así que no hay ciclo.
  const recursos = [...new Set(p.representaciones.map((r) => r.recurso))].sort();
  for (const recurso of recursos) {
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('catalogo.recurso:' || $1 || ':' || $2, 0))", [ctx.cuenta, recurso]);
  }

  // El modelo propio se crea sólo si alguien lo usa: un ítem de ML vinculado a un SKU de Woo cuelga del
  // modelo de esa variante, y crear un `ml_simple` vacío para él sería ruido en el catálogo.
  let modeloPropio: string | null = null;
  // Una variación de Woo no es dueña del modelo: el título es del padre y la baja de la variación no archiva
  // al padre. En todos los demás casos el payload describe su propio modelo.
  const esVariacionWoo = ctx.canal === 'woocommerce' && p.representaciones.some((r) => r.variacion !== '');
  const obtenerModelo = async (): Promise<string> => {
    if (modeloPropio) return modeloPropio;
    modeloPropio = await upsertModelo(tx, empresa, ctx.cuenta, p.modelo.origen, p.modelo.claveOrigen,
      p.modelo.titulo, !esVariacionWoo, esVariacionWoo ? null : p.archivar);
    return modeloPropio;
  };

  const abrir = async (tipo: TipoCaso, objeto: { variante?: string; representacion?: string },
    detalle: Record<string, unknown> = {}, prioridad: 'baja' | 'normal' = 'normal') => {
    const r = await tx.query(
      `INSERT INTO catalog.identity_cases (company_id, tipo, prioridad, variant_id, representation_id, detalle)
       VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`,
      [empresa, tipo, prioridad, objeto.variante ?? null, objeto.representacion ?? null, JSON.stringify(detalle)]);
    if (r.rowCount) resumen.casosAbiertos.push(tipo);
  };
  const cerrar = (variante: string, tipos: TipoCaso[], motivo: string) => tx.query(
    `UPDATE catalog.identity_cases SET cerrado_en = now(), motivo_cierre = $3
      WHERE variant_id = $1 AND tipo = ANY($2) AND cerrado_en IS NULL`, [variante, tipos, motivo]);

  for (const obs of p.representaciones) {
    const existente = (await tx.query<RepExistente>(
      `SELECT id, variant_id, version_remota, omitida_por_decision FROM catalog.external_representations
        WHERE channel_account_id = $1 AND recurso = $2 AND variacion_normalizada = $3 FOR UPDATE`,
      [ctx.cuenta, obs.recurso, obs.variacion])).rows[0];
    if (existente?.version_remota && ctx.versionRemota && ctx.versionRemota < existente.version_remota) {
      resumen.viejas++;
      continue;
    }

    if (obs.tipo === 'contenedor') {
      await upsertRepresentacion(tx, empresa, ctx, obs, { modelo: await obtenerModelo(), variante: null, omitida: false }, p.archivar);
      resumen.representaciones++;
      continue;
    }

    const vinculo = ctx.canal === 'woocommerce'
      ? await vincularWoo(tx, empresa, ctx, obs, existente, obtenerModelo, abrir, cerrar)
      : await vincularMl(tx, empresa, ctx, obs, existente, obtenerModelo, abrir);
    const repId = await upsertRepresentacion(tx, empresa, ctx, obs, vinculo, p.archivar);
    resumen.representaciones++;

    if (vinculo.casoSobreRepresentacion) {
      await abrir(vinculo.casoSobreRepresentacion.tipo, { representacion: repId },
        vinculo.casoSobreRepresentacion.detalle, vinculo.casoSobreRepresentacion.prioridad);
    }
    if (obs.userProductId && vinculo.variante) {
      await revisarUserProduct(tx, ctx.cuenta, repId, obs.userProductId, vinculo.variante, abrir);
    }
  }
  return resumen;
}

interface Vinculo {
  modelo: string | null;
  variante: string | null;
  omitida: boolean;
  casoSobreRepresentacion?: { tipo: TipoCaso; detalle: Record<string, unknown>; prioridad: 'baja' | 'normal' };
}

type Abrir = (tipo: TipoCaso, objeto: { variante?: string; representacion?: string },
  detalle?: Record<string, unknown>, prioridad?: 'baja' | 'normal') => Promise<void>;

/**
 * Woo es la fuente del SKU canónico. La variante se crea la primera vez que se ve el producto que se
 * vende, y recibe FB-{ID_WOO} sólo si Woo muestra exactamente eso y nadie más lo tiene ni lo muestra.
 */
async function vincularWoo(
  tx: Consultable, empresa: string, ctx: ContextoAplicacion, obs: RepresentacionObservada,
  existente: RepExistente | undefined, obtenerModelo: () => Promise<string>, abrir: Abrir,
  cerrar: (variante: string, tipos: TipoCaso[], motivo: string) => Promise<unknown>,
): Promise<Vinculo> {
  // Orden de candados: primero el de decisiones, después las filas. Si Woo asigna el SKU, reconciliarSku va a
  // pedir el candado de las cuentas de ML; tomarlo DESPUÉS de bloquear la variante invertía el orden de un
  // evento (candado → variante) y podía terminar en deadlock. Los advisory locks son reentrantes: pedirlo de
  // nuevo más adelante no bloquea.
  if (obs.sku.estado === 'canonico') {
    const cuentasMl = (await tx.query<{ id: string }>(
      "SELECT id FROM core.channel_accounts WHERE company_id = $1 AND channel = 'mercadolibre' ORDER BY id", [empresa])).rows;
    for (const c of cuentasMl) await bloquearDecisiones(tx, c.id);
  }
  const modelo = await obtenerModelo();
  const variante = existente?.variant_id ?? (await tx.query<{ id: string }>(
    'INSERT INTO catalog.sellable_variants (company_id, model_id) VALUES ($1, $2) RETURNING id',
    [empresa, modelo])).rows[0]!.id;
  const actual = (await tx.query<{ sku: string | null }>(
    'SELECT sku FROM catalog.sellable_variants WHERE id = $1 FOR UPDATE', [variante])).rows[0]!.sku;

  if (obs.sku.estado === 'vacio') {
    await abrir('woo_sin_sku', { variante });
  } else if (obs.sku.estado === 'otro') {
    await abrir('woo_sku_no_canonico', { variante }, { observado: obs.sku.valor });
  } else if (obs.sku.estado === 'canonico') {
    const valor = obs.sku.valor;
    if (actual === valor) {
      await cerrar(variante, CASOS_SKU_WOO, 'Woo muestra el SKU canónico');
    } else if (actual === null) {
      // "Nadie más lo tiene ni lo muestra": otra variante con ese SKU, u otro producto de la misma tienda
      // que lo tiene cargado (para él sería 'otro', pero el valor está repetido en Woo).
      const tomado = (await tx.query<{ n: number }>(
        `SELECT (SELECT count(*) FROM catalog.sellable_variants WHERE company_id = $1 AND sku = $2)
              + (SELECT count(*) FROM catalog.external_representations
                  WHERE channel_account_id = $3 AND sku_observado = $2
                    AND NOT (recurso = $4 AND variacion_normalizada = $5)) AS n`,
        [empresa, valor, ctx.cuenta, obs.recurso, obs.variacion])).rows[0]!.n;
      if (Number(tomado) > 0) {
        await abrir('woo_sku_duplicado', { variante }, { sku: valor });
      } else {
        await tx.query('UPDATE catalog.sellable_variants SET sku = $2, version = version + 1 WHERE id = $1', [variante, valor]);
        await cerrar(variante, CASOS_SKU_WOO, 'SKU canónico asignado');
        // Publicaciones de ML que esperaban este SKU (caso sku_inexistente_en_woo) se fusionan ahora.
        await reconciliarSku(tx, empresa, valor, `apareció ${valor} en Woo`);
      }
    }
    // Si la variante ya tiene otro SKU, el canónico de un id de Woo no cambia nunca: no hay nada que hacer.
  }
  return { modelo, variante, omitida: false };
}

/**
 * ML: la identidad sale de la decisión vigente del matcher. Sin decisión, variante con SKU pendiente y
 * caso; con `omitir`, representación omitida sin variante y caso de baja prioridad.
 */
async function vincularMl(
  tx: Consultable, empresa: string, ctx: ContextoAplicacion, obs: RepresentacionObservada,
  existente: RepExistente | undefined, obtenerModelo: () => Promise<string>, abrir: Abrir,
): Promise<Vinculo> {
  // Ya vinculada: el re-vínculo es trabajo de decisiones.ts. Acá sólo se refrescan los datos observados.
  if (existente?.variant_id) return { modelo: null, variante: existente.variant_id, omitida: false };
  if (existente?.omitida_por_decision) return { modelo: null, variante: null, omitida: true };

  // Mismo candado que los eventos: si no, un evento que llega mientras esta publicación nueva todavía no está
  // confirmada no la encuentra, y acá se lee "sin decisión": quedaría pendiente con una decisión vigente.
  await bloquearDecisiones(tx, ctx.cuenta);
  const decision = (await tx.query<{ accion: string; sku: string | null }>(
    `SELECT accion, sku FROM catalog.matcher_decisions
      WHERE channel_account_id = $1 AND recurso = $2 AND variacion_normalizada = $3 AND vigente_hasta IS NULL`,
    [ctx.cuenta, obs.recurso, obs.variacion])).rows[0];

  if (decision?.accion === 'omitir') {
    return {
      modelo: null, variante: null, omitida: true,
      casoSobreRepresentacion: { tipo: 'omitida_revisar', detalle: {}, prioridad: 'baja' },
    };
  }
  if ((decision?.accion === 'confirmar' || decision?.accion === 'asignar') && decision.sku) {
    const destino = (await tx.query<{ id: string }>(
      'SELECT id FROM catalog.sellable_variants WHERE company_id = $1 AND sku = $2', [empresa, decision.sku])).rows[0];
    if (destino) return { modelo: null, variante: destino.id, omitida: false };
    // La decisión apunta a un SKU que todavía no está (o nunca va a estar) en Woo. Si después aparece, la
    // fusión de la variante pendiente con la del SKU la hace decisiones.ts.
    const pendiente = await crearPendiente(tx, empresa, await obtenerModelo());
    await abrir('sku_inexistente_en_woo', { variante: pendiente }, { sku: decision.sku });
    return { modelo: null, variante: pendiente, omitida: false };
  }
  const pendiente = await crearPendiente(tx, empresa, await obtenerModelo());
  await abrir('sku_pendiente', { variante: pendiente });
  return { modelo: null, variante: pendiente, omitida: false };
}

async function crearPendiente(tx: Consultable, empresa: string, modelo: string): Promise<string> {
  return (await tx.query<{ id: string }>(
    'INSERT INTO catalog.sellable_variants (company_id, model_id) VALUES ($1, $2) RETURNING id',
    [empresa, modelo])).rows[0]!.id;
}

/**
 * user_product_id es una pista de variante (decisión de José, 2026-09-18): si otra publicación de la misma
 * cuenta muestra el mismo valor y está vinculada a otra variante, se abre un caso. Nunca se fusiona sola.
 */
async function revisarUserProduct(
  tx: Consultable, cuenta: string, repId: string, userProductId: string, variante: string, abrir: Abrir,
): Promise<void> {
  const otras = (await tx.query<{ recurso: string; variacion_normalizada: string }>(
    `SELECT recurso, variacion_normalizada FROM catalog.external_representations
      WHERE channel_account_id = $1 AND user_product_id = $2 AND id <> $3
        AND variant_id IS NOT NULL AND variant_id <> $4 AND archivado_en IS NULL`,
    [cuenta, userProductId, repId, variante])).rows;
  if (otras.length) {
    await abrir('user_product_divergente', { representacion: repId }, {
      user_product_id: userProductId,
      otras: otras.map((o) => (o.variacion_normalizada ? `${o.recurso}/${o.variacion_normalizada}` : o.recurso)),
    });
  }
}

async function upsertModelo(
  tx: Consultable, empresa: string, cuenta: string, origen: OrigenModelo, clave: string, titulo: string,
  actualizarTitulo: boolean, archivar: string | null,
): Promise<string> {
  return (await tx.query<{ id: string }>(
    `INSERT INTO catalog.product_models (company_id, channel_account_id, origen, clave_origen, titulo, archivado_en, motivo_archivo)
     VALUES ($1, $2, $3, $4, $5, CASE WHEN $7::text IS NULL THEN NULL ELSE now() END, $7)
     ON CONFLICT (channel_account_id, origen, clave_origen) DO UPDATE SET
       titulo = CASE WHEN $6 THEN EXCLUDED.titulo ELSE product_models.titulo END,
       observado_en = now(),
       -- Sólo quien describe al modelo lo archiva o lo reactiva (no una variación de Woo, que pasa $6 = false).
       archivado_en = CASE WHEN NOT $6 THEN product_models.archivado_en
                           WHEN $7::text IS NULL THEN NULL
                           ELSE COALESCE(product_models.archivado_en, now()) END,
       motivo_archivo = CASE WHEN NOT $6 THEN product_models.motivo_archivo ELSE $7 END,
       version = product_models.version + 1
     RETURNING id`,
    [empresa, cuenta, origen, clave, titulo, actualizarTitulo, archivar])).rows[0]!.id;
}

async function upsertRepresentacion(
  tx: Consultable, empresa: string, ctx: ContextoAplicacion, obs: RepresentacionObservada,
  v: { modelo: string | null; variante: string | null; omitida: boolean }, archivar: string | null,
): Promise<string> {
  return (await tx.query<{ id: string }>(
    `INSERT INTO catalog.external_representations
       (company_id, channel_account_id, canal, recurso, variacion_normalizada, tipo, model_id, variant_id,
        omitida_por_decision, sku_observado, user_product_id, estado_remoto, version_remota, archivado_en, motivo_archivo)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, CASE WHEN $14::text IS NULL THEN NULL ELSE now() END, $14)
     ON CONFLICT (channel_account_id, recurso, variacion_normalizada) DO UPDATE SET
       tipo = EXCLUDED.tipo, model_id = EXCLUDED.model_id, variant_id = EXCLUDED.variant_id,
       omitida_por_decision = EXCLUDED.omitida_por_decision,
       sku_observado = EXCLUDED.sku_observado, user_product_id = EXCLUDED.user_product_id,
       estado_remoto = EXCLUDED.estado_remoto, version_remota = EXCLUDED.version_remota, observado_en = now(),
       -- La reaparición desarchiva: una publicación que vuelve de la papelera es la misma representación.
       archivado_en = CASE WHEN $14::text IS NULL THEN NULL
                           ELSE COALESCE(external_representations.archivado_en, now()) END,
       motivo_archivo = $14
     RETURNING id`,
    [empresa, ctx.cuenta, ctx.canal, obs.recurso, obs.variacion, obs.tipo, v.modelo, v.variante, v.omitida,
      textoSku(obs.sku), obs.userProductId, obs.estadoRemoto, ctx.versionRemota || null, archivar])).rows[0]!.id;
}
