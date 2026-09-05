import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import request from 'supertest';
import { openDb } from '../db/index.js';
import {
  auditarIdentidadProductos,
  bootstrapProductosFusion,
  buscarProductosFusion,
  decidirCasoIdentidad,
  esGtinValido,
  estadoIdentidadProductos,
  fingerprintEvidencia,
  listarColasIdentidad,
  procesarOperacionesIdentidad,
  procesarPasoOperacionIdentidad,
  reintentarOperacionIdentidad,
} from '../lib/identidadProductos.js';
import { identidadProductosRouter } from '../routes/identidadProductos.js';

const FILE = './test/tmp-identidad-productos.sqlite';
const ISO = '2026-09-04T12:00:00.000Z';

function woo(db, { id, sku, gtin = null, stock = 2, nombre = `Producto ${id}` }) {
  db.prepare(`INSERT INTO catalogo_cache
    (id_woo,nombre,sku,tipo,stock,gtin,actualizado_en) VALUES (?,?,?,'simple',?,?,?)`)
    .run(id, nombre, sku, stock, gtin, ISO);
}

// `atributos` distinto de null marca que la observación trae el detalle de la 082. Pasar
// `atributos: null` simula una fila cacheada antes de esa migración, que no es clasificable.
function ml(db, { clave, sku = null, presente = sku !== null, custom = null, gtin = null, stock = 2, itemId, atributos = '[]' }) {
  const [item, variation = ''] = clave.split('|');
  db.prepare(`INSERT INTO ml_publicaciones_cache
    (clave,item_id,variation_id,titulo,status,seller_sku,seller_sku_presente,seller_custom_field,
     gtin,available_quantity,atributos_json,actualizado_en)
    VALUES (?,?,?,'Publicación','active',?,?,?,?,?,?,?)`).run(clave, itemId || item, variation, sku,
      presente ? 1 : 0, custom, gtin, stock, atributos, ISO);
}

describe('UM1 identidad de productos', () => {
  let db;
  beforeEach(() => { db = openDb(FILE); });
  afterEach(() => {
    try { db.close(); } catch {}
    for (const suffix of ['', '-wal', '-shm']) if (fs.existsSync(`${FILE}${suffix}`)) fs.unlinkSync(`${FILE}${suffix}`);
  });

  it('aplica 082 idempotente y deriva un fusion_sku ineditable de id_woo', () => {
    // La idempotencia de 082 la da su marcador, no `user_version`: en esta base
    // `user_version` es la compuerta de la migración Hito 7 y debe quedar en 30, o
    // esa migración se saltea y la base pierde device_tokens (auth móvil caída).
    expect(db.prepare("SELECT 1 FROM _schema_migrations WHERE key='identidad_productos_082'").get()).toBeTruthy();
    expect(db.pragma('user_version', { simple: true })).toBe(30);
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='device_tokens'").get()).toBeTruthy();
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

  it('devuelve a urgente una operación shadow obsoleta antes de cualquier efecto remoto', () => {
    woo(db, { id: 51, sku: 'FB-51', stock: 2 });
    ml(db, { clave: 'MLA51|', sku: null, stock: 2 });
    auditarIdentidadProductos(db, 'test', { lecturaConfiable: true, ahora: new Date(ISO) });
    let caso = db.prepare("SELECT * FROM identidad_casos WHERE ml_key='MLA51|'").get();
    const producto = db.prepare('SELECT * FROM productos_fusion WHERE primary_woo_id=51').get();
    const decision = decidirCasoIdentidad(db, caso.id, { tipo: 'vincular', product_id: producto.id,
      operation_id: 'shadow-obsoleta', expected_version: caso.expected_version,
      evidence_fingerprint: caso.evidencia_fingerprint }, 'ana');
    expect(decision.operacion.estado).toBe('shadow');

    // La identidad cambia antes de que la operación llegue al adaptador remoto.
    db.prepare("UPDATE ml_publicaciones_cache SET seller_sku='SKU-AJENO',seller_sku_presente=1 WHERE clave='MLA51|'").run();
    auditarIdentidadProductos(db, 'test', { lecturaConfiable: true, ahora: new Date(ISO) });

    caso = db.prepare("SELECT * FROM identidad_casos WHERE ml_key='MLA51|'").get();
    const operacion = db.prepare('SELECT * FROM identidad_operaciones WHERE id=?').get(decision.operacion.id);
    expect(caso).toMatchObject({ estado: 'urgente', clasificacion: 'sku_inexistente', responsable: null, tomado_en: null });
    expect(operacion).toMatchObject({ estado: 'intervencion', intentos: 0, ultimo_error: 'obsoleta_por_cambio_identidad_antes_de_efecto_remoto' });
    expect(db.prepare("SELECT COUNT(*) n FROM identidad_operacion_pasos WHERE operacion_id=?").get(operacion.id).n).toBe(0);
    const evento = db.prepare("SELECT detalle_json FROM identidad_historial WHERE entidad_tipo='operacion' AND entidad_id=? AND evento='operacion_shadow_obsoleta_por_cambio_identidad'").get(operacion.id);
    expect(JSON.parse(evento.detalle_json)).toMatchObject({ decision_id: decision.decision.id, clasificacion_nueva: 'sku_inexistente' });
    expect(reintentarOperacionIdentidad(db, operacion.id, { operation_id: 'no-reintentar', expected_version: caso.expected_version,
      evidence_fingerprint: caso.evidencia_fingerprint }, 'ana')).toMatchObject({ ok: false, code: 'OBSOLETE_OPERATION' });
  });

  it('admite hasta dos claves de canario y nunca procesa más de dos operaciones por corrida', async () => {
    for (const id of [61, 62, 63]) {
      woo(db, { id, sku: `FB-${id}`, stock: 2 });
      ml(db, { clave: `MLA${id}|`, sku: null, stock: 2 });
    }
    auditarIdentidadProductos(db, 'test', { lecturaConfiable: true, ahora: new Date(ISO) });
    for (const id of [61, 62, 63]) {
      const caso = db.prepare('SELECT * FROM identidad_casos WHERE ml_key=?').get(`MLA${id}|`);
      const producto = db.prepare('SELECT * FROM productos_fusion WHERE primary_woo_id=?').get(id);
      decidirCasoIdentidad(db, caso.id, { tipo: 'vincular', product_id: producto.id, operation_id: `canario-${id}`,
        expected_version: caso.expected_version, evidence_fingerprint: caso.evidencia_fingerprint }, 'ana');
    }
    // Aisla el selector del worker: `reprocess` es terminal y no introduce pausas entre pasos.
    db.prepare("UPDATE identidad_operaciones SET paso_actual='reprocess' WHERE ml_key IN ('MLA61|','MLA62|','MLA63|')").run();
    db.prepare("UPDATE identidad_config SET modo='enforced',escrituras_remotas_habilitadas=1,canario_ml_key='MLA61|, MLA62|',lote_max=9 WHERE id=1").run();
    const remoto = new Map([[ 'MLA61|', { seller_sku: '', stock: 2 } ], [ 'MLA62|', { seller_sku: '', stock: 2 } ], [ 'MLA63|', { seller_sku: '', stock: 2 } ]]);
    const adapter = {
      setStock: vi.fn(async (key, stock) => { remoto.get(key).stock = stock; return { ok: true }; }),
      clearSku: vi.fn(async (key) => { remoto.get(key).seller_sku = ''; return { ok: true }; }),
      writeSku: vi.fn(async (key, sku) => { remoto.get(key).seller_sku = sku; return { ok: true }; }),
      read: vi.fn(async (key) => ({ ...remoto.get(key), observed_at: new Date().toISOString() })),
    };
    const r = await procesarOperacionesIdentidad(db, adapter, { ahora: new Date() });
    expect(r).toMatchObject({ ok: true, canario: ['MLA61|', 'MLA62|'], tope: 2 });
    expect(db.prepare("SELECT estado FROM identidad_operaciones WHERE ml_key='MLA61|'").get().estado).toBe('completada');
    expect(db.prepare("SELECT estado FROM identidad_operaciones WHERE ml_key='MLA62|'").get().estado).toBe('completada');
    expect(db.prepare("SELECT estado FROM identidad_operaciones WHERE ml_key='MLA63|'").get().estado).toBe('shadow');
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

  it('una operación vieja que nunca se intentó se ejecuta sola, no va a intervención', async () => {
    // El umbral de 15 minutos mide un intento que no progresa, NO la antigüedad del registro.
    // Con `intentos = 0` la operación jamás corrió: descartarla por vieja mandaba a
    // intervención trabajo que el sistema nunca intentó, y obligaba a un reintento manual.
    // Pasó en producción con 51 operaciones encoladas mientras las escrituras estaban en shadow.
    woo(db, { id: 77, sku: 'FB-77', gtin: '7501031311309', stock: 4 });
    ml(db, { clave: 'MLA77|', sku: null, gtin: '7501031311309', stock: 4 });
    auditarIdentidadProductos(db, 'test', { lecturaConfiable: true, ahora: new Date(ISO) });
    const caso = db.prepare("SELECT * FROM identidad_casos WHERE ml_key='MLA77|'").get();
    const producto = db.prepare('SELECT * FROM productos_fusion WHERE primary_woo_id=77').get();
    const creada = decidirCasoIdentidad(db, caso.id, { tipo: 'vincular', product_id: producto.id,
      operation_id: 'saga-vieja', expected_version: caso.expected_version, evidence_fingerprint: caso.evidencia_fingerprint }, 'ana');

    // Encolada hace 3 horas y nunca intentada, como quedaban las que esperaban el rollout.
    const hace3Horas = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    db.prepare("UPDATE identidad_operaciones SET estado='pendiente',intentos=0,iniciada_en=? WHERE id=?")
      .run(hace3Horas, creada.operacion.id);

    const remoto = { seller_sku: producto.fusion_sku, stock: 4 };
    const adapter = {
      setStock: vi.fn(async () => ({ ok: true })),
      clearSku: vi.fn(async () => ({ ok: true })),
      writeSku: vi.fn(async () => ({ ok: true })),
      read: vi.fn(async () => ({ ...remoto, observed_at: new Date().toISOString() })),
    };
    const r = await procesarPasoOperacionIdentidad(db, creada.operacion.id, adapter, { allowRemoteWrites: true });

    expect(r.ok).toBe(true);
    expect(db.prepare('SELECT estado FROM identidad_operaciones WHERE id=?').get(creada.operacion.id).estado)
      .not.toBe('intervencion');
  });

  it('ejecuta el camino directo sin cero (zero/write/verify_write/activate/reprocess) escribiendo el SKU una sola vez, y manda a intervención al tercer fallo', async () => {
    woo(db, { id: 11, sku: 'FB-11', gtin: '4006381333931', stock: 5 });
    ml(db, { clave: 'MLA11|', sku: null, gtin: '4006381333931', stock: 5 });
    auditarIdentidadProductos(db, 'test', { lecturaConfiable: true, ahora: new Date(ISO) });
    const caso = db.prepare("SELECT * FROM identidad_casos WHERE ml_key='MLA11|'").get();
    const producto = db.prepare('SELECT * FROM productos_fusion WHERE primary_woo_id=11').get();
    const creada = decidirCasoIdentidad(db, caso.id, { tipo: 'vincular', product_id: producto.id,
      operation_id: 'saga-ok', expected_version: caso.expected_version, evidence_fingerprint: caso.evidencia_fingerprint }, 'ana');
    expect(creada.operacion.stock_objetivo).toBe(5);
    // El SKU destino (producto.fusion_sku) llega no vacío: camino directo. El stock remoto
    // arranca DISTINTO del stock_objetivo capturado al decidir (7 contra 5) — es justo el caso
    // que antes rompía `activate` al exigir igualdad de stock también en el camino sin cero.
    const remoto = { seller_sku: 'VIEJO-SKU', stock: 7 };
    const adapter = {
      setStock: vi.fn(async (_key, stock) => { remoto.stock = stock; return { ok: true }; }),
      clearSku: vi.fn(async () => { remoto.seller_sku = ''; return { ok: true }; }),
      writeSku: vi.fn(async (_key, sku) => { remoto.seller_sku = sku; return { ok: true }; }),
      read: vi.fn(async () => ({ ...remoto, observed_at: new Date().toISOString() })),
    };
    for (let i = 0; i < 5; i++) expect((await procesarPasoOperacionIdentidad(db, creada.operacion.id, adapter, { allowRemoteWrites: true })).ok).toBe(true);
    expect(db.prepare('SELECT estado,sin_cero FROM identidad_operaciones WHERE id=?').get(creada.operacion.id)).toEqual({ estado: 'completada', sin_cero: 1 });
    const pasos = db.prepare("SELECT paso FROM identidad_operacion_pasos WHERE operacion_id=? AND estado='confirmado' ORDER BY id").all(creada.operacion.id).map((p) => p.paso);
    expect(pasos).toEqual(['zero', 'write', 'verify_write', 'activate', 'reprocess']);
    expect(db.prepare('SELECT estado FROM identidad_casos WHERE id=?').get(caso.id).estado).toBe('verificado');
    // Ni una escritura de stock: el camino directo sobrescribe el SKU y listo.
    expect(adapter.setStock).not.toHaveBeenCalled();
    expect(adapter.clearSku).not.toHaveBeenCalled();
    expect(adapter.writeSku).toHaveBeenCalledTimes(1);
    expect(adapter.writeSku).toHaveBeenCalledWith('MLA11|', 'FB-11');
    // El stock remoto queda intacto (7), pese a ser distinto del stock_objetivo capturado (5):
    // la activación no lo exige en el camino sin cero.
    expect(remoto.stock).toBe(7);

    ml(db, { clave: 'MLA12|', sku: null, gtin: '4006381333931', stock: 5 });
    auditarIdentidadProductos(db, 'test', { lecturaConfiable: true, ahora: new Date(ISO) });
    const caso2 = db.prepare("SELECT * FROM identidad_casos WHERE ml_key='MLA12|'").get();
    const fallida = decidirCasoIdentidad(db, caso2.id, { tipo: 'vincular', product_id: producto.id,
      operation_id: 'saga-fail', expected_version: caso2.expected_version, evidence_fingerprint: caso2.evidencia_fingerprint }, 'ana').operacion;
    const adapterFail = { read: async () => { throw new Error('timeout ML'); } };
    await procesarPasoOperacionIdentidad(db, fallida.id, adapterFail, { allowRemoteWrites: true });
    await procesarPasoOperacionIdentidad(db, fallida.id, adapterFail, { allowRemoteWrites: true });
    const tercer = await procesarPasoOperacionIdentidad(db, fallida.id, adapterFail, { allowRemoteWrites: true });
    expect(tercer.code).toBe('INTERVENTION_REQUIRED');
    expect(tercer.operacion.intentos).toBe(3);
  });

  it('no reabre una identidad completada si aparece un GTIN contradictorio, pero sí si desaparece el SKU verificado', async () => {
    woo(db, { id: 111, sku: 'FB-111', gtin: '4006381333931', stock: 5 });
    woo(db, { id: 112, sku: 'FB-112', gtin: '036000291452', stock: 5 });
    ml(db, { clave: 'MLA111|', sku: null, gtin: '4006381333931', stock: 5 });
    auditarIdentidadProductos(db, 'test', { lecturaConfiable: true, ahora: new Date(ISO) });
    let caso = db.prepare("SELECT * FROM identidad_casos WHERE ml_key='MLA111|'").get();
    const producto = db.prepare('SELECT * FROM productos_fusion WHERE primary_woo_id=111').get();
    const creada = decidirCasoIdentidad(db, caso.id, { tipo: 'vincular', product_id: producto.id,
      operation_id: 'saga-gtin-posterior', expected_version: caso.expected_version,
      evidence_fingerprint: caso.evidencia_fingerprint }, 'ana');
    const remoto = { seller_sku: '', stock: 5 };
    const adapter = {
      setStock: vi.fn(), clearSku: vi.fn(),
      writeSku: vi.fn(async (_key, sku) => { remoto.seller_sku = sku; return { ok: true }; }),
      read: vi.fn(async () => ({ ...remoto, observed_at: new Date().toISOString() })),
    };
    for (let i = 0; i < 5; i++) {
      const r = await procesarPasoOperacionIdentidad(db, creada.operacion.id, adapter, { allowRemoteWrites: true });
      expect(r.ok).toBe(true);
      if (db.prepare('SELECT estado FROM identidad_operaciones WHERE id=?').get(creada.operacion.id).estado === 'completada') break;
    }

    // Simula el refresco posterior del canario: el SKU escrito sigue correcto, pero ML
    // publica ahora un GTIN válido que pertenece inequívocamente a otro producto Woo.
    db.prepare(`UPDATE ml_publicaciones_cache SET seller_sku='FB-111',seller_sku_presente=1,
      gtin='036000291452',actualizado_en=? WHERE clave='MLA111|'`).run(ISO);
    // Primero persiste la nueva clasificación/huella; después reproduce el estado exacto que
    // dejó el bug ya desplegado: urgente con esa misma evidencia y sin evento de recuperación.
    auditarIdentidadProductos(db, 'test', { lecturaConfiable: true, ahora: new Date(ISO) });
    caso = db.prepare("SELECT * FROM identidad_casos WHERE ml_key='MLA111|'").get();
    db.prepare("DELETE FROM identidad_historial WHERE entidad_tipo='caso' AND entidad_id=? AND evento='gtin_contradictorio_post_verificacion'").run(caso.id);
    db.prepare("UPDATE identidad_casos SET estado='urgente' WHERE id=?").run(caso.id);
    const versionUrgente = caso.expected_version;
    auditarIdentidadProductos(db, 'test', { lecturaConfiable: true, ahora: new Date(ISO) });
    caso = db.prepare("SELECT * FROM identidad_casos WHERE ml_key='MLA111|'").get();
    expect(caso).toMatchObject({ estado: 'verificado', clasificacion: 'gtin_contradictorio', producto_id: producto.id });
    expect(caso.expected_version).toBe(versionUrgente + 1);
    expect(db.prepare("SELECT COUNT(*) n FROM identidad_historial WHERE entidad_tipo='caso' AND entidad_id=? AND evento='gtin_contradictorio_post_verificacion'").get(caso.id).n).toBe(1);
    expect(listarColasIdentidad(db).ml_to_fusion.some((fila) => fila.id === caso.id)).toBe(false);

    // El siguiente scan trae la misma evidencia y ya no entra por `cambio`; debe conservar
    // igual el estado y no duplicar el evento de reclasificación.
    const versionRecuperada = caso.expected_version;
    auditarIdentidadProductos(db, 'test', { lecturaConfiable: true, ahora: new Date(ISO) });
    caso = db.prepare("SELECT * FROM identidad_casos WHERE ml_key='MLA111|'").get();
    expect(caso).toMatchObject({ estado: 'verificado', clasificacion: 'gtin_contradictorio' });
    expect(caso.expected_version).toBe(versionRecuperada);
    expect(db.prepare("SELECT COUNT(*) n FROM identidad_historial WHERE entidad_tipo='caso' AND entidad_id=? AND evento='gtin_contradictorio_post_verificacion'").get(caso.id).n).toBe(1);

    // Una operación posterior manda: la completada histórica no puede pisar trabajo nuevo.
    const opCompletada = db.prepare('SELECT * FROM identidad_operaciones WHERE id=?').get(creada.operacion.id);
    const opPosterior = db.prepare(`INSERT INTO identidad_operaciones
      (operation_id,caso_id,decision_id,producto_id,ml_key,sku_objetivo,stock_objetivo,
       estado,paso_actual,iniciada_en,actualizada_en)
      VALUES ('saga-posterior',?,?,?,?,?,?,'shadow','zero',?,?)`).run(caso.id,
        opCompletada.decision_id, producto.id, 'MLA111|', 'FB-111', 5, ISO, ISO).lastInsertRowid;
    db.prepare("UPDATE identidad_casos SET estado='pendiente' WHERE id=?").run(caso.id);
    auditarIdentidadProductos(db, 'test', { lecturaConfiable: true, ahora: new Date(ISO) });
    expect(db.prepare('SELECT estado FROM identidad_casos WHERE id=?').get(caso.id).estado).toBe('pendiente');
    db.prepare('DELETE FROM identidad_operaciones WHERE id=?').run(opPosterior);
    db.prepare("UPDATE identidad_casos SET estado='verificado' WHERE id=?").run(caso.id);

    // La protección es estrecha: si el SELLER_SKU verificado desaparece, vuelve a ser una
    // urgencia real aunque el GTIN todavía sugiera el mismo Producto Fusion.
    db.prepare(`UPDATE ml_publicaciones_cache SET seller_sku=NULL,seller_sku_presente=0,
      gtin='4006381333931',actualizado_en=? WHERE clave='MLA111|'`).run(ISO);
    auditarIdentidadProductos(db, 'test', { lecturaConfiable: true, ahora: new Date(ISO) });
    caso = db.prepare("SELECT * FROM identidad_casos WHERE ml_key='MLA111|'").get();
    expect(caso).toMatchObject({ estado: 'urgente', clasificacion: 'sku_ausente', producto_id: producto.id });
  });

  it('recorre el camino largo (zero/verify_zero/clear/verify_clear/write/verify_write/restore/verify_restore/activate/reprocess) cuando la operación debe dejar la publicación sin SKU', async () => {
    // `sku_objetivo` sale de `producto.fusion_sku`, generado siempre por la 082 a partir de
    // `primary_woo_id` y column UNIQUE NOT NULL: por el flujo público (decidirCasoIdentidad)
    // nunca llega vacío, así que este camino ya no es alcanzable operando la herramienta.
    // Se fuerza acá pisando la fila directamente, únicamente para no perder cobertura de la
    // rama que el código todavía contiene (`if (String(op.sku_objetivo||'').trim())`).
    woo(db, { id: 13, sku: 'FB-13', gtin: '4006381333932', stock: 5 });
    ml(db, { clave: 'MLA13|', sku: null, gtin: '4006381333932', stock: 5 });
    auditarIdentidadProductos(db, 'test', { lecturaConfiable: true, ahora: new Date(ISO) });
    const caso = db.prepare("SELECT * FROM identidad_casos WHERE ml_key='MLA13|'").get();
    const producto = db.prepare('SELECT * FROM productos_fusion WHERE primary_woo_id=13').get();
    const creada = decidirCasoIdentidad(db, caso.id, { tipo: 'vincular', product_id: producto.id,
      operation_id: 'saga-largo', expected_version: caso.expected_version, evidence_fingerprint: caso.evidencia_fingerprint }, 'ana');
    db.prepare("UPDATE identidad_operaciones SET sku_objetivo='' WHERE id=?").run(creada.operacion.id);
    const remoto = { seller_sku: 'VIEJO-SKU', stock: 5 };
    const adapter = {
      setStock: vi.fn(async (_key, stock) => { remoto.stock = stock; return { ok: true }; }),
      clearSku: vi.fn(async () => { remoto.seller_sku = ''; return { ok: true }; }),
      writeSku: vi.fn(async (_key, sku) => { remoto.seller_sku = sku; return { ok: true }; }),
      read: vi.fn(async () => ({ ...remoto, observed_at: new Date().toISOString() })),
    };
    for (let i = 0; i < 10; i++) expect((await procesarPasoOperacionIdentidad(db, creada.operacion.id, adapter, { allowRemoteWrites: true })).ok).toBe(true);
    expect(db.prepare('SELECT estado,sin_cero FROM identidad_operaciones WHERE id=?').get(creada.operacion.id)).toEqual({ estado: 'completada', sin_cero: 0 });
    const pasos = db.prepare("SELECT paso FROM identidad_operacion_pasos WHERE operacion_id=? AND estado='confirmado' ORDER BY id").all(creada.operacion.id).map((p) => p.paso);
    expect(pasos).toEqual(['zero', 'verify_zero', 'clear', 'verify_clear', 'write', 'verify_write', 'restore', 'verify_restore', 'activate', 'reprocess']);
    expect(adapter.setStock).toHaveBeenCalledTimes(2); // pone en 0 y luego restaura
    expect(adapter.clearSku).toHaveBeenCalledTimes(1);
    expect(adapter.writeSku).toHaveBeenCalledTimes(1);
  });

  it('atajo: si ML ya tiene SKU y stock objetivo, completa sin ninguna escritura remota', async () => {
    woo(db, { id: 14, sku: 'FB-14', gtin: '4006381333933', stock: 5 });
    ml(db, { clave: 'MLA14|', sku: null, gtin: '4006381333933', stock: 5 });
    auditarIdentidadProductos(db, 'test', { lecturaConfiable: true, ahora: new Date(ISO) });
    const caso = db.prepare("SELECT * FROM identidad_casos WHERE ml_key='MLA14|'").get();
    const producto = db.prepare('SELECT * FROM productos_fusion WHERE primary_woo_id=14').get();
    const creada = decidirCasoIdentidad(db, caso.id, { tipo: 'vincular', product_id: producto.id,
      operation_id: 'saga-atajo', expected_version: caso.expected_version, evidence_fingerprint: caso.evidencia_fingerprint }, 'ana');
    // ML ya tiene exactamente el SKU y el stock que la operación buscaba fijar.
    const remoto = { seller_sku: producto.fusion_sku, stock: creada.operacion.stock_objetivo };
    const adapter = {
      setStock: vi.fn(), clearSku: vi.fn(), writeSku: vi.fn(),
      read: vi.fn(async () => ({ ...remoto, observed_at: new Date().toISOString() })),
    };
    for (let i = 0; i < 5; i++) {
      const r = await procesarPasoOperacionIdentidad(db, creada.operacion.id, adapter, { allowRemoteWrites: true });
      expect(r.ok).toBe(true);
      const estadoAhora = db.prepare('SELECT estado FROM identidad_operaciones WHERE id=?').get(creada.operacion.id).estado;
      if (estadoAhora === 'completada') break;
    }
    expect(db.prepare('SELECT estado FROM identidad_operaciones WHERE id=?').get(creada.operacion.id).estado).toBe('completada');
    expect(adapter.setStock).not.toHaveBeenCalled();
    expect(adapter.clearSku).not.toHaveBeenCalled();
    expect(adapter.writeSku).not.toHaveBeenCalled();
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

  it('no clasifica una observacion anterior a la 082 y bloquea la conciliacion', () => {
    woo(db, { id: 71, sku: 'FB-71' });
    // Con SKU exacto: si se clasificara sobre el default de la migracion, saldria sku_ausente.
    ml(db, { clave: 'MLA71|', sku: 'FB-71', atributos: null });
    ml(db, { clave: 'MLA72|', sku: 'FB-71' });
    const r = auditarIdentidadProductos(db, 'test', { lecturaConfiable: true });
    expect(r.total).toBe(2);
    expect(r.observacion_incompleta).toBe(1);
    expect(r.auditadas).toBe(1);
    // No se crea caso para la clave sin observar: contarla como urgente fabricaria backlog falso.
    expect(db.prepare("SELECT COUNT(*) n FROM identidad_casos WHERE ml_key='MLA71|'").get().n).toBe(0);
    // La igualdad sola se cumpliria; la conciliacion exige ademas cero incompletas.
    expect(r.auditadas).toBe(r.verificadas + r.excepciones + r.urgentes);
    expect(r.conciliado).toBe(false);
    const salud = estadoIdentidadProductos(db);
    expect(salud.observacion_incompleta).toBe(1);
    expect(salud.sano).toBe(false);
    expect(salud.degradado).toBe(true);
  });

  it('no declara conciliado un universo vacio ni cuenta casos fuera del universo', () => {
    // Universo vacio: la igualdad 0 === 0+0+0 se cumple sola. No alcanza.
    const vacio = auditarIdentidadProductos(db, 'test', { lecturaConfiable: true });
    expect(vacio.total).toBe(0);
    expect(vacio.conciliado).toBe(false);

    // Un caso urgente de una clave que despues se pausa no puede seguir contando: si contara,
    // la igualdad del gate 2 quedaria inalcanzable para siempre.
    woo(db, { id: 81, sku: 'NO-COINCIDE' });
    ml(db, { clave: 'MLA81|', sku: 'INEXISTENTE-81' });
    const antes = auditarIdentidadProductos(db, 'test', { lecturaConfiable: true });
    expect(antes.total).toBe(1);
    expect(antes.urgentes).toBe(1);
    db.prepare("UPDATE ml_publicaciones_cache SET status='paused' WHERE clave='MLA81|'").run();
    const despues = auditarIdentidadProductos(db, 'test', { lecturaConfiable: true });
    expect(despues.total).toBe(0);
    expect(despues.urgentes).toBe(0);
    expect(db.prepare("SELECT COUNT(*) n FROM identidad_casos WHERE ml_key='MLA81|'").get().n).toBe(1);
  });

  describe('buscarProductosFusion', () => {
    it('con búsqueda vacía devuelve todos los productos activos respetando el límite', () => {
      woo(db, { id: 50, sku: 'FB-50', nombre: 'Bicicleta A' });
      woo(db, { id: 51, sku: 'FB-51', nombre: 'Bicicleta B' });
      woo(db, { id: 52, sku: 'FB-52', nombre: 'Bicicleta C' });
      bootstrapProductosFusion(db);
      expect(buscarProductosFusion(db, { q: '' }).length).toBe(3);
      expect(buscarProductosFusion(db, { q: '', limite: 2 }).length).toBe(2);
    });

    it('trata % y _ literales en el texto de búsqueda sin matchear de más ni romper', () => {
      woo(db, { id: 60, sku: 'FB-60', nombre: 'Combo 50% off_especial' });
      woo(db, { id: 61, sku: 'FB-61', nombre: 'Producto normal' });
      bootstrapProductosFusion(db);
      const porPorcentaje = buscarProductosFusion(db, { q: '50%' });
      expect(porPorcentaje.map((p) => p.primary_woo_id)).toEqual([60]);
      const porGuionBajo = buscarProductosFusion(db, { q: 'off_especial' });
      expect(porGuionBajo.map((p) => p.primary_woo_id)).toEqual([60]);
      // Si % se tratara como wildcard, "50X" también matchearía "50% off..." de más.
      expect(buscarProductosFusion(db, { q: '50X' }).length).toBe(0);
    });

    it('nunca devuelve productos no activos (provisional o archivado)', () => {
      woo(db, { id: 70, sku: 'FB-70', nombre: 'Producto activo' });
      woo(db, { id: 71, sku: 'FB-71', nombre: 'Producto provisional' });
      woo(db, { id: 72, sku: 'FB-72', nombre: 'Producto archivado' });
      bootstrapProductosFusion(db);
      db.prepare("UPDATE productos_fusion SET estado='provisional' WHERE primary_woo_id=71").run();
      db.prepare("UPDATE productos_fusion SET estado='archivado' WHERE primary_woo_id=72").run();
      const resultados = buscarProductosFusion(db, { q: '' });
      expect(resultados.map((p) => p.primary_woo_id)).toEqual([70]);
      expect(buscarProductosFusion(db, { q: 'provisional' }).length).toBe(0);
      expect(buscarProductosFusion(db, { q: 'archivado' }).length).toBe(0);
    });

    it('clampa limite a [1,50] con 0, negativo, mayor a 50 y valor no numérico', () => {
      for (let i = 80; i < 90; i++) woo(db, { id: i, sku: `FB-${i}`, nombre: `Producto ${i}` });
      bootstrapProductosFusion(db);
      expect(buscarProductosFusion(db, { limite: 0 }).length).toBe(1);
      expect(buscarProductosFusion(db, { limite: -5 }).length).toBe(1);
      expect(buscarProductosFusion(db, { limite: 999 }).length).toBe(10);
      expect(buscarProductosFusion(db, { limite: 'abc' }).length).toBe(10); // default 20 clampado por el fallback numérico
    });

    it('un producto activo sin fila en catalogo_cache aparece igual, con campos woo nulos', () => {
      // productos_fusion referencia catalogo_cache por FK; para simular un LEFT JOIN sin match
      // insertamos directo en catalogo_cache y luego borramos la fila de woo dejando el producto Fusion.
      woo(db, { id: 90, sku: 'FB-90', nombre: 'Producto sin cache' });
      bootstrapProductosFusion(db);
      db.prepare('DELETE FROM catalogo_cache WHERE id_woo=90').run();
      const resultados = buscarProductosFusion(db, { q: 'sin cache' });
      expect(resultados.length).toBe(1);
      expect(resultados[0]).toMatchObject({ sku_woo: null, stock_woo: null, gtin: null, primary_woo_id: 90 });
    });

    it('encuentra por SKU Woo y por GTIN, no solo por nombre', () => {
      woo(db, { id: 100, sku: 'ABC-999', gtin: '4006381333931', nombre: 'Nombre irrelevante' });
      bootstrapProductosFusion(db);
      expect(buscarProductosFusion(db, { q: 'ABC-999' }).map((p) => p.primary_woo_id)).toEqual([100]);
      expect(buscarProductosFusion(db, { q: '4006381333931' }).map((p) => p.primary_woo_id)).toEqual([100]);
    });

    it('encuentra sin tilde: "Casco Rembrandt Para Ninos" matchea "Casco Rembrandt Para Niños" (antes daba 0 por LIKE literal)', () => {
      woo(db, { id: 200, sku: 'FB-200', nombre: 'Casco Rembrandt Para Niños' });
      bootstrapProductosFusion(db);
      expect(buscarProductosFusion(db, { q: 'Casco Rembrandt Para Ninos' }).map((p) => p.primary_woo_id)).toEqual([200]);
    });

    it('encuentra por tokens no contiguos: "casco ninos" matchea "Casco Rembrandt Para Niños" (antes daba 0 por LIKE de substring único)', () => {
      woo(db, { id: 201, sku: 'FB-201', nombre: 'Casco Rembrandt Para Niños' });
      bootstrapProductosFusion(db);
      expect(buscarProductosFusion(db, { q: 'casco ninos' }).map((p) => p.primary_woo_id)).toEqual([201]);
    });

    it('encuentra con el orden de los tokens invertido: "rembrandt casco" matchea "Casco Rembrandt Para Niños" (antes daba 0 por orden fijo del LIKE)', () => {
      woo(db, { id: 202, sku: 'FB-202', nombre: 'Casco Rembrandt Para Niños' });
      bootstrapProductosFusion(db);
      expect(buscarProductosFusion(db, { q: 'rembrandt casco' }).map((p) => p.primary_woo_id)).toEqual([202]);
    });

    it('prioriza coincidencia exacta de identificador sobre coincidencia solo por nombre', () => {
      // La consulta es exactamente el SKU de un producto, pero también matchea por nombre en otro.
      woo(db, { id: 210, sku: 'FB-210', nombre: 'Bicicleta Rodado Aro Especial' });
      woo(db, { id: 211, sku: 'FB-210-DIST', nombre: 'FB-210' }); // nombre literal igual a la consulta
      bootstrapProductosFusion(db);
      const resultados = buscarProductosFusion(db, { q: 'FB-210' });
      expect(resultados.map((p) => p.primary_woo_id)).toEqual([210, 211]);
    });

    it('ordena por similitud (tsr) descendente cuando ambos productos contienen todos los tokens', () => {
      // Los dos matchean los 3 tokens de la consulta (el segundo por substring "aventuraa"
      // que contiene "aventura"), pero el nombre exacto a la consulta debe salir primero:
      // tsr('casco aventura rojo', 'casco aventura rojo') = 1 vs
      // tsr('casco aventura rojo', 'casco aventuraa rojo deluxe edition') ≈ 0.70 (verificado a mano).
      woo(db, { id: 220, sku: 'FB-220', nombre: 'Casco Aventura Rojo' });
      woo(db, { id: 221, sku: 'FB-221', nombre: 'Casco Aventuraa Rojo Deluxe Edition' });
      bootstrapProductosFusion(db);
      const resultados = buscarProductosFusion(db, { q: 'Casco Aventura Rojo' });
      expect(resultados.map((p) => p.primary_woo_id)).toEqual([220, 221]);
    });

    it('un producto sin fila en catalogo_cache sigue siendo buscable por nombre_canonico con la nueva búsqueda en JS', () => {
      woo(db, { id: 230, sku: 'FB-230', nombre: 'Casco Aventura Sin Cache' });
      bootstrapProductosFusion(db);
      db.prepare('DELETE FROM catalogo_cache WHERE id_woo=230').run();
      const resultados = buscarProductosFusion(db, { q: 'aventura sin cache' });
      expect(resultados.map((p) => p.primary_woo_id)).toEqual([230]);
      expect(resultados[0]).toMatchObject({ sku_woo: null, stock_woo: null, gtin: null });
    });

    it('nunca devuelve un producto provisional o archivado aunque coincida por texto libre (post reescritura)', () => {
      woo(db, { id: 240, sku: 'FB-240', nombre: 'Casco Rembrandt Provisional' });
      woo(db, { id: 241, sku: 'FB-241', nombre: 'Casco Rembrandt Archivado' });
      bootstrapProductosFusion(db);
      db.prepare("UPDATE productos_fusion SET estado='provisional' WHERE primary_woo_id=240").run();
      db.prepare("UPDATE productos_fusion SET estado='archivado' WHERE primary_woo_id=241").run();
      expect(buscarProductosFusion(db, { q: 'casco rembrandt' }).length).toBe(0);
    });
  });

  describe('GET /productos/buscar', () => {
    it('devuelve productos activos filtrados por texto vía HTTP', async () => {
      woo(db, { id: 110, sku: 'FB-110', nombre: 'Rodado 29 Aro Naranja' });
      woo(db, { id: 111, sku: 'FB-111', nombre: 'Rodado 26 Aro Verde' });
      bootstrapProductosFusion(db);
      const app = express(); app.use(express.json());
      app.use((req, _res, next) => { req.user = { username: 'lector', is_admin: false, permisos: [{ herramienta: 'matcher', nivel: 'read' }] }; next(); });
      app.use('/api/identidad-productos', identidadProductosRouter(db));
      const resp = await request(app).get('/api/identidad-productos/productos/buscar').query({ q: 'Naranja' });
      expect(resp.status).toBe(200);
      expect(resp.body.data.map((p) => p.primary_woo_id)).toEqual([110]);
    });
  });
});
