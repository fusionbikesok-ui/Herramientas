import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { crearPool } from '../../src/db/pool.ts';
import { crearBaseDePrueba, type BaseDePrueba } from '../soporte/base.ts';
import { anotarFallo, avanzarAviso, avanzarDeposito, pendientesVencidas, reclamar } from '../../src/informes/entregas.ts';
import { limpiar } from '../soporte/fixtures.ts';

describe('entregas', () => {
  let base: BaseDePrueba; let pool: ReturnType<typeof crearPool>; let admin: ReturnType<typeof crearPool>;
  const HASH = 'a'.repeat(64);
  const AHORA = new Date('2026-09-17T10:00:00Z');
  beforeAll(async () => { base = await crearBaseDePrueba(); pool = crearPool(base.urlApp); admin = crearPool(base.urlAdmin); });
  afterAll(async () => { await pool.end(); await admin.end(); await base.borrar(); });
  // Cada caso arranca con la tabla vacía: si compartieran filas, el orden decidiría el resultado.
  beforeEach(async () => { await limpiar(admin, ['informes.entregas']); });

  const SUBIDA = { b2_object_key: 'e1/reportes/2026-09-16.json', b2_version_id: 'v1', retention_until: new Date('2027-09-20T00:00:00Z') };

  it('reclama, sube y avisa; los dos estados avanzan por separado', async () => {
    const r = await reclamar(pool, 'reporte', '2026-09-16', { hash: HASH, ahora: AHORA });
    expect(r).toMatchObject({ deposito: 'generado', aviso: 'pendiente' });
    expect(await avanzarDeposito(pool, r!, 'firmado', { kid: 'k1', ruta_pendiente: '/tmp/x.json' }, AHORA)).toBe(true);
    expect(await avanzarDeposito(pool, r!, 'subido', SUBIDA, AHORA)).toBe(true);
    expect(await avanzarAviso(pool, r!, AHORA)).toBe(true);
    const fila = (await pool.query(`SELECT estado_deposito, estado_aviso, kid, b2_version_id, avisado_en FROM informes.entregas WHERE fecha='2026-09-16'`)).rows[0];
    expect(fila).toMatchObject({ estado_deposito: 'subido', estado_aviso: 'avisado', kid: 'k1', b2_version_id: 'v1' });
    expect(fila.avisado_en).not.toBeNull();
  });

  it('avisar sin haber subido deja la subida pendiente y reclamable', async () => {
    const r = await reclamar(pool, 'manifiesto', '2026-09-16', { hash: HASH, ahora: AHORA });
    await avanzarDeposito(pool, r!, 'firmado', {}, AHORA);
    expect(await avanzarAviso(pool, r!, AHORA)).toBe(true);
    await pool.query('UPDATE informes.entregas SET lease_hasta = NULL');
    // Justamente lo que el plan viejo rompía: el email no da por terminada la subida.
    const otra = await reclamar(pool, 'manifiesto', '2026-09-16', { hash: HASH, ahora: AHORA });
    expect(otra).toMatchObject({ deposito: 'firmado', aviso: 'avisado' });
  });

  it('no deja saltear ni retroceder estados', async () => {
    const r = await reclamar(pool, 'reporte', '2026-09-15', { hash: HASH, ahora: AHORA });
    expect(await avanzarDeposito(pool, r!, 'subido', SUBIDA, AHORA)).toBe(false);
    await avanzarDeposito(pool, r!, 'firmado', {}, AHORA);
    await avanzarDeposito(pool, r!, 'subido', SUBIDA, AHORA);
    expect(await avanzarDeposito(pool, r!, 'firmado', {}, AHORA)).toBe(false);
    expect((await pool.query(`SELECT estado_deposito FROM informes.entregas WHERE fecha='2026-09-15'`)).rows[0].estado_deposito).toBe('subido');
  });

  it('un segundo proceso no puede reclamar mientras el lease está vigente', async () => {
    expect(await reclamar(pool, 'reporte', '2026-09-15', { hash: HASH, leaseMs: 60_000, ahora: AHORA })).not.toBeNull();
    expect(await reclamar(pool, 'reporte', '2026-09-15', { hash: HASH, ahora: AHORA })).toBeNull();
  });

  it('cuando el lease vence, el nuevo dueño invalida al viejo', async () => {
    const viejo = await reclamar(pool, 'reporte', '2026-09-14', { hash: HASH, leaseMs: -1, ahora: AHORA });
    const nuevo = await reclamar(pool, 'reporte', '2026-09-14', { hash: HASH, ahora: AHORA });
    expect(nuevo!.testigo).not.toBe(viejo!.testigo);
    // El proceso viejo sigue vivo y cree que le toca: no debe poder escribir.
    expect(await avanzarDeposito(pool, viejo!, 'firmado', {}, AHORA)).toBe(false);
    expect((await pool.query(`SELECT estado_deposito FROM informes.entregas WHERE fecha='2026-09-14'`)).rows[0].estado_deposito).toBe('generado');
  });

  it('con el lease ya vencido, el dueño tampoco escribe', async () => {
    const r = await reclamar(pool, 'reporte', '2026-09-13', { hash: HASH, leaseMs: -1, ahora: AHORA });
    expect(await avanzarDeposito(pool, r!, 'firmado', {}, AHORA)).toBe(false);
  });

  it('el vencimiento se mide contra el reloj real, no contra el instante del reclamo', async () => {
    // Reclama a las 10:00 con un lease de 10 min y recién intenta escribir a las 10:20: tiene que fallar.
    // Sin este caso, una implementación que use el instante del reclamo como hora por omisión pasa igual,
    // porque `lease_hasta > reclamo.ahora` es siempre verdadero (hallazgo crítico de la revisión).
    const r = await reclamar(pool, 'reporte', '2026-09-10', { hash: HASH, leaseMs: 10 * 60_000, ahora: AHORA });
    const despues = new Date(AHORA.getTime() + 20 * 60_000);
    expect(await avanzarDeposito(pool, r!, 'firmado', {}, despues)).toBe(false);
    expect(await avanzarAviso(pool, r!, despues)).toBe(false);
    // Dentro de la ventana, el mismo dueño sí escribe.
    const dentro = new Date(AHORA.getTime() + 60_000);
    expect(await avanzarDeposito(pool, r!, 'firmado', {}, dentro)).toBe(true);
  });

  it('una entrega subida y avisada no se vuelve a reclamar', async () => {
    const r = await reclamar(pool, 'manifiesto', '2026-09-13', { hash: HASH, ahora: AHORA });
    await avanzarDeposito(pool, r!, 'firmado', {}, AHORA);
    await avanzarDeposito(pool, r!, 'subido', SUBIDA, AHORA);
    await avanzarAviso(pool, r!, AHORA);
    await pool.query('UPDATE informes.entregas SET lease_hasta = NULL');
    expect(await reclamar(pool, 'manifiesto', '2026-09-13', { hash: HASH, ahora: AHORA })).toBeNull();
  });

  it('el mismo día con otro contenido no pisa lo ya firmado', async () => {
    const r = await reclamar(pool, 'reporte', '2026-09-12', { hash: HASH, ahora: AHORA });
    await avanzarDeposito(pool, r!, 'firmado', {}, AHORA);
    await pool.query('UPDATE informes.entregas SET lease_hasta = NULL');
    expect(await reclamar(pool, 'reporte', '2026-09-12', { hash: 'b'.repeat(64), ahora: AHORA })).toBeNull();
    const fila = (await pool.query(`SELECT hash_contenido, ultimo_error FROM informes.entregas WHERE fecha='2026-09-12'`)).rows[0];
    expect(fila.hash_contenido).toBe(HASH);
    expect(fila.ultimo_error).toMatch(/hash/);
  });

  it('anotarFallo cuenta los intentos de cada camino por separado', async () => {
    const r = await reclamar(pool, 'manifiesto', '2026-09-12', { hash: HASH, ahora: AHORA });
    await anotarFallo(pool, r!, 'deposito', 'B2 no responde', AHORA);
    await anotarFallo(pool, r!, 'aviso', 'SMTP 451', AHORA);
    const fila = (await pool.query(`SELECT intentos_deposito, intentos_aviso, ultimo_error FROM informes.entregas WHERE fecha='2026-09-12' AND tipo='manifiesto'`)).rows[0];
    expect(fila).toMatchObject({ intentos_deposito: 1, intentos_aviso: 1, ultimo_error: 'SMTP 451' });
  });

  it('pendientesVencidas encuentra las que llevan más de 24 h sin subir', async () => {
    const r = await reclamar(pool, 'manifiesto', '2026-09-11', { hash: HASH, ahora: AHORA });
    await avanzarDeposito(pool, r!, 'firmado', {}, AHORA);
    await pool.query(`UPDATE informes.entregas SET generado_en = $1::timestamptz - interval '30 hours' WHERE fecha='2026-09-11'`, [AHORA]);
    const vencidas = await pendientesVencidas(pool, AHORA);
    expect(vencidas).toHaveLength(1);
    expect(vencidas[0]).toMatchObject({ tipo: 'manifiesto', estado_deposito: 'firmado' });
  });
});
