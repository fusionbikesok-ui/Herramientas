import { createHmac, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { crearPool } from '../src/db/pool.ts';
import { emitirCodigos, INTENTOS_POR_HORA, usarCodigo } from '../src/auth/recuperacion.ts';
import { crearBaseDePrueba, type BaseDePrueba } from './soporte/base.ts';
import { limpiar, sembrar } from './soporte/fixtures.ts';

const CLAVE = randomBytes(32);
const AHORA = new Date('2026-09-17T10:00:00Z');

describe('recuperación de acceso', () => {
  let base: BaseDePrueba; let pool: ReturnType<typeof crearPool>; let admin: ReturnType<typeof crearPool>;
  let userId: string;
  beforeAll(async () => { base = await crearBaseDePrueba(); pool = crearPool(base.urlApp); admin = crearPool(base.urlAdmin); });
  afterAll(async () => { await pool.end(); await admin.end(); await base.borrar(); });
  // Cada caso con su propio usuario y sin intentos previos: el límite de uno no puede afectar al otro.
  beforeEach(async () => {
    await limpiar(admin, ['security.recovery_attempts', 'security.recovery_codes']);
    userId = (await sembrar(pool)).userId;
  });
  const usar = (codigo: string, ip: string, ahora = AHORA, usuario = userId) => usarCodigo(pool, CLAVE, usuario, codigo, { ip, ahora });

  it('E1-WA-01 emite 10 códigos de 128 bits y no los guarda en claro', async () => {
    const codigos = await emitirCodigos(pool, CLAVE, userId, AHORA);
    expect(codigos).toHaveLength(10);
    expect(new Set(codigos).size).toBe(10);
    // 128 bits en base32 son 26 caracteres, sin los que se confunden al leerlos en papel.
    for (const c of codigos) expect(c).toMatch(/^[a-z2-7]{26}$/);
    const filas = await pool.query(`SELECT encode(code_hash, 'hex') AS h FROM security.recovery_codes WHERE user_id = $1`, [userId]);
    expect(filas.rows).toHaveLength(10);
    expect(JSON.stringify(filas.rows)).not.toContain(codigos[0]!);
  });

  it('E1-WA-01 un código sirve una sola vez y deja su evento de auditoría', async () => {
    const [codigo] = await emitirCodigos(pool, CLAVE, userId, AHORA, 1);
    expect(await usar(codigo!, '1.2.3.4')).toEqual({ ok: true });
    expect(await usar(codigo!, '1.2.3.4')).toEqual({ ok: false, motivo: 'invalido' });
    const eventos = await pool.query(`SELECT COUNT(*)::int n FROM audit.audit_events WHERE action = 'security.recovery_code.used' AND aggregate_id = $1`, [userId]);
    expect(eventos.rows[0].n).toBe(1);
  });

  it('emitir de nuevo invalida los códigos que quedaban', async () => {
    const [viejo] = await emitirCodigos(pool, CLAVE, userId, AHORA, 1);
    await emitirCodigos(pool, CLAVE, userId, AHORA, 1);
    expect(await usar(viejo!, '1.2.3.4')).toEqual({ ok: false, motivo: 'invalido' });
  });

  it('E1-WA-01 corta a los 5 intentos fallidos por cuenta en una hora', async () => {
    // Cinco IP distintas: el que corta acá es el límite por cuenta, no el de IP.
    for (let i = 0; i < INTENTOS_POR_HORA; i += 1) await usar('nosirve', `10.0.0.${i}`);
    expect(await usar('nosirve', '10.0.0.9')).toEqual({ ok: false, motivo: 'limite' });
    // Pasada la hora vuelve a aceptar intentos.
    expect(await usar('nosirve', '10.0.0.9', new Date(AHORA.getTime() + 61 * 60_000))).toEqual({ ok: false, motivo: 'invalido' });
  });

  it('corta también por IP, con cuentas distintas', async () => {
    for (let i = 0; i < INTENTOS_POR_HORA; i += 1) {
      const otro = (await sembrar(pool)).userId;
      await usar('nosirve', '7.7.7.7', AHORA, otro);
    }
    expect(await usar('nosirve', '7.7.7.7')).toEqual({ ok: false, motivo: 'limite' });
  });

  it('un código válido no sirve si la cuenta ya está frenada', async () => {
    const [codigo] = await emitirCodigos(pool, CLAVE, userId, AHORA, 1);
    for (let i = 0; i < INTENTOS_POR_HORA; i += 1) await usar('nosirve', `8.8.8.${i}`);
    expect(await usar(codigo!, '8.8.9.9')).toEqual({ ok: false, motivo: 'limite' });
  });

  it('responde igual exista o no el usuario', async () => {
    const inexistente = '00000000-0000-7000-8000-0000000000ff';
    expect(await usar('nosirve', '5.5.5.5', AHORA, inexistente)).toEqual(await usar('nosirve', '6.6.6.6'));
  });

  it('guarda exactamente el HMAC-SHA256 del código con la clave', async () => {
    const [codigo] = await emitirCodigos(pool, CLAVE, userId, AHORA, 1);
    const esperado = createHmac('sha256', CLAVE).update(codigo!).digest('hex');
    const fila = await pool.query(`SELECT encode(code_hash, 'hex') AS h FROM security.recovery_codes WHERE user_id = $1 AND used_at IS NULL`, [userId]);
    expect(fila.rows[0].h).toBe(esperado);
  });

  it('después del bloqueo tampoco se distingue un usuario inexistente', async () => {
    const inexistente = '00000000-0000-7000-8000-0000000000aa';
    for (let i = 0; i < INTENTOS_POR_HORA; i += 1) {
      await usar('nosirve', `20.0.0.${i}`, AHORA, inexistente);
      await usar('nosirve', `21.0.0.${i}`);
    }
    // Las dos cuentas, la real y la que no existe, quedan frenadas igual.
    expect(await usar('nosirve', '22.0.0.1', AHORA, inexistente)).toEqual({ ok: false, motivo: 'limite' });
    expect(await usar('nosirve', '22.0.0.2')).toEqual({ ok: false, motivo: 'limite' });
  });

  it('intentos simultáneos no pasan todos el límite', async () => {
    const resultados = await Promise.all(Array.from({ length: 12 }, (_, i) => usar('nosirve', `30.0.0.${i}`)));
    expect(resultados.filter((r) => !r.ok && r.motivo === 'invalido')).toHaveLength(INTENTOS_POR_HORA);
    expect(resultados.filter((r) => !r.ok && r.motivo === 'limite')).toHaveLength(12 - INTENTOS_POR_HORA);
  });
});
