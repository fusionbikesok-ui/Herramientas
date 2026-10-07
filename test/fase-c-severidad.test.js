import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { openDb } from '../db/index.js';
import { auditarIdentidadProductos } from '../lib/identidadProductos.js';

const FILE = './test/tmp-fase-c-severidad.sqlite';
const ISO = '2026-10-07T12:00:00.000Z';
const AHORA = () => ({ lecturaConfiable: true, ahora: new Date(ISO) });

function woo(db, { id, sku, gtin = null, stock = 2 }) {
  db.prepare(`INSERT INTO catalogo_cache (id_woo,nombre,sku,tipo,stock,gtin,actualizado_en) VALUES (?,?,?,'simple',?,?,?)`)
    .run(id, `Producto ${id}`, sku, stock, gtin, ISO);
}
function ml(db, { clave, sku, gtin = null, stock = 2 }) {
  const [item, variation = ''] = clave.split('|');
  db.prepare(`INSERT INTO ml_publicaciones_cache
    (clave,item_id,variation_id,titulo,status,seller_sku,seller_sku_presente,gtin,available_quantity,atributos_json,actualizado_en)
    VALUES (?,?,?,'Publicación','active',?,1,?,?,'[]',?)`).run(clave, item, variation, sku, gtin, stock, ISO);
}
const decision = (db, clave, sku) => db.prepare(`INSERT INTO sku_matcher_decisiones (clave,sku,accion,actualizado_en,origen)
  VALUES (?,?,'confirmar',?,'test')`).run(clave, sku, ISO);
const caso = (db, clave) => db.prepare("SELECT clasificacion, estado, severidad FROM identidad_casos WHERE ml_key=?").get(clave);

describe('Fase C R2: severidad de un caso con SKU igual al vinculado', () => {
  let db;
  const env0 = process.env.IDENTIDAD_PROTECCION;
  beforeEach(() => {
    db = openDb(FILE);
    woo(db, { id: 1, sku: 'FB-1', gtin: '4006381333931' });
    woo(db, { id: 4, sku: 'FB-4', gtin: '036000291452' });
  });
  afterEach(() => {
    db.close(); for (const s of ['', '-wal', '-shm']) if (fs.existsSync(`${FILE}${s}`)) fs.unlinkSync(`${FILE}${s}`);
    if (env0 === undefined) delete process.env.IDENTIDAD_PROTECCION; else process.env.IDENTIDAD_PROTECCION = env0;
  });

  // ML con SKU de FB-1 pero con el GTIN de FB-4 (el error está en el catálogo de ML) y vinculada a FB-1.
  const gtinContradictorio = () => { ml(db, { clave: 'MLA6|', sku: 'FB-1', gtin: '036000291452' }); decision(db, 'MLA6|', 'FB-1'); };

  it('activo: gtin_contradictorio con SKU igual baja a normal y no oscila a crítica en los scans siguientes', () => {
    process.env.IDENTIDAD_PROTECCION = 'activo';
    gtinContradictorio();
    auditarIdentidadProductos(db, 'test', AHORA());
    expect(caso(db, 'MLA6|')).toMatchObject({ clasificacion: 'gtin_contradictorio', estado: 'urgente', severidad: 'normal' });
    auditarIdentidadProductos(db, 'test', AHORA());
    auditarIdentidadProductos(db, 'test', AHORA());
    expect(caso(db, 'MLA6|').severidad).toBe('normal');
    expect(db.prepare("SELECT COUNT(*) n FROM identidad_historial WHERE evento='reactivada_con_identidad_invalida'").get().n).toBe(0);
  });

  it('sombra (default): la severidad queda como hoy (urgente)', () => {
    delete process.env.IDENTIDAD_PROTECCION;
    gtinContradictorio();
    auditarIdentidadProductos(db, 'test', AHORA());
    expect(caso(db, 'MLA6|')).toMatchObject({ clasificacion: 'gtin_contradictorio', severidad: 'urgente' });
  });

  it('activo: sin decisión (no hay SKU vinculado) no baja: sigue urgente', () => {
    process.env.IDENTIDAD_PROTECCION = 'activo';
    ml(db, { clave: 'MLA7|', sku: 'FB-1', gtin: '036000291452' });
    auditarIdentidadProductos(db, 'test', AHORA());
    expect(caso(db, 'MLA7|').severidad).toBe('urgente');
  });
});
