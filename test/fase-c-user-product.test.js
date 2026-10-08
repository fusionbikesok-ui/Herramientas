import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import { openDb } from '../db/index.js';
import { frenaIdentidad, sqlFrenaIdentidad } from '../lib/proteccionIdentidad.js';
import { computedStockCte, getReactivablesRows } from '../routes/sync.js';
import { claveFrenadaParaVenta, claveCubiertaParaVenta } from '../lib/guardiaMl.js';

const TEST_DB = './test/fase-c-user-product.sqlite';
const TS = '2026-10-07T12:00:00.000Z';
const ACTIVO = { IDENTIDAD_PROTECCION: 'activo' };

// El stock de ML es por user_product: dos publicaciones que lo comparten son UNA cantidad. Si una está frenada por
// Identidad, la hermana no puede mandar stock (la reactivaría y subiría también a la frenada).
describe('Fase C: hermanas por user_product_id', () => {
  let db; let idWoo = 0;
  const env0 = process.env.IDENTIDAD_PROTECCION;
  beforeEach(() => { db = openDb(TEST_DB); });
  afterEach(() => {
    db.close(); if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    if (env0 === undefined) delete process.env.IDENTIDAD_PROTECCION; else process.env.IDENTIDAD_PROTECCION = env0;
  });

  const prod = (sku, stock = 1) => db.prepare("INSERT INTO catalogo_cache (id_woo,nombre,sku,tipo,stock,actualizado_en) VALUES (?,?,?,'simple',?,?)").run(++idWoo, sku, sku, stock, TS);
  const pub = (n, up, { sku = 'FB-1', status = 'active', qty = 1, sub = '' } = {}) => {
    const clave = `MLA${n}|`;
    db.prepare(`INSERT INTO ml_publicaciones_cache (clave,item_id,variation_id,titulo,status,sub_status,seller_sku,available_quantity,user_product_id,actualizado_en)
      VALUES (?,?,'','t',?,?,?,?,?,?)`).run(clave, `MLA${n}`, status, sub, sku, qty, up, TS);
    return clave;
  };
  const dec = (c, sku = 'FB-1', accion = 'confirmar') => db.prepare("INSERT INTO sku_matcher_decisiones (clave,sku,accion,actualizado_en) VALUES (?,?,?,?)").run(c, sku, accion, TS);
  const caso = (c, cl = 'sku_exacto', estado = 'intervencion') => db.prepare(`INSERT INTO identidad_casos
    (direccion,ml_key,clasificacion,estado,severidad,evidencia_fingerprint,primera_deteccion_en,ultima_deteccion_en)
    VALUES ('ml_fusion',?,?,?,'urgente','fp',?,?)`).run(c, cl, estado, TS, TS);
  const stock = (env = ACTIVO) => Object.fromEntries(db.prepare(`${computedStockCte(env)} SELECT clave, stock_disponible_ml s FROM computed`).all().map((r) => [r.clave, r.s]));

  it('la hermana de una clave frenada por R2 frena también, con motivo propio', () => {
    prod('FB-1');
    const a = pub(1, 'UP1'); dec(a); caso(a);
    const b = pub(2, 'UP1'); dec(b);
    expect(frenaIdentidad(db, a)).toEqual({ frena: true, motivo: 'intervencion' });
    expect(frenaIdentidad(db, b)).toEqual({ frena: true, motivo: `hermana_user_product:${a}` });
  });

  it('sin user_product_id (nulo o vacío) no hay hermanas', () => {
    prod('FB-1');
    const a = pub(1, null); dec(a); caso(a);
    const b = pub(2, null); dec(b);
    const c = pub(3, ''); dec(c);
    const d = pub(4, ''); dec(d); caso(d);
    expect(frenaIdentidad(db, b).frena).toBe(false);
    expect(frenaIdentidad(db, c).frena).toBe(false);
  });

  it('otro user_product no se contagia; omitir no se frena por hermana', () => {
    prod('FB-1');
    const a = pub(1, 'UP1'); dec(a); caso(a);
    const otra = pub(2, 'UP2'); dec(otra);
    const om = pub(3, 'UP1'); dec(om, null, 'omitir');
    expect(frenaIdentidad(db, otra).frena).toBe(false);
    expect(frenaIdentidad(db, om)).toEqual({ frena: false, motivo: 'omitir' });
  });

  it('un caso leve (pendiente, SKU igual) en la hermana no frena', () => {
    prod('FB-1');
    const a = pub(1, 'UP1'); dec(a); caso(a, 'decision_no_aplicada', 'pendiente');
    const b = pub(2, 'UP1'); dec(b);
    expect(frenaIdentidad(db, b).frena).toBe(false);
  });

  it('paridad función↔SQL, hermanas incluidas', () => {
    prod('FB-1');
    const a = pub(1, 'UP1'); dec(a); caso(a);
    const b = pub(2, 'UP1'); dec(b);
    const c = pub(3, 'UP2'); dec(c);
    const d = pub(4, 'UP3'); dec(d, 'FB-1'); caso(d, 'gtin_contradictorio', 'urgente');
    db.prepare("UPDATE ml_publicaciones_cache SET seller_sku='FB-9' WHERE clave=?").run(d);
    const e = pub(5, 'UP3'); dec(e);
    const filas = db.prepare(`SELECT d.clave, ${sqlFrenaIdentidad('d.clave', 'd.sku')} AS f FROM sku_matcher_decisiones d ORDER BY d.clave`).all();
    for (const r of filas) expect(!!r.f, r.clave).toBe(frenaIdentidad(db, r.clave).frena);
    expect(filas.filter((r) => r.f).map((r) => r.clave)).toEqual([a, b, d, e].sort());
  });

  it('CTE activo: la hermana da 0; sombra sin cambios', () => {
    prod('FB-1', 1);
    const a = pub(1, 'UP1'); dec(a); caso(a);
    const b = pub(2, 'UP1'); dec(b);
    expect(stock()[b]).toBe(0);
    expect(stock({ IDENTIDAD_PROTECCION: 'sombra' })[b]).toBe(1);
    expect(stock({})[b]).toBe(1);
    expect(stock({ IDENTIDAD_PROTECCION: 'apagado' })[b]).toBe(1);
  });

  it('reactivador: hermana pausada con stock Woo > 0 y clave frenada no es reactivable', () => {
    process.env.IDENTIDAD_PROTECCION = 'activo';
    prod('FB-1', 3);
    const a = pub(1, 'UP1', { status: 'paused', qty: 0, sub: 'out_of_stock' }); dec(a); caso(a);
    const b = pub(2, 'UP1', { status: 'paused', qty: 0, sub: 'out_of_stock' }); dec(b);
    expect(getReactivablesRows(db).map((r) => r.clave)).toEqual([]);
    db.prepare("UPDATE identidad_casos SET estado='resuelto' WHERE ml_key=?").run(a);
    expect(getReactivablesRows(db).map((r) => r.clave).sort()).toEqual([a, b].sort());
  });

  it('R5: el pedido de la hermana se retiene (frenada, no cubierta); sombra conserva la regla de hoy', () => {
    process.env.IDENTIDAD_PROTECCION = 'activo';
    prod('FB-1');
    const a = pub(1, 'UP1'); dec(a); caso(a);
    const b = pub(2, 'UP1'); dec(b);
    expect(claveFrenadaParaVenta(db, b)).toBe(true);
    expect(claveCubiertaParaVenta(db, b)).toBe(false);
    process.env.IDENTIDAD_PROTECCION = 'sombra';
    expect(claveFrenadaParaVenta(db, b)).toBe(false);
  });
});

describe('migración 121', () => {
  it('crea el índice por user_product_id y es idempotente', () => {
    const f = './test/fase-c-user-product-mig.sqlite';
    const db = openDb(f);
    try {
      expect(db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_ml_pub_user_product'").get()).toBeTruthy();
      db.exec(fs.readFileSync('./migrations/121_ml_pub_user_product_idx.sql', 'utf8'));
    } finally { db.close(); fs.rmSync(f, { force: true }); fs.rmSync(`${f}-wal`, { force: true }); fs.rmSync(`${f}-shm`, { force: true }); }
  });
});
