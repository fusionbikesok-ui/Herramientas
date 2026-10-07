import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import { openDb } from '../db/index.js';
import { computedStockCte } from '../routes/sync.js';

const TEST_DB = './test/fase-c-cte.sqlite';
const TS = '2026-10-07T12:00:00.000Z';
const ACTIVO = { IDENTIDAD_PROTECCION: 'activo' };

describe('Fase C: CTE del sync de stock (R2)', () => {
  let db;
  beforeEach(() => { db = openDb(TEST_DB); });
  afterEach(() => { db.close(); if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB); });

  let idWoo = 0;
  // Un producto vinculado con stock 7 en Woo; seller_sku de ML configurable.
  const vinculada = (n, sellerSku, { accion = 'confirmar' } = {}) => {
    const clave = `MLA${n}|`; const sku = `FB-${n}`;
    db.prepare(`INSERT INTO catalogo_cache (id_woo,nombre,sku,tipo,stock,actualizado_en) VALUES (?,?,?,'simple',7,?)`).run(++idWoo, `P${n}`, sku, TS);
    db.prepare(`INSERT INTO ml_publicaciones_cache (clave,item_id,variation_id,titulo,status,seller_sku,available_quantity,actualizado_en)
      VALUES (?,?,'','x','active',?,7,datetime('now'))`).run(clave, `MLA${n}`, sellerSku);
    db.prepare("INSERT INTO sku_matcher_decisiones (clave,sku,accion,actualizado_en) VALUES (?,?,?,datetime('now'))").run(clave, sku, accion);
    return clave;
  };
  const caso = (clave, clasificacion, estado = 'urgente') => db.prepare(`INSERT INTO identidad_casos
    (direccion,ml_key,clasificacion,estado,severidad,evidencia_fingerprint,primera_deteccion_en,ultima_deteccion_en)
    VALUES ('ml_fusion',?,?,?,'urgente','fp',?,?)`).run(clave, clasificacion, estado, TS, TS);
  const guardia = (clave) => db.prepare(`INSERT INTO guardia_ml_casos
    (clave,estado,motivo,bloquea_sync,creado_en,actualizado_en) VALUES (?,'abierto','sin_cobertura',1,?,?)`).run(clave, TS, TS);
  const stock = (env) => Object.fromEntries(db.prepare(`${computedStockCte(env)} SELECT clave, stock_disponible_ml s FROM computed`).all().map((r) => [r.clave, r.s]));

  it('SKU igual con GTIN contradictorio sincroniza el stock de Woo', () => {
    const c = vinculada(1, 'FB-1'); caso(c, 'gtin_contradictorio');
    expect(stock(ACTIVO)[c]).toBe(7);
  });
  it('SKU distinto con contradicción manda 0', () => {
    const c = vinculada(1, 'FB-9'); caso(c, 'gtin_contradictorio');
    expect(stock(ACTIVO)[c]).toBe(0);
  });
  it('seller_sku faltante con contradicción de título manda 0', () => {
    const c = vinculada(1, null); caso(c, 'contradiccion_titulo', 'tomado');
    expect(stock(ACTIVO)[c]).toBe(0);
  });
  it('intervencion manda 0', () => {
    const c = vinculada(1, 'FB-1'); caso(c, 'sku_exacto', 'intervencion');
    expect(stock(ACTIVO)[c]).toBe(0);
  });
  it('decision_no_aplicada y pendiente siguen normal', () => {
    const c = vinculada(1, 'FB-9'); caso(c, 'decision_no_aplicada', 'pendiente');
    expect(stock(ACTIVO)[c]).toBe(7);
  });
  it('omitir se ignora: no aparece en la CTE', () => {
    const c = vinculada(1, 'FB-1', { accion: 'omitir' });
    expect(stock(ACTIVO)).not.toHaveProperty(c);
  });
  it('en activo ya no depende de guardia_ml_casos', () => {
    const c = vinculada(1, 'FB-1'); guardia(c);
    expect(stock(ACTIVO)[c]).toBe(7);
  });
  it('expone frena_identidad', () => {
    const a = vinculada(1, 'FB-9'); caso(a, 'gtin_contradictorio');
    const b = vinculada(2, 'FB-2');
    const r = Object.fromEntries(db.prepare(`${computedStockCte(ACTIVO)} SELECT clave, frena_identidad f FROM computed`).all().map((x) => [x.clave, x.f]));
    expect(r).toEqual({ [a]: 1, [b]: 0 });
  });

  describe('sombra y apagado: la CTE es exactamente la de hoy', () => {
    it('mismo texto en sombra, apagado, sin variable y valor inválido', () => {
      const hoy = computedStockCte({ IDENTIDAD_PROTECCION: 'sombra' });
      for (const env of [{}, { IDENTIDAD_PROTECCION: 'apagado' }, { IDENTIDAD_PROTECCION: 'xx' }]) expect(computedStockCte(env)).toBe(hoy);
      expect(hoy).not.toBe(computedStockCte(ACTIVO));
      expect(hoy).toContain('guardia_ml_casos');
    });
    it('en sombra el resultado no cambia: Guardia sigue bloqueando y R2 no aplica', () => {
      const a = vinculada(1, 'FB-9'); caso(a, 'gtin_contradictorio');   // R2 lo frenaría en activo
      const b = vinculada(2, 'FB-2'); guardia(b);                        // Guardia lo excluye hoy
      const c = vinculada(3, 'FB-3');
      expect(stock({})).toEqual({ [a]: 7, [c]: 7 });
    });
  });
});
