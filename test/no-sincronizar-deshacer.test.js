import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import { openDb } from '../db/index.js';
import { marcarNoSincronizar, deshacerNoSincronizar } from '../lib/noSincronizar.js';
import { colaCasos } from '../lib/catalogoVinculos.js';

const FILE = './test/tmp-no-sincronizar-deshacer.sqlite';
const now = () => new Date().toISOString();

function cache(db, clave) {
  const [item, variacion = ''] = clave.split('|');
  db.prepare(`INSERT INTO ml_publicaciones_cache (clave,item_id,variation_id,titulo,status,seller_sku,available_quantity,actualizado_en)
    VALUES (?,?,?,?,?,?,?,?)`).run(clave, item, variacion, 'Pub', 'active', null, 1, now());
}
// Caso de Identidad abierto para la publicación, como lo deja el scan de conciliación.
function caso(db, clave) {
  const ts = now();
  return Number(db.prepare(`INSERT INTO identidad_casos
    (direccion,ml_key,clasificacion,estado,evidencia_fingerprint,expected_version,primera_deteccion_en,ultima_deteccion_en)
    VALUES ('ml_fusion',?,'sin_vinculo','urgente','fp-test',1,?,?)`).run(clave, ts, ts).lastInsertRowid);
}
const casoRow = (db, id) => db.prepare('SELECT * FROM identidad_casos WHERE id=?').get(id);
const abiertos = (db) => colaCasos(db, { filtro: 'abiertos' }).data.map((f) => f.caso_id);
const omitir = (db, clave) => db.prepare("SELECT * FROM sku_matcher_decisiones WHERE clave=? AND accion='omitir'").get(clave);

describe('deshacer no sincronizar reabre el caso de Identidad', () => {
  let db;
  beforeEach(() => { process.env.IDENTIDAD_PROTECCION = 'activo'; db = openDb(FILE); });
  afterEach(() => {
    try { db.close(); } catch { /* ya cerrada */ }
    for (const s of ['', '-wal', '-shm']) if (fs.existsSync(`${FILE}${s}`)) fs.unlinkSync(`${FILE}${s}`);
  });

  it('(a) marcar y deshacer deja el caso abierto en la cola y borra el omitir', () => {
    cache(db, 'MLA30|');
    const id = caso(db, 'MLA30|');
    expect(marcarNoSincronizar(db, { clave: 'MLA30|', variante: 'a', motivo: 'm', actor: 'ana', expectedSku: null }).ok).toBe(true);
    expect(casoRow(db, id).estado).toBe('exceptuado');
    expect(abiertos(db)).not.toContain(id);

    const r = deshacerNoSincronizar(db, { clave: 'MLA30|', motivo: 'error', actor: 'beto', esAdmin: false });
    expect(r.ok).toBe(true);
    expect(omitir(db, 'MLA30|')).toBeUndefined();
    const c = casoRow(db, id);
    expect(c.estado).toBe('urgente');
    expect(c.resuelto_en).toBeNull();
    expect(c.expected_version).toBe(3); // marca (+1) y deshacer (+1)
    expect(abiertos(db)).toContain(id);
    const ev = db.prepare("SELECT evento,actor FROM identidad_historial WHERE entidad_tipo='caso' AND entidad_id=? ORDER BY id DESC LIMIT 1").get(id);
    expect(ev).toMatchObject({ evento: 'caso_reabierto_por_deshacer', actor: 'beto' });
    expect(db.prepare("SELECT activa FROM identidad_excepciones WHERE caso_id=? AND motivo LIKE 'No sincronizar por%'").all(id).every((e) => e.activa === 0)).toBe(true);
  });

  it('(c) como admin: marcar y deshacer reabre el caso; sin admin responde 403 y no toca nada', () => {
    cache(db, 'MLA31|');
    const id = caso(db, 'MLA31|');
    expect(marcarNoSincronizar(db, { clave: 'MLA31|', variante: 'c', motivo: 'm', actor: 'jose', expectedSku: null }).ok).toBe(true);
    expect(deshacerNoSincronizar(db, { clave: 'MLA31|', motivo: 'x', actor: 'beto', esAdmin: false }))
      .toMatchObject({ ok: false, status: 403 });
    expect(omitir(db, 'MLA31|')).toBeTruthy();
    expect(casoRow(db, id).estado).toBe('exceptuado');

    expect(deshacerNoSincronizar(db, { clave: 'MLA31|', motivo: 'x', actor: 'jose', esAdmin: true }).ok).toBe(true);
    expect(omitir(db, 'MLA31|')).toBeUndefined();
    expect(casoRow(db, id).estado).toBe('urgente');
    expect(abiertos(db)).toContain(id);
  });

  it('no reabre si otra decisión vigente (solo_ml manual) sigue cerrando el caso', () => {
    cache(db, 'MLA32|');
    const id = caso(db, 'MLA32|');
    marcarNoSincronizar(db, { clave: 'MLA32|', variante: 'a', motivo: 'm', actor: 'ana', expectedSku: null });
    // Otra decisión posterior reemplaza la excepción de la marca (índice único de activas por caso).
    db.prepare("UPDATE identidad_excepciones SET activa=0,invalidada_en=?,invalidada_motivo='reemplazada' WHERE caso_id=?").run(now(), id);
    db.prepare(`INSERT INTO identidad_excepciones (caso_id,tipo,motivo,evidencia_fingerprint,creada_por,creada_en)
      VALUES (?,'solo_ml','Excepción manual','fp-test','jose',?)`).run(id, now());
    expect(deshacerNoSincronizar(db, { clave: 'MLA32|', motivo: 'x', actor: 'beto', esAdmin: false }).ok).toBe(true);
    expect(casoRow(db, id).estado).toBe('exceptuado');
    expect(abiertos(db)).not.toContain(id);
  });
});
