/*
 * test/identidad/calibracion.test.ts — E3 corte 1 tarea 7: métricas de calibración.
 */
import fs from 'node:fs';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { calibrar } from '../../src/identidad/calibracion.ts';
import { ENGINE_VERSION } from '../../src/identidad/motor.ts';
import { crearPool } from '../../src/db/pool.ts';
import { crearBaseDePrueba, type BaseDePrueba } from '../soporte/base.ts';

const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/muestra-30.json', import.meta.url), 'utf8'));

describe('E3-CALIB-01 calibrar', () => {
  let base: BaseDePrueba; let admin: pg.Pool; let empresa: string;
  const ventana = { desde: new Date('2026-01-01'), hasta: new Date('2027-01-01') };
  const muestra = fixture.casos.map((c: any) => ({ clave: c.clave, ml: c.ml, skuVerdad: c.sku_verdad ?? null }));

  beforeAll(async () => {
    base = await crearBaseDePrueba(); admin = crearPool(base.urlAdmin, { max: 2 });
    empresa = (await admin.query<{ id: string }>("insert into core.companies(legal_name) values ('F') returning id")).rows[0]!.id;
  });
  afterAll(async () => { await admin.end(); await base.borrar(); });

  it('sobre la muestra congelada, top1 ≤ top3 ≤ recall y todo es proporción [0,1]', async () => {
    const m = await calibrar(admin, { empresa, ...ventana, muestra, catalogo: fixture.catalogo });
    const conVerdad = muestra.filter((v: any) => v.skuVerdad).length;
    expect(m.engineVersion).toBe(ENGINE_VERSION);
    expect(m.n).toBe(conVerdad);
    expect(m.top1).toBeGreaterThan(0);
    expect(m.top1).toBeLessThanOrEqual(m.top3);
    expect(m.top3).toBeLessThanOrEqual(m.recallN);
    expect(m.recallN).toBeLessThanOrEqual(1);
    expect(m.top1MalAlto).toBeLessThanOrEqual(1 - m.top1);
  });

  it('sin decisiones en la ventana: sombra en cero y tiempo mediano null', async () => {
    const m = await calibrar(admin, { empresa, ...ventana, muestra: [], catalogo: fixture.catalogo });
    expect(m.n).toBe(0);
    expect(m.top1).toBe(0);
    expect(m.autoSkuSombra).toEqual({ total: 0, coincideHumana: 0, contradiceHumana: 0 });
    expect(m.tiempoMedianoDecisionS).toBeNull();
  });
});
