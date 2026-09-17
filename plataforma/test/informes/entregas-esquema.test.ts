import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { crearPool } from '../../src/db/pool.ts';
import { crearBaseDePrueba, type BaseDePrueba } from '../soporte/base.ts';

describe('informes.entregas', () => {
  let base: BaseDePrueba; let pool: ReturnType<typeof crearPool>;
  beforeAll(async () => { base = await crearBaseDePrueba(); pool = crearPool(base.urlApp); });
  afterAll(async () => { await pool.end(); await base.borrar(); });

  it('una entrega por tipo y fecha', async () => {
    await pool.query(`INSERT INTO informes.entregas (tipo, fecha, hash_contenido) VALUES ('reporte','2026-09-16', repeat('a',64))`);
    await expect(pool.query(`INSERT INTO informes.entregas (tipo, fecha, hash_contenido) VALUES ('reporte','2026-09-16', repeat('b',64))`))
      .rejects.toThrow(/duplicate key/);
  });

  it('rechaza estados y tipos desconocidos', async () => {
    await expect(pool.query(`INSERT INTO informes.entregas (tipo, fecha, estado_deposito, hash_contenido) VALUES ('reporte','2026-09-15','enviado', repeat('a',64))`))
      .rejects.toThrow(/entregas_estado_deposito_check/);
    await expect(pool.query(`INSERT INTO informes.entregas (tipo, fecha, estado_deposito, hash_contenido) VALUES ('otro','2026-09-15','generado', repeat('a',64))`))
      .rejects.toThrow(/entregas_tipo_check/);
  });

  it('el aviso es independiente de la subida: se puede avisar sin haber subido', async () => {
    await pool.query(`INSERT INTO informes.entregas (tipo, fecha, estado_deposito, estado_aviso, hash_contenido)
      VALUES ('manifiesto','2026-09-11','firmado','avisado', repeat('a',64))`);
    const fila = (await pool.query(`SELECT estado_deposito, estado_aviso FROM informes.entregas WHERE fecha='2026-09-11'`)).rows[0];
    expect(fila).toEqual({ estado_deposito: 'firmado', estado_aviso: 'avisado' });
  });

  it('subido exige clave de objeto y versión', async () => {
    await expect(pool.query(`INSERT INTO informes.entregas (tipo, fecha, estado_deposito, hash_contenido)
      VALUES ('reporte','2026-09-10','subido', repeat('a',64))`)).rejects.toThrow(/entregas_subido_check/);
  });

  it('audit_daily_manifests acepta compliance', async () => {
    const r = await pool.query(`SELECT pg_get_constraintdef(oid) d FROM pg_constraint
      WHERE conrelid = 'audit.audit_daily_manifests'::regclass AND conname LIKE '%retention_mode%'`);
    expect(r.rows[0].d).toMatch(/compliance/);
  });

  it('el rol de la aplicación puede leer, insertar y actualizar, pero no borrar', async () => {
    await pool.query(`INSERT INTO informes.entregas (tipo, fecha, estado_deposito, hash_contenido) VALUES ('manifiesto','2026-09-09','generado', repeat('c',64))`);
    expect((await pool.query(`SELECT COUNT(*)::int n FROM informes.entregas WHERE fecha='2026-09-09'`)).rows[0].n).toBe(1);
    await pool.query(`UPDATE informes.entregas SET intentos_deposito = intentos_deposito + 1 WHERE fecha = '2026-09-09'`);
    await expect(pool.query(`DELETE FROM informes.entregas WHERE fecha = '2026-09-09'`)).rejects.toThrow(/permission denied/);
  });
});
