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
    // ORDER BY chain_seq (no `chain_seq::text AS chain_seq`) a propósito: con el alias casteado a
    // texto, Postgres resolvía el ORDER BY contra ESE alias y ordenaba lexicográficamente, así que
    // '9999' (empieza con '9') le ganaba en orden de texto a '10000' o más (empiezan con '1') y el
    // LIMIT 1 devolvía el hash de un evento viejo en vez del último real (bug en producción
    // 2026-09-19 a 2026-09-22, encontrado en la evidencia de aceptación de E2).
    const hash = await cliente.query<{ hash: string | null; chain_seq_texto: string | null }>(
      `SELECT encode(hash, 'hex') AS hash, chain_seq::text AS chain_seq_texto FROM audit.audit_events
        WHERE occurred_at < $1 ORDER BY chain_seq DESC LIMIT 1`,
      [hasta],
    );
    // La función real es verify_chain(desde, hasta): se verifica hasta el extremo capturado, no toda la
    // cadena, para que un evento posterior no cambie el veredicto del día (hallazgo 10 de la revisión).
    // En un día sin eventos `ultimo` es null, y verify_chain interpreta `hasta = NULL` como "sin tope":
    // sin este resguardo, un día vacío terminaría verificando también los eventos POSTERIORES al día
    // reportado, y una corrupción futura podría marcar como rota una jornada que nunca tuvo problema.
    // El tope correcto para un día vacío es el chain_seq del último hash conocido hasta el fin del día
    // (el mismo que se acaba de leer arriba). Si tampoco hay cadena previa (nada ocurrió todavía a esa
    // fecha), no hay nada que verificar: pasar hasta=NULL igual sería "sin tope" y volvería a mirar
    // eventos futuros, así que directamente no se llama a verify_chain.
    const hastaVerificar = ultimo ?? hash.rows[0]?.chain_seq_texto ?? null;
    const rotoEn = hastaVerificar === null ? null : (await cliente.query<{ roto: string | null }>(
      'SELECT audit.verify_chain(NULL::bigint, $1::bigint) AS roto', [hastaVerificar])).rows[0]?.roto ?? null;
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
