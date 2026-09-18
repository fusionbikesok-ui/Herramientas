import type pg from 'pg';
import { registrarEvento } from '../audit/auditoria.ts';
import { enTransaccion, type Consultable } from '../db/pool.ts';
import type { SobreCifrado } from '../seguridad/sobre.ts';
import { ErrorIncierto, ErrorLeaseVencido, ErrorTransitorio } from './errores.ts';

export type Cola = 'inbox' | 'outbox';

const TABLA: Record<Cola, { tabla: string; tipo: string }> = {
  inbox: { tabla: 'integrations.inbox_messages', tipo: 'topic' },
  outbox: { tabla: 'integrations.outbox_commands', tipo: 'command_type' },
};

export interface MensajeEntrada {
  channelAccountId: string; topic: string; resourceId: string; remoteVersion: string;
  // 'bootstrap' (E2 T1): la lectura completa inicial del catálogo, que encola lo que la cola nunca vio.
  source: 'webhook_copy' | 'sweep' | 'bootstrap'; correlationId: string; maxAttempts?: number;
}

export interface Reclamo {
  cola: Cola; id: string; token: string; tipo: string; attempts: number; maxAttempts: number; correlationId: string;
  /*
   * Lo que sigue lo agregó E2 T1: el primer consumidor real del inbox necesita descifrar el payload, y
   * para armar el AAD del sobre hacen falta la cuenta, el tópico, el recurso y la versión remota
   * (`seguridad/sobre.ts`). Venían en la fila pero no en el reclamo, así que el consumidor tenía que
   * volver a consultarla: una segunda lectura que nadie garantiza que vea lo mismo.
   *
   * Sólo el inbox los trae; la outbox no tiene sobre ni recurso remoto.
   */
  channelAccountId: string;
  resourceId: string;
  remoteVersion: string;
  /** Null cuando el mensaje no tiene payload: vencido a los 90 días, o encolado sólo como aviso. */
  sobre: SobreCifrado | null;
}

export async function encolarInbox(db: Consultable, m: MensajeEntrada): Promise<{ id: string | null; creado: boolean }> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO integrations.inbox_messages
       (channel_account_id, topic, resource_id, remote_version, source, correlation_id, max_attempts)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (channel_account_id, topic, resource_id, remote_version) DO NOTHING
     RETURNING id`,
    [m.channelAccountId, m.topic, m.resourceId, m.remoteVersion, m.source, m.correlationId, m.maxAttempts ?? 8],
  );
  const id = r.rows[0]?.id ?? null;
  return { id, creado: id !== null };
}

export async function reclamar(pool: pg.Pool, cola: Cola, tipos: string[], n: number, leaseSegundos = 60): Promise<Reclamo[]> {
  if (!tipos.length) return [];
  const { tabla, tipo } = TABLA[cola];
  // El sobre y el recurso remoto sólo existen en el inbox; para la outbox se devuelven vacíos.
  const extra = cola === 'inbox'
    ? `, m.channel_account_id, m.resource_id, m.remote_version,
         m.payload_ciphertext, m.payload_key_id, m.payload_nonce, m.payload_tag`
    : '';
  const r = await pool.query<{
    id: string; lease_token: string; tipo: string; attempts: number; max_attempts: number; correlation_id: string;
    channel_account_id?: string; resource_id?: string; remote_version?: string;
    payload_ciphertext?: Buffer | null; payload_key_id?: string | null; payload_nonce?: Buffer | null; payload_tag?: Buffer | null;
  }>(
    `WITH c AS (
       SELECT id FROM ${tabla}
        WHERE status IN ('pending', 'retryable') AND available_at <= now() AND ${tipo} = ANY($1)
        ORDER BY available_at, id LIMIT $2 FOR UPDATE SKIP LOCKED)
     UPDATE ${tabla} m
        SET status = 'claimed', lease_token = gen_random_uuid(),
            lease_until = now() + make_interval(secs => $3), attempts = m.attempts + 1
       FROM c WHERE m.id = c.id
     RETURNING m.id, m.lease_token, m.${tipo} AS tipo, m.attempts, m.max_attempts, m.correlation_id${extra}`,
    [tipos, n, leaseSegundos],
  );
  return r.rows.map((f) => ({
    cola, id: f.id, token: f.lease_token, tipo: f.tipo, attempts: f.attempts, maxAttempts: f.max_attempts,
    correlationId: f.correlation_id,
    channelAccountId: f.channel_account_id ?? '', resourceId: f.resource_id ?? '', remoteVersion: f.remote_version ?? '',
    // Las cuatro partes o ninguna: un sobre a medias no se puede descifrar, y devolverlo incompleto
    // invitaría a que el consumidor lo intente igual.
    sobre: f.payload_ciphertext && f.payload_key_id && f.payload_nonce && f.payload_tag
      ? { ciphertext: f.payload_ciphertext, keyId: f.payload_key_id, nonce: f.payload_nonce, tag: f.payload_tag }
      : null,
  }));
}

// Filtro de lease vigente: sólo quien tiene el token y dentro del plazo puede transicionar.
const VIGENTE = `id = $1 AND status = 'claimed' AND lease_token = $2 AND lease_until > now()`;

/**
 * Cierra el mensaje **dentro de una transacción ajena**, para que el trabajo que el consumidor escribió y
 * el cierre del mensaje vivan o mueran juntos. Sin esto, proyectar el catálogo y marcar el mensaje como
 * hecho eran dos transacciones: un corte en el medio dejaba el catálogo escrito con el mensaje abierto
 * (se reprocesa, y eso está bien) o el mensaje cerrado sin catálogo (se pierde, y eso no).
 *
 * Exige el lease vigente igual que `completar`: quien no lo tiene no cierra nada.
 */
export async function completarEnTx(tx: Consultable, r: Reclamo): Promise<void> {
  const { tabla } = TABLA[r.cola];
  const u = await tx.query(`UPDATE ${tabla} SET status = 'succeeded', lease_token = NULL, lease_until = NULL WHERE ${VIGENTE}`, [r.id, r.token]);
  if (u.rowCount !== 1) throw new ErrorLeaseVencido(`lease vencido o ajeno para ${r.cola}#${r.id}`);
  await registrarEvento(tx, {
    companyId: await empresaDe(tx, r.cola, r.id), actorType: 'system', actorId: 'plataforma.colas',
    action: 'cola.succeeded', aggregateType: r.cola, aggregateId: r.id, correlationId: r.correlationId,
  });
}

export async function completar(pool: pg.Pool, r: Reclamo): Promise<void> {
  await enTransaccion(pool, (tx) => completarEnTx(tx, r));
}

export function backoffSegundos(intento: number, azar: () => number = Math.random): number {
  const base = Math.min(5 * 2 ** intento, 900);
  if (base === 900) return 900;
  return Math.round(base * (0.8 + 0.4 * azar()));
}

async function empresaDe(tx: Consultable, cola: Cola, id: string): Promise<string> {
  const { tabla } = TABLA[cola];
  const e = await tx.query<{ company_id: string }>(`SELECT ca.company_id FROM ${tabla} m JOIN core.channel_accounts ca ON ca.id = m.channel_account_id WHERE m.id = $1`, [id]);
  const fila = e.rows[0];
  if (!fila) throw new Error(`mensaje ${cola}#${id} sin cuenta de canal`);
  return fila.company_id;
}

export async function fallar(pool: pg.Pool, r: Reclamo, error: unknown): Promise<'retryable' | 'uncertain' | 'dead_lettered'> {
  const { tabla } = TABLA[r.cola];
  const codigo = error instanceof Error ? error.name : 'desconocido';
  const detalle = error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500);
  const agotado = r.attempts >= r.maxAttempts;
  const destino = error instanceof ErrorIncierto ? 'uncertain' : error instanceof ErrorTransitorio && !agotado ? 'retryable' : 'dead_lettered';
  return enTransaccion(pool, async (tx) => {
    const columnaError = r.cola === 'inbox' ? ', last_error_code = $4' : '';
    const params: unknown[] = [r.id, r.token, destino];
    if (r.cola === 'inbox') params.push(codigo);
    const disponible = destino === 'retryable' ? `, available_at = now() + make_interval(secs => ${backoffSegundos(r.attempts)})` : '';
    const u = await tx.query(`UPDATE ${tabla} SET status = $3, lease_token = NULL, lease_until = NULL${columnaError}${disponible} WHERE ${VIGENTE}`, params);
    if (u.rowCount !== 1) throw new ErrorLeaseVencido(`lease vencido o ajeno para ${r.cola}#${r.id}`);
    if (destino === 'retryable') return destino;
    if (destino === 'dead_lettered') {
      const motivo = error instanceof ErrorTransitorio ? 'intentos_agotados' : 'error_terminal';
      await tx.query('INSERT INTO integrations.dead_letters (source_type, source_id, reason_code, detail) VALUES ($1, $2, $3, $4)', [r.cola, r.id, motivo, detalle]);
    }
    await registrarEvento(tx, {
      companyId: await empresaDe(tx, r.cola, r.id), actorType: 'system', actorId: 'plataforma.colas',
      action: `cola.${destino}`, aggregateType: r.cola, aggregateId: r.id, correlationId: r.correlationId,
      reason: detalle, payload: { codigo, intento: r.attempts },
    });
    return destino;
  });
}

export async function soltarPorApagado(pool: pg.Pool, r: Reclamo): Promise<void> {
  const { tabla } = TABLA[r.cola];
  await pool.query(`UPDATE ${tabla} SET status = 'pending', lease_token = NULL, lease_until = NULL, attempts = GREATEST(attempts - 1, 0) WHERE ${VIGENTE}`, [r.id, r.token]);
}

export async function liberarVencidos(pool: pg.Pool, cola: Cola): Promise<{ pendientes: number; muertos: number }> {
  const { tabla } = TABLA[cola];
  return enTransaccion(pool, async (tx) => {
    const u = await tx.query<{ id: string; status: string; correlation_id: string }>(
      `UPDATE ${tabla} SET status = CASE WHEN attempts >= max_attempts THEN 'dead_lettered' ELSE 'pending' END,
              lease_token = NULL, lease_until = NULL
        WHERE status = 'claimed' AND lease_until <= now()
        RETURNING id, status, correlation_id`,
    );
    let muertos = 0;
    for (const f of u.rows) {
      if (f.status !== 'dead_lettered') continue;
      muertos++;
      await tx.query("INSERT INTO integrations.dead_letters (source_type, source_id, reason_code, detail) VALUES ($1, $2, 'lease_vencido_agotado', 'el procesamiento se interrumpió en todos los intentos')", [cola, f.id]);
      await registrarEvento(tx, {
        companyId: await empresaDe(tx, cola, f.id), actorType: 'system', actorId: 'plataforma.scheduler',
        action: 'cola.dead_lettered', aggregateType: cola, aggregateId: f.id, correlationId: f.correlation_id,
        reason: 'lease vencido con intentos agotados',
      });
    }
    return { pendientes: u.rows.length - muertos, muertos };
  });
}
