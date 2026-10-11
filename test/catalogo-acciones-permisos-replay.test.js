import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import { openDb } from '../db/index.js';
import { auditarIdentidadProductos, decidirCasoIdentidad, guardarComando } from '../lib/identidadProductos.js';
import { cancelarVinculo, revertirVinculo } from '../lib/catalogoVinculosAcciones.js';

const FILE = './test/tmp-catalogo-acciones-permisos-replay.sqlite';
const ISO = '2026-09-04T12:00:00.000Z';

describe('acciones de Catálogo: permisos antes de resolver el replay por operation_id', () => {
  let db;
  beforeEach(() => { process.env.IDENTIDAD_PROTECCION = 'activo'; db = openDb(FILE); });
  afterEach(() => {
    try { db.close(); } catch { /* ya cerrada */ }
    for (const s of ['', '-wal', '-shm']) if (fs.existsSync(FILE + s)) fs.unlinkSync(FILE + s);
  });

  // Operación real de Vincular (la decide ana) sobre una publicación sin vínculo.
  function operacionDeAna() {
    db.prepare(`INSERT INTO catalogo_cache(id_woo,nombre,sku,tipo,stock,gtin,actualizado_en) VALUES (24,'Producto 24','FB-24','simple',5,'4006381333962',?)`).run(ISO);
    db.prepare(`INSERT INTO ml_publicaciones_cache (clave,item_id,variation_id,titulo,status,seller_sku,seller_sku_presente,gtin,available_quantity,atributos_json,actualizado_en)
      VALUES ('MLA24|','MLA24','','Publicación','active',NULL,0,'4006381333962',5,'[]',?)`).run(ISO);
    auditarIdentidadProductos(db, 'test', { lecturaConfiable: true, ahora: new Date(ISO) });
    const caso = db.prepare("SELECT * FROM identidad_casos WHERE ml_key='MLA24|'").get();
    const producto = db.prepare('SELECT * FROM productos_fusion WHERE primary_woo_id=24').get();
    return decidirCasoIdentidad(db, caso.id, { tipo: 'vincular', product_id: producto.id, operation_id: 'vincular-24',
      expected_version: caso.expected_version, evidence_fingerprint: caso.evidencia_fingerprint }, 'ana').operacion;
  }
  const casoActual = () => db.prepare("SELECT * FROM identidad_casos WHERE ml_key='MLA24|'").get();

  it('deshacer: un usuario que no es dueño ni admin no recibe el replay de un operation_id ajeno', () => {
    const op = operacionDeAna();
    const input = { operation_id: 'deshacer-24', expected_version: casoActual().expected_version, evidence_fingerprint: casoActual().evidencia_fingerprint };
    expect(cancelarVinculo(db, op.id, input, 'ana', { esAdmin: false }).ok).toBe(true);
    // Replay del mismo operation_id por otra persona: 403, no el resultado guardado.
    expect(cancelarVinculo(db, op.id, input, 'beto', { esAdmin: false })).toMatchObject({ ok: false, code: 'FORBIDDEN', status: 403 });
    // El dueño sí obtiene el replay como antes.
    expect(cancelarVinculo(db, op.id, input, 'ana', { esAdmin: false })).toMatchObject({ ok: true, repetido: true });
  });

  it('revertir con override: sin admin, 403 aunque el operation_id ya esté guardado', () => {
    guardarComando(db, 'rev-24', 'revertir_vinculo', 'operacion', 999, { ok: true }, 'jose', ISO);
    const input = { operation_id: 'rev-24', motivo: 'x', override_omitir: true };
    expect(revertirVinculo(db, 999, input, 'ana', { esAdmin: false })).toMatchObject({ ok: false, code: 'FORBIDDEN', status: 403 });
    expect(revertirVinculo(db, 999, input, 'jose', { esAdmin: true })).toMatchObject({ ok: true, repetido: true });
  });
});
