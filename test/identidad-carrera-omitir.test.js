import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import { openDb } from '../db/index.js';
import { auditarIdentidadProductos, decidirCasoIdentidad, marcarClaveNoSincroniza, procesarPasoOperacionIdentidad } from '../lib/identidadProductos.js';

const FILE = './test/tmp-identidad-carrera.sqlite';
const ISO = '2026-09-04T12:00:00.000Z';

describe('saga de Identidad: No sincronizar durante un paso remoto', () => {
  let db;
  beforeEach(() => { db = openDb(FILE); });
  afterEach(() => { db.close(); for (const s of ['', '-wal', '-shm']) if (fs.existsSync(FILE + s)) fs.unlinkSync(FILE + s); });

  function preparar() {
    db.prepare(`INSERT INTO catalogo_cache(id_woo,nombre,sku,tipo,stock,gtin,actualizado_en) VALUES (21,'Producto 21','FB-21','simple',5,'4006381333931',?)`).run(ISO);
    db.prepare(`INSERT INTO ml_publicaciones_cache (clave,item_id,variation_id,titulo,status,seller_sku,seller_sku_presente,gtin,available_quantity,atributos_json,actualizado_en)
      VALUES ('MLA21|','MLA21','','Publicación','active',NULL,0,'4006381333931',5,'[]',?)`).run(ISO);
    auditarIdentidadProductos(db, 'test', { lecturaConfiable: true, ahora: new Date(ISO) });
    const caso = db.prepare("SELECT * FROM identidad_casos WHERE ml_key='MLA21|'").get();
    const producto = db.prepare('SELECT * FROM productos_fusion WHERE primary_woo_id=21').get();
    return decidirCasoIdentidad(db, caso.id, { tipo: 'vincular', product_id: producto.id, operation_id: 'carrera-21',
      expected_version: caso.expected_version, evidence_fingerprint: caso.evidencia_fingerprint }, 'ana').operacion;
  }

  it('un omitir durante el await remoto deja la operación fallida y no avanza ni vincula', async () => {
    const op = preparar();
    const remoto = { seller_sku: '', stock: 5 };
    let disparado = false;
    const hook = () => { if (disparado) return; disparado = true; expect(marcarClaveNoSincroniza(db, { clave: 'MLA21|', actor: 'ana', expectedSku: null }).ok).toBe(true); };
    const adapter = {
      setStock: vi.fn(async (_k, s) => { hook(); remoto.stock = s; return { ok: true }; }),
      clearSku: vi.fn(async () => { hook(); remoto.seller_sku = ''; return { ok: true }; }),
      writeSku: vi.fn(async (_k, s) => { hook(); remoto.seller_sku = s; return { ok: true }; }),
      read: vi.fn(async () => { hook(); return { ...remoto, observed_at: new Date().toISOString() }; }),
    };
    for (let i = 0; i < 6; i++) await procesarPasoOperacionIdentidad(db, op.id, adapter, { allowRemoteWrites: true });
    expect(disparado).toBe(true);
    expect(db.prepare('SELECT estado,ultimo_error FROM identidad_operaciones WHERE id=?').get(op.id)).toMatchObject({ estado: 'fallida', ultimo_error: 'cancelada por omitir' });
    expect(db.prepare("SELECT accion FROM sku_matcher_decisiones WHERE clave='MLA21|'").get().accion).toBe('omitir');
    expect(db.prepare("SELECT estado FROM identidad_casos WHERE ml_key='MLA21|'").get().estado).toBe('exceptuado');
    expect(db.prepare("SELECT COUNT(*) n FROM identidades_canal WHERE external_key='MLA21|' AND activa=1").get().n).toBe(0);
    // Tras el omitir no hay más escrituras remotas.
    const llamadas = adapter.setStock.mock.calls.length + adapter.writeSku.mock.calls.length + adapter.clearSku.mock.calls.length;
    await procesarPasoOperacionIdentidad(db, op.id, adapter, { allowRemoteWrites: true });
    expect(adapter.setStock.mock.calls.length + adapter.writeSku.mock.calls.length + adapter.clearSku.mock.calls.length).toBe(llamadas);
  });
});
