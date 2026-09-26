/*
 * test/identidad/canario.test.ts — E3 corte 3 tarea 5: congelar, correr y cerrar el canario (spec §7).
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { crearPool } from '../../src/db/pool.ts';
import { congelarCanario, correrCanario, cerrarCanario } from '../../src/identidad/canario.ts';
import { ErrorBarridoReintentable } from '../../src/worker/barridos.ts';
import { ErrorCanalTerminal } from '../../src/reconciliacion/cliente-http.ts';
import type { Relector, ResultadoRelectura } from '../../src/reconciliacion/relectura.ts';
import { crearBaseDePrueba, type BaseDePrueba } from '../soporte/base.ts';

describe('E3-CAN-01 canario', () => {
  let base: BaseDePrueba; let app: pg.Pool; let admin: pg.Pool; let empresa: string; let ml: string; let n = 0;
  const q = async <T extends pg.QueryResultRow>(sql: string, p: unknown[] = []) => (await admin.query<T>(sql, p)).rows;

  beforeAll(async () => {
    base = await crearBaseDePrueba(); app = crearPool(base.urlApp, { max: 8 }); admin = crearPool(base.urlAdmin, { max: 3 });
    empresa = (await admin.query<{ id: string }>("insert into core.companies(legal_name) values ('F') returning id")).rows[0]!.id;
    ml = (await admin.query<{ id: string }>(
      "insert into core.channel_accounts(company_id,channel,external_account) values ($1,'mercadolibre','1') returning id", [empresa])).rows[0]!.id;
  });
  beforeEach(async () => {
    n = 0;
    await admin.query(`TRUNCATE catalog.e3_canario_casos, catalog.e3_canario_corridas, catalog.identity_cases, catalog.identity_decisions, catalog.matcher_decisions,
      catalog.format_observations, catalog.external_representations, catalog.sellable_variants, catalog.product_models CASCADE`);
  });
  afterAll(async () => { await app.end(); await admin.end(); await base.borrar(); });

  const modelo = async (clave: string) => (await admin.query<{ id: string }>(
    `INSERT INTO catalog.product_models (company_id, channel_account_id, origen, clave_origen, titulo)
     VALUES ($1, $2, 'ml_simple', $3, $3) RETURNING id`, [empresa, ml, clave])).rows[0]!.id;
  const variante = async (sku: string | null) => (await admin.query<{ id: string }>(
    'INSERT INTO catalog.sellable_variants (company_id, model_id, sku) VALUES ($1, $2, $3) RETURNING id', [empresa, await modelo(randomUUID()), sku])).rows[0]!.id;

  /** Caso sku_pendiente con auto_sku/sombra hacia una variante con SKU único. */
  async function escenario(opts: { d5?: boolean; sombra?: boolean } = {}) {
    n++;
    const recurso = `MLA${n}`; const sku = `FB-${1000 + n}`;
    const destino = await variante(sku); const pendiente = await variante(null);
    await admin.query(`INSERT INTO catalog.external_representations (company_id, channel_account_id, canal, tipo, recurso, variacion_normalizada, variant_id)
      VALUES ($1, $2, 'mercadolibre', 'vendible', $3, '', $4)`, [empresa, ml, recurso, pendiente]);
    const caso = (await admin.query<{ id: string }>(
      `INSERT INTO catalog.identity_cases (company_id, tipo, variant_id, estado, detalle) VALUES ($1, 'sku_pendiente', $2, 'actionable', $3) RETURNING id`,
      [empresa, pendiente, JSON.stringify(opts.d5 ? { d5: 'true' } : {})])).rows[0]!.id;
    if (opts.sombra !== false) {
      await admin.query(`INSERT INTO catalog.identity_decisions (company_id, case_id, channel_account_id, recurso, variacion_normalizada, eleccion, variant_id, origen, actor, efecto, engine_version)
        VALUES ($1,$2,$3,$4,'', 'vincular', $5, 'auto_sku', 'identidad.motor', 'sombra', 'test')`, [empresa, caso, ml, recurso, destino]);
    }
    return { recurso, sku, destino, pendiente, caso };
  }
  const humana = (e: { caso: string; recurso: string }, variantId: string) => admin.query(
    `INSERT INTO catalog.identity_decisions (company_id, case_id, channel_account_id, recurso, variacion_normalizada, eleccion, variant_id, origen, actor, efecto)
     VALUES ($1,$2,$3,$4,'','vincular',$5,'humano','jose','aplicar')`, [empresa, e.caso, ml, e.recurso, variantId]);

  const item = (recurso: string, sku: string): ResultadoRelectura => ({
    tipo: 'recursos', recursos: [{ id: recurso, version: 'v1', lifecycle: 'open', projection: null,
      payload: { id: recurso, title: 'x', status: 'active', seller_custom_field: sku, attributes: [], variations: [], listing_type_id: 'gold_special' } }],
  });
  const relectorOk = (skus: Record<string, string>): Relector => ({ topic: 'ml.items', versionKind: 'temporal', id: /.*/, releer: vi.fn(async (r: string) => item(r, skus[r]!)) });
  const estados = async () => q<{ recurso: string; estado: string; tomado_hasta: Date | null }>('SELECT recurso, estado, tomado_hasta FROM catalog.e3_canario_casos ORDER BY recurso');
  const DIA = '2026-09-27';

  it('congelar excluye D5, humana, legado y sin sombra', async () => {
    const bueno = await escenario();
    await escenario({ d5: true });
    const conHumana = await escenario(); await humana(conHumana, conHumana.destino);
    const conLegado = await escenario();
    await admin.query(`INSERT INTO catalog.matcher_decisions (company_id, channel_account_id, canal, recurso, variacion_normalizada, accion, sku, origen, actor) VALUES ($1,$2,'mercadolibre',$3,'','confirmar',$4,'copia','persona')`, [empresa, ml, conLegado.recurso, conLegado.sku]);
    await escenario({ sombra: false });
    const r = await congelarCanario(app, { empresa, dia: DIA });
    expect(r).toMatchObject({ casos: 1, excluidosD5: 1 });
    expect((await estados()).map((e) => e.recurso)).toEqual([bueno.recurso]);
  });

  it('una segunda congelar el mismo día falla y no toca la primera', async () => {
    await escenario();
    await congelarCanario(app, { empresa, dia: DIA });
    await expect(congelarCanario(app, { empresa, dia: DIA })).rejects.toThrow();
    expect(await estados()).toHaveLength(1);
  });

  it('un caso abierto después del congelado no entra', async () => {
    await escenario(); const { corridaId } = await congelarCanario(app, { empresa, dia: DIA });
    await escenario();
    await correrCanario(app, relectorOk({ MLA1: 'FB-1001', MLA2: 'FB-1002' }), { corridaId, bandeja: true });
    expect(await estados()).toHaveLength(1);
  });

  it('correr vincula y es idempotente', async () => {
    const e = await escenario(); const { corridaId } = await congelarCanario(app, { empresa, dia: DIA });
    const rel = relectorOk({ [e.recurso]: e.sku });
    expect(await correrCanario(app, rel, { corridaId, bandeja: true })).toMatchObject({ procesados: 1, vinculados: 1 });
    expect(await correrCanario(app, rel, { corridaId, bandeja: true })).toMatchObject({ procesados: 0, vinculados: 0 });
    expect((await estados())[0]!.estado).toBe('vinculado');
    expect(await q("SELECT 1 FROM catalog.identity_decisions WHERE origen='auto_sku' AND efecto='aplicar' AND superada_en IS NULL")).toHaveLength(1);
  });

  it('un lease vencido se reclama y uno vigente de otro proceso se deja en paz', async () => {
    const a = await escenario(); const b = await escenario();
    const { corridaId } = await congelarCanario(app, { empresa, dia: DIA });
    await admin.query(`UPDATE catalog.e3_canario_casos SET tomado_por='otro', tomado_hasta = now() - interval '1 minute' WHERE recurso = $1`, [a.recurso]);
    await admin.query(`UPDATE catalog.e3_canario_casos SET tomado_por='otro', tomado_hasta = now() + interval '5 minutes' WHERE recurso = $1`, [b.recurso]);
    const r = await correrCanario(app, relectorOk({ [a.recurso]: a.sku, [b.recurso]: b.sku }), { corridaId, bandeja: true });
    expect(r.procesados).toBe(1);
    expect(await estados()).toEqual([expect.objectContaining({ recurso: a.recurso, estado: 'vinculado' }), expect.objectContaining({ recurso: b.recurso, estado: 'pendiente' })]);
  });

  it('[esc:canario-401] a mitad: corrida abortada, lo vinculado queda, el caso en curso vuelve a pendiente', async () => {
    const a = await escenario(); const b = await escenario(); const c = await escenario();
    const { corridaId } = await congelarCanario(app, { empresa, dia: DIA });
    const skus: Record<string, string> = { [a.recurso]: a.sku, [b.recurso]: b.sku, [c.recurso]: c.sku };
    const rel: Relector = { topic: 'ml.items', versionKind: 'temporal', id: /.*/, releer: vi.fn(async (r: string) => { if (r === b.recurso) throw new ErrorCanalTerminal('no autorizado', 401); return item(r, skus[r]!); }) };
    const r = await correrCanario(app, rel, { corridaId, bandeja: true });
    expect(r).toMatchObject({ abortado: true, vinculados: 1 });
    expect((await q<{ estado: string }>('SELECT estado FROM catalog.e3_canario_corridas'))[0]!.estado).toBe('abortada');
    const est = Object.fromEntries((await estados()).map((e) => [e.recurso, e]));
    expect(est[a.recurso]!.estado).toBe('vinculado');
    expect(est[b.recurso]).toMatchObject({ estado: 'pendiente', tomado_hasta: null });
    expect(est[c.recurso]!.estado).toBe('pendiente');
  });

  it('[esc:relectura-5xx] queda parked y un segundo correr lo reintenta a vinculado', async () => {
    const e = await escenario(); const { corridaId } = await congelarCanario(app, { empresa, dia: DIA });
    const caido: Relector = { topic: 'ml.items', versionKind: 'temporal', id: /.*/, releer: vi.fn(async () => { throw new ErrorBarridoReintentable('BULK_503', 0); }) };
    expect(await correrCanario(app, caido, { corridaId, bandeja: true, esperar: async () => {} })).toMatchObject({ parked: 1 });
    expect((await estados())[0]!.estado).toBe('parked');
    expect(await correrCanario(app, relectorOk({ [e.recurso]: e.sku }), { corridaId, bandeja: true })).toMatchObject({ vinculados: 1 });
    expect((await estados())[0]!.estado).toBe('vinculado');
  });

  describe('cerrar (D6)', () => {
    it('un parked cuenta como error y el veredicto es con_errores', async () => {
      await escenario(); const { corridaId } = await congelarCanario(app, { empresa, dia: DIA });
      const caido: Relector = { topic: 'ml.items', versionKind: 'temporal', id: /.*/, releer: vi.fn(async () => { throw new ErrorBarridoReintentable('BULK_503', 0); }) };
      await correrCanario(app, caido, { corridaId, bandeja: true, esperar: async () => {} });
      const r = await cerrarCanario(app, { corridaId });
      expect(r.errores).toEqual([{ tipo: 'parked_sin_resolver', recurso: 'MLA1' }]);
      expect(r.veredicto).toBe('con_errores');
    });

    it('humana posterior a otra variante = corregido_por_jose; a la misma = redundante', async () => {
      const a = await escenario(); const b = await escenario();
      const { corridaId } = await congelarCanario(app, { empresa, dia: DIA });
      await correrCanario(app, relectorOk({ [a.recurso]: a.sku, [b.recurso]: b.sku }), { corridaId, bandeja: true });
      // La humana supera la auto_sku/aplicar vigente (UNIQUE parcial): supersede_a apunta a ella.
      const supersede = async (e: typeof a, variantId: string) => {
        const auto = (await q<{ id: string }>(`SELECT id FROM catalog.identity_decisions WHERE recurso=$1 AND origen='auto_sku' AND efecto='aplicar'`, [e.recurso]))[0]!.id;
        await admin.query(`INSERT INTO catalog.identity_decisions (company_id, case_id, channel_account_id, recurso, variacion_normalizada, eleccion, variant_id, origen, actor, efecto, supersede_a)
          VALUES ($1,$2,$3,$4,'','vincular',$5,'humano','jose','aplicar',$6)`, [empresa, e.caso, ml, e.recurso, variantId, auto]);
      };
      await supersede(a, await variante('FB-9999')); await supersede(b, b.destino);
      const r = await cerrarCanario(app, { corridaId });
      expect(r.errores).toEqual([{ tipo: 'corregido_por_jose', recurso: a.recurso }]);
      expect(r.noErrores.redundante).toBe(1);
      expect(r.veredicto).toBe('con_errores');
    });

    it('con casos pendientes es incompleto y no cierra; una corrida cerrada no se cierra dos veces', async () => {
      await escenario(); const { corridaId } = await congelarCanario(app, { empresa, dia: DIA });
      expect((await cerrarCanario(app, { corridaId })).veredicto).toBe('incompleto');
      expect((await q<{ estado: string }>('SELECT estado FROM catalog.e3_canario_corridas'))[0]!.estado).toBe('abierta');
      await admin.query("UPDATE catalog.e3_canario_casos SET estado='vinculado'");
      expect((await cerrarCanario(app, { corridaId })).veredicto).toBe('cero_errores');
      await expect(cerrarCanario(app, { corridaId })).rejects.toThrow('ya está cerrada');
    });

    it('sin errores el veredicto es cero_errores y la corrida queda cerrada', async () => {
      const e = await escenario(); const { corridaId } = await congelarCanario(app, { empresa, dia: DIA });
      await correrCanario(app, relectorOk({ [e.recurso]: e.sku }), { corridaId, bandeja: true });
      expect((await cerrarCanario(app, { corridaId })).veredicto).toBe('cero_errores');
      expect((await q<{ estado: string }>('SELECT estado FROM catalog.e3_canario_corridas'))[0]!.estado).toBe('cerrada');
    });
  });
});
