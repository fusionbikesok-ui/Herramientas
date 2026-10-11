import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import { openDb } from '../db/index.js';
import { auditarIdentidadProductos, decidirCasoIdentidad } from '../lib/identidadProductos.js';
import { marcarNoSincronizar, deshacerNoSincronizar } from '../lib/noSincronizar.js';

const FILE = './test/tmp-no-sincronizar-restaura-vinculo.sqlite';
const ISO = '2026-09-04T12:00:00.000Z';

describe('deshacer no sincronizar restaura el vínculo anterior (o lo dice)', () => {
  let db;
  beforeEach(() => { process.env.IDENTIDAD_PROTECCION = 'activo'; db = openDb(FILE); });
  afterEach(() => {
    try { db.close(); } catch { /* ya cerrada */ }
    for (const s of ['', '-wal', '-shm']) if (fs.existsSync(FILE + s)) fs.unlinkSync(FILE + s);
  });

  // Vínculo real (Vincular por la saga) de MLA23 con FB-23; después se marca "no sincronizar" sobre ese vínculo.
  function vinculadaYMarcada() {
    db.prepare(`INSERT INTO catalogo_cache(id_woo,nombre,sku,tipo,stock,gtin,actualizado_en) VALUES (23,'Producto 23','FB-23','simple',5,'4006381333955',?)`).run(ISO);
    db.prepare(`INSERT INTO ml_publicaciones_cache (clave,item_id,variation_id,titulo,status,seller_sku,seller_sku_presente,gtin,available_quantity,atributos_json,actualizado_en)
      VALUES ('MLA23|','MLA23','','Publicación','active',NULL,0,'4006381333955',5,'[]',?)`).run(ISO);
    auditarIdentidadProductos(db, 'test', { lecturaConfiable: true, ahora: new Date(ISO) });
    const caso = db.prepare("SELECT * FROM identidad_casos WHERE ml_key='MLA23|'").get();
    const producto = db.prepare('SELECT * FROM productos_fusion WHERE primary_woo_id=23').get();
    decidirCasoIdentidad(db, caso.id, { tipo: 'vincular', product_id: producto.id, operation_id: 'vincular-23',
      expected_version: caso.expected_version, evidence_fingerprint: caso.evidencia_fingerprint }, 'ana');
    // Estado de un Vincular ya completado: la decisión confirmada con el SKU.
    db.prepare("INSERT INTO sku_matcher_decisiones (clave,sku,wc_nombre,accion,origen,confirmado_por,actualizado_en) VALUES ('MLA23|','FB-23','Producto 23','confirmar','manual','ana',?)").run(ISO);
    expect(marcarNoSincronizar(db, { clave: 'MLA23|', variante: 'a', motivo: 'm', actor: 'ana', expectedSku: 'FB-23' }).ok).toBe(true);
  }

  it('si el SKU anterior sigue en Woo, deshacer lo vuelve a vincular por la saga y lo informa', () => {
    vinculadaYMarcada();
    const r = deshacerNoSincronizar(db, { clave: 'MLA23|', motivo: 'me equivoqué', actor: 'ana', esAdmin: false });
    expect(r).toMatchObject({ ok: true, vinculo: { restaurado: true, sku: 'FB-23' }, aviso: null });
    // La restauración pasa por la saga: queda una operación nueva (no se escribe el vínculo a mano) y ya no hay omitir.
    expect(r.vinculo.operacion_id).toBeTruthy();
    expect(db.prepare('SELECT ml_key FROM identidad_operaciones WHERE id=?').get(r.vinculo.operacion_id)).toMatchObject({ ml_key: 'MLA23|' });
    expect(db.prepare("SELECT accion FROM sku_matcher_decisiones WHERE clave='MLA23|'").get()?.accion ?? null).not.toBe('omitir');
  });

  it('si el SKU anterior ya no existe en Woo, deshacer deja la publicación sin vínculo y lo avisa', () => {
    vinculadaYMarcada();
    db.prepare("DELETE FROM catalogo_cache WHERE sku='FB-23'").run();
    const r = deshacerNoSincronizar(db, { clave: 'MLA23|', motivo: 'me equivoqué', actor: 'ana', esAdmin: false });
    expect(r).toMatchObject({ ok: true, vinculo: { restaurado: false, sku: 'FB-23', motivo: 'sku_no_existe_en_woo' } });
    expect(r.aviso).toContain('FB-23');
    expect(db.prepare("SELECT COUNT(*) n FROM sku_matcher_decisiones WHERE clave='MLA23|' AND sku IS NOT NULL").get().n).toBe(0);
  });
});
