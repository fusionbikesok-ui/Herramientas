import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import { openDb } from '../db/index.js';
import { auditarIdentidadProductos, decidirCasoIdentidad, reintentarOperacionIdentidad } from '../lib/identidadProductos.js';
import { cancelarVinculo } from '../lib/catalogoVinculosAcciones.js';

const FILE = './test/tmp-identidad-reintento-cancelada.sqlite';
const ISO = '2026-09-04T12:00:00.000Z';

describe('reintentar una operación de Identidad cancelada', () => {
  let db;
  beforeEach(() => { process.env.IDENTIDAD_PROTECCION = 'activo'; db = openDb(FILE); });
  afterEach(() => { db.close(); for (const s of ['', '-wal', '-shm']) if (fs.existsSync(FILE + s)) fs.unlinkSync(FILE + s); });

  // Fixture real: catálogo + publicación sin vínculo, auditoría y Vincular (la misma forma que identidad-carrera-omitir).
  function operacionPendiente() {
    db.prepare(`INSERT INTO catalogo_cache(id_woo,nombre,sku,tipo,stock,gtin,actualizado_en) VALUES (22,'Producto 22','FB-22','simple',5,'4006381333948',?)`).run(ISO);
    db.prepare(`INSERT INTO ml_publicaciones_cache (clave,item_id,variation_id,titulo,status,seller_sku,seller_sku_presente,gtin,available_quantity,atributos_json,actualizado_en)
      VALUES ('MLA22|','MLA22','','Publicación','active',NULL,0,'4006381333948',5,'[]',?)`).run(ISO);
    auditarIdentidadProductos(db, 'test', { lecturaConfiable: true, ahora: new Date(ISO) });
    const caso = db.prepare("SELECT * FROM identidad_casos WHERE ml_key='MLA22|'").get();
    const producto = db.prepare('SELECT * FROM productos_fusion WHERE primary_woo_id=22').get();
    const r = decidirCasoIdentidad(db, caso.id, { tipo: 'vincular', product_id: producto.id, operation_id: 'vincular-22',
      expected_version: caso.expected_version, evidence_fingerprint: caso.evidencia_fingerprint }, 'ana');
    return r.operacion;
  }
  const casoActual = () => db.prepare("SELECT * FROM identidad_casos WHERE ml_key='MLA22|'").get();

  it('una operación cancelada por Deshacer no se reactiva: 409 y queda cancelada', () => {
    const op = operacionPendiente();
    const cancelada = cancelarVinculo(db, op.id, { operation_id: 'deshacer-22', expected_version: casoActual().expected_version,
      evidence_fingerprint: casoActual().evidencia_fingerprint }, 'ana');
    expect(cancelada.ok).toBe(true);
    const r = reintentarOperacionIdentidad(db, op.id, { operation_id: 'reintento-22', expected_version: casoActual().expected_version,
      evidence_fingerprint: casoActual().evidencia_fingerprint }, 'ana');
    expect(r).toMatchObject({ ok: false, code: 'INVALID_STATE', status: 409 });
    expect(db.prepare('SELECT estado,ultimo_error FROM identidad_operaciones WHERE id=?').get(op.id))
      .toMatchObject({ estado: 'fallida', ultimo_error: expect.stringMatching(/^cancelada: /) });
  });

  it('una operación cancelada por omitir (sin el prefijo "cancelada:") sigue admitiendo reintento como antes', () => {
    const op = operacionPendiente();
    db.prepare("UPDATE identidad_operaciones SET estado='fallida', ultimo_error='cancelada por omitir' WHERE id=?").run(op.id);
    const r = reintentarOperacionIdentidad(db, op.id, { operation_id: 'reintento-omitir-22', expected_version: casoActual().expected_version,
      evidence_fingerprint: casoActual().evidencia_fingerprint }, 'ana');
    expect(r).toMatchObject({ ok: true });
  });
});
