/*
 * test/identidad/decidir.test.ts — E3 corte 1 tarea 3: decidirCaso, el servicio de decisión de la bandeja.
 *
 * Foco de revisión del plan: version_conflict sin efecto parcial (b), idempotencia real con doble clic (c) y
 * cuerpo distinto (d), variante inválida por archivada (e) o de otra empresa (f), revertir sólo admin (g)/(h),
 * y bandeja_apagada con el flag off (i).
 */
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { decidirCaso, type PedidoDecision } from '../../src/identidad/decidir.ts';
import { canonizar } from '../../src/informes/jcs.ts';
import { crearPool } from '../../src/db/pool.ts';
import { crearBaseDePrueba, type BaseDePrueba } from '../soporte/base.ts';

describe('E3-DEC-01 decidirCaso', () => {
  let base: BaseDePrueba; let app: pg.Pool; let admin: pg.Pool; let empresa: string; let otraEmpresa: string; let ml: string;
  const q = async <T extends pg.QueryResultRow>(sql: string, p: unknown[] = []) => (await admin.query<T>(sql, p)).rows;

  beforeAll(async () => {
    base = await crearBaseDePrueba(); app = crearPool(base.urlApp, { max: 8 }); admin = crearPool(base.urlAdmin, { max: 3 });
    empresa = (await admin.query<{ id: string }>("insert into core.companies(legal_name) values ('F') returning id")).rows[0]!.id;
    otraEmpresa = (await admin.query<{ id: string }>("insert into core.companies(legal_name) values ('G') returning id")).rows[0]!.id;
    ml = (await admin.query<{ id: string }>(
      "insert into core.channel_accounts(company_id,channel,external_account) values ($1,'mercadolibre','1') returning id", [empresa])).rows[0]!.id;
  });
  beforeEach(async () => {
    await admin.query(`TRUNCATE catalog.identity_cases, catalog.identity_decisions, catalog.matcher_decisions,
      catalog.external_representations, catalog.sellable_variants, catalog.product_models CASCADE`);
  });
  afterAll(async () => { await app.end(); await admin.end(); await base.borrar(); });

  /** Modelo + variante pendiente colgando de una publicación de ML, y el caso sku_pendiente abierto sobre ella. */
  async function casoPendiente(recurso: string, empresaId = empresa, cuentaId = ml) {
    const modelo = (await admin.query<{ id: string }>(
      `INSERT INTO catalog.product_models (company_id, channel_account_id, origen, clave_origen, titulo)
       VALUES ($1, $2, 'ml_simple', $3, $3) RETURNING id`, [empresaId, cuentaId, recurso])).rows[0]!.id;
    const variante = (await admin.query<{ id: string }>(
      'INSERT INTO catalog.sellable_variants (company_id, model_id) VALUES ($1, $2) RETURNING id',
      [empresaId, modelo])).rows[0]!.id;
    await admin.query(
      `INSERT INTO catalog.external_representations (company_id, channel_account_id, canal, tipo, recurso, variacion_normalizada, variant_id)
       VALUES ($1, $2, 'mercadolibre', 'vendible', $3, '', $4)`, [empresaId, cuentaId, recurso, variante]);
    const caso = (await admin.query<{ id: string }>(
      `INSERT INTO catalog.identity_cases (company_id, tipo, variant_id) VALUES ($1, 'sku_pendiente', $2) RETURNING id`,
      [empresaId, variante])).rows[0]!.id;
    return { variante, caso };
  }
  const variantePendiente = async (empresaId = empresa, cuentaId = ml, archivada = false) => {
    const modelo = (await admin.query<{ id: string }>(
      `INSERT INTO catalog.product_models (company_id, channel_account_id, origen, clave_origen, titulo)
       VALUES ($1, $2, 'ml_simple', $3, $3) RETURNING id`, [empresaId, cuentaId, randomUUID()])).rows[0]!.id;
    return (await admin.query<{ id: string }>(
      `INSERT INTO catalog.sellable_variants (company_id, model_id, archivado_en, motivo_archivo)
       VALUES ($1, $2, ${archivada ? 'now()' : 'NULL'}, ${archivada ? "'archivada para el test'" : 'NULL'}) RETURNING id`,
      [empresaId, modelo])).rows[0]!.id;
  };
  const vinculo = async (recurso: string) => (await q<{ v: string | null }>(
    `SELECT r.variant_id AS v FROM catalog.external_representations r WHERE r.channel_account_id = $1 AND r.recurso = $2`,
    [ml, recurso]))[0]?.v;

  /** sha256 canónico del pedido SIN la idempotencyKey, tal como lo exige el paso 1 del flujo. */
  function hashPedido(p: Omit<PedidoDecision, 'idempotencyKey'>): string {
    return createHash('sha256').update(canonizar(p)).digest('hex');
  }
  const pedido = (o: Partial<PedidoDecision> & { caseId: string; expectedVersion: number }): PedidoDecision => ({
    eleccion: 'vincular', actor: 'jose', esAdmin: false, idempotencyKey: randomUUID(), ...o,
  });
  const decidir = (p: PedidoDecision) => decidirCaso(app, p, { bandeja: true });

  it('(a) vincular un caso sku_pendiente: la publicación queda en la variante elegida, el caso se cierra, versión sube a 2, la pendiente se fusiona y hay auditoría', async () => {
    const { variante: destino } = await variantePendienteConSku('FB-1');
    const { variante: pendiente, caso } = await casoPendiente('MLA1');
    const r = await decidir(pedido({ caseId: caso, expectedVersion: 1, eleccion: 'vincular', variantId: destino }));
    expect(r).toMatchObject({ ok: true, version: 2, vinculo: 'vinculada' });
    expect(await vinculo('MLA1')).toBe(destino);
    expect((await q<{ estado: string; cerrado_en: Date | null }>(
      'SELECT estado, cerrado_en FROM catalog.identity_cases WHERE id = $1', [caso]))[0]).toMatchObject({ estado: 'verified', cerrado_en: expect.any(Date) });
    expect((await q<{ archivado_en: Date | null }>('SELECT archivado_en FROM catalog.sellable_variants WHERE id = $1', [pendiente]))[0]!.archivado_en)
      .not.toBeNull();
    expect((await q<{ n: number }>(
      "SELECT count(*)::int n FROM audit.audit_events WHERE action = 'identidad.decision' AND aggregate_id = $1", [caso]))[0]!.n).toBe(1);
  });

  it('(b) dos decidirCaso concurrentes con expectedVersion=1 sobre EL MISMO caso: exactamente un ok y un version_conflict, una sola fila en identity_decisions', async () => {
    const v1 = await variantePendienteConSku('FB-2001'); const v2 = await variantePendienteConSku('FB-2002');
    const { caso } = await casoPendiente('MLA2');
    const [r1, r2] = await Promise.all([
      decidir(pedido({ caseId: caso, expectedVersion: 1, eleccion: 'vincular', variantId: v1.variante })),
      decidir(pedido({ caseId: caso, expectedVersion: 1, eleccion: 'vincular', variantId: v2.variante })),
    ]);
    const oks = [r1, r2].filter((r) => r.ok);
    const conflictos = [r1, r2].filter((r) => !r.ok);
    expect(oks).toHaveLength(1);
    expect(conflictos).toHaveLength(1);
    expect(conflictos[0]).toMatchObject({ ok: false, code: 'version_conflict' });
    expect((await q<{ n: number }>('SELECT count(*)::int n FROM catalog.identity_decisions WHERE case_id = $1', [caso]))[0]!.n).toBe(1);
  });

  it('(c) la misma clave de idempotencia dos veces: el mismo decisionId y una sola fila', async () => {
    const { variante: destino } = await variantePendienteConSku('FB-3');
    const { caso } = await casoPendiente('MLA3');
    const p = pedido({ caseId: caso, expectedVersion: 1, eleccion: 'vincular', variantId: destino });
    const r1 = await decidir(p);
    const r2 = await decidir(p);
    expect(r1.ok && r2.ok).toBe(true);
    if (r1.ok && r2.ok) expect(r1.decisionId).toBe(r2.decisionId);
    expect((await q<{ n: number }>('SELECT count(*)::int n FROM catalog.identity_decisions WHERE case_id = $1', [caso]))[0]!.n).toBe(1);
  });

  it('(d) la misma clave de idempotencia con otro cuerpo: idempotency_mismatch', async () => {
    const { variante: destino } = await variantePendienteConSku('FB-4');
    const { caso } = await casoPendiente('MLA4');
    const clave = randomUUID();
    const r1 = await decidir(pedido({ caseId: caso, expectedVersion: 1, eleccion: 'vincular', variantId: destino, idempotencyKey: clave }));
    expect(r1.ok).toBe(true);
    const r2 = await decidir(pedido({ caseId: caso, expectedVersion: 1, eleccion: 'omitir', idempotencyKey: clave }));
    expect(r2).toMatchObject({ ok: false, code: 'idempotency_mismatch' });
  });

  it('(e) una variante archivada: variante_invalida', async () => {
    const archivada = await variantePendiente(empresa, ml, true);
    const { caso } = await casoPendiente('MLA5');
    const r = await decidir(pedido({ caseId: caso, expectedVersion: 1, eleccion: 'vincular', variantId: archivada }));
    expect(r).toMatchObject({ ok: false, code: 'variante_invalida' });
  });

  it('(f) una variante de otra empresa: variante_invalida', async () => {
    const cuentaOtra = (await admin.query<{ id: string }>(
      "insert into core.channel_accounts(company_id,channel,external_account) values ($1,'mercadolibre','2') returning id", [otraEmpresa])).rows[0]!.id;
    const deOtra = await variantePendiente(otraEmpresa, cuentaOtra, false);
    const { caso } = await casoPendiente('MLA6');
    const r = await decidir(pedido({ caseId: caso, expectedVersion: 1, eleccion: 'vincular', variantId: deOtra }));
    expect(r).toMatchObject({ ok: false, code: 'variante_invalida' });
  });

  it('(g) revertir sin admin: solo_admin', async () => {
    const { variante: destino } = await variantePendienteConSku('FB-7');
    const { caso } = await casoPendiente('MLA7');
    const original = await decidir(pedido({ caseId: caso, expectedVersion: 1, eleccion: 'vincular', variantId: destino }));
    expect(original.ok).toBe(true);
    if (!original.ok) return;
    const r = await decidir(pedido({ caseId: caso, expectedVersion: 2, eleccion: 'sin_candidato', esAdmin: false, revierte: original.decisionId }));
    expect(r).toMatchObject({ ok: false, code: 'solo_admin' });
  });

  it('(h) revertir con admin: una decisión nueva con supersede_a, la anterior con superada_en y el vínculo vuelto atrás', async () => {
    const { variante: destino } = await variantePendienteConSku('FB-8');
    const { variante: pendienteOriginal, caso } = await casoPendiente('MLA8');
    const original = await decidir(pedido({ caseId: caso, expectedVersion: 1, eleccion: 'vincular', variantId: destino }));
    expect(original.ok).toBe(true);
    if (!original.ok) return;
    const r = await decidir(pedido({
      caseId: caso, expectedVersion: 2, eleccion: 'sin_candidato', esAdmin: true, revierte: original.decisionId }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((await q<{ superada_en: Date | null }>('SELECT superada_en FROM catalog.identity_decisions WHERE id = $1', [original.decisionId]))[0]!.superada_en)
      .not.toBeNull();
    expect((await q<{ supersede_a: string | null }>('SELECT supersede_a FROM catalog.identity_decisions WHERE id = $1', [r.decisionId]))[0]!.supersede_a)
      .toBe(original.decisionId);
    // El vínculo vuelve atrás: sin_candidato abre una nueva variante pendiente (no la vieja, que ya se fusionó).
    const vActual = await vinculo('MLA8');
    expect(vActual).not.toBe(destino);
    void pendienteOriginal;
  });

  it('(i) bandeja:false devuelve bandeja_apagada y no escribe ninguna fila', async () => {
    const { variante: destino } = await variantePendienteConSku('FB-9');
    const { caso } = await casoPendiente('MLA9');
    const r = await decidirCaso(app, pedido({ caseId: caso, expectedVersion: 1, eleccion: 'vincular', variantId: destino }), { bandeja: false });
    expect(r).toMatchObject({ ok: false, code: 'bandeja_apagada' });
    expect((await q<{ n: number }>('SELECT count(*)::int n FROM catalog.identity_decisions')).map((x) => x.n)[0]).toBe(0);
    expect((await q<{ version: number }>('SELECT version FROM catalog.identity_cases WHERE id = $1', [caso]))[0]!.version).toBe(1);
  });

  /** Variante con SKU real (Woo), para poder usarla como destino de `vincular` sin chocar con archivado. */
  async function variantePendienteConSku(sku: string, empresaId = empresa, cuentaId = ml) {
    const modelo = (await admin.query<{ id: string }>(
      `INSERT INTO catalog.product_models (company_id, channel_account_id, origen, clave_origen, titulo)
       VALUES ($1, $2, 'woo_simple', $3, $3) RETURNING id`, [empresaId, cuentaId, sku])).rows[0]!.id;
    const variante = (await admin.query<{ id: string }>(
      'INSERT INTO catalog.sellable_variants (company_id, model_id, sku) VALUES ($1, $2, $3) RETURNING id',
      [empresaId, modelo, sku])).rows[0]!.id;
    return { variante };
  }
});
