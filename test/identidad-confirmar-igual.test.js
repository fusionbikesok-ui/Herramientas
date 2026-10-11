import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { openDb } from '../db/index.js';
import { auditarIdentidadProductos, decidirCasoIdentidad, destrabarOperacionIdentidad } from '../lib/identidadProductos.js';

const FILE = './test/tmp-identidad-confirmar-igual.sqlite';
const ISO = '2026-10-09T12:00:00.000Z';

function contradictorio(db, id) {
  db.prepare(`INSERT INTO catalogo_cache (id_woo,nombre,sku,tipo,stock,actualizado_en)
    VALUES (?,'Bicicleta Rodado 27 Talle M',?,'simple',2,?)`).run(id, `FB-${id}`, ISO);
  db.prepare(`INSERT INTO ml_publicaciones_cache
    (clave,item_id,variation_id,titulo,status,seller_sku,seller_sku_presente,available_quantity,atributos_json,actualizado_en)
    VALUES (?,?,'', 'Bicicleta Rodado 29 Talle M','active',NULL,0,2,'[]',?)`).run(`MLA${id}|`, `MLA${id}`, ISO);
  auditarIdentidadProductos(db, 'test', { lecturaConfiable: true, ahora: new Date(ISO) });
  return {
    producto: db.prepare('SELECT * FROM productos_fusion WHERE primary_woo_id=?').get(id),
    fila: () => db.prepare('SELECT * FROM identidad_casos WHERE ml_key=?').get(`MLA${id}|`),
  };
}

function decidir(db, c, extra, operationId) {
  const f = c.fila();
  return decidirCasoIdentidad(db, f.id, { tipo: 'vincular', product_id: c.producto.id, operation_id: operationId,
    expected_version: f.expected_version, evidence_fingerprint: f.evidencia_fingerprint, ...extra }, 'jose');
}

describe('confirmar igual (override de contradicción)', () => {
  let db;
  beforeEach(() => { db = openDb(FILE); });
  afterEach(() => {
    try { db.close(); } catch { /* ya cerrada */ }
    for (const s of ['', '-wal', '-shm']) if (fs.existsSync(`${FILE}${s}`)) fs.unlinkSync(`${FILE}${s}`);
  });

  it('sin override sigue rechazando la contradicción', () => {
    const c = contradictorio(db, 1101);
    expect(decidir(db, c, {}, 'sin-1101')).toMatchObject({ ok: false, code: 'contradiccion_titulo' });
  });

  it('exige un motivo para confirmar igual', () => {
    const c = contradictorio(db, 1102);
    expect(decidir(db, c, { override_contradiccion: true }, 'sin-motivo')).toMatchObject({ ok: false, code: 'INVALID_INPUT' });
  });

  it('con override y motivo guarda la decisión con la marca y encola la corrección', () => {
    const c = contradictorio(db, 1103);
    const r = decidir(db, c, { override_contradiccion: true, motivo: 'El título de ML está mal escrito' }, 'ok-1103');
    expect(r.ok).toBe(true);
    expect(r.decision).toMatchObject({ override_contradiccion: 1, override_motivo: 'El título de ML está mal escrito' });
    expect(r.operacion).toMatchObject({ sku_objetivo: 'FB-1103' });
    expect(db.prepare("SELECT evento FROM identidad_historial WHERE evento='confirmar_igual'").all()).toHaveLength(1);
  });

  it('el override vale solo para esa clave y SKU: otra decisión sin override vuelve a rechazar', () => {
    const a = contradictorio(db, 1104);
    expect(decidir(db, a, { override_contradiccion: true, motivo: 'm' }, 'ok-1104').ok).toBe(true);
    const b = contradictorio(db, 1105);
    expect(decidir(db, b, {}, 'sin-1105')).toMatchObject({ ok: false, code: 'contradiccion_titulo' });
  });
});

describe('destrabar una operación en intervención', () => {
  let db;
  beforeEach(() => { db = openDb(FILE); });
  afterEach(() => {
    try { db.close(); } catch { /* ya cerrada */ }
    for (const s of ['', '-wal', '-shm']) if (fs.existsSync(`${FILE}${s}`)) fs.unlinkSync(`${FILE}${s}`);
  });

  function enIntervencion(id) {
    const c = contradictorio(db, id);
    const r = decidir(db, c, { override_contradiccion: true, motivo: 'm' }, `op-${id}`);
    db.prepare("UPDATE identidad_operaciones SET estado='intervencion',ultimo_error='boom' WHERE id=?").run(r.operacion.id);
    return { c, op: r.operacion };
  }

  it('pasa intervencion → pendiente (o shadow) con motivo y deja evento', () => {
    const { c, op } = enIntervencion(1201);
    const f = c.fila();
    const r = destrabarOperacionIdentidad(db, op.id, { operation_id: 'destrabar-1', motivo: 'Revisado con el proveedor',
      expected_version: f.expected_version, evidence_fingerprint: f.evidencia_fingerprint }, 'jose');
    expect(r.ok).toBe(true);
    expect(['pendiente', 'shadow']).toContain(r.operacion.estado);
    expect(r.operacion.intentos).toBe(0);
    expect(db.prepare("SELECT evento FROM identidad_historial WHERE evento='operacion_destrabada'").all()).toHaveLength(1);
  });

  it('exige motivo', () => {
    const { c, op } = enIntervencion(1202);
    const f = c.fila();
    expect(destrabarOperacionIdentidad(db, op.id, { operation_id: 'd-2', expected_version: f.expected_version,
      evidence_fingerprint: f.evidencia_fingerprint }, 'jose')).toMatchObject({ ok: false, code: 'INVALID_INPUT' });
  });

  it('solo destraba lo que está en intervención', () => {
    const { c, op } = enIntervencion(1203);
    db.prepare("UPDATE identidad_operaciones SET estado='completada' WHERE id=?").run(op.id);
    const f = c.fila();
    expect(destrabarOperacionIdentidad(db, op.id, { operation_id: 'd-3', motivo: 'x', expected_version: f.expected_version,
      evidence_fingerprint: f.evidencia_fingerprint }, 'jose')).toMatchObject({ ok: false, code: 'INVALID_STATE' });
  });

  it('es idempotente por operation_id', () => {
    const { c, op } = enIntervencion(1204);
    const f = c.fila();
    const input = { operation_id: 'd-4', motivo: 'x', expected_version: f.expected_version, evidence_fingerprint: f.evidencia_fingerprint };
    expect(destrabarOperacionIdentidad(db, op.id, input, 'jose').ok).toBe(true);
    expect(destrabarOperacionIdentidad(db, op.id, input, 'jose')).toMatchObject({ ok: true, repetido: true });
  });
});

describe('confirmar igual y la auditoría', () => {
  let db;
  beforeEach(() => { db = openDb(FILE); });
  afterEach(() => {
    try { db.close(); } catch { /* ya cerrada */ }
    for (const s of ['', '-wal', '-shm']) if (fs.existsSync(`${FILE}${s}`)) fs.unlinkSync(`${FILE}${s}`);
  });

  it('la auditoría no reabre como contradicción un par ya confirmado igual', () => {
    const c = contradictorio(db, 1301);
    // ML ya lleva el SKU: sin override la clasificación es contradicción de título.
    db.prepare("UPDATE ml_publicaciones_cache SET seller_sku='FB-1301',seller_sku_presente=1 WHERE clave='MLA1301|'").run();
    auditarIdentidadProductos(db, 'test', { lecturaConfiable: true, ahora: new Date(ISO) });
    expect(c.fila().clasificacion).toBe('contradiccion_titulo');
    const f = c.fila();
    db.prepare(`INSERT INTO identidad_decisiones (caso_id,producto_id,tipo,operation_id,expected_version,evidencia_fingerprint,
      decidida_por,decidida_en,override_contradiccion,override_motivo) VALUES (?,?,'vincular','aud-1301',?,?,'jose',?,1,'m')`)
      .run(f.id, c.producto.id, f.expected_version, f.evidencia_fingerprint, ISO);
    auditarIdentidadProductos(db, 'test', { lecturaConfiable: true, ahora: new Date(ISO) });
    expect(c.fila().clasificacion).not.toBe('contradiccion_titulo');
  });
});
