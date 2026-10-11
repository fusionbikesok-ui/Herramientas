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

  it('ML ya tiene el SKU pero el vínculo local es viejo: alinea el vínculo y cierra el caso, sin operación (también pausada)', () => {
    const c = caso(db, { id: 907, clave: 'MLA907|' });
    db.prepare("UPDATE ml_publicaciones_cache SET seller_sku='FB-907',seller_sku_presente=1,status='paused',available_quantity=0 WHERE clave='MLA907|'").run();
    db.prepare("INSERT OR REPLACE INTO sku_matcher_decisiones (clave,sku,accion,actualizado_en) VALUES ('MLA907|','FB-VIEJO','confirmar',?)").run(ISO);
    const r = vincular(db, c, 'op-alinea');
    expect(r).toMatchObject({ ok: true, vinculo_actualizado: true });
    expect(db.prepare("SELECT sku FROM sku_matcher_decisiones WHERE clave='MLA907|'").get().sku).toBe('FB-907');
    expect(c.fila().estado).toBe('resuelto');
    expect(db.prepare("SELECT COUNT(*) n FROM identidad_operaciones WHERE ml_key='MLA907|'").get().n).toBe(0);
    expect(db.prepare("SELECT COUNT(*) n FROM identidad_historial WHERE evento='vinculo_alineado_sin_operacion'").get().n).toBe(1);
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

describe('alinear el vínculo local cuando ML ya lleva el SKU objetivo', () => {
  let db;
  beforeEach(() => { db = openDb(FILE); });
  afterEach(() => {
    try { db.close(); } catch { /* ya cerrada */ }
    for (const suffix of ['', '-wal', '-shm']) if (fs.existsSync(`${FILE}${suffix}`)) fs.unlinkSync(`${FILE}${suffix}`);
  });

  // Caso abierto + ML ya con el SKU nuevo (pausada) + vínculo local viejo.
  function alineable(id, clave = `MLA${id}|`) {
    const c = caso(db, { id, clave });
    db.prepare("UPDATE ml_publicaciones_cache SET seller_sku=?,seller_sku_presente=1,status='paused',available_quantity=0 WHERE clave=?").run(`FB-${id}`, clave);
    db.prepare("INSERT OR REPLACE INTO sku_matcher_decisiones (clave,sku,accion,actualizado_en) VALUES (?,'FB-VIEJO','confirmar',?)").run(clave, ISO);
    return c;
  }
  const vinc = (c, op, extra = {}) => { const f = c.fila(); return decidirCasoIdentidad(db, f.id, { tipo: 'vincular', product_id: c.producto.id, operation_id: op,
    expected_version: f.expected_version, evidence_fingerprint: f.evidencia_fingerprint, ...extra }, 'ana'); };

  it('es idempotente por operation_id', () => {
    const c = alineable(910);
    expect(vinc(c, 'op-i').ok).toBe(true);
    const otra = vinc(c, 'op-i');
    expect(otra).toMatchObject({ ok: true, repetido: true });
    expect(db.prepare("SELECT COUNT(*) n FROM identidad_decisiones WHERE operation_id='op-i'").get().n).toBe(1);
  });

  it('deja identidades_canal apuntando al producto nuevo (archiva la vieja)', () => {
    const c = alineable(911);
    const otro = caso(db, { id: 9110, clave: 'MLA9110|' }).producto.id; // otro producto Fusion (el viejo)
    db.prepare("INSERT INTO identidades_canal (producto_id,canal,external_key,activa,creado_en,actualizado_en) VALUES (?,'ml','MLA911|',1,?,?)").run(otro, ISO, ISO);
    expect(vinc(c, 'op-ic').ok).toBe(true);
    const activas = db.prepare("SELECT producto_id FROM identidades_canal WHERE canal='ml' AND external_key='MLA911|' AND activa=1").all();
    expect(activas).toEqual([{ producto_id: c.producto.id }]);
  });

  it('con una operación abierta sobre la clave: OPERACION_DUPLICADA y el caso no se toca', () => {
    const c = alineable(912);
    const dec = db.prepare(`INSERT INTO identidad_decisiones (caso_id,producto_id,tipo,operation_id,expected_version,evidencia_fingerprint,decidida_por,decidida_en)
      VALUES (?,?,'vincular','op-previa',1,'fp','ana',?)`).run(c.fila().id, c.producto.id, ISO).lastInsertRowid;
    db.prepare(`INSERT INTO identidad_operaciones (operation_id,tipo,caso_id,decision_id,producto_id,ml_key,sku_anterior,sku_objetivo,stock_objetivo,estado,paso_actual,iniciada_en,actualizada_en)
      VALUES ('op-x','correccion_sku',?,?,?,'MLA912|','A','B',1,'pendiente','zero',?,?)`).run(c.fila().id, dec, c.producto.id, ISO, ISO);
    expect(vinc(c, 'op-dup')).toMatchObject({ ok: false, code: 'OPERACION_DUPLICADA' });
    expect(c.fila().estado).not.toBe('resuelto');
  });

  it('un caso en intervencion NO se cierra por este camino (lo destraba un admin)', () => {
    const c = alineable(913);
    db.prepare("UPDATE identidad_casos SET estado='intervencion' WHERE ml_key='MLA913|'").run();
    expect(vinc(c, 'op-int')).toMatchObject({ ok: false, code: 'INVALID_STATE' });
    expect(c.fila().estado).toBe('intervencion');
  });

  it('un caso ya resuelto o exceptuado tampoco', () => {
    const c = alineable(914);
    db.prepare("UPDATE identidad_casos SET estado='exceptuado' WHERE ml_key='MLA914|'").run();
    expect(vinc(c, 'op-exc')).toMatchObject({ ok: false, code: 'INVALID_STATE' });
  });

  it('con hermanas activas pide confirmación; con confirmación alinea', () => {
    const c = alineable(915, 'MLA915|a');
    db.prepare(`INSERT INTO ml_publicaciones_cache (clave,item_id,variation_id,titulo,status,seller_sku,seller_sku_presente,available_quantity,atributos_json,actualizado_en)
      VALUES ('MLA915|b','MLA915','b','Otra','active','FB-OTRO',1,2,'[]',?)`).run(ISO);
    expect(vinc(c, 'op-h1')).toMatchObject({ ok: false, code: 'SIBLING_IMPACT_CONFIRMATION_REQUIRED', sibling_count: 1 });
    expect(vinc(c, 'op-h2', { confirm_sibling_impact: true }).ok).toBe(true);
  });

  it('una publicación en omitir exige override_omitir', () => {
    const c = alineable(916);
    db.prepare("UPDATE sku_matcher_decisiones SET accion='omitir' WHERE clave='MLA916|'").run();
    expect(vinc(c, 'op-o1')).toMatchObject({ ok: false, code: 'omitir_requiere_override' });
    expect(vinc(c, 'op-o2', { override_omitir: true }).ok).toBe(true);
    expect(db.prepare("SELECT sku,accion FROM sku_matcher_decisiones WHERE clave='MLA916|'").get()).toEqual({ sku: 'FB-916', accion: 'confirmar' });
  });

  it('fusion_sku igual al de ML pero distinto del SKU de Woo: SKU_INCONSISTENTE y no se graba nada', () => {
    const c = alineable(917);
    db.prepare("UPDATE catalogo_cache SET sku='FB-OTRO-917' WHERE id_woo=917").run();
    expect(vinc(c, 'op-inc')).toMatchObject({ ok: false, code: 'SKU_INCONSISTENTE' });
    expect(db.prepare("SELECT sku FROM sku_matcher_decisiones WHERE clave='MLA917|'").get().sku).toBe('FB-VIEJO');
    expect(c.fila().estado).not.toBe('resuelto');
  });
});
