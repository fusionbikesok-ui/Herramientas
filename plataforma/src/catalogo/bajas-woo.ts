import type { Reclamo } from '../colas/colas.ts';
import type { Consultable } from '../db/pool.ts';
import { registrarEvento } from '../audit/auditoria.ts';
import { ErrorTransitorio } from '../colas/errores.ts';

export class ErrorBajaWooInvalida extends Error { override name = 'ErrorBajaWooInvalida'; }
export class ErrorEsperaPadreWoo extends ErrorTransitorio { override name = 'ErrorEsperaPadreWoo'; }

/**
 * El motor declara ausencias con un sobre mínimo, no con un producto Woo. El aviso sólo puede
 * archivar representaciones de la misma cuenta cuando sigue siendo la observación vigente.
 * `true` significa que el mensaje ya se atendió (baja u observación superada).
 * Debe ejecutarse dentro de la misma transacción que completarEnTx.
 */
export async function atenderBajaWoo(tx: Consultable, r: Reclamo, payload: unknown): Promise<boolean> {
  const p = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? payload as Record<string, unknown> : null;
  const baja = r.remoteVersion.startsWith('deleted:') || p?.lifecycle === 'deleted';
  if (baja && (!/^deleted:[1-9][0-9]*$/.test(r.remoteVersion) || p?.id !== r.resourceId
    || p.lifecycle !== 'deleted' || Object.keys(p).some((k) => k !== 'id' && k !== 'lifecycle'))) {
    throw new ErrorBajaWooInvalida('aviso de baja Woo con identidad, versión o contenido inválido');
  }

  // Una variación se identifica por su propio id en E1 y por (padre, variación) en el catálogo.
  // Tomar el mismo candado de recurso que aplicarProyeccion ANTES de bloquear observaciones.
  const existentes = (await tx.query<{ recurso: string }>(
    `SELECT DISTINCT recurso FROM catalog.external_representations
     WHERE channel_account_id=$1 AND canal='woocommerce'
       AND (recurso=$2 OR variacion_normalizada=$2)`, [r.channelAccountId, r.resourceId])).rows;
  const padreTexto = p?.type === 'variation' && (typeof p.parent_id === 'number' || typeof p.parent_id === 'string')
    ? String(p.parent_id) : '';
  const padrePayload = /^[0-9]+$/.test(padreTexto) && padreTexto !== '0' ? padreTexto : null;
  const recursos = [...new Set([r.resourceId, ...existentes.map((x) => x.recurso), ...(padrePayload ? [padrePayload] : [])])].sort();
  for (const recurso of recursos) {
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('catalogo.recurso:' || $1 || ':' || $2, 0))",
      [r.channelAccountId, recurso]);
  }
  const observaciones = (await tx.query<{ resource_id: string; remote_version: string; lifecycle: string }>(
    `SELECT resource_id,remote_version,lifecycle FROM integrations.resource_observations
     WHERE channel_account_id=$1 AND topic='woo.products' AND resource_id=ANY($2)
     ORDER BY resource_id FOR UPDATE`, [r.channelAccountId, recursos])).rows;
  const actual = observaciones.find((x) => x.resource_id === r.resourceId);
  if (baja && !actual) throw new ErrorBajaWooInvalida('baja Woo sin observación de la misma cuenta y recurso');

  // Una hija restaurada puede llegar antes que el padre. No consumirla como obsoleta:
  // la deduplicación impediría volver a proyectar esa misma versión al reaparecer el padre.
  if (!baja && actual?.lifecycle !== 'deleted'
    && observaciones.some((x) => x.resource_id !== r.resourceId && x.lifecycle === 'deleted')) {
    throw new ErrorEsperaPadreWoo('variación Woo pendiente de reconciliar su padre eliminado');
  }
  const obsoleta = baja
    ? actual!.lifecycle !== 'deleted' || actual!.remote_version !== r.remoteVersion
    : actual?.lifecycle === 'deleted';
  if (!baja && !obsoleta) return false;

  const empresa = (await tx.query<{ company_id: string }>(
    'SELECT company_id FROM core.channel_accounts WHERE id=$1', [r.channelAccountId])).rows[0]!.company_id;
  let archivadas = 0;
  if (!obsoleta) {
    const resultado = await tx.query(
      `UPDATE catalog.external_representations
       SET archivado_en=COALESCE(archivado_en,now()),
           motivo_archivo=COALESCE(motivo_archivo,'baja confirmada por barrido Woo'), estado_remoto='deleted'
       WHERE channel_account_id=$1 AND canal='woocommerce'
         AND (recurso=$2 OR variacion_normalizada=$2)
         AND (archivado_en IS NULL OR estado_remoto IS DISTINCT FROM 'deleted')`,
      [r.channelAccountId, r.resourceId]);
    archivadas = resultado.rowCount ?? 0;
    // No poner deleted:<corrida> en version_remota: no es una fecha comparable y bloquearía
    // todas las reapariciones. La observación E1 conserva esa versión y frena mensajes atrasados.
    // Modelos y variantes canónicos pueden seguir usados por ML: no se archivan ni se desvinculan.
  }
  await registrarEvento(tx, {
    companyId: empresa, actorType: 'system', actorId: 'plataforma.catalogo',
    action: obsoleta ? 'catalogo.observacion_woo_obsoleta' : 'catalogo.baja_woo',
    aggregateType: 'inbox', aggregateId: r.id, correlationId: r.correlationId,
    reason: obsoleta ? 'la observación vigente supera este mensaje' : 'baja confirmada por el motor de barridos',
    payload: { cuenta: r.channelAccountId, recurso: r.resourceId, version: r.remoteVersion, archivadas },
  });
  return true;
}
