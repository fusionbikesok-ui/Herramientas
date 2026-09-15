import type pg from 'pg';
import { ErrorLeaseVencido } from '../colas/errores.ts';
import { enTransaccion, type Consultable } from '../db/pool.ts';
import { cifrarSobre, type KeyringSobre } from '../seguridad/sobre.ts';
import type { ResultadoBarrido } from '../worker/barridos.ts';
import { hashCanonico, jsonCanonico } from './canonico.ts';
import { renovarLeaseCorrida, type CorridaReclamada } from './corridas.ts';
import type { AdaptadorBarrido, AlcanceBajas, RecursoRemoto, TipoVersion } from './tipos.ts';

export class ErrorPaginaInvalida extends Error { override name = 'ErrorPaginaInvalida'; }

const PREFIJO_BAJA = 'deleted:';
const RENOVAR_LEASE_MS = 25_000;

interface ObservacionActual { remote_version: string; remote_hash: Buffer; lifecycle: string }

function validarRecurso(r: RecursoRemoto, tipo: TipoVersion): void {
  if (!r.id?.trim() || !r.version?.trim()) throw new ErrorPaginaInvalida('recurso remoto sin identidad o versión');
  if (r.version.startsWith(PREFIJO_BAJA)) throw new ErrorPaginaInvalida(`versión reservada para ${r.id}`);
  if (tipo === 'temporal' && !Number.isFinite(Date.parse(r.version))) {
    throw new ErrorPaginaInvalida(`versión temporal inválida para ${r.id}`);
  }
  if (r.updatedAt !== undefined && r.updatedAt !== null && !Number.isFinite(Date.parse(r.updatedAt))) {
    throw new ErrorPaginaInvalida(`fecha remota inválida para ${r.id}`);
  }
  for (const rel of r.relations ?? []) {
    if (!rel.targetId?.trim() || !rel.targetTopic?.trim()) throw new ErrorPaginaInvalida(`relación inválida para ${r.id}`);
  }
  try {
    jsonCanonico(r.payload);
    jsonCanonico(r.projection);
  } catch {
    throw new ErrorPaginaInvalida(`payload no canonizable para ${r.id}`);
  }
}

/** >0 si la nueva versión reemplaza a la actual, 0 si es la misma, <0 si llegó atrasada. */
function compararVersion(tipo: TipoVersion, nueva: string, previa: ObservacionActual): number {
  // Un recurso que reaparece después de una baja declarada siempre vuelve a observarse.
  if (previa.lifecycle === 'deleted' && previa.remote_version.startsWith(PREFIJO_BAJA)) return 1;
  if (tipo === 'hash') return nueva === previa.remote_version ? 0 : 1;
  return Math.sign(Date.parse(nueva) - Date.parse(previa.remote_version));
}

async function encolar(
  tx: pg.PoolClient, corrida: CorridaReclamada, resourceId: string, version: string,
  payload: unknown, keyring: KeyringSobre,
): Promise<boolean> {
  const sobre = cifrarSobre(Buffer.from(jsonCanonico(payload), 'utf8'), {
    account: corrida.channelAccountId, topic: corrida.topic, resource: resourceId, remoteVersion: version,
  }, keyring);
  const r = await tx.query(
    `INSERT INTO integrations.inbox_messages
      (channel_account_id,topic,resource_id,remote_version,source,correlation_id,payload_hash,
       payload_ciphertext,payload_key_id,payload_nonce,payload_tag)
     VALUES ($1,$2,$3,$4,'sweep',$5,$6,$7,$8,$9,$10)
     ON CONFLICT (channel_account_id,topic,resource_id,remote_version) DO NOTHING`,
    [corrida.channelAccountId, corrida.topic, resourceId, version, corrida.correlationId,
      hashCanonico(payload), sobre.ciphertext, sobre.keyId, sobre.nonce, sobre.tag],
  );
  return r.rowCount === 1;
}

async function persistirRecurso(
  tx: pg.PoolClient, corrida: CorridaReclamada, tipo: TipoVersion,
  recurso: RecursoRemoto, keyring: KeyringSobre,
): Promise<'enqueued' | 'duplicate' | 'stale'> {
  const actual = await tx.query<ObservacionActual>(
    `SELECT remote_version,remote_hash,lifecycle FROM integrations.resource_observations
      WHERE channel_account_id=$1 AND topic=$2 AND resource_id=$3 FOR UPDATE`,
    [corrida.channelAccountId, corrida.topic, recurso.id],
  );
  const previa = actual.rows[0];
  const remoteHash = hashCanonico(recurso.payload);
  const comparacion = previa ? compararVersion(tipo, recurso.version, previa) : 1;
  await persistirRelaciones(tx, corrida, recurso);

  if (comparacion > 0 || (comparacion === 0 && !remoteHash.equals(previa!.remote_hash))) {
    const encolado = await encolar(tx, corrida, recurso.id, recurso.version, recurso.payload, keyring);
    await tx.query(
      `INSERT INTO integrations.resource_observations
        (channel_account_id,topic,resource_id,remote_version,remote_updated_at,remote_hash,
         projection_hash,lifecycle,last_seen_run_id,last_enqueued_version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$4)
       ON CONFLICT (channel_account_id,topic,resource_id) DO UPDATE SET
         remote_version=excluded.remote_version,remote_updated_at=excluded.remote_updated_at,
         remote_hash=excluded.remote_hash,projection_hash=excluded.projection_hash,
         lifecycle=excluded.lifecycle,last_seen_run_id=excluded.last_seen_run_id,
         last_seen_at=now(),last_enqueued_version=excluded.last_enqueued_version`,
      [corrida.channelAccountId, corrida.topic, recurso.id, recurso.version, recurso.updatedAt ?? null,
        remoteHash, hashCanonico(recurso.projection), recurso.lifecycle, corrida.id],
    );
    return encolado ? 'enqueued' : 'duplicate';
  }

  // Igual o atrasada: sólo cuenta como avistamiento; una señal vieja nunca cambia el estado observado.
  await tx.query(
    `UPDATE integrations.resource_observations SET last_seen_run_id=$4,last_seen_at=now()
      WHERE channel_account_id=$1 AND topic=$2 AND resource_id=$3`,
    [corrida.channelAccountId, corrida.topic, recurso.id, corrida.id],
  );
  return comparacion < 0 ? 'stale' : 'duplicate';
}

/**
 * Corriente de sólo presencia: marca avistamiento de los IDs enumerados sin tocar versión, hash,
 * ciclo de vida ni inbox. Un ID desconocido no crea observación: el contenido lo trae la corriente
 * incremental del mismo tópico.
 */
async function marcarPresencia(
  tx: pg.PoolClient, corrida: CorridaReclamada, ids: readonly string[],
): Promise<void> {
  if (!ids.length) return;
  await tx.query(
    `UPDATE integrations.resource_observations SET last_seen_run_id=$3,last_seen_at=now()
      WHERE channel_account_id=$1 AND topic=$2 AND resource_id = ANY($4::text[])`,
    [corrida.channelAccountId, corrida.topic, corrida.id, ids],
  );
}

async function persistirRelaciones(tx: Consultable, corrida: CorridaReclamada, recurso: RecursoRemoto): Promise<void> {
  for (const relacion of recurso.relations ?? []) {
    await tx.query(
      `INSERT INTO integrations.resource_relations
        (channel_account_id,relation_type,source_topic,source_id,target_topic,target_id,last_seen_run_id,lifecycle)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (channel_account_id,relation_type,source_topic,source_id,target_topic,target_id)
       DO UPDATE SET last_seen_at=now(),last_seen_run_id=excluded.last_seen_run_id,lifecycle=excluded.lifecycle`,
      [corrida.channelAccountId, relacion.type, corrida.topic, recurso.id, relacion.targetTopic,
        relacion.targetId, corrida.id, relacion.lifecycle ?? 'open'],
    );
  }
}

const CONDICION_ALCANCE: Readonly<Record<AlcanceBajas, string>> = {
  todos: '',
  no_variaciones: `AND NOT EXISTS (SELECT 1 FROM integrations.resource_relations r
      WHERE r.channel_account_id=o.channel_account_id AND r.relation_type='product_variation'
        AND r.target_topic=o.topic AND r.target_id=o.resource_id)`,
};

async function declararBajas(
  tx: pg.PoolClient, corrida: CorridaReclamada, keyring: KeyringSobre, alcance: AlcanceBajas,
): Promise<number> {
  const ausentes = await tx.query<{ resource_id: string }>(
    `SELECT o.resource_id FROM integrations.resource_observations o
      WHERE o.channel_account_id=$1 AND o.topic=$2 AND o.lifecycle<>'deleted'
        AND o.last_seen_run_id IS DISTINCT FROM $3 ${CONDICION_ALCANCE[alcance]}
      FOR UPDATE`,
    [corrida.channelAccountId, corrida.topic, corrida.id],
  );
  for (const fila of ausentes.rows) {
    const version = `${PREFIJO_BAJA}${corrida.id}`;
    const payload = { id: fila.resource_id, lifecycle: 'deleted' };
    const hash = hashCanonico(payload);
    await encolar(tx, corrida, fila.resource_id, version, payload, keyring);
    await tx.query(
      `UPDATE integrations.resource_observations SET remote_version=$3,remote_hash=$4,
       projection_hash=$4,lifecycle='deleted',last_enqueued_version=$3
       WHERE channel_account_id=$1 AND topic=$2 AND resource_id=$5`,
      [corrida.channelAccountId, corrida.topic, version, hash, fila.resource_id],
    );
  }
  return ausentes.rows.length;
}

export function crearProcesadorMotor(opciones: {
  db: pg.Pool;
  adaptador: AdaptadorBarrido;
  keyring: KeyringSobre;
  reloj?: () => Date;
  relojMonotonoMs?: () => number;
  maxPaginas?: number;
}): (corrida: CorridaReclamada) => Promise<ResultadoBarrido> {
  const { adaptador, db, keyring } = opciones;
  const presencia = adaptador.modo === 'presencia';
  const monotono = opciones.relojMonotonoMs ?? (() => performance.now());
  return async (corrida) => {
    if (corrida.topic !== adaptador.topic || corrida.cursorKind !== adaptador.cursorKind) {
      throw new Error('adaptador asignado a otra corriente');
    }
    const config = await db.query<{ overlap_seconds: number }>(
      `SELECT overlap_seconds FROM integrations.reconciliation_cursors
        WHERE channel_account_id=$1 AND topic=$2 AND cursor_kind=$3`,
      [corrida.channelAccountId, corrida.topic, corrida.cursorKind],
    );
    const overlap = config.rows[0]?.overlap_seconds;
    if (overlap === undefined) throw new Error('corriente inexistente');

    // La ventana se congela en el primer intento; un reintento repite exactamente la misma ventana.
    const candidatoTo = (opciones.reloj ?? (() => new Date()))();
    const updatedAt = typeof corrida.cursorBefore?.updated_at === 'string' ? Date.parse(corrida.cursorBefore.updated_at) : Number.NaN;
    const candidatoFrom = Number.isFinite(updatedAt) ? new Date(updatedAt - overlap * 1000) : null;
    const ventana = await db.query<{ window_from: Date | null; window_to: Date }>(
      `UPDATE integrations.sweep_runs SET
         window_from=CASE WHEN window_to IS NULL THEN $4 ELSE window_from END,
         window_to=coalesce(window_to,$5)
       WHERE id=$1 AND status='claimed' AND lease_token=$2 AND worker_id=$3 AND lease_until>now()
       RETURNING window_from,window_to`,
      [corrida.id, corrida.token, corrida.workerId, candidatoFrom, candidatoTo],
    );
    const fila = ventana.rows[0];
    if (!fila) throw new ErrorLeaseVencido(`lease vencido o ajeno para sweep#${corrida.id}`);
    const windowFrom = fila.window_from; const windowTo = fila.window_to;

    let posicion: Record<string, unknown> | null = null;
    let cursorAfter: Record<string, unknown> | null = null;
    let paginas = 0; let enumerados = 0; let encolados = 0; let duplicados = 0;
    let ultimaRenovacion = monotono();
    do {
      paginas++;
      if (paginas > (opciones.maxPaginas ?? 100_000)) throw new Error('límite de páginas excedido');
      if (monotono() - ultimaRenovacion >= RENOVAR_LEASE_MS) {
        await renovarLeaseCorrida(db, corrida);
        ultimaRenovacion = monotono();
      }
      const pagina = await adaptador.listar({ corrida, windowFrom, windowTo }, posicion);
      if (!pagina || !Array.isArray(pagina.resources)) throw new ErrorPaginaInvalida('página remota malformada');
      let presentes: readonly string[] = [];
      if (presencia) {
        if (!Array.isArray(pagina.presentes)) throw new ErrorPaginaInvalida('corriente de presencia sin IDs');
        if (pagina.resources.length) throw new ErrorPaginaInvalida('corriente de presencia con contenido');
        presentes = pagina.presentes;
        if (presentes.some((id) => typeof id !== 'string' || !id.trim())) throw new ErrorPaginaInvalida('ID presente inválido');
      } else {
        for (const recurso of pagina.resources) validarRecurso(recurso, adaptador.versionKind);
      }
      await enTransaccion(db, async (tx) => {
        if (presencia) {
          await marcarPresencia(tx, corrida, presentes);
          enumerados += presentes.length;
        } else {
          for (const recurso of pagina.resources) {
            const resultado = await persistirRecurso(tx, corrida, adaptador.versionKind, recurso, keyring);
            enumerados++;
            if (resultado === 'enqueued') encolados++; else duplicados++;
          }
        }
        await tx.query(
          `UPDATE integrations.sweep_runs SET enumerated=$2,missing_enqueued=$3,duplicates=$4 WHERE id=$1`,
          [corrida.id, enumerados, encolados, duplicados],
        );
      });
      posicion = pagina.nextPosition;
      cursorAfter = pagina.cursorAfter;
    } while (posicion !== null);
    if (!cursorAfter || cursorAfter.v !== 1) throw new ErrorPaginaInvalida('adaptador no devolvió cursor v1');
    if (adaptador.fullScan) {
      const alcance = adaptador.alcanceBajas ?? 'todos';
      return { cursorAfter, antesDeCerrar: async (tx) => { await declararBajas(tx, corrida, keyring, alcance); } };
    }
    return { cursorAfter };
  };
}
