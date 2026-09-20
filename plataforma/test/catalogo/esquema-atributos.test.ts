/*
 * test/catalogo/esquema-atributos.test.ts — E2 T2 tarea 1: la migración 0014 sobre una base limpia.
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { crearBaseDePrueba, type BaseDePrueba } from '../soporte/base.ts';
import type { TipoCaso } from '../../src/catalogo/aplicar.ts';

let base: BaseDePrueba; let db: pg.Client; let app: pg.Client;
beforeAll(async () => {
  base = await crearBaseDePrueba();
  db = new pg.Client({ connectionString: base.urlAdmin }); await db.connect();
  app = new pg.Client({ connectionString: base.urlApp }); await app.connect();
});
afterAll(async () => { await db.end(); await app.end(); await base.borrar(); });

const cols = async (tabla: string) => new Map((await db.query<{ column_name: string; data_type: string; is_nullable: string; column_default: string | null }>(
  `SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
   WHERE table_schema = 'catalog' AND table_name = $1`, [tabla])).rows.map((r) => [r.column_name, r]));

async function sembrar() {
  const empresa = (await db.query<{ id: string }>(`INSERT INTO core.companies (legal_name) VALUES ($1) RETURNING id`, [`E ${randomUUID()}`])).rows[0]!.id;
  const cuenta = (await db.query<{ id: string }>(`INSERT INTO core.channel_accounts (company_id, channel, external_account)
    VALUES ($1, 'woocommerce', $2) RETURNING id`, [empresa, randomUUID().slice(0, 12)])).rows[0]!.id;
  const modelo = (await db.query<{ id: string }>(`INSERT INTO catalog.product_models (company_id, channel_account_id, origen, clave_origen, titulo)
    VALUES ($1, $2, 'woo_simple', $3, 'm') RETURNING id`, [empresa, cuenta, randomUUID()])).rows[0]!.id;
  const rep = (await db.query<{ id: string }>(`INSERT INTO catalog.external_representations
    (company_id, channel_account_id, canal, recurso, tipo, model_id) VALUES ($1, $2, 'woocommerce', $3, 'contenedor', $4) RETURNING id`,
    [empresa, cuenta, randomUUID(), modelo])).rows[0]!.id;
  return { empresa, modelo, rep };
}

describe('E2-T2-SCH-01 migración 0014', () => {
  it('external_representations gana siete columnas nullable y sin default', async () => {
    const c = await cols('external_representations');
    const esperado: Record<string, string> = { atributos_crudos: 'jsonb', comercial_crudo: 'jsonb', capturado_en: 'timestamp with time zone',
      precio: 'numeric', moneda: 'text', stock_canal: 'integer', gtin: 'text' };
    for (const [n, tipo] of Object.entries(esperado)) {
      expect(c.get(n)?.data_type, n).toBe(tipo);
      expect(c.get(n)?.is_nullable, n).toBe('YES');
      expect(c.get(n)?.column_default, n).toBeNull();
    }
    const p = (await db.query(`SELECT numeric_precision, numeric_scale FROM information_schema.columns
      WHERE table_schema='catalog' AND table_name='external_representations' AND column_name='precio'`)).rows[0];
    expect([p.numeric_precision, p.numeric_scale]).toEqual([12, 2]);
  });

  it('una representación sin las columnas nuevas sigue siendo válida', async () => {
    const s = await sembrar();
    const r = (await db.query(`SELECT precio, gtin, atributos_crudos FROM catalog.external_representations WHERE id = $1`, [s.rep])).rows[0];
    expect(r).toEqual({ precio: null, gtin: null, atributos_crudos: null });
  });

  it('model_attributes y model_images existen con sus columnas y NOT NULL', async () => {
    const a = await cols('model_attributes');
    for (const n of ['nombre_normalizado', 'valor', 'observado_en', 'model_id', 'representation_id']) expect(a.get(n)?.is_nullable, n).toBe('NO');
    expect(a.get('vigente_hasta')?.is_nullable).toBe('YES');
    const i = await cols('model_images');
    for (const n of ['url', 'observado_en', 'model_id', 'representation_id']) expect(i.get(n)?.is_nullable, n).toBe('NO');
    expect(i.get('orden')?.is_nullable).toBe('YES');
    expect(i.get('vigente_hasta')?.is_nullable).toBe('YES');
  });

  it('el UNIQUE de atributos es (representación, nombre, valor): mismo valor duplicado se rechaza, otra representación no', async () => {
    const s = await sembrar(); const s2 = await sembrar();
    const ins = (rep: string, modelo: string, v = 'maxxis') => app.query(
      `INSERT INTO catalog.model_attributes (model_id, representation_id, nombre_normalizado, valor, observado_en) VALUES ($1,$2,'marca',$3, now())`, [modelo, rep, v]);
    await ins(s.rep, s.modelo);
    await expect(ins(s.rep, s.modelo)).rejects.toMatchObject({ code: '23505' });
    await ins(s.rep, s.modelo, 'otro');
    await ins(s2.rep, s2.modelo);
  });

  it('el UNIQUE de imágenes es (representación, url)', async () => {
    const s = await sembrar(); const s2 = await sembrar();
    const ins = (rep: string, modelo: string) => app.query(
      `INSERT INTO catalog.model_images (model_id, representation_id, url, orden, observado_en) VALUES ($1,$2,'https://x/a.jpg',0, now())`, [modelo, rep]);
    await ins(s.rep, s.modelo);
    await expect(ins(s.rep, s.modelo)).rejects.toMatchObject({ code: '23505' });
    await ins(s2.rep, s2.modelo);
  });

  it('las FK rechazan modelo o representación inexistentes', async () => {
    const s = await sembrar();
    await expect(app.query(`INSERT INTO catalog.model_attributes (model_id, representation_id, nombre_normalizado, valor, observado_en)
      VALUES ($1, $2, 'a', 'b', now())`, [randomUUID(), s.rep])).rejects.toMatchObject({ code: '23503' });
    await expect(app.query(`INSERT INTO catalog.model_images (model_id, representation_id, url, observado_en)
      VALUES ($1, $2, 'u', now())`, [s.modelo, randomUUID()])).rejects.toMatchObject({ code: '23503' });
  });

  it('el índice (nombre_normalizado, valor) existe', async () => {
    const r = await db.query<{ indexdef: string }>(`SELECT indexdef FROM pg_indexes WHERE schemaname='catalog' AND tablename='model_attributes'`);
    expect(r.rows.some((x) => /\(nombre_normalizado, valor\)/.test(x.indexdef))).toBe(true);
  });

  it('plataforma_app hereda SELECT/INSERT/UPDATE y no tiene DELETE (default privileges de 0013)', async () => {
    const s = await sembrar();
    await app.query(`INSERT INTO catalog.model_attributes (model_id, representation_id, nombre_normalizado, valor, observado_en) VALUES ($1,$2,'a','b', now())`, [s.modelo, s.rep]);
    await app.query(`UPDATE catalog.model_attributes SET vigente_hasta = now() WHERE representation_id = $1`, [s.rep]);
    expect((await app.query(`SELECT 1 FROM catalog.model_attributes WHERE representation_id = $1`, [s.rep])).rowCount).toBe(1);
    await expect(app.query(`DELETE FROM catalog.model_attributes WHERE representation_id = $1`, [s.rep])).rejects.toMatchObject({ code: '42501' });
    await expect(app.query(`DELETE FROM catalog.model_images`)).rejects.toMatchObject({ code: '42501' });
  });

  it('identity_cases admite atributo_divergente y sigue rechazando tipos desconocidos', async () => {
    const s = await sembrar();
    const tipo: TipoCaso = 'atributo_divergente';
    await db.query(`INSERT INTO catalog.identity_cases (company_id, tipo, representation_id) VALUES ($1, $2, $3)`, [s.empresa, tipo, s.rep]);
    await expect(db.query(`INSERT INTO catalog.identity_cases (company_id, tipo, representation_id) VALUES ($1, 'inventado', $2)`, [s.empresa, s.rep]))
      .rejects.toMatchObject({ code: '23514' });
  });
});
