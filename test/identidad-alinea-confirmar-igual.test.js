import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { openDb } from '../db/index.js';
import { auditarIdentidadProductos, decidirCasoIdentidad } from '../lib/identidadProductos.js';

const FILE = './test/tmp-identidad-alinea-confirmar.sqlite';
const ISO = '2026-10-10T12:00:00.000Z';

// Producto con título contradictorio (Rodado 27 en ML vs 29 en Woo) y ML ya lleva el SKU objetivo,
// pero el vínculo local todavía apunta a otro SKU: el camino es alinearVinculoLocal.
function contradictorioAlineable(db, id) {
  db.prepare(`INSERT INTO catalogo_cache (id_woo,nombre,sku,tipo,stock,actualizado_en)
    VALUES (?,'Bicicleta Rodado 29 Talle M',?,'simple',2,?)`).run(id, `FB-${id}`, ISO);
  db.prepare(`INSERT INTO ml_publicaciones_cache
    (clave,item_id,variation_id,titulo,status,seller_sku,seller_sku_presente,available_quantity,atributos_json,actualizado_en)
    VALUES (?,?,'','Bicicleta Rodado 27 Talle M','active',NULL,0,2,'[]',?)`).run(`MLA${id}|`, `MLA${id}`, ISO);
  auditarIdentidadProductos(db, 'test', { lecturaConfiable: true, ahora: new Date(ISO) });
  db.prepare("UPDATE ml_publicaciones_cache SET seller_sku=?,seller_sku_presente=1,status='paused',available_quantity=0 WHERE clave=?")
    .run(`FB-${id}`, `MLA${id}|`);
  db.prepare("INSERT OR REPLACE INTO sku_matcher_decisiones (clave,sku,accion,actualizado_en) VALUES (?,'FB-VIEJO','confirmar',?)")
    .run(`MLA${id}|`, ISO);
  return {
    producto: db.prepare('SELECT * FROM productos_fusion WHERE primary_woo_id=?').get(id),
    fila: () => db.prepare('SELECT * FROM identidad_casos WHERE ml_key=?').get(`MLA${id}|`),
  };
}

function vincular(db, c, operationId, extra = {}) {
  const f = c.fila();
  return decidirCasoIdentidad(db, f.id, { tipo: 'vincular', product_id: c.producto.id, operation_id: operationId,
    expected_version: f.expected_version, evidence_fingerprint: f.evidencia_fingerprint, ...extra }, 'jose');
}

describe('alinear vínculo local con "confirmar igual" (contradicción de título)', () => {
  let db;
  beforeEach(() => { db = openDb(FILE); });
  afterEach(() => {
    try { db.close(); } catch { /* ya cerrada */ }
    for (const s of ['', '-wal', '-shm']) if (fs.existsSync(`${FILE}${s}`)) fs.unlinkSync(`${FILE}${s}`);
  });

  it('sin override sigue rechazando con contradiccion_titulo y no toca nada', () => {
    const c = contradictorioAlineable(db, 1201);
    expect(vincular(db, c, 'sin-1201')).toMatchObject({ ok: false, code: 'contradiccion_titulo' });
    expect(c.fila().estado).not.toBe('resuelto');
  });

  it('con override y motivo alinea: resuelve, graba la marca en la decisión y emite confirmar_igual', () => {
    const c = contradictorioAlineable(db, 1202);
    const r = vincular(db, c, 'ok-1202', { override_contradiccion: true, motivo: 'El título de ML está mal escrito' });
    expect(r).toMatchObject({ ok: true, vinculo_actualizado: true });
    expect(r.decision).toMatchObject({ override_contradiccion: 1, override_motivo: 'El título de ML está mal escrito' });
    expect(c.fila().estado).toBe('resuelto');
    expect(db.prepare("SELECT sku FROM sku_matcher_decisiones WHERE clave='MLA1202|'").get().sku).toBe('FB-1202');
    expect(db.prepare("SELECT COUNT(*) n FROM identidad_historial WHERE evento='confirmar_igual'").get().n).toBe(1);
    expect(db.prepare("SELECT COUNT(*) n FROM identidad_historial WHERE evento='vinculo_alineado_sin_operacion'").get().n).toBe(1);
  });

  it('con override pero sin motivo: INVALID_INPUT y no se alinea', () => {
    const c = contradictorioAlineable(db, 1203);
    expect(vincular(db, c, 'sin-motivo-1203', { override_contradiccion: true })).toMatchObject({ ok: false, code: 'INVALID_INPUT' });
    expect(c.fila().estado).not.toBe('resuelto');
  });
});
