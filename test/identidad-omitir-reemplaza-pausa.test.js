import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { openDb } from '../db/index.js';
import { auditarIdentidadProductos, decidirCasoIdentidad, procesarPasoOperacionIdentidad } from '../lib/identidadProductos.js';
import { abrirOActualizarIncidente } from '../lib/incidentes.js';

const FILE = './test/tmp-identidad-omitir-reemplaza-pausa.sqlite';
const ISO = '2026-10-10T12:00:00.000Z';
const ALERTA = { integracion: 'mercadolibre', proceso: 'identidad_pausa', tipoError: 'pausa_bloqueada_impacto' };

// Publicación con omitir (marca b) y una pausa bloqueada_impacto de esa clave, más una alerta abierta.
function pausaBloqueada(db, clave, { estado = 'bloqueada_impacto', opId = `pausa-${clave}` } = {}) {
  const [item] = clave.split('|');
  db.prepare(`INSERT INTO identidad_pausas (operation_id,ml_key,item_id,motivo,estado,creada_por,creada_en,actualizada_en)
    VALUES (?,?,?,'duplicada',?,'ana',?,?)`).run(opId, clave, item, estado, ISO, ISO);
  return db.prepare('SELECT id FROM identidad_pausas WHERE operation_id=?').get(opId).id;
}
function abrirAlerta(db) {
  abrirOActualizarIncidente(db, { ...ALERTA, severidad: 'advertencia', mensajeTecnico: 'pausa bloqueada', mensajeHumano: 'pausa bloqueada', contexto: {} });
}
const estadoPausa = (db, id) => db.prepare('SELECT estado,ultimo_error FROM identidad_pausas WHERE id=?').get(id);
const estadoAlerta = (db) => db.prepare('SELECT estado FROM incidentes_operativos WHERE clave_dedupe=?')
  .get(`${ALERTA.integracion}|${ALERTA.proceso}|${ALERTA.tipoError}`)?.estado;

// Caso abierto + ML ya con el SKU objetivo + vínculo local viejo + omitir: camino alinearVinculoLocal.
function alineableOmitida(db, id) {
  db.prepare(`INSERT INTO catalogo_cache (id_woo,nombre,sku,tipo,stock,actualizado_en) VALUES (?,?,?,'simple',2,?)`)
    .run(id, `Producto ${id}`, `FB-${id}`, ISO);
  db.prepare(`INSERT INTO ml_publicaciones_cache
    (clave,item_id,variation_id,titulo,status,seller_sku,seller_sku_presente,available_quantity,atributos_json,actualizado_en)
    VALUES (?,?,'','Publicación','active',NULL,0,2,'[]',?)`).run(`MLA${id}|`, `MLA${id}`, ISO);
  auditarIdentidadProductos(db, 'test', { lecturaConfiable: true, ahora: new Date(ISO) });
  db.prepare("UPDATE ml_publicaciones_cache SET seller_sku=?,seller_sku_presente=1,status='paused',available_quantity=0 WHERE clave=?")
    .run(`FB-${id}`, `MLA${id}|`);
  db.prepare("INSERT OR REPLACE INTO sku_matcher_decisiones (clave,sku,accion,origen,actualizado_en) VALUES (?,'FB-VIEJO','omitir','no_sincronizar_b',?)")
    .run(`MLA${id}|`, ISO);
  return {
    producto: db.prepare('SELECT * FROM productos_fusion WHERE primary_woo_id=?').get(id),
    fila: () => db.prepare('SELECT * FROM identidad_casos WHERE ml_key=?').get(`MLA${id}|`),
  };
}

describe('vincular sobre una marca omitir reemplaza la pausa bloqueada_impacto de la clave', () => {
  let db;
  beforeEach(() => { db = openDb(FILE); });
  afterEach(() => {
    try { db.close(); } catch { /* ya cerrada */ }
    for (const s of ['', '-wal', '-shm']) if (fs.existsSync(`${FILE}${s}`)) fs.unlinkSync(`${FILE}${s}`);
  });

  it('por alinearVinculoLocal: cancela la pausa bloqueada de esa clave y cierra la alerta', () => {
    const c = alineableOmitida(db, 1301);
    const pausa = pausaBloqueada(db, 'MLA1301|');
    abrirAlerta(db);
    const f = c.fila();
    const r = decidirCasoIdentidad(db, f.id, { tipo: 'vincular', product_id: c.producto.id, operation_id: 'alinea-1301',
      expected_version: f.expected_version, evidence_fingerprint: f.evidencia_fingerprint, override_omitir: true }, 'jose');
    expect(r).toMatchObject({ ok: true, vinculo_actualizado: true });
    expect(db.prepare("SELECT accion FROM sku_matcher_decisiones WHERE clave='MLA1301|'").get().accion).toBe('confirmar');
    expect(estadoPausa(db, pausa)).toMatchObject({ estado: 'cancelada', ultimo_error: 'reemplazada por otra marca' });
    expect(estadoAlerta(db)).toBe('resuelto');
  });

  it('por la saga (procesarPasoOperacionIdentidad): cancela la pausa al activar y cierra la alerta', async () => {
    const c = alineableOmitida(db, 1302);
    db.prepare("UPDATE ml_publicaciones_cache SET seller_sku=NULL,seller_sku_presente=0,status='active',available_quantity=2 WHERE clave='MLA1302|'").run();
    db.prepare("UPDATE sku_matcher_decisiones SET sku=NULL WHERE clave='MLA1302|'").run();
    const pausa = pausaBloqueada(db, 'MLA1302|');
    abrirAlerta(db);
    const f = c.fila();
    const op = decidirCasoIdentidad(db, f.id, { tipo: 'vincular', product_id: c.producto.id, operation_id: 'saga-1302',
      expected_version: f.expected_version, evidence_fingerprint: f.evidencia_fingerprint, override_omitir: true }, 'jose').operacion;
    const remoto = { seller_sku: '', stock: 2 };
    const adapter = {
      setStock: vi.fn(async (_k, s) => { remoto.stock = s; return { ok: true }; }),
      clearSku: vi.fn(async () => { remoto.seller_sku = ''; return { ok: true }; }),
      writeSku: vi.fn(async (_k, s) => { remoto.seller_sku = s; return { ok: true }; }),
      read: vi.fn(async () => ({ ...remoto, observed_at: new Date().toISOString() })),
    };
    for (let i = 0; i < 8; i++) await procesarPasoOperacionIdentidad(db, op.id, adapter, { allowRemoteWrites: true });
    expect(db.prepare('SELECT estado FROM identidad_operaciones WHERE id=?').get(op.id).estado).toBe('completada');
    expect(db.prepare("SELECT accion FROM sku_matcher_decisiones WHERE clave='MLA1302|'").get().accion).toBe('confirmar');
    expect(estadoPausa(db, pausa)).toMatchObject({ estado: 'cancelada', ultimo_error: 'reemplazada por otra marca' });
    expect(estadoAlerta(db)).toBe('resuelto');
  });

  it('no toca pausas de otras claves ni pausas pendientes de la misma clave; la alerta sigue abierta si queda otra bloqueada', () => {
    const c = alineableOmitida(db, 1303);
    const propia = pausaBloqueada(db, 'MLA1303|');
    const pendiente = pausaBloqueada(db, 'MLA1303|', { estado: 'pendiente', opId: 'pend-1303' });
    const ajena = pausaBloqueada(db, 'MLA9999|', { opId: 'ajena-9999' });
    abrirAlerta(db);
    const f = c.fila();
    decidirCasoIdentidad(db, f.id, { tipo: 'vincular', product_id: c.producto.id, operation_id: 'alinea-1303',
      expected_version: f.expected_version, evidence_fingerprint: f.evidencia_fingerprint, override_omitir: true }, 'jose');
    expect(estadoPausa(db, propia).estado).toBe('cancelada');
    expect(estadoPausa(db, pendiente).estado).toBe('pendiente');
    expect(estadoPausa(db, ajena).estado).toBe('bloqueada_impacto');
    expect(estadoAlerta(db)).toBe('activo');
  });
});
