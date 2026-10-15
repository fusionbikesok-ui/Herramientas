// Etiquetas en Preparación (spec 2026-10-15, v8–v23): esquema de la migración 133, backfills acotados por canal y fecha del paso 2.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import Database from 'better-sqlite3';
import { openDb } from '../db/index.js';
import { ensureTables, marcarPreparacionEnviada } from '../routes/preparacion.js';
import { asegurarEsquemaEtiquetas, backfillEtiquetas133 } from '../lib/etiquetasPreparacion.js';

vi.mock('../routes/woo.js', async () => {
  const actual = await vi.importActual('../routes/woo.js');
  return { ...actual, wooFetch: vi.fn() };
});

const TEST_DB = `./test/tmp-etiquetas-esquema.${process.pid}.sqlite`;
const limpiar = () => { for (const suf of ['', '-wal', '-shm', '-journal']) fs.rmSync(TEST_DB + suf, { force: true }); };
let db;
const T = (dias) => new Date(Date.now() - dias * 86400000).toISOString();

function prep({ clave, canal = 'web', estado = 'completada', pack = null, tracking = null, pendiente = 0, completado = T(10) }) {
  return db.prepare(`INSERT INTO preparaciones (canal, clave, pack_id, estado, creado_en, completado_en, tracking, woo_paso2_pendiente)
    VALUES (?,?,?,?,?,?,?,?)`).run(canal, clave, pack, estado, T(20), completado, tracking, pendiente).lastInsertRowid;
}
const col = (clave, c) => db.prepare(`SELECT ${c} v FROM preparaciones WHERE clave=?`).get(clave).v;

beforeEach(() => { limpiar(); db = openDb(TEST_DB); ensureTables(db); });
afterEach(() => { db.close(); limpiar(); });

describe('migración 133: esquema', () => {
  it('crea las columnas, la tabla de descargas y los dos triggers', () => {
    const cols = db.prepare('PRAGMA table_info(preparaciones)').all().map((c) => c.name);
    for (const c of ['etiqueta_cargada_en', 'etiqueta_origen', 'envio_confirmado_en', 'envio_descartado_en', 'envio_descartado_motivo', 'envio_descartado_por']) expect(cols).toContain(c);
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='etiquetas_ml_descargas'").get()).toBeTruthy();
    const triggers = db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='despacho_controles'").all().map((t) => t.name);
    expect(triggers.length).toBe(2);
  });

  it('asegurarEsquemaEtiquetas es idempotente', () => {
    asegurarEsquemaEtiquetas(db); asegurarEsquemaEtiquetas(db);
    expect(db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='trigger' AND tbl_name='despacho_controles'").get().n).toBe(2);
  });

  it('una base vieja (con tablas previas a la 133) recibe columnas y backfill al abrirse', () => {
    db.close(); limpiar();
    const viejo = new Database(TEST_DB);
    viejo.close();
    db = openDb(TEST_DB);
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='etiquetas_ml_descargas'").get()).toBeTruthy();
  });
});

describe('triggers de despacho_controles (v22/v23): solo ML se fecha por despacho', () => {
  const grupo = (g, extra = '') => db.prepare(`INSERT INTO despacho_controles (grupo_clave, estado, creado_en, actualizado_en ${extra ? ', confirmado_en' : ''}) VALUES (?, 'pendiente', ?, ? ${extra ? ', ?' : ''})`).run(...[g, T(1), T(1), ...(extra ? [extra] : [])]);

  it('UPDATE de confirmado_en: fecha al grupo ML (por clave y por pack_id) y deja intacto al web', () => {
    prep({ clave: 'ml:1', canal: 'ml' });
    prep({ clave: 'ml:2', canal: 'ml', pack: 'PK1' });
    prep({ clave: 'web:9', canal: 'web' });
    grupo('ml:1'); grupo('PK1'); grupo('web:9');
    const ts = T(0.5);
    db.prepare('UPDATE despacho_controles SET confirmado_en=? ').run(ts);
    expect(col('ml:1', 'envio_confirmado_en')).toBe(ts);
    expect(col('ml:2', 'envio_confirmado_en')).toBe(ts);
    expect(col('web:9', 'envio_confirmado_en')).toBeNull();
  });

  it('INSERT con confirmado_en (regularización de un control inexistente) también fecha', () => {
    prep({ clave: 'ml:3', canal: 'ml' });
    const ts = T(0.2);
    grupo('ml:3', ts);
    expect(col('ml:3', 'envio_confirmado_en')).toBe(ts);
  });

  it('no pisa una fecha ya escrita (COALESCE)', () => {
    prep({ clave: 'ml:4', canal: 'ml' });
    grupo('ml:4');
    db.prepare('UPDATE despacho_controles SET confirmado_en=?').run(T(3));
    const primera = col('ml:4', 'envio_confirmado_en');
    db.prepare('UPDATE despacho_controles SET confirmado_en=?').run(T(0.1));
    expect(col('ml:4', 'envio_confirmado_en')).toBe(primera);
  });
});

describe('marcarPreparacionEnviada: paso 2 en una sola sentencia (v22/v23)', () => {
  it('web: deja woo_paso2_pendiente=0 y envio_confirmado_en juntos', () => {
    prep({ clave: 'web:1', canal: 'web', estado: 'en_preparacion', pendiente: 1, tracking: 'AND1' });
    marcarPreparacionEnviada(db, 'web:1', { usuario: 'u' });
    expect(col('web:1', 'woo_paso2_pendiente')).toBe(0);
    expect(col('web:1', 'envio_confirmado_en')).toBeTruthy();
  });

  it('web: no mueve una fecha ya confirmada', () => {
    prep({ clave: 'web:2', canal: 'web', estado: 'completada', pendiente: 1 });
    db.prepare("UPDATE preparaciones SET envio_confirmado_en='2026-01-01T00:00:00.000Z' WHERE clave='web:2'").run();
    marcarPreparacionEnviada(db, 'web:2', {});
    expect(col('web:2', 'envio_confirmado_en')).toBe('2026-01-01T00:00:00.000Z');
  });

  it('ML (barrido / proyección): NO fecha nada hasta el despacho', () => {
    prep({ clave: 'ml:7', canal: 'ml', estado: 'en_preparacion' });
    marcarPreparacionEnviada(db, 'ml:7', { usuario: 'sistema' });
    expect(col('ml:7', 'envio_confirmado_en')).toBeNull();
  });
});

describe('backfill 133 (acotado por canal, v8.4 / v10 / v20.2 / v21)', () => {
  function reiniciarMarcas() {
    db.exec('UPDATE preparaciones SET envio_confirmado_en=NULL, etiqueta_cargada_en=NULL, etiqueta_origen=NULL');
  }
  const evento = (id, tipo) => db.prepare("INSERT INTO preparacion_eventos (preparacion_id, tipo, detalle_json, creado_en) VALUES (?,?,'{}',?)").run(id, tipo, T(5));
  const foto = (id, tipo, creado) => db.prepare("INSERT INTO preparacion_fotos (preparacion_id, tipo, url, creado_en) VALUES (?,?,?,?)").run(id, tipo, '/uploads/x.jpg', creado);

  it('web: completada con tracking y sin paso 2 pendiente ni abandono toma completado_en; las demás quedan NULL', () => {
    prep({ clave: 'web:10', tracking: 'A', completado: T(9) });                    // confirmada (histórico inferido)
    prep({ clave: 'web:11', tracking: null });                                      // sin tracking
    prep({ clave: 'web:12', tracking: 'B', pendiente: 1 });                         // incierta
    const ab = prep({ clave: 'web:13', tracking: 'C' }); evento(ab, 'tracking_abandonado'); // abandonada
    reiniciarMarcas();
    backfillEtiquetas133(db);
    expect(col('web:10', 'envio_confirmado_en')).toBe(db.prepare("SELECT completado_en v FROM preparaciones WHERE clave='web:10'").get().v);
    expect(col('web:11', 'envio_confirmado_en')).toBeNull();
    expect(col('web:12', 'envio_confirmado_en')).toBeNull();
    expect(col('web:13', 'envio_confirmado_en')).toBeNull();
  });

  it('ML: control individual confirmado y pack de dos preparaciones toman la fecha; web con control NO', () => {
    prep({ clave: 'ml:20', canal: 'ml', pack: 'PKX' }); prep({ clave: 'ml:21', canal: 'ml', pack: 'PKX' }); prep({ clave: 'web:22', canal: 'web' });
    const ts = T(4);
    db.prepare("INSERT INTO despacho_controles (grupo_clave, estado, creado_en, actualizado_en) VALUES ('PKX','pendiente',?,?)").run(T(5), T(5));
    db.prepare("INSERT INTO despacho_controles (grupo_clave, estado, creado_en, actualizado_en) VALUES ('web:22','pendiente',?,?)").run(T(5), T(5));
    db.exec('DROP TRIGGER IF EXISTS trg_envio_ml_upd; DROP TRIGGER IF EXISTS trg_envio_ml_ins');
    db.prepare("UPDATE despacho_controles SET confirmado_en=? WHERE grupo_clave IN ('PKX','web:22')").run(ts);
    reiniciarMarcas();
    backfillEtiquetas133(db);
    expect(col('ml:20', 'envio_confirmado_en')).toBe(ts);
    expect(col('ml:21', 'envio_confirmado_en')).toBe(ts);
    expect(col('web:22', 'envio_confirmado_en')).toBeNull();
  });

  it('ML: miembros confirmados de un lote con salida toman la fecha de salida; los no confirmados no', () => {
    prep({ clave: 'ml:30', canal: 'ml' }); prep({ clave: 'ml:31', canal: 'ml' });
    const c30 = db.prepare("INSERT INTO despacho_controles (grupo_clave, estado, creado_en, actualizado_en) VALUES ('ml:30','pendiente',?,?)").run(T(6), T(6)).lastInsertRowid;
    const c31 = db.prepare("INSERT INTO despacho_controles (grupo_clave, estado, creado_en, actualizado_en) VALUES ('ml:31','pendiente',?,?)").run(T(6), T(6)).lastInsertRowid;
    const cols = db.prepare('PRAGMA table_info(despacho_lotes)').all().map((c) => c.name);
    const salida = T(3);
    const lote = db.prepare(`INSERT INTO despacho_lotes (canal, fecha_jornada, estado, creado_en, creado_por, salida_confirmada_en) VALUES ('ml','2026-10-01','cerrado',?,?,?)`).run(T(7), 'u', salida).lastInsertRowid;
    expect(cols).toContain('salida_confirmada_en');
    db.prepare("INSERT INTO despacho_lote_items (lote_id, control_id, estado, agregado_en) VALUES (?,?,'confirmado',?)").run(lote, c30, T(6));
    db.prepare("INSERT INTO despacho_lote_items (lote_id, control_id, estado, agregado_en) VALUES (?,?,'esperado',?)").run(lote, c31, T(6));
    reiniciarMarcas();
    backfillEtiquetas133(db);
    expect(col('ml:30', 'envio_confirmado_en')).toBe(salida);
    expect(col('ml:31', 'envio_confirmado_en')).toBeNull();
  });

  it('etiqueta_cargada_en histórica: foto paquete_cerrado/etiquetado → su fecha; sin foto → completado_en; origen historico_inferido; abiertas intactas', () => {
    const a = prep({ clave: 'web:40', completado: T(8) }); foto(a, 'paquete_cerrado', T(9));
    const b = prep({ clave: 'ml:41', canal: 'ml', completado: T(7) });
    const c = prep({ clave: 'web:42', estado: 'en_preparacion', completado: null });
    const d = prep({ clave: 'web:43', estado: 'anulado_en_woo', completado: T(6) });
    reiniciarMarcas();
    backfillEtiquetas133(db);
    expect(col('web:40', 'etiqueta_cargada_en')).toBe(db.prepare("SELECT creado_en v FROM preparacion_fotos WHERE preparacion_id=?").get(a).v);
    expect(col('web:40', 'etiqueta_origen')).toBe('historico_inferido');
    expect(col('ml:41', 'etiqueta_cargada_en')).toBe(db.prepare("SELECT completado_en v FROM preparaciones WHERE id=?").get(b).v);
    expect(col('web:42', 'etiqueta_cargada_en')).toBeNull();
    expect(col('web:43', 'etiqueta_cargada_en')).toBeTruthy();
    expect(c && d).toBeTruthy();
  });
});
