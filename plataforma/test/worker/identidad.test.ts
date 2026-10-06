/*
 * test/worker/identidad.test.ts — E3 corte 1 tarea 4: el ciclo del motor de identidad.
 *
 * Cubre lo que catalogo.test.ts no puede: el candado consultivo. No repite los tests de negocio del
 * motor (SKU único, humana vigente, etc. — eso es motor.test.ts): acá sólo importa que dos vueltas
 * concurrentes no corran el motor dos veces sobre la misma empresa, y que la vuelta suelta el candado
 * al terminar (una vuelta posterior lo puede volver a tomar).
 */
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { iniciarCicloIdentidad, type RegistroCicloIdentidad } from '../../src/worker/identidad.ts';
import { crearPool } from '../../src/db/pool.ts';
import { crearBaseDePrueba, type BaseDePrueba } from '../soporte/base.ts';

const logMudo: RegistroCicloIdentidad = { info: () => undefined, error: () => undefined };

describe('iniciarCicloIdentidad', () => {
  let base: BaseDePrueba; let app: pg.Pool; let admin: pg.Pool; let empresa: string; let ml: string;
  const q = async <T extends pg.QueryResultRow>(sql: string, p: unknown[] = []) => (await admin.query<T>(sql, p)).rows;

  beforeAll(async () => {
    base = await crearBaseDePrueba(); app = crearPool(base.urlApp, { max: 8 }); admin = crearPool(base.urlAdmin, { max: 3 });
    empresa = (await admin.query<{ id: string }>("insert into core.companies(legal_name) values ('F') returning id")).rows[0]!.id;
    ml = (await admin.query<{ id: string }>(
      "insert into core.channel_accounts(company_id,channel,external_account) values ($1,'mercadolibre','1') returning id", [empresa])).rows[0]!.id;
  });
  beforeEach(async () => {
    await admin.query(`TRUNCATE catalog.identity_cases, catalog.identity_decisions, catalog.identity_candidates,
      catalog.matcher_decisions, catalog.model_attributes, catalog.external_representations,
      catalog.sellable_variants, catalog.product_models CASCADE`);
  });
  afterEach(() => { vi.useRealTimers(); });
  afterAll(async () => { await app.end(); await admin.end(); await base.borrar(); });

  async function casoConSkuObservado(recurso: string, skuObservado: string) {
    const modelo = (await admin.query<{ id: string }>(
      `INSERT INTO catalog.product_models (company_id, channel_account_id, origen, clave_origen, titulo)
       VALUES ($1, $2, 'ml_simple', $3, $3) RETURNING id`, [empresa, ml, recurso])).rows[0]!.id;
    const variante = (await admin.query<{ id: string }>(
      'INSERT INTO catalog.sellable_variants (company_id, model_id) VALUES ($1, $2) RETURNING id',
      [empresa, modelo])).rows[0]!.id;
    await admin.query(
      `INSERT INTO catalog.external_representations (company_id, channel_account_id, canal, tipo, recurso, variacion_normalizada, variant_id, model_id, sku_observado)
       VALUES ($1, $2, 'mercadolibre', 'vendible', $3, '', $4, $5, $6)`,
      [empresa, ml, recurso, variante, modelo, skuObservado]);
    await admin.query(
      `INSERT INTO catalog.identity_cases (company_id, tipo, variant_id) VALUES ($1, 'sku_pendiente', $2)`,
      [empresa, variante]);
  }
  async function varianteConSku(sku: string) {
    const modelo = (await admin.query<{ id: string }>(
      `INSERT INTO catalog.product_models (company_id, channel_account_id, origen, clave_origen, titulo)
       VALUES ($1, $2, 'woo_simple', $3, $3) RETURNING id`, [empresa, ml, `Bici ${sku}`])).rows[0]!.id;
    await admin.query('INSERT INTO catalog.sellable_variants (company_id, model_id, sku) VALUES ($1, $2, $3)', [empresa, modelo, sku]);
  }

  it('una vuelta corre el motor y deja el resultado (INSTANCIA sola, sin contención)', async () => {
    await varianteConSku('FB-8001');
    await casoConSkuObservado('MLC1', 'FB-8001');
    vi.useFakeTimers();
    const ciclo = iniciarCicloIdentidad(app, 10_000, logMudo);
    await vi.advanceTimersToNextTimerAsync();
    await ciclo.detener();
    const n = (await q<{ n: number }>(
      "SELECT count(*)::int n FROM catalog.identity_decisions WHERE channel_account_id = $1 AND recurso = 'MLC1' AND origen = 'auto_sku'",
      [ml]))[0]!.n;
    expect(n).toBe(1);
  });

  it('el candado se suelta al terminar la vuelta: una vuelta posterior lo puede volver a tomar', async () => {
    await varianteConSku('FB-8002');
    await casoConSkuObservado('MLC2', 'FB-8002');
    vi.useFakeTimers();
    const ciclo = iniciarCicloIdentidad(app, 10_000, logMudo);
    await vi.advanceTimersToNextTimerAsync(); // dispara la vuelta (async, corre contra la base real).
    await ciclo.detener(); // espera la vuelta en curso antes de seguir (detener() awaitea `enCurso`).
    // Si el candado hubiera quedado tomado, esta consulta directa (otra sesión) fallaría en tomarlo.
    const propio = await admin.connect();
    try {
      const { rows: [libre] } = await propio.query<{ ok: boolean }>("SELECT pg_try_advisory_lock(hashtext('identidad.motor')) AS ok");
      expect(libre?.ok).toBe(true);
      await propio.query("SELECT pg_advisory_unlock(hashtext('identidad.motor'))");
    } finally { propio.release(); }
  });

  it('si otra sesión ya tiene el candado, la vuelta no corre el motor (no revienta, simplemente no hace nada)', async () => {
    await varianteConSku('FB-8003');
    await casoConSkuObservado('MLC3', 'FB-8003');
    const otra = await admin.connect();
    await otra.query("SELECT pg_advisory_lock(hashtext('identidad.motor'))");
    try {
      vi.useFakeTimers();
      const ciclo = iniciarCicloIdentidad(app, 10_000, logMudo);
      await vi.advanceTimersToNextTimerAsync();
      await ciclo.detener();
      const n = (await q<{ n: number }>(
        "SELECT count(*)::int n FROM catalog.identity_decisions WHERE channel_account_id = $1 AND recurso = 'MLC3' AND origen = 'auto_sku'",
        [ml]))[0]!.n;
      expect(n).toBe(0); // el motor no corrió: el caso sigue intacto.
    } finally {
      await otra.query("SELECT pg_advisory_unlock(hashtext('identidad.motor'))");
      otra.release();
    }
  });
});
