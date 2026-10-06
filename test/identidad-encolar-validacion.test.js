import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { openDb } from '../db/index.js';
import { auditarIdentidadProductos, decidirCasoIdentidad } from '../lib/identidadProductos.js';

const FILE = './test/tmp-identidad-encolar.sqlite';
const ISO = '2026-10-06T12:00:00.000Z';

function woo(db, { id, sku, stock = 2 }) {
  db.prepare(`INSERT INTO catalogo_cache (id_woo,nombre,sku,tipo,stock,actualizado_en) VALUES (?,?,?,'simple',?,?)`)
    .run(id, `Producto ${id}`, sku, stock, ISO);
}

function ml(db, { clave, sku = null }) {
  const [item, variation = ''] = clave.split('|');
  db.prepare(`INSERT INTO ml_publicaciones_cache
    (clave,item_id,variation_id,titulo,status,seller_sku,seller_sku_presente,available_quantity,atributos_json,actualizado_en)
    VALUES (?,?,?,'Publicación','active',?,?,2,'[]',?)`).run(clave, item, variation, sku, sku === null ? 0 : 1, ISO);
}

// Deja un caso abierto con la publicación sin SKU y devuelve lo necesario para decidir.
function caso(db, { id, clave }) {
  woo(db, { id, sku: `FB-${id}` });
  ml(db, { clave, sku: null });
  auditarIdentidadProductos(db, 'test', { lecturaConfiable: true, ahora: new Date(ISO) });
  return {
    producto: db.prepare('SELECT * FROM productos_fusion WHERE primary_woo_id=?').get(id),
    fila: () => db.prepare('SELECT * FROM identidad_casos WHERE ml_key=?').get(clave),
  };
}

function vincular(db, c, operationId) {
  const fila = c.fila();
  return decidirCasoIdentidad(db, fila.id, {
    tipo: 'vincular', product_id: c.producto.id, operation_id: operationId,
    expected_version: fila.expected_version, evidence_fingerprint: fila.evidencia_fingerprint,
  }, 'ana');
}

describe('encolar corrección de identidad: validación y deduplicación', () => {
  let db;
  beforeEach(() => { db = openDb(FILE); });
  afterEach(() => {
    try { db.close(); } catch { /* ya cerrada */ }
    for (const suffix of ['', '-wal', '-shm']) if (fs.existsSync(`${FILE}${suffix}`)) fs.unlinkSync(`${FILE}${suffix}`);
  });

  it('una publicación sin SKU (NULL) NO es "sin cambio": se corrige', () => {
    const c = caso(db, { id: 901, clave: 'MLA901|' });
    const r = vincular(db, c, 'op-null');
    expect(r.ok).toBe(true);
    expect(r.operacion).toMatchObject({ sku_anterior: null, sku_objetivo: 'FB-901' });
  });

  it('un SKU distinto se corrige', () => {
    const c = caso(db, { id: 902, clave: 'MLA902|' });
    db.prepare("UPDATE ml_publicaciones_cache SET seller_sku='SKU-AJENO',seller_sku_presente=1 WHERE clave='MLA902|'").run();
    const r = vincular(db, c, 'op-distinto');
    expect(r.ok).toBe(true);
    expect(r.operacion).toMatchObject({ sku_anterior: 'SKU-AJENO', sku_objetivo: 'FB-902' });
  });

  it('rechaza sku_anterior == sku_objetivo y no persiste ni decisión ni operación', () => {
    const c = caso(db, { id: 903, clave: 'MLA903|' });
    db.prepare("UPDATE ml_publicaciones_cache SET seller_sku='FB-903',seller_sku_presente=1 WHERE clave='MLA903|'").run();
    const r = vincular(db, c, 'op-igual');
    expect(r).toMatchObject({ ok: false, code: 'SIN_CAMBIO_SKU' });
    expect(db.prepare("SELECT COUNT(*) n FROM identidad_decisiones WHERE operation_id='op-igual'").get().n).toBe(0);
    expect(db.prepare("SELECT COUNT(*) n FROM identidad_operaciones WHERE ml_key='MLA903|'").get().n).toBe(0);
  });

  it('tolera espacios al comparar los SKU', () => {
    const c = caso(db, { id: 904, clave: 'MLA904|' });
    db.prepare("UPDATE ml_publicaciones_cache SET seller_sku=' FB-904 ',seller_sku_presente=1 WHERE clave='MLA904|'").run();
    expect(vincular(db, c, 'op-espacios')).toMatchObject({ ok: false, code: 'SIN_CAMBIO_SKU' });
  });

  it('rechaza una segunda corrección mientras hay una abierta sobre la misma publicación', () => {
    const c = caso(db, { id: 905, clave: 'MLA905|' });
    const primera = vincular(db, c, 'op-1');
    expect(primera.ok).toBe(true);
    const segunda = vincular(db, c, 'op-2');
    expect(segunda).toMatchObject({ ok: false, code: 'OPERACION_DUPLICADA', operacion_id: primera.operacion.id });
    expect(db.prepare("SELECT COUNT(*) n FROM identidad_operaciones WHERE ml_key='MLA905|'").get().n).toBe(1);
  });

  it('permite una nueva corrección cuando la anterior ya terminó', () => {
    const c = caso(db, { id: 906, clave: 'MLA906|' });
    const primera = vincular(db, c, 'op-a');
    db.prepare("UPDATE identidad_operaciones SET estado='completada' WHERE id=?").run(primera.operacion.id);
    expect(vincular(db, c, 'op-b').ok).toBe(true);
  });
});
