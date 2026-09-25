/*
 * test/identidad/calibracion.test.ts — E3 corte 1 tarea 7: métricas de calibración.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { apartarCaso } from '../../src/identidad/apartar.ts';
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

  it('[esc:calibracion] sobre la muestra congelada, top1 ≤ top3 ≤ recall y todo es proporción [0,1]', async () => {
    const { muestra: m, ventana: v } = await calibrar(admin, { empresa, ...ventana, muestra, catalogo: fixture.catalogo });
    expect(v.n).toBe(0); // la ventana no se mezcla con la muestra
    const conVerdad = muestra.filter((v: any) => v.skuVerdad).length;
    expect(m.n).toBe(conVerdad);
    expect(m.top1).toBeGreaterThan(0);
    expect(m.top1).toBeLessThanOrEqual(m.top3);
    expect(m.top3).toBeLessThanOrEqual(m.recallN);
    expect(m.recallN).toBeLessThanOrEqual(1);
    expect(m.top1MalAlto).toBeLessThanOrEqual(1 - m.top1);
  });

  it('sin decisiones en la ventana: sombra en cero y tiempo mediano null', async () => {
    const m = await calibrar(admin, { empresa, ...ventana, muestra: [], catalogo: fixture.catalogo });
    expect(m.engineVersion).toBe(ENGINE_VERSION);
    expect(m.total.n).toBe(0);
    expect(m.total.top1).toBe(0);
    expect(m.autoSkuSombra).toEqual({ total: 0, coincideHumana: 0, contradiceHumana: 0 });
    expect(m.tiempoMedianoDecisionS).toBeNull();
  });

  // ─────────────── escenarios con Postgres ───────────────
  let ml: string; let seq = 0;
  const q = async <T extends pg.QueryResultRow>(sql: string, p: unknown[] = []) => (await admin.query<T>(sql, p)).rows;
  const vacia = { empresa: '', ...ventana, muestra: [] as any[], catalogo: [] as any[] };
  const run = () => calibrar(admin, { ...vacia, empresa });

  async function limpiar() {
    await admin.query(`TRUNCATE catalog.identity_cases, catalog.identity_decisions, catalog.identity_candidates,
      catalog.matcher_decisions, catalog.model_attributes, catalog.external_representations,
      catalog.sellable_variants, catalog.product_models CASCADE`);
  }
  async function destino() {
    seq++;
    const modelo = (await q<{ id: string }>(
      `INSERT INTO catalog.product_models (company_id, channel_account_id, origen, clave_origen, titulo)
       VALUES ($1, $2, 'woo_simple', $3, $3) RETURNING id`, [empresa, ml, `D${seq}`]))[0]!.id;
    return (await q<{ id: string }>('INSERT INTO catalog.sellable_variants (company_id, model_id, sku) VALUES ($1, $2, $3) RETURNING id',
      [empresa, modelo, `FB-${7000 + seq}`]))[0]!.id;
  }
  /** Caso ML abierto en `abierto`; devuelve su recurso y case_id. */
  async function caso(abierto = '2026-06-01T10:00:00Z') {
    seq++;
    const recurso = `MLC${seq}`;
    const modelo = (await q<{ id: string }>(
      `INSERT INTO catalog.product_models (company_id, channel_account_id, origen, clave_origen, titulo)
       VALUES ($1, $2, 'ml_simple', $3, $3) RETURNING id`, [empresa, ml, recurso]))[0]!.id;
    const variante = (await q<{ id: string }>('INSERT INTO catalog.sellable_variants (company_id, model_id) VALUES ($1, $2) RETURNING id', [empresa, modelo]))[0]!.id;
    const id = (await q<{ id: string }>(
      `INSERT INTO catalog.identity_cases (company_id, tipo, variant_id, abierto_en) VALUES ($1, 'sku_pendiente', $2, $3) RETURNING id`,
      [empresa, variante, abierto]))[0]!.id;
    return { recurso, id };
  }
  async function decision(c: { recurso: string; id: string | null }, o: { origen: 'humano' | 'auto_sku'; eleccion?: string; variante?: string | null; en: string; supersede?: string }) {
    const eleccion = o.eleccion ?? 'vincular';
    return (await q<{ id: string }>(
      `INSERT INTO catalog.identity_decisions (company_id, case_id, channel_account_id, recurso, variacion_normalizada, eleccion, variant_id, origen, actor, efecto, supersede_a, creado_en)
       VALUES ($1, $2, $3, $4, '', $5, $6, $7, 'x', $8, $9, $10) RETURNING id`,
      [empresa, c.id, ml, c.recurso, eleccion, eleccion === 'vincular' ? o.variante ?? null : null, o.origen,
       o.origen === 'humano' ? 'aplicar' : 'sombra', o.supersede ?? null, o.en]))[0]!.id;
  }
  async function corrida(casoId: string, en: string, lista: Array<[string, number]>) {
    const runId = randomUUID();
    for (const [i, [v, puntaje]] of lista.entries()) {
      await admin.query(
        `INSERT INTO catalog.identity_candidates (case_id, run_id, variant_id, rank, puntaje, engine_version, creado_en) VALUES ($1, $2, $3, $4, $5, 'test', $6)`,
        [casoId, runId, v, i + 1, puntaje, en]);
    }
  }

  describe('con decisiones', () => {
    beforeAll(async () => {
      ml = (await q<{ id: string }>("insert into core.channel_accounts(company_id,channel,external_account) values ($1,'mercadolibre','9') returning id", [empresa]))[0]!.id;
    });
    beforeEach(limpiar);

    it('humanas de la ventana: top1, top3 sin top1, sin candidatos (fallo) y top1 equivocado con puntaje alto', async () => {
      const [t1, t2, t3, t4, x] = [await destino(), await destino(), await destino(), await destino(), await destino()];
      const a = await caso(); await corrida(a.id, '2026-06-01T10:01:00Z', [[t1, 0.9]]); await decision(a, { origen: 'humano', variante: t1, en: '2026-06-01T11:00:00Z' });
      const b = await caso(); await corrida(b.id, '2026-06-01T10:01:00Z', [[x, 0.5], [t2, 0.4]]); await decision(b, { origen: 'humano', variante: t2, en: '2026-06-01T11:00:00Z' });
      const c = await caso(); await decision(c, { origen: 'humano', variante: t3, en: '2026-06-01T11:00:00Z' });
      const d = await caso(); await corrida(d.id, '2026-06-01T10:01:00Z', [[x, 0.9], [t4, 0.2]]); await decision(d, { origen: 'humano', variante: t4, en: '2026-06-01T11:00:00Z' });
      const m = await run();
      expect(m.muestra.n).toBe(0);
      expect(m.ventana).toEqual({ n: 4, top1: 0.25, top3: 0.75, top1MalAlto: 0.25, recallN: 0.75 });
      expect(m.total).toEqual(m.ventana);
    });

    it('apartar un caso de la ventana no cambia ninguna métrica: «No estoy seguro» no es una decisión', async () => {
      const [t1, t2] = [await destino(), await destino()];
      const a = await caso(); await corrida(a.id, '2026-06-01T10:01:00Z', [[t1, 0.9]]); await decision(a, { origen: 'humano', variante: t1, en: '2026-06-01T11:00:00Z' });
      const b = await caso(); await corrida(b.id, '2026-06-01T10:01:00Z', [[t2, 0.9]]); await decision(b, { origen: 'humano', variante: t2, en: '2026-06-01T11:00:00Z' });
      const antes = await run();
      await apartarCaso(admin, { caseId: b.id, expectedVersion: 1, actor: 'jose', idempotencyKey: 'apt-1' });
      const despues = await run();
      expect(despues).toEqual(antes);
    });

    it('una corrida posterior a la decisión no cuenta (sin fuga de la verdad)', async () => {
      const [t, x] = [await destino(), await destino()];
      const a = await caso();
      await corrida(a.id, '2026-06-01T10:01:00Z', [[x, 0.3]]); // lo que tenía delante: sin acierto
      await decision(a, { origen: 'humano', variante: t, en: '2026-06-01T11:00:00Z' });
      await corrida(a.id, '2026-06-01T12:00:00Z', [[t, 0.95]]); // recorrido posterior, ya con la verdad decidida
      const m = await run();
      expect(m.ventana.n).toBe(1);
      expect(m.ventana.top1).toBe(0);
      expect(m.ventana.recallN).toBe(0);
    });

    it('decisiones fuera de la ventana o no vincular no entran', async () => {
      const t = await destino();
      const a = await caso(); await corrida(a.id, '2026-06-01T10:01:00Z', [[t, 0.9]]);
      await decision(a, { origen: 'humano', variante: t, en: '2025-06-01T11:00:00Z' });
      const b = await caso(); await decision(b, { origen: 'humano', eleccion: 'omitir', en: '2026-06-01T11:00:00Z' });
      expect((await run()).ventana.n).toBe(0);
    });

    it('auto_sku en sombra: coincide, contradice y sin humana', async () => {
      const [t1, t2, otro] = [await destino(), await destino(), await destino()];
      const a = await caso(); await decision(a, { origen: 'auto_sku', variante: t1, en: '2026-06-01T10:30:00Z' }); await decision(a, { origen: 'humano', variante: t1, en: '2026-06-01T11:00:00Z' });
      const b = await caso(); await decision(b, { origen: 'auto_sku', variante: t2, en: '2026-06-01T10:30:00Z' }); await decision(b, { origen: 'humano', variante: otro, en: '2026-06-01T11:00:00Z' });
      const c = await caso(); await decision(c, { origen: 'auto_sku', variante: t2, en: '2026-06-01T10:30:00Z' });
      expect((await run()).autoSkuSombra).toEqual({ total: 3, coincideHumana: 1, contradiceHumana: 1 });
    });

    it('tiempo mediano de resolución: mediana de las humanas originales, sin contar reversiones', async () => {
      const t = await destino();
      const a = await caso('2026-06-01T10:00:00Z'); await decision(a, { origen: 'humano', variante: t, en: '2026-06-01T10:01:40Z' }); // 100 s
      const b = await caso('2026-06-01T10:00:00Z'); const db = await decision(b, { origen: 'humano', variante: t, en: '2026-06-01T10:05:00Z' }); // 300 s
      await decision(b, { origen: 'humano', eleccion: 'sin_candidato', en: '2026-06-02T10:00:00Z', supersede: db }); // reversión: 1 día
      expect((await run()).tiempoMedianoDecisionS).toBe(200);
    });
  });
});
