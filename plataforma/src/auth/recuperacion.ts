/*
 * src/auth/recuperacion.ts — recuperar el acceso cuando se perdieron las passkeys (E1-WA-01).
 *
 * Lo primero para no quedar afuera son dos passkeys registradas (teléfono y computadora). Los códigos de un
 * solo uso son el ÚLTIMO recurso y se guardan fuera del sistema: diez, de 128 bits, imposibles de adivinar.
 * No son un segundo factor ni reemplazan a la passkey.
 *
 * Reglas:
 * - El código en claro sólo existe en lo que devuelve `emitirCodigos`; en la base queda su HMAC-SHA256.
 * - Límite de cinco intentos por hora por cuenta, cinco por IP y un tope global, evaluado ANTES de comparar el
 *   código: con el límite alcanzado, ni siquiera un código válido sirve.
 * - La respuesta es la misma exista o no el usuario, para no revelar quién tiene cuenta.
 * - Usar un código lo consume y deja un evento de auditoría, en una sola transacción. No cierra sesiones:
 *   E1 no tiene sesiones reales todavía; eso llega con E4.
 */
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { registrarEvento } from '../audit/auditoria.ts';

export const CODIGOS_POR_EMISION = 10;
export const INTENTOS_POR_HORA = 5;
export const INTENTOS_GLOBALES_POR_HORA = 100;

export type ResultadoRecuperacion = { ok: true } | { ok: false; motivo: 'invalido' | 'limite' };

const ALFABETO = 'abcdefghijklmnopqrstuvwxyz234567';

/** 16 bytes (128 bits) en base32 minúscula sin relleno: 26 caracteres, sin 0/1/8/9 que se confunden. */
function codigoNuevo(): string {
  const bytes = randomBytes(16);
  let bits = 0; let acumulado = 0; let salida = '';
  for (const b of bytes) {
    acumulado = (acumulado << 8) | b; bits += 8;
    while (bits >= 5) { salida += ALFABETO[(acumulado >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) salida += ALFABETO[(acumulado << (5 - bits)) & 31];
  return salida;
}

export const hashDe = (clave: Buffer, codigo: string) => {
  if (clave.length < 32) throw new Error('recuperación: la clave HMAC tiene que tener al menos 32 bytes');
  return createHmac('sha256', clave).update(codigo.trim().toLowerCase()).digest();
};

/** Emite códigos nuevos y deja sin efecto los que quedaban sin usar. Devuelve los códigos en claro. */
export async function emitirCodigos(
  pool: pg.Pool, clave: Buffer, userId: string, ahora: Date, cantidad = CODIGOS_POR_EMISION,
): Promise<string[]> {
  const codigos = Array.from({ length: cantidad }, codigoNuevo);
  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');
    await cliente.query(`UPDATE security.recovery_codes SET used_at = $2 WHERE user_id = $1 AND used_at IS NULL`, [userId, ahora]);
    for (const c of codigos) {
      await cliente.query(`INSERT INTO security.recovery_codes (user_id, code_hash, created_at) VALUES ($1, $2, $3)`, [userId, hashDe(clave, c), ahora]);
    }
    await cliente.query('COMMIT');
    return codigos;
  } catch (e) {
    await cliente.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    cliente.release();
  }
}

export async function usarCodigo(
  pool: pg.Pool, clave: Buffer, userId: string, codigo: string, opciones: { ip: string; ahora: Date },
): Promise<ResultadoRecuperacion> {
  const { ip, ahora } = opciones;
  const desde = new Date(ahora.getTime() - 3_600_000);
  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');
    // Un intento a la vez: sin esto, pedidos simultáneos veían el mismo conteo y pasaban todos el límite.
    await cliente.query(`SELECT pg_advisory_xact_lock(hashtext('security.recovery_attempts'))`);
    const usuario = (await cliente.query<{ company_id: string }>(
      `SELECT company_id FROM security.users WHERE id = $1`, [userId])).rows[0];
    // El límite por cuenta se cuenta por el identificador PEDIDO, exista o no: si se contara sólo para cuentas
    // reales, un id inexistente nunca llegaría al 429 y la diferencia revelaría quién tiene cuenta.
    const conteos = (await cliente.query<{ cuenta: number; ip: number; global: number }>(
      `SELECT count(*) FILTER (WHERE cuenta_pedida = $1)::int AS cuenta,
              count(*) FILTER (WHERE ip = $2::inet)::int AS ip,
              count(*)::int AS global
         FROM security.recovery_attempts WHERE intentado_en > $3 AND NOT exitoso`,
      [userId, ip, desde])).rows[0]!;

    if (conteos.cuenta >= INTENTOS_POR_HORA || conteos.ip >= INTENTOS_POR_HORA || conteos.global >= INTENTOS_GLOBALES_POR_HORA) {
      // Frenado no se registra: cada pedido rechazado sumaba una fila y permitía sostener el bloqueo sin fin.
      await cliente.query('COMMIT');
      return { ok: false, motivo: 'limite' };
    }
    const registrar = (exitoso: boolean) => cliente.query(
      `INSERT INTO security.recovery_attempts (user_id, cuenta_pedida, ip, intentado_en, exitoso) VALUES ($1, $2, $3, $4, $5)`,
      [usuario ? userId : null, userId, ip, ahora, exitoso]);

    const usado = usuario ? (await cliente.query<{ id: string }>(
      `UPDATE security.recovery_codes SET used_at = $3
        WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL RETURNING id`,
      [userId, hashDe(clave, codigo), ahora])).rows[0] : undefined;
    await registrar(Boolean(usado));
    if (usado && usuario) {
      await registrarEvento(cliente, {
        companyId: usuario.company_id, actorType: 'user', actorId: userId,
        action: 'security.recovery_code.used', aggregateType: 'user', aggregateId: userId,
        correlationId: randomUUID(), payload: { ip },
      });
    }
    await cliente.query('COMMIT');
    return usado ? { ok: true } : { ok: false, motivo: 'invalido' };
  } catch (e) {
    await cliente.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    cliente.release();
  }
}
