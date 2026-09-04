import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import request from 'supertest';
import { openDb } from '../db/index.js';
import {
  auditarIdentidadProductos,
  bootstrapProductosFusion,
  decidirCasoIdentidad,
  esGtinValido,
  fingerprintEvidencia,
  listarColasIdentidad,
  procesarPasoOperacionIdentidad,
} from '../lib/identidadProductos.js';
import { identidadProductosRouter } from '../routes/identidadProductos.js';

const FILE = './test/tmp-identidad-productos.sqlite';
const ISO = '2026-09-04T12:00:00.000Z';

function woo(db, { id, sku, gtin = null, stock = 2, nombre = `Producto ${id}` }) {
  db.prepare(`INSERT INTO catalogo_cache
    (id_woo,nombre,sku,tipo,stock,gtin,actualizado_en) VALUES (?,?,?,'simple',?,?,?)`)
    .run(id, nombre, sku, stock, gtin, ISO);
}

function ml(db, { clave, sku = null, presente = sku !== null, custom = null, gtin = null, stock = 2, itemId }) {
  const [item, variation = ''] = clave.split('|');
  db.prepare(`INSERT INTO ml_publicaciones_cache
    (clave,item_id,variation_id,titulo,status,seller_sku,seller_sku_presente,seller_custom_field,
     gtin,available_quantity,actualizado_en)
    VALUES (?,?,?,'Publicación','active',?,?,?,?,?,?)`).run(clave, itemId || item, variation, sku,
      presente ? 1 : 0, custom, gtin, stock, ISO);
}

describe('UM1 identidad de productos', () => {
  let db;
  beforeEach(() => { db = openDb(FILE); });
  afterEach(() => {
    try { db.close(); } catch {}
    for (const suffix of ['', '-wal', '-shm']) if (fs.existsSync(`${FILE}${suffix}`)) fs.unlinkSync(`${FILE}${suffix}`);
  });

  it('aplica 082 idempotente y deriva un fusion_sku ineditable de id_woo', () => {
    expect(db.pragma('user_version', { simple: true })).toBe(82);
    woo(db, { id: 41, sku: 'LEGACY-41' });
    expect(bootstrapProductosFusion(db)).toEqual({ total: 1, creados: 1 });
    expect(bootstrapProductosFusion(db)).toEqual({ total: 1, creados: 0 });
    const producto = db.prepare('SELECT * FROM productos_fusion WHERE primary_woo_id=41').get();
    expect(producto.fusion_sku).toBe('FB-41');
    expect(() => db.prepare("UPDATE productos_fusion SET fusion_sku='EDITADO' WHERE id=?").run(producto.id)).toThrow();
    expect(() => db.prepare('DELETE FROM productos_fusion WHERE id=?').run(producto.id)).toThrow(/borrado fisico/);
  });

  it.each([
    ['96385074', true],
    ['036000291452', true],
    ['4006381333931', true],
    ['00012345600012', true],
    ['4006381333932', false],
    ['123', false],
    ['400638133393X', false],
  ])('valida GTIN %s con longitud y dígito verificador', (gtin, valido) => {
    expect(esGtinValido(gtin)).toBe(valido);
  });

  it('clasifica todo el universo activo con stock y seller_custom_field nunca cubre', () => {
    woo(db, { id: 1, sku: 'FB-1', gtin: '4006381333931', stock: 2 });
    woo(db, { id: 2, sku: 'DUP', stock: 1 });
    woo(db, { id: 3, sku: 'DUP', stock: 1 });
    woo(db, { id: 4, sku: 'FB-4', gtin: '036000291452', stock: 2 });
    ml(db, { clave: 'MLA1|', sku: 'FB-1', stock: 2 });
    ml(db, { clave: 'MLA2|', sku: null, custom: 'FB-1', stock: 2 });
    ml(db, { clave: 'MLA3|', sku: '   ', presente: true, stock: 2 });
    ml(db, { clave: 'MLA4|', sku: 'NO-EXISTE', stock: 2 });
    ml(db, { clave: 'MLA5|', sku: 'DUP', stock: 1 });
    ml(db, { clave: 'MLA6|', sku: 'FB-1', gtin: '036000291452', stock: 2 });
    ml(db, { clave: 'MLA7|', sku: 'FB-1', stock: 99 });
    ml(db, { clave: 'MLA-SIN-STOCK|', sku: null, stock: 0 });

    const r = auditarIdentidadProductos(db, 'test', { lecturaConfiable: true, ahora: new Date(ISO) });
    expect(r).toMatchObject({ total: 7, verificadas: 1, excepciones: 0, urgentes: 6, conciliado: true });
    const clases = Object.fromEntries(db.prepare('SELECT ml_key,clasificacion FROM identidad_casos').all().map((c) => [c.ml_key, c.clasificacion]));
    expect(clases).toMatchObject({
      'MLA1|': 'sku_exacto', 'MLA2|': 'sku_ausente', 'MLA3|': 'sku_vacio',
      'MLA4|': 'sku_inexistente', 'MLA5|': 'sku_no_unico',
      'MLA6|': 'gtin_contradictorio', 'MLA7|': 'stock_no_verificado',
    });
    expect(db.prepare("SELECT estado FROM identidad_casos WHERE ml_key='MLA2|'").get().estado).toBe('urgente');
    expect(db.prepare("SELECT COUNT(*) n FROM identidades_canal WHERE canal='ml' AND activa=1").get().n).toBe(1);
  });

  it('solo cubre después de SKU y stock remotos confiables de menos de 60 minutos', () => {
    woo(db, { id: 8, sku: 'FB-8', stock: 3 });
    ml(db, { clave: 'MLA8|', sku: 'FB-8', stock: 3 });
    let r = auditarIdentidadProductos(db, 'test', { lecturaConfiable: false, ahora: new Date(ISO) });
    expect(r.verificadas).toBe(0);
    expect(db.prepare("SELECT COUNT(*) n FROM identidades_canal WHERE canal='ml' AND activa=1").get().n).toBe(0);
    r = auditarIdentidadProductos(db, 'test', { lecturaConfiable: true, ahora: new Date(ISO) });
    expect(r.verificadas).toBe(1);
    const identity = db.prepare("SELECT * FROM identidades_canal WHERE canal='ml' AND activa=1").get();
    expect(identity.sku_verificado_en).toBe(ISO);
    expect(identity.stock_verificado_en).toBe(ISO);
    expect(db.prepare("SELECT origen FROM sku_matcher_decisiones WHERE clave='MLA8|'").get().origen).toBe('identidad_productos');
  });

  it('exige envelope concurrente, persiste solo_ml e invalida la excepción si cambia evidencia', () => {
    ml(db, { clave: 'MLA9|', sku: null, custom: 'A', stock: 1 });
    auditarIdentidadProductos(db, 'test', { lecturaConfiable: true, ahora: new Date(ISO) });
    let caso = db.prepare("SELECT * FROM identidad_casos WHERE ml_key='MLA9|'").get();
    expect(decidirCasoIdentidad(db, caso.id, { tipo: 'solo_ml', operation_id: 'exc-bad', expected_version: caso.expected_version }, 'ana').code).toBe('INVALID_INPUT');
    const input = { tipo: 'solo_ml', motivo: 'Producto exclusivo ML', operation_id: 'exc-1',
      expected_version: caso.expected_version, evidence_fingerprint: caso.evidencia_fingerprint };
    expect(decidirCasoIdentidad(db, caso.id, input, 'ana').caso.estado).toBe('exceptuado');
    expect(decidirCasoIdentidad(db, caso.id, input, 'ana').repetido).toBe(true);
    db.prepare("UPDATE ml_publicaciones_cache SET seller_custom_field='B' WHERE clave='MLA9|'").run();
    auditarIdentidadProductos(db, 'test', { lecturaConfiable: true, ahora: new Date(ISO) });
    caso = db.prepare("SELECT * FROM identidad_casos WHERE ml_key='MLA9|'").get();
    expect(caso.estado).toBe('urgente');
    expect(db.prepare('SELECT activa,invalidada_motivo FROM identidad_excepciones WHERE caso_id=?').get(caso.id))
      .toEqual({ activa: 0, invalidada_motivo: 'cambio_identidad' });
  });

  it('persiste decisión antes de saga, queda shadow y bloquea cualquier side effect por defecto', async () => {
    woo(db, { id: 10, sku: 'FB-10', gtin: '4006381333931', stock: 4 });
    ml(db, { clave: 'MLA10|', sku: null, gtin: '4006381333931', stock: 4 });
    auditarIdentidadProductos(db, 'test', { lecturaConfiable: true, ahora: new Date(ISO) });
    const caso = db.prepare("SELECT * FROM identidad_casos WHERE ml_key='MLA10|'").get();
    const producto = db.prepare('SELECT * FROM productos_fusion WHERE primary_woo_id=10').get();
    const decision = decidirCasoIdentidad(db, caso.id, { tipo: 'vincular', product_id: producto.id,
      operation_id: 'link-shadow', expected_version: caso.expected_version, evidence_fingerprint: caso.evidencia_fingerprint }, 'ana');
    expect(decision.operacion.estado).toBe('shadow');
    const adapter = { setStock: vi.fn(), read: vi.fn(), clearSku: vi.fn(), writeSku: vi.fn() };
    const procesada = await procesarPasoOperacionIdentidad(db, decision.operacion.id, adapter);
    expect(procesada.code).toBe('REMOTE_WRITES_DISABLED');
    expect(adapter.setStock).not.toHaveBeenCalled();
    expect(db.prepare('SELECT COUNT(*) n FROM identidad_decisiones').get().n).toBe(1);
  });

  it('ejecuta zero/clear/write/restore con verificación durable y manda a intervención al tercer fallo', async () => {
    woo(db, { id: 11, sku: 'FB-11', gtin: '4006381333931', stock: 5 });
    ml(db, { clave: 'MLA11|', sku: null, gtin: '4006381333931', stock: 5 });
    auditarIdentidadProductos(db, 'test', { lecturaConfiable: true, ahora: new Date(ISO) });
    const caso = db.prepare("SELECT * FROM identidad_casos WHERE ml_key='MLA11|'").get();
    const producto = db.prepare('SELECT * FROM productos_fusion WHERE primary_woo_id=11').get();
    const creada = decidirCasoIdentidad(db, caso.id, { tipo: 'vincular', product_id: producto.id,
      operation_id: 'saga-ok', expected_version: caso.expected_version, evidence_fingerprint: caso.evidencia_fingerprint }, 'ana');
    const remoto = { seller_sku: '', stock: 5 };
    const adapter = {
      setStock: async (_key, stock) => { remoto.stock = stock; return { ok: true }; },
      clearSku: async () => { remoto.seller_sku = ''; return { ok: true }; },
      writeSku: async (_key, sku) => { remoto.seller_sku = sku; return { ok: true }; },
      read: async () => ({ ...remoto, observed_at: new Date().toISOString() }),
    };
    for (let i = 0; i < 10; i++) expect((await procesarPasoOperacionIdentidad(db, creada.operacion.id, adapter, { allowRemoteWrites: true })).ok).toBe(true);
    expect(db.prepare('SELECT estado FROM identidad_operaciones WHERE id=?').get(creada.operacion.id).estado).toBe('completada');
    expect(db.prepare('SELECT COUNT(*) n FROM identidad_operacion_pasos WHERE operacion_id=? AND estado=\'confirmado\'').get(creada.operacion.id).n).toBe(10);
    expect(db.prepare('SELECT estado FROM identidad_casos WHERE id=?').get(caso.id).estado).toBe('verificado');

    ml(db, { clave: 'MLA12|', sku: null, gtin: '4006381333931', stock: 5 });
    auditarIdentidadProductos(db, 'test', { lecturaConfiable: true, ahora: new Date(ISO) });
    const caso2 = db.prepare("SELECT * FROM identidad_casos WHERE ml_key='MLA12|'").get();
    const fallida = decidirCasoIdentidad(db, caso2.id, { tipo: 'vincular', product_id: producto.id,
      operation_id: 'saga-fail', expected_version: caso2.expected_version, evidence_fingerprint: caso2.evidencia_fingerprint }, 'ana').operacion;
    const adapterFail = { setStock: async () => { throw new Error('timeout ML'); } };
    await procesarPasoOperacionIdentidad(db, fallida.id, adapterFail, { allowRemoteWrites: true });
    await procesarPasoOperacionIdentidad(db, fallida.id, adapterFail, { allowRemoteWrites: true });
    const tercer = await procesarPasoOperacionIdentidad(db, fallida.id, adapterFail, { allowRemoteWrites: true });
    expect(tercer.code).toBe('INTERVENTION_REQUIRED');
    expect(tercer.operacion.intentos).toBe(3);
  });

  it('bloquea impacto potencial sobre hermanas hasta confirmarlo y expone ambas colas', () => {
    woo(db, { id: 20, sku: 'FB-20', gtin: '4006381333931', stock: 1 });
    woo(db, { id: 21, sku: 'FB-21', stock: 2 });
    ml(db, { clave: 'MLA20|a', itemId: 'MLA20', sku: null, gtin: '4006381333931', stock: 1 });
    ml(db, { clave: 'MLA20|b', itemId: 'MLA20', sku: 'NO', stock: 1 });
    auditarIdentidadProductos(db, 'test', { lecturaConfiable: true, ahora: new Date(ISO) });
    const caso = db.prepare("SELECT * FROM identidad_casos WHERE ml_key='MLA20|a'").get();
    const producto = db.prepare('SELECT * FROM productos_fusion WHERE primary_woo_id=20').get();
    const input = { tipo: 'vincular', product_id: producto.id, operation_id: 'siblings-1',
      expected_version: caso.expected_version, evidence_fingerprint: caso.evidencia_fingerprint };
    expect(decidirCasoIdentidad(db, caso.id, input, 'ana').code).toBe('SIBLING_IMPACT_CONFIRMATION_REQUIRED');
    expect(decidirCasoIdentidad(db, caso.id, { ...input, confirm_sibling_impact: true }, 'ana').ok).toBe(true);
    const colas = listarColasIdentidad(db);
    expect(colas.ml_to_fusion.length).toBeGreaterThan(0);
    expect(colas.woo_to_ml.some((p) => p.primary_woo_id === 21)).toBe(true);
  });

  it('ofrece view model estable y permite notas a matcher:read, pero no decisiones', async () => {
    ml(db, { clave: 'MLA30|', sku: null, stock: 1 });
    auditarIdentidadProductos(db, 'test', { lecturaConfiable: true, ahora: new Date(ISO) });
    const caso = db.prepare("SELECT * FROM identidad_casos WHERE ml_key='MLA30|'").get();
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => { req.user = { username: 'lector', is_admin: false, permisos: [{ herramienta: 'matcher', nivel: 'read' }] }; next(); });
    app.use('/api/identidad-productos', identidadProductosRouter(db));
    expect((await request(app).get('/api/identidad-productos/resumen')).body.data).toHaveProperty('salud.modo', 'shadow');
    expect((await request(app).get(`/api/identidad-productos/casos/${caso.id}`)).body.data).toHaveProperty('evidencia');
    const envelope = { operation_id: 'note-1', expected_version: caso.expected_version,
      evidence_fingerprint: caso.evidencia_fingerprint, nota: 'Revisar etiqueta física' };
    expect((await request(app).post(`/api/identidad-productos/casos/${caso.id}/notas`).send(envelope)).status).toBe(201);
    expect((await request(app).post(`/api/identidad-productos/casos/${caso.id}/decisiones`).send({ ...envelope, tipo: 'investigar' })).status).toBe(403);
    expect(fingerprintEvidencia({ b: 2, a: 1 })).toBe(fingerprintEvidencia({ a: 1, b: 2 }));
  });
});
