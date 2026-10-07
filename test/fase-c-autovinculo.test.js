import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { openDb } from '../db/index.js';
import { autoVincularPorSellerSku } from '../lib/mlMapeo.js';
import { auditarIdentidadProductos } from '../lib/identidadProductos.js';
import { clavesSinVinculoAFrenar, frenaIdentidad } from '../lib/proteccionIdentidad.js';

const FILE = './test/tmp-fase-c-autovinculo.sqlite';
const ISO = '2026-10-07T12:00:00.000Z';
const AHORA = () => ({ lecturaConfiable: true, ahora: new Date(ISO) });

function woo(db, { id, sku, gtin = null, stock = 2 }) {
  db.prepare(`INSERT INTO catalogo_cache (id_woo,nombre,sku,tipo,stock,gtin,actualizado_en) VALUES (?,?,?,'simple',?,?,?)`)
    .run(id, `Producto ${id}`, sku, stock, gtin, ISO);
}
function ml(db, { clave, sku = null, gtin = null, stock = 2 }) {
  const [item, variation = ''] = clave.split('|');
  db.prepare(`INSERT INTO ml_publicaciones_cache
    (clave,item_id,variation_id,titulo,status,seller_sku,seller_sku_presente,gtin,available_quantity,atributos_json,actualizado_en)
    VALUES (?,?,?,'Publicación','active',?,?,?,?,'[]',?)`).run(clave, item, variation, sku, sku === null ? 0 : 1, gtin, stock, ISO);
}

describe('Fase C R3/R4: vínculo automático seguro y publicación nueva no vinculable', () => {
  let db;
  beforeEach(() => { db = openDb(FILE); });
  afterEach(() => { db.close(); for (const s of ['', '-wal', '-shm']) if (fs.existsSync(`${FILE}${s}`)) fs.unlinkSync(`${FILE}${s}`); });

  it('con SKU exacto y único se vincula aunque el GTIN de ML no coincida', () => {
    woo(db, { id: 1, sku: 'FB-1', gtin: '4006381333931' });
    woo(db, { id: 4, sku: 'FB-4', gtin: '036000291452' });
    ml(db, { clave: 'MLA1|', sku: 'FB-1', gtin: '036000291452' }); // el GTIN de catálogo de ML es el de OTRO producto
    expect(autoVincularPorSellerSku(db)).toBe(1);
    expect(db.prepare("SELECT sku, accion, origen FROM sku_matcher_decisiones WHERE clave='MLA1|'").get())
      .toEqual({ sku: 'FB-1', accion: 'asignar', origen: 'auto_seller_sku' });
  });

  it('SKU ambiguo en la corrida: no vincula ninguna', () => {
    woo(db, { id: 1, sku: 'FB-1' });
    ml(db, { clave: 'MLA1|', sku: 'FB-1', stock: 99 });
    ml(db, { clave: 'MLA2|', sku: 'FB-1', stock: 99 });
    expect(autoVincularPorSellerSku(db)).toBe(0);
    expect(db.prepare('SELECT COUNT(*) n FROM sku_matcher_decisiones').get().n).toBe(0);
    auditarIdentidadProductos(db, 'test', AHORA());
    // El audit las deja con caso abierto: `stock_no_verificado` (SKU exacto en Woo pero sin verificar). No está en la lista
    // de R4 (CLASIFICACIONES_SIN_VINCULO): el reporte de sombra las cuenta aparte para decidir.
    expect(db.prepare("SELECT clasificacion, estado FROM identidad_casos WHERE ml_key='MLA1|'").get())
      .toEqual({ clasificacion: 'stock_no_verificado', estado: 'urgente' });
  });

  it('la publicación nueva sin SKU abre caso y queda para stock 0', () => {
    woo(db, { id: 1, sku: 'FB-1' });
    ml(db, { clave: 'MLA9|', sku: null });
    expect(autoVincularPorSellerSku(db)).toBe(0);
    auditarIdentidadProductos(db, 'test', AHORA());
    expect(db.prepare("SELECT clasificacion, estado FROM identidad_casos WHERE ml_key='MLA9|'").get())
      .toEqual({ clasificacion: 'sku_ausente', estado: 'urgente' });
    expect(clavesSinVinculoAFrenar(db).map((r) => [r.clave, r.clasificacion])).toEqual([['MLA9|', 'sku_ausente']]);
    expect(frenaIdentidad(db, 'MLA9|')).toMatchObject({ frena: true, motivo: 'sin_vinculo:sku_ausente' });
  });

  it('SKU que no existe en Woo: caso sku_inexistente y a stock 0', () => {
    woo(db, { id: 1, sku: 'FB-1' });
    ml(db, { clave: 'MLA8|', sku: 'NO-EXISTE' });
    auditarIdentidadProductos(db, 'test', AHORA());
    expect(clavesSinVinculoAFrenar(db).map((r) => r.clasificacion)).toEqual(['sku_inexistente']);
  });

  it('al vincularla (decisión asignar) deja de frenar, sin esperar al próximo audit', () => {
    woo(db, { id: 1, sku: 'FB-1' });
    ml(db, { clave: 'MLA9|', sku: null });
    auditarIdentidadProductos(db, 'test', AHORA());
    expect(frenaIdentidad(db, 'MLA9|').frena).toBe(true);
    db.prepare("INSERT INTO sku_matcher_decisiones (clave,sku,accion,actualizado_en) VALUES ('MLA9|','FB-1','asignar',?)").run(ISO);
    expect(frenaIdentidad(db, 'MLA9|').frena).toBe(false);
    expect(clavesSinVinculoAFrenar(db)).toEqual([]);
  });

  it('omitir no frena aunque tenga caso abierto', () => {
    ml(db, { clave: 'MLA9|', sku: null });
    auditarIdentidadProductos(db, 'test', AHORA());
    db.prepare("INSERT INTO sku_matcher_decisiones (clave,sku,accion,actualizado_en) VALUES ('MLA9|',NULL,'omitir',?)").run(ISO);
    expect(frenaIdentidad(db, 'MLA9|')).toMatchObject({ frena: false, motivo: 'omitir' });
    expect(clavesSinVinculoAFrenar(db)).toEqual([]);
  });
});
