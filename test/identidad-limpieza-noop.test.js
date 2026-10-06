import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { openDb } from '../db/index.js';
import { buscarOperacionesNoOpIdentidad, cancelarOperacionesIdentidadPorIds, cancelarOperacionesNoOpIdentidad } from '../lib/identidadLimpieza.js';

const FILE = './test/tmp-identidad-limpieza.sqlite';
const ISO = '2026-10-06T12:00:00.000Z';
let n = 0;

// Inserta caso + producto + publicación + operación mínimos y devuelve el id de la operación.
function op(db, { clave, skuAnt, skuObj, stockObj, stockMl, estado = 'pendiente' }) {
  n += 1;
  if (!db.prepare('SELECT 1 FROM ml_publicaciones_cache WHERE clave=?').get(clave)) {
    const [item, variation = ''] = clave.split('|');
    db.prepare(`INSERT INTO ml_publicaciones_cache (clave,item_id,variation_id,titulo,status,seller_sku,seller_sku_presente,available_quantity,atributos_json,actualizado_en)
      VALUES (?,?,?,'P','active',?,1,?,'[]',?)`).run(clave, item, variation, skuAnt, stockMl, ISO);
  }
  db.prepare(`INSERT INTO catalogo_cache (id_woo,nombre,sku,tipo,stock,actualizado_en) VALUES (?,?,?,'simple',1,?)`).run(1000 + n, `W${n}`, skuObj, ISO);
  const prod = db.prepare('SELECT id FROM productos_fusion WHERE primary_woo_id=?').get(1000 + n)?.id
    ?? db.prepare(`INSERT INTO productos_fusion (primary_woo_id,nombre_canonico,estado,creado_en,actualizado_en) VALUES (?,?,'activo',?,?)`).run(1000 + n, `W${n}`, ISO, ISO).lastInsertRowid;
  const caso = db.prepare('SELECT id FROM identidad_casos WHERE ml_key=?').get(clave)?.id ?? db.prepare(`INSERT INTO identidad_casos (direccion,ml_key,producto_id,clasificacion,estado,severidad,evidencia_fingerprint,expected_version,primera_deteccion_en,ultima_deteccion_en)
    VALUES ('ml_fusion',?,?,'test','pendiente','normal',?,1,?,?)`).run(clave, prod, `fp${n}`, ISO, ISO).lastInsertRowid;
  const dec = db.prepare(`INSERT INTO identidad_decisiones (caso_id,producto_id,tipo,operation_id,expected_version,evidencia_fingerprint,decidida_por,decidida_en)
    VALUES (?,?,'vincular',?,1,?,'t',?)`).run(caso, prod, `d${n}`, `fp${n}`, ISO).lastInsertRowid;
  return db.prepare(`INSERT INTO identidad_operaciones (operation_id,tipo,caso_id,decision_id,producto_id,ml_key,sku_anterior,sku_objetivo,stock_objetivo,estado,iniciada_en,actualizada_en)
    VALUES (?,'correccion_sku',?,?,?,?,?,?,?,?,?,?)`).run(`o${n}`, caso, dec, prod, clave, skuAnt, skuObj, stockObj, estado, ISO, ISO).lastInsertRowid;
}

describe('limpieza de operaciones no-op de identidad', () => {
  let db;
  beforeEach(() => { db = openDb(FILE); });
  afterEach(() => {
    try { db.close(); } catch { /* ya cerrada */ }
    for (const suffix of ['', '-wal', '-shm']) if (fs.existsSync(`${FILE}${suffix}`)) fs.unlinkSync(`${FILE}${suffix}`);
  });

  it('por defecto solo toma el no-op puro; la de stock obsoleto necesita la opción', () => {
    const pura = op(db, { clave: 'MLA1|', skuAnt: 'FB-1', skuObj: 'FB-1', stockObj: 2, stockMl: 2 });
    const obsoleta = op(db, { clave: 'MLA2|', skuAnt: 'FB-2', skuObj: 'FB-2', stockObj: 4, stockMl: 2 });
    expect(buscarOperacionesNoOpIdentidad(db).map((o) => o.id)).toEqual([pura]);
    expect(buscarOperacionesNoOpIdentidad(db, { incluirStockObsoleto: true }).map((o) => o.id)).toEqual([pura, obsoleta]);
  });

  it('no toma una corrección real ni una con sku_anterior NULL', () => {
    op(db, { clave: 'MLA3|', skuAnt: 'FB-A', skuObj: 'FB-B', stockObj: 1, stockMl: 1 });
    op(db, { clave: 'MLA4|', skuAnt: null, skuObj: 'FB-4', stockObj: 1, stockMl: 1 });
    expect(buscarOperacionesNoOpIdentidad(db, { incluirStockObsoleto: true })).toEqual([]);
  });

  it('deja afuera una clave que comparte operación real (el par 128/135)', () => {
    op(db, { clave: 'MLA5|', skuAnt: 'FB-53504', skuObj: 'FB-31402', stockObj: 0, stockMl: 50 });
    op(db, { clave: 'MLA5|', skuAnt: 'FB-53504', skuObj: 'FB-53504', stockObj: 50, stockMl: 50 });
    expect(buscarOperacionesNoOpIdentidad(db, { incluirStockObsoleto: true })).toEqual([]);
  });

  it('simula por defecto y no escribe', () => {
    const id = op(db, { clave: 'MLA6|', skuAnt: 'FB-6', skuObj: 'FB-6', stockObj: 1, stockMl: 1 });
    const r = cancelarOperacionesNoOpIdentidad(db);
    expect(r).toMatchObject({ simulado: true, cancelaria: [id], canceladas: [] });
    expect(db.prepare('SELECT estado FROM identidad_operaciones WHERE id=?').get(id).estado).toBe('pendiente');
  });

  it('cancela con motivo, deja historial y no pisa una operación que el worker ya tomó', () => {
    const a = op(db, { clave: 'MLA7|', skuAnt: 'FB-7', skuObj: 'FB-7', stockObj: 1, stockMl: 1 });
    const b = op(db, { clave: 'MLA8|', skuAnt: 'FB-8', skuObj: 'FB-8', stockObj: 1, stockMl: 1, estado: 'procesando' });
    const r = cancelarOperacionesNoOpIdentidad(db, { simular: false });
    expect(r.canceladas).toEqual([a]);
    expect(db.prepare('SELECT estado,ultimo_error FROM identidad_operaciones WHERE id=?').get(a))
      .toMatchObject({ estado: 'fallida', ultimo_error: expect.stringContaining('no-op') });
    expect(db.prepare('SELECT estado FROM identidad_operaciones WHERE id=?').get(b).estado).toBe('procesando');
    expect(db.prepare("SELECT COUNT(*) n FROM identidad_historial WHERE evento='operacion_noop_cancelada' AND entidad_id=?").get(a).n).toBe(1);
  });
});

describe('cancelación explícita por ids', () => {
  let db;
  beforeEach(() => { db = openDb(FILE); });
  afterEach(() => {
    try { db.close(); } catch { /* ya cerrada */ }
    for (const suffix of ['', '-wal', '-shm']) if (fs.existsSync(`${FILE}${suffix}`)) fs.unlinkSync(`${FILE}${suffix}`);
  });

  it('simula por defecto y no escribe', () => {
    const a = op(db, { clave: 'MLA20|', skuAnt: 'FB-A', skuObj: 'FB-B', stockObj: 0, stockMl: 50 });
    const r = cancelarOperacionesIdentidadPorIds(db, { ids: [a] });
    expect(r).toMatchObject({ simulado: true, cancelaria: [a], canceladas: [] });
    expect(db.prepare('SELECT estado FROM identidad_operaciones WHERE id=?').get(a).estado).toBe('pendiente');
  });

  it('cancela con motivo e historial, incluida una bloqueada_impacto', () => {
    const a = op(db, { clave: 'MLA21|', skuAnt: 'FB-A', skuObj: 'FB-B', stockObj: 0, stockMl: 50 });
    const b = op(db, { clave: 'MLA22|', skuAnt: 'REM', skuObj: 'FB-C', stockObj: 1, stockMl: 1, estado: 'bloqueada_impacto' });
    const r = cancelarOperacionesIdentidadPorIds(db, { ids: [a, b], motivo: 'decisión de José', simular: false });
    expect(r.canceladas).toEqual([a, b]);
    expect(db.prepare('SELECT estado,ultimo_error FROM identidad_operaciones WHERE id=?').get(b))
      .toMatchObject({ estado: 'fallida', ultimo_error: 'cancelada: decisión de José' });
    expect(db.prepare("SELECT COUNT(*) n FROM identidad_historial WHERE evento='operacion_cancelada_explicita'").get().n).toBe(2);
  });

  it('no toca completadas, en curso ni inexistentes: las reporta', () => {
    const c = op(db, { clave: 'MLA23|', skuAnt: 'FB-A', skuObj: 'FB-B', stockObj: 1, stockMl: 1, estado: 'completada' });
    const p = op(db, { clave: 'MLA24|', skuAnt: 'FB-A', skuObj: 'FB-B', stockObj: 1, stockMl: 1, estado: 'procesando' });
    const r = cancelarOperacionesIdentidadPorIds(db, { ids: [c, p, 99999], simular: false });
    expect(r.canceladas).toEqual([]);
    expect(r.omitidas.map((o) => o.id)).toEqual([c, p, 99999]);
    expect(db.prepare('SELECT estado FROM identidad_operaciones WHERE id=?').get(c).estado).toBe('completada');
  });

  it('exige ids', () => {
    expect(() => cancelarOperacionesIdentidadPorIds(db, { ids: [] })).toThrow('ids requeridos');
  });
});
