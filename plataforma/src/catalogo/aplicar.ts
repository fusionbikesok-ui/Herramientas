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
import { decisionVigente } from '../identidad/autoridad.ts';
import { valoresRelacionados } from './atributos.ts';
import { bloquearDecisiones, reconciliarSku } from './decisiones.ts';
import type { OrigenModelo, Proyeccion, RepresentacionObservada, SkuObservado } from './intenciones.ts';

export type Canal = 'woocommerce' | 'mercadolibre';

export interface ContextoAplicacion {
  tx: Consultable;
  cuenta: string;
  canal: Canal;
  /** La versión remota del mensaje: ISO de la fecha de modificación, comparable como texto. */
  versionRemota: string;
  /** Abrir `atributo_divergente`. Por defecto NO (se despliega capturando, se enciende después de medir). */
  compararAtributos?: boolean;
  /** E3_BANDEJA: si una decisión humana de la bandeja manda sobre la copiada del legado. Por defecto NO
   *  (comportamiento idéntico a antes de E3, bit a bit: decisionVigente ni consulta identity_decisions). */
  bandeja?: boolean;
}

export interface ResumenAplicacion {
  representaciones: number;
  /** Representaciones que no se tocaron porque ya había una versión más nueva. */
  viejas: number;
  casosAbiertos: string[];
  /** 6b: modelos tocados por esta proyección (COALESCE(r.model_id, v.model_id) de cada representación escrita). */
  modelos: string[];
  /** 6b: de esos, los que tuvieron un valor de `categoria_canal` abierto o cerrado en esta proyección. */
  categoriaCambio: Set<string>;
  empresa: string;
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
  const resumen: ResumenAplicacion = { representaciones: 0, viejas: 0, casosAbiertos: [], modelos: [], categoriaCambio: new Set(), empresa };

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
      const contenedorId = await upsertRepresentacion(tx, empresa, ctx, obs, { modelo: await obtenerModelo(), variante: null, omitida: false }, p.archivar);
      resumen.representaciones++;
      await persistirExtras(tx, ctx, contenedorId, obs, resumen, empresa);
      continue;
    }

    const vinculo = ctx.canal === 'woocommerce'
      ? await vincularWoo(tx, empresa, ctx, obs, existente, obtenerModelo, abrir, cerrar)
      : await vincularMl(tx, empresa, ctx, obs, existente, obtenerModelo, abrir);
    const repId = await upsertRepresentacion(tx, empresa, ctx, obs, vinculo, p.archivar);
    resumen.representaciones++;
    await persistirExtras(tx, ctx, repId, obs, resumen, empresa);

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
        await reconciliarSku(tx, empresa, valor, `apareció ${valor} en Woo`, { bandeja: ctx.bandeja ?? false });
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
  // Ya vinculada: el re-vínculo es trabajo de decisiones.ts. Igual se llama obtenerModelo() (punto B, hallazgo
  // de José 2026-09-24: 52% de las representaciones vendibles de ML sin título observable) — un ítem de ML SIN
  // variaciones nunca genera un 'contenedor' aparte (ver ml.ts proyectarItemMl), así que si esta rama no
  // persiste su modelo ml_simple, el título que trae el payload se pierde para siempre: no hay otra fila que
  // lo guarde. `upsertModelo` es idempotente por (cuenta, origen, clave_origen), así que esto no crea
  // duplicados ni cambia a qué variante queda vinculada la representación.
  if (existente?.variant_id) return { modelo: await obtenerModelo(), variante: existente.variant_id, omitida: false };
  if (existente?.omitida_por_decision) return { modelo: null, variante: null, omitida: true };

  // Mismo candado que los eventos: si no, un evento que llega mientras esta publicación nueva todavía no está
  // confirmada no la encuentra, y acá se lee "sin decisión": quedaría pendiente con una decisión vigente.
  await bloquearDecisiones(tx, ctx.cuenta);
  const decision = await decisionVigente(tx, ctx.cuenta, obs.recurso, obs.variacion, { bandeja: ctx.bandeja ?? false });

  if (decision?.fuente === 'humano' && decision.eleccion === 'vincular') {
    return { modelo: await obtenerModelo(), variante: decision.variantId, omitida: false };
  }
  if (decision?.fuente === 'humano' && (decision.eleccion === 'omitir' || decision.eleccion === 'mantener_omision')) {
    return {
      modelo: null, variante: null, omitida: true,
      casoSobreRepresentacion: { tipo: 'omitida_revisar', detalle: {}, prioridad: 'baja' },
    };
  }
  if (decision?.fuente === 'humano' && decision.eleccion === 'sin_candidato') {
    const pendiente = await crearPendiente(tx, empresa, await obtenerModelo());
    await abrir('sku_pendiente', { variante: pendiente });
    return { modelo: null, variante: pendiente, omitida: false };
  }
  if (decision?.fuente === 'legado' && decision.accion === 'omitir') {
    return {
      modelo: null, variante: null, omitida: true,
      casoSobreRepresentacion: { tipo: 'omitida_revisar', detalle: {}, prioridad: 'baja' },
    };
  }
  if (decision?.fuente === 'legado' && (decision.accion === 'confirmar' || decision.accion === 'asignar')) {
    // Fallback al legado EXACTO como hoy: sin filtrar archivadas (ver autoridad.ts). No es un cambio de
    // comportamiento, es el mismo SELECT que había acá antes, ahora dentro de decisionVigente.
    const destino = (await tx.query<{ id: string }>(
      'SELECT id FROM catalog.sellable_variants WHERE company_id = $1 AND sku = $2', [empresa, decision.sku])).rows[0];
    if (destino) return { modelo: await obtenerModelo(), variante: destino.id, omitida: false };
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
        omitida_por_decision, sku_observado, user_product_id, estado_remoto, version_remota, archivado_en, motivo_archivo,
        atributos_crudos, comercial_crudo, capturado_en, precio, moneda, stock_canal, gtin)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, CASE WHEN $14::text IS NULL THEN NULL ELSE now() END, $14,
        $15::jsonb, $16::jsonb, CASE WHEN $15::jsonb IS NOT NULL OR $16::jsonb IS NOT NULL THEN now() END,
        $17::numeric, $18, $19::integer, $20)
     ON CONFLICT (channel_account_id, recurso, variacion_normalizada) DO UPDATE SET
       tipo = EXCLUDED.tipo, model_id = EXCLUDED.model_id, variant_id = EXCLUDED.variant_id,
       omitida_por_decision = EXCLUDED.omitida_por_decision,
       sku_observado = EXCLUDED.sku_observado, user_product_id = EXCLUDED.user_product_id,
       estado_remoto = EXCLUDED.estado_remoto, version_remota = EXCLUDED.version_remota, observado_en = now(),
       -- La reaparición desarchiva: una publicación que vuelve de la papelera es la misma representación.
       archivado_en = CASE WHEN $14::text IS NULL THEN NULL
                           ELSE COALESCE(external_representations.archivado_en, now()) END,
       motivo_archivo = $14,
       -- Lo capturado se pisa sólo si esta observación trae datos: una proyección sin extras no borra lo que ya había.
       atributos_crudos = COALESCE(EXCLUDED.atributos_crudos, external_representations.atributos_crudos),
       comercial_crudo = COALESCE(EXCLUDED.comercial_crudo, external_representations.comercial_crudo),
       capturado_en = COALESCE(EXCLUDED.capturado_en, external_representations.capturado_en),
       precio = COALESCE(EXCLUDED.precio, external_representations.precio),
       moneda = COALESCE(EXCLUDED.moneda, external_representations.moneda),
       stock_canal = COALESCE(EXCLUDED.stock_canal, external_representations.stock_canal),
       gtin = COALESCE(EXCLUDED.gtin, external_representations.gtin)
     RETURNING id`,
    [empresa, ctx.cuenta, ctx.canal, obs.recurso, obs.variacion, obs.tipo, v.modelo, v.variante, v.omitida,
      textoSku(obs.sku), obs.userProductId, obs.estadoRemoto, ctx.versionRemota || null, archivar,
      obs.crudo ? JSON.stringify(obs.crudo.atributos ?? null) : null, obs.crudo ? JSON.stringify(obs.crudo.comercial ?? null) : null,
      numeroAcotado(obs.comercial?.precio, 1e10), obs.comercial?.moneda ?? null,
      numeroAcotado(obs.comercial?.stock, 2 ** 31) === null ? null : Math.trunc(obs.comercial!.stock!), obs.comercial?.gtin ?? null])).rows[0]!.id;
}

/**
 * Un número finito dentro de ±tope, o null: un valor fuera de rango abortaría la transacción del mensaje entero.
 * Es una pérdida SILENCIOSA (el valor absurdo no queda en ningún lado salvo en el crudo): si algún día importa,
 * debe convertirse en un caso en lugar de un NULL.
 */
export const numeroAcotado = (n: number | undefined, tope: number): number | null =>
  n !== undefined && Number.isFinite(n) && Math.abs(n) < tope ? n : null;

/**
 * Persiste lo extraído (atributos e imágenes) en la MISMA transacción que la representación, y compara con el
 * otro canal. Sin `crudo` la observación no trajo nada capturable y no se toca nada: una proyección sin extras
 * no borra lo ya guardado. Con `crudo`, lo que el canal ya no informa se marca con `vigente_hasta` (la app no
 * tiene DELETE) y lo que reaparece revive su misma fila.
 */
export async function persistirExtras(
  tx: Consultable, ctx: ContextoAplicacion, repId: string, obs: Pick<RepresentacionObservada, 'atributos' | 'imagenes' | 'crudo'>,
  resumen: ResumenAplicacion, empresa: string,
): Promise<void> {
  // Aun sin `crudo` conviene registrar a qué modelo pertenece esta representación (6b): el proyector clasifica
  // por modelo tocado, y una representación sin extras igual pudo cambiar de variante/modelo.
  //
  // COALESCE(v.model_id, r.model_id) — variante primero, no al revés (punto B, 2026-09-24): desde que
  // vincularMl() persiste un ml_simple propio también para representaciones YA vinculadas a una variante
  // (para no perder el título de ML, ver el comentario ahí), `r.model_id` puede estar seteado AL MISMO TIEMPO
  // que `r.variant_id`. Los atributos/imágenes/comparación de aquí siguen colgando del modelo de LA VARIANTE
  // (compartido entre canales, donde `compararAtributos` puede ver lo que dice Woo) — el `ml_simple` es sólo
  // para el título observado (modelo-ml.ts), nunca el modelo "activo" de una representación ya vinculada.
  // Sin variante (contenedor, pendiente, omitida) sigue cayendo en `r.model_id` como siempre.
  const modeloFila = (await tx.query<{ model_id: string | null }>(
    `SELECT COALESCE(v.model_id, r.model_id) AS model_id FROM catalog.external_representations r
       LEFT JOIN catalog.sellable_variants v ON v.id = r.variant_id WHERE r.id = $1`, [repId])).rows[0]?.model_id;
  // Una publicación omitida por decisión no tiene modelo ni variante: no hay a quién colgarle nada.
  if (!modeloFila) return;
  const modelo = modeloFila;
  resumen.modelos.push(modelo);
  if (!obs.crudo) return;

  const attrs = obs.atributos ?? [];
  const nombres = attrs.map((a) => a.nombre); const valores = attrs.map((a) => a.valor);
  // "Cambió" = se insertó de cero, o ya existía pero estaba cerrada (revivida). Una fila ya vigente con el mismo
  // valor se re-escribe igual (mismo observado_en) pero no es un cambio real: se filtra por la vigencia PREVIA.
  const previaVigente = new Set((await tx.query<{ nombre_normalizado: string; valor: string }>(
    `SELECT nombre_normalizado, valor FROM catalog.model_attributes
      WHERE representation_id = $1 AND vigente_hasta IS NULL`, [repId])).rows.map((a) => `${a.nombre_normalizado}\u0000${a.valor}`));
  const nuevos = (await tx.query<{ nombre_normalizado: string; valor: string }>(
    `INSERT INTO catalog.model_attributes (model_id, representation_id, nombre_normalizado, valor, observado_en)
     SELECT $1, $2, n, v, now() FROM unnest($3::text[], $4::text[]) AS u(n, v)
     ON CONFLICT (representation_id, nombre_normalizado, valor) DO UPDATE
       SET observado_en = EXCLUDED.observado_en, vigente_hasta = NULL, model_id = EXCLUDED.model_id
     RETURNING nombre_normalizado, valor`,
    [modelo, repId, nombres, valores])).rows
    .filter((a) => !previaVigente.has(`${a.nombre_normalizado}\u0000${a.valor}`));
  const cerrados = (await tx.query<{ nombre_normalizado: string }>(
    `UPDATE catalog.model_attributes m SET vigente_hasta = now()
      WHERE m.representation_id = $1 AND m.vigente_hasta IS NULL
        AND NOT EXISTS (SELECT 1 FROM unnest($2::text[], $3::text[]) AS u(n, v)
                         WHERE u.n = m.nombre_normalizado AND u.v = m.valor)
      RETURNING nombre_normalizado`, [repId, nombres, valores])).rows;
  // 6b: `categoria_canal` es lo único que dispara la clasificación (D25). Un valor nuevo, revivido o cerrado
  // cuenta como cambio; que la fila se haya tocado sin cambiar de vigencia (mismo valor, sólo observado_en) no.
  const tocoCategoria = nuevos.some((n) => n.nombre_normalizado === 'categoria_canal')
    || cerrados.some((n) => n.nombre_normalizado === 'categoria_canal');
  if (tocoCategoria) resumen.categoriaCambio.add(modelo);

  const imgs = obs.imagenes ?? [];
  const urls = imgs.map((i) => i.url); const ordenes = imgs.map((i) => i.orden);
  await tx.query(
    `INSERT INTO catalog.model_images (model_id, representation_id, url, orden, observado_en)
     SELECT $1, $2, u, o, now() FROM unnest($3::text[], $4::int[]) AS x(u, o)
     ON CONFLICT (representation_id, url) DO UPDATE
       SET orden = EXCLUDED.orden, observado_en = EXCLUDED.observado_en, vigente_hasta = NULL, model_id = EXCLUDED.model_id`,
    [modelo, repId, urls, ordenes]);
  await tx.query(
    `UPDATE catalog.model_images m SET vigente_hasta = now()
      WHERE m.representation_id = $1 AND m.vigente_hasta IS NULL AND NOT (m.url = ANY($2::text[]))`, [repId, urls]);

  if (ctx.compararAtributos ?? false) await compararAtributos(tx, ctx, repId, modelo, attrs, resumen, empresa);
}

/** La categoría es propia de cada canal (nombre en Woo, id en ML): compararla daría divergencia siempre. */
const NO_COMPARABLES = new Set(['categoria_canal']);

/**
 * Dos canales que afirman valores DISJUNTOS para el mismo atributo del mismo modelo abren UN caso
 * `atributo_divergente`, colgado de esta representación (`identity_cases` no tiene `model_id`), con todos los
 * atributos en conflicto en el detalle: uno por atributo violaría `identity_cases_un_abierto_representacion` y
 * abortaría el mensaje. Que un canal no informe un atributo NO es contradicción. Valores que se solapan
 * (Woo lista cinco talles y ML publica uno de ellos) o cuyos tokens se contienen ("43" / "43 eu") tampoco. Si el conflicto desaparece, el caso se cierra.
 * Nunca se fusiona nada solo.
 */
async function compararAtributos(
  tx: Consultable, ctx: ContextoAplicacion, repId: string, modelo: string,
  attrs: { nombre: string; valor: string }[], resumen: ResumenAplicacion, empresa: string,
): Promise<void> {
  const propios = new Map<string, string[]>();
  for (const a of attrs) {
    if (NO_COMPARABLES.has(a.nombre)) continue;
    propios.set(a.nombre, [...(propios.get(a.nombre) ?? []), a.valor]);
  }
  const conflictos: { nombre: string; canal: string; valores: string[]; canal_otro: string; valores_otro: string[] }[] = [];
  if (propios.size) {
    const otros = (await tx.query<{ nombre_normalizado: string; valor: string; canal: string }>(
      `SELECT DISTINCT a.nombre_normalizado, a.valor, r.canal
         FROM catalog.model_attributes a JOIN catalog.external_representations r ON r.id = a.representation_id
        WHERE a.model_id = $1 AND a.vigente_hasta IS NULL AND r.canal <> $2 AND r.archivado_en IS NULL
          AND a.nombre_normalizado = ANY($3::text[])`, [modelo, ctx.canal, [...propios.keys()]])).rows;
    const porNombre = new Map<string, { canal: string; valores: string[] }>();
    for (const o of otros) {
      const e = porNombre.get(o.nombre_normalizado) ?? { canal: o.canal, valores: [] };
      e.valores.push(o.valor); porNombre.set(o.nombre_normalizado, e);
    }
    for (const [nombre, mios] of propios) {
      const otro = porNombre.get(nombre);
      if (!otro) continue;
      if (otro.valores.some((v) => mios.some((m) => valoresRelacionados(m, v)))) continue;
      conflictos.push({ nombre, canal: ctx.canal, valores: mios, canal_otro: otro.canal, valores_otro: otro.valores });
    }
  }
  const abierto = (await tx.query<{ id: string }>(
    `SELECT id FROM catalog.identity_cases
      WHERE representation_id = $1 AND tipo = 'atributo_divergente' AND cerrado_en IS NULL FOR UPDATE`, [repId])).rows[0];
  if (conflictos.length === 0) {
    if (abierto) await tx.query(
      `UPDATE catalog.identity_cases SET cerrado_en = now(), motivo_cierre = 'los canales ya no discrepan' WHERE id = $1`, [abierto.id]);
    return;
  }
  const detalle = JSON.stringify({ atributos: conflictos });
  if (abierto) {
    await tx.query('UPDATE catalog.identity_cases SET detalle = $2::jsonb WHERE id = $1', [abierto.id, detalle]);
  } else {
    await tx.query(
      `INSERT INTO catalog.identity_cases (company_id, tipo, representation_id, detalle) VALUES ($1, 'atributo_divergente', $2, $3::jsonb)`,
      [empresa, repId, detalle]);
    resumen.casosAbiertos.push('atributo_divergente');
  }
}
