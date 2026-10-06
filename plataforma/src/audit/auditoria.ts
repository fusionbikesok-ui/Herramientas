import type { Consultable } from '../db/pool.ts';

export interface EventoAuditoria {
  companyId: string;
  actorType: 'user' | 'system' | 'channel';
  actorId: string;
  action: string;
  aggregateType: string;
  aggregateId: string;
  correlationId: string;
  reason?: string;
  payload?: Record<string, unknown>;
}

// Escribe en la conexión o transacción recibida: el llamador decide la atomicidad con su cambio.
// hash, prev_hash y chain_seq los asigna el trigger de la base (schema.sql).
export async function registrarEvento(db: Consultable, e: EventoAuditoria): Promise<{ id: string; chainSeq: string }> {
  const r = await db.query<{ id: string; chain_seq: string }>(
    `INSERT INTO audit.audit_events
       (company_id, actor_type, actor_id, action, aggregate_type, aggregate_id, correlation_id, reason, payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id, chain_seq`,
    [e.companyId, e.actorType, e.actorId, e.action, e.aggregateType, e.aggregateId, e.correlationId, e.reason ?? null, JSON.stringify(e.payload ?? {})],
  );
  const fila = r.rows[0];
  if (!fila) throw new Error('registrarEvento: el INSERT no devolvió fila');
  return { id: fila.id, chainSeq: fila.chain_seq };
}

// Devuelve el primer chain_seq donde la cadena se rompe, o null si está íntegra.
export async function verificarCadena(db: Consultable, desde?: number): Promise<number | null> {
  const r = await db.query<{ roto: string | null }>('SELECT audit.verify_chain($1) AS roto', [desde ?? null]);
  const roto = r.rows[0]?.roto ?? null;
  return roto === null ? null : Number(roto);
}
