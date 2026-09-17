/*
 * src/informes/manifiesto.ts — el extremo de la cadena de auditoría de cada día, fuera de la base.
 *
 * La cadena de hashes detecta que alguien modificó o borró un evento del medio, pero no que borró el
 * último: nada apunta al que ya no está. El manifiesto firmado de cada día fija ese extremo afuera.
 *
 * Todo se lee en una transacción REPEATABLE READ que primero fija el último chain_seq y después verifica
 * hasta ese valor: con eventos entrando en paralelo, conteo, extremos y verificación podían describir tres
 * estados distintos (hallazgo 18 de la revisión externa).
 */
import type pg from 'pg';
import { medianocheArt } from './dia.ts';

export interface Manifiesto {
  tipo: 'manifiesto';
  fecha: string;
  ventana: { desde: string; hasta: string };
  primer_chain_seq: string | null;
  ultimo_chain_seq: string | null;
  ultimo_hash: string;
  eventos: number;
  cadena: { integra: boolean; roto_en: string | null };
}

const HASH_CERO = '0'.repeat(64);

export async function armarManifiesto(pool: pg.Pool, fecha: string): Promise<Manifiesto> {
  const desde = medianocheArt(fecha);
  const siguiente = new Date(desde.getTime());
  siguiente.setUTCDate(siguiente.getUTCDate() + 1);
  const hasta = medianocheArt(siguiente.toISOString().slice(0, 10));

  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const dia = await cliente.query<{ primero: string | null; ultimo: string | null; n: string }>(
      `SELECT MIN(chain_seq)::text AS primero, MAX(chain_seq)::text AS ultimo, COUNT(*)::text AS n
         FROM audit.audit_events WHERE occurred_at >= $1 AND occurred_at < $2`,
      [desde, hasta],
    );
    const { primero, ultimo, n } = dia.rows[0]!;
    // Sin eventos en el día, el extremo que se fija es el último hash conocido hasta el fin del día.
    const hash = await cliente.query<{ hash: string | null }>(
      `SELECT encode(hash, 'hex') AS hash FROM audit.audit_events
        WHERE occurred_at < $1 ORDER BY chain_seq DESC LIMIT 1`,
      [hasta],
    );
    // La función real es verify_chain(desde, hasta): se verifica hasta el extremo capturado, no toda la
    // cadena, para que un evento posterior no cambie el veredicto del día (hallazgo 10 de la revisión).
    const roto = await cliente.query<{ roto: string | null }>(
      'SELECT audit.verify_chain(NULL::bigint, $1::bigint) AS roto', [ultimo]);
    const rotoEn = roto.rows[0]?.roto ?? null;
    await cliente.query('COMMIT');

    return {
      tipo: 'manifiesto', fecha, ventana: { desde: desde.toISOString(), hasta: hasta.toISOString() },
      primer_chain_seq: primero, ultimo_chain_seq: ultimo,
      ultimo_hash: hash.rows[0]?.hash ?? HASH_CERO, eventos: Number(n),
      cadena: { integra: rotoEn === null, roto_en: rotoEn },
    };
  } catch (e) {
    await cliente.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    cliente.release();
  }
}
