/*
 * src/catalogo/decisiones.ts — que el vínculo de cada publicación de ML refleje la decisión vigente del matcher.
 *
 * El proyector vincula una publicación la primera vez que la ve y después no la toca. Acá se mantiene al día
 * cuando la decisión cambia (evento o copia) o cuando aparece el SKU al que una decisión apuntaba:
 *
 *   decisión confirmar/asignar a un SKU que existe  → la publicación cuelga de esa variante
 *   decisión a un SKU que no existe                 → variante pendiente + caso sku_inexistente_en_woo
 *   decisión omitir                                 → publicación omitida, sin variante + caso omitida_revisar
 *   sin decisión (nunca hubo, o se revocó)          → variante pendiente + caso sku_pendiente
 *
 * Fusión (§6 del diseño): cuando una publicación deja una variante PENDIENTE que ya no tiene ninguna otra
 * publicación, esa variante se archiva con motivo "fusionada en ..." y sus casos se cierran. Una variante con
 * SKU no se archiva nunca por esto: es de Woo, y existe aunque ML deje de apuntarle.
 *
 * Concurrencia: quien escribe decisiones o vínculos de ML toma primero el candado de la cuenta
 * (`bloquearDecisiones`) y después bloquea filas; siempre en ese orden, para no cruzarse en un deadlock. Dos
 * cambios sobre la misma publicación se serializan y el segundo decide sobre lo que dejó el primero.
 */
import { randomUUID } from 'node:crypto';
import { registrarEvento } from '../audit/auditoria.ts';
import type { Consultable } from '../db/pool.ts';

/**
 * Candado de las decisiones de una cuenta, hasta el fin de la transacción. Lo toman los eventos, las copias, el
 * proyector al vincular una publicación de ML y la reconciliación por SKU:
 * sin él, dos eventos sobre una clave SIN decisión vigente leían "no hay" a la vez (un FOR UPDATE sobre una fila
 * que no existe no bloquea nada) y los dos insertaban, chocando contra matcher_decisions_un_vigente. Por cuenta y
 * no por clave: una copia de 7.000 filas tomaría 7.000 candados y podría agotar la tabla de locks, y las
 * decisiones del matcher llegan a ritmo humano, así que serializarlas por cuenta no cuesta nada.
 */
export async function bloquearDecisiones(tx: Consultable, cuenta: string): Promise<void> {
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('catalogo.decisiones:' || $1, 0))", [cuenta]);
}

export type Reconciliacion = 'sin_representacion' | 'sin_cambios' | 'vinculada' | 'omitida' | 'pendiente';

type Deseado =
  | { tipo: 'variante'; variante: string }
  | { tipo: 'omitida' }
  | { tipo: 'pendiente'; caso: 'sku_pendiente' | 'sku_inexistente_en_woo'; sku: string | null };

const CASOS_DE_PENDIENTE = ['sku_pendiente', 'sku_inexistente_en_woo'];

export async function reconciliarClave(
  tx: Consultable, cuenta: string, recurso: string, variacion: string, motivo: string,
): Promise<Reconciliacion> {
  const rep = (await tx.query<{ id: string; company_id: string; variant_id: string | null; omitida_por_decision: boolean }>(
    `SELECT id, company_id, variant_id, omitida_por_decision FROM catalog.external_representations
      WHERE channel_account_id = $1 AND recurso = $2 AND variacion_normalizada = $3 AND tipo = 'vendible' FOR UPDATE`,
    [cuenta, recurso, variacion])).rows[0];
  // Todavía no se vio la publicación: cuando el proyector la vea, la vincula con la decisión vigente.
  if (!rep) return 'sin_representacion';
  const empresa = rep.company_id;

  const dec = (await tx.query<{ accion: string; sku: string | null }>(
    `SELECT accion, sku FROM catalog.matcher_decisions
      WHERE channel_account_id = $1 AND recurso = $2 AND variacion_normalizada = $3 AND vigente_hasta IS NULL`,
    [cuenta, recurso, variacion])).rows[0];
  let deseado: Deseado;
  if (dec?.accion === 'omitir') deseado = { tipo: 'omitida' };
  else if ((dec?.accion === 'confirmar' || dec?.accion === 'asignar') && dec.sku) {
    const destino = (await tx.query<{ id: string }>(
      'SELECT id FROM catalog.sellable_variants WHERE company_id = $1 AND sku = $2 FOR UPDATE', [empresa, dec.sku])).rows[0];
    deseado = destino ? { tipo: 'variante', variante: destino.id } : { tipo: 'pendiente', caso: 'sku_inexistente_en_woo', sku: dec.sku };
  } else deseado = { tipo: 'pendiente', caso: 'sku_pendiente', sku: null };

  const actual = rep.variant_id ? (await tx.query<{ sku: string | null }>(
    'SELECT sku FROM catalog.sellable_variants WHERE id = $1 FOR UPDATE', [rep.variant_id])).rows[0]! : null;

  const abrir = (tipo: string, objeto: { variante?: string; representacion?: string }, prioridad = 'normal', detalle: object = {}) => tx.query(
    `INSERT INTO catalog.identity_cases (company_id, tipo, prioridad, variant_id, representation_id, detalle)
     VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`,
    [empresa, tipo, prioridad, objeto.variante ?? null, objeto.representacion ?? null, JSON.stringify(detalle)]);
  const cerrarDeVariante = (variante: string, tipos: string[], m: string) => tx.query(
    `UPDATE catalog.identity_cases SET cerrado_en = now(), motivo_cierre = $3
      WHERE variant_id = $1 AND tipo = ANY($2) AND cerrado_en IS NULL`, [variante, tipos, m]);
  const cerrarOmitida = () => tx.query(
    `UPDATE catalog.identity_cases SET cerrado_en = now(), motivo_cierre = $2
      WHERE representation_id = $1 AND tipo = 'omitida_revisar' AND cerrado_en IS NULL`, [rep.id, `la decisión cambió: ${motivo}`]);

  // ¿Ya está donde tiene que estar?
  if (deseado.tipo === 'variante' && rep.variant_id === deseado.variante) return 'sin_cambios';
  if (deseado.tipo === 'omitida' && rep.omitida_por_decision) return 'sin_cambios';
  if (deseado.tipo === 'pendiente' && rep.variant_id && actual?.sku === null) {
    // Sigue pendiente; sólo puede haber cambiado el motivo (sin decisión ↔ SKU que no existe).
    const otro = deseado.caso === 'sku_pendiente' ? 'sku_inexistente_en_woo' : 'sku_pendiente';
    await cerrarDeVariante(rep.variant_id, [otro], `la decisión cambió: ${motivo}`);
    await abrir(deseado.caso, { variante: rep.variant_id }, 'normal', deseado.sku ? { sku: deseado.sku } : {});
    return 'sin_cambios';
  }

  let nueva: string | null = null;
  if (deseado.tipo === 'variante') nueva = deseado.variante;
  if (deseado.tipo === 'pendiente') {
    nueva = (await tx.query<{ id: string }>(
      'INSERT INTO catalog.sellable_variants (company_id, model_id) VALUES ($1, $2) RETURNING id',
      [empresa, await modeloPropioMl(tx, empresa, cuenta, recurso)])).rows[0]!.id;
    await abrir(deseado.caso, { variante: nueva }, 'normal', deseado.sku ? { sku: deseado.sku } : {});
  }
  await tx.query(
    'UPDATE catalog.external_representations SET variant_id = $2, omitida_por_decision = $3 WHERE id = $1',
    [rep.id, nueva, deseado.tipo === 'omitida']);
  if (deseado.tipo === 'omitida') await abrir('omitida_revisar', { representacion: rep.id }, 'baja');
  else await cerrarOmitida();

  // Fusión: una pendiente que quedó sin publicaciones se archiva. Una con SKU es de Woo y se queda.
  if (rep.variant_id && actual?.sku === null) {
    const quedan = (await tx.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM catalog.external_representations WHERE variant_id = $1', [rep.variant_id])).rows[0]!.n;
    if (quedan === 0) {
      const destino = nueva ? `fusionada en ${nueva}` : 'la publicación quedó omitida';
      await tx.query(
        'UPDATE catalog.sellable_variants SET archivado_en = now(), motivo_archivo = $2, version = version + 1 WHERE id = $1',
        [rep.variant_id, destino]);
      await cerrarDeVariante(rep.variant_id, CASOS_DE_PENDIENTE, destino);
    }
  }

  await registrarEvento(tx, {
    companyId: empresa, actorType: 'system', actorId: 'plataforma.catalogo', action: 'catalogo.vinculo_cambiado',
    aggregateType: 'external_representation', aggregateId: rep.id, correlationId: randomUUID(), reason: motivo,
    payload: { recurso, variacion, de: rep.variant_id, a: nueva, omitida: deseado.tipo === 'omitida' },
  });
  return deseado.tipo === 'variante' ? 'vinculada' : deseado.tipo;
}

/**
 * Apareció en Woo un SKU: toda publicación de ML cuya decisión vigente apuntaba a él y que hoy está en una
 * variante pendiente se fusiona con la variante de ese SKU.
 */
export async function reconciliarSku(tx: Consultable, empresa: string, sku: string, motivo: string): Promise<number> {
  const claves = (await tx.query<{ channel_account_id: string; recurso: string; variacion_normalizada: string }>(
    `SELECT channel_account_id, recurso, variacion_normalizada FROM catalog.matcher_decisions
      WHERE company_id = $1 AND sku = $2 AND vigente_hasta IS NULL AND accion IN ('confirmar', 'asignar')
      ORDER BY recurso, variacion_normalizada`, [empresa, sku])).rows;
  let cambiadas = 0;
  for (const cuenta of [...new Set(claves.map((c) => c.channel_account_id))].sort()) await bloquearDecisiones(tx, cuenta);
  for (const c of claves) {
    if ((await reconciliarClave(tx, c.channel_account_id, c.recurso, c.variacion_normalizada, motivo)) === 'vinculada') cambiadas++;
  }
  return cambiadas;
}

/**
 * El modelo propio de una publicación de ML, para colgarle una variante pendiente: el del ítem clásico si la
 * publicación es una variación, o el `ml_simple` del ítem. Si nunca se creó (la publicación colgaba de un
 * modelo de Woo desde el principio), se crea ahora con el id como título hasta que el proyector lo refresque.
 */
async function modeloPropioMl(tx: Consultable, empresa: string, cuenta: string, recurso: string): Promise<string> {
  const existente = (await tx.query<{ id: string }>(
    `SELECT id FROM catalog.product_models
      WHERE channel_account_id = $1 AND clave_origen = $2 AND origen IN ('ml_clasico', 'ml_simple')
      ORDER BY origen LIMIT 1`, [cuenta, recurso])).rows[0];
  if (existente) return existente.id;
  return (await tx.query<{ id: string }>(
    `INSERT INTO catalog.product_models (company_id, channel_account_id, origen, clave_origen, titulo)
     VALUES ($1, $2, 'ml_simple', $3, $3)
     ON CONFLICT (channel_account_id, origen, clave_origen) DO UPDATE SET observado_en = product_models.observado_en
     RETURNING id`, [empresa, cuenta, recurso])).rows[0]!.id;
}
