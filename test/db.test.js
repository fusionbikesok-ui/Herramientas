import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import { openDb } from '../db/index.js';

const TEST_DB = './test/tmp-fusion.sqlite';

describe('db schema', () => {
  afterEach(() => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  it('creates all required tables', () => {
    const db = openDb(TEST_DB);
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    ).all().map(r => r.name);
    expect(tables).toEqual([
      '_schema_migrations',
      'catalogo_cache',
      'cobertura_exclusiones',
      'cobertura_hay_que_publicar',
      'cobertura_marcados_correcto',
      'cobertura_salteados',
      'cobertura_sesion',
      'ean_sku',
      'errores_descartados',
      'mapeo_fusion',
      'ml_oauth_token',
      'ml_precio_auditoria',
      'ml_precios_cache',
      'ml_publicaciones_cache',
      'ml_reactivacion_frenada',
      'ml_shipment_estado',
      'ml_sku_push_fallos',
      'ml_stock_estado',
      'ml_vinculos_revisados',
      'ordenes_ml_procesadas',
      'ordenes_ml_wc_pedidos',
      'password_reset_tokens',
      'pedidos',
      'pendientes_mapeo',
      'recepcion_documentos',
      'recepcion_items',
      'recepciones',
      'sku_matcher_decisiones',
      'skus_config_ml',
      'sync_estado',
      'sync_log',
      'user_permisos',
      'users',
    ]);
    db.close();
  });

  it('crea las columnas de precio en ml_publicaciones_cache y las tablas de vínculos', () => {
    const db = openDb(TEST_DB);
    const cols = db.prepare('PRAGMA table_info(ml_publicaciones_cache)').all().map(c => c.name);
    expect(cols).toContain('precio');
    expect(cols).toContain('available_quantity');
    expect(cols).toContain('precio_actualizado_en');

    // Las tablas nuevas existen y aceptan una fila.
    db.prepare(`INSERT INTO ml_reactivacion_frenada
      (clave, sku, motivo, neto, precio_contado, deficit_pct, detectado_en)
      VALUES ('MLA1|', 'FB-1', 'El neto de ML queda por debajo del precio web', 100, 150, 0.33, '2026-07-30T10:00:00Z')`).run();
    expect(db.prepare('SELECT COUNT(*) n FROM ml_reactivacion_frenada').get().n).toBe(1);

    // PK compuesta: la misma clave con dos señales distintas convive.
    const ins = db.prepare(`INSERT INTO ml_vinculos_revisados
      (clave, senal, valor_revisado, revisado_por, revisado_en)
      VALUES (?, ?, ?, ?, ?)`);
    ins.run('MLA1|', 'precio', '99000', 'auditor', '2026-07-30T10:00:00Z');
    ins.run('MLA1|', 'seller_sku', 'FB-9', 'auditor', '2026-07-30T10:00:00Z');
    expect(db.prepare('SELECT COUNT(*) n FROM ml_vinculos_revisados').get().n).toBe(2);
    db.close();
  });
});

// ── Migraciones del Matcher unificado, entrega 1 ────────────────────────────────
// Estas dos migraciones corren sobre la base REAL de producción al desplegar, y las dos
// tienen una forma de fallar silenciosa: la 014 puede dejar a alguien sin poder trabajar
// (sin error visible, solo 403 en cada botón) y la 012 puede dejar la tabla a medias y
// romper la pantalla principal para siempre. Por eso se prueban acá y no solo por lectura.
describe('Matcher unificado — migraciones de la entrega 1', () => {
  const DB_MIG = './test/tmp-migraciones-matcher.sqlite';
  afterEach(() => {
    if (fs.existsSync(DB_MIG)) fs.unlinkSync(DB_MIG);
  });

  // Hallazgo del revisor sobre la primera versión de la 014: copiaba el nivel guardado, y
  // como `cobertura` era niveles:false TODAS las filas dicen 'read'. Con el nivel derivado
  // del método eso significa entrar, ver la cola y recibir 403 en confirmar, descartar,
  // saltear, publicar y deshacer. Tiene que otorgar 'write': es el acceso equivalente al que
  // la persona ya tenía.
  it('014: quien tenía solo `cobertura` recibe `matcher` con write, no read', () => {
    const db = openDb(DB_MIG);
    db.prepare("INSERT INTO users (id, username, pass_hash, is_admin, activo, creado_en, actualizado_en) VALUES (90, 'solo_cobertura', 'x', 0, 1, ?, ?)").run(new Date().toISOString(), new Date().toISOString());
    db.prepare("INSERT INTO user_permisos (user_id, herramienta, nivel) VALUES (90, 'cobertura', 'read')").run();
    db.close();

    const db2 = openDb(DB_MIG); // el arranque aplica la migración
    const permisos = db2.prepare('SELECT herramienta, nivel FROM user_permisos WHERE user_id = 90').all();
    expect(permisos).toEqual([{ herramienta: 'matcher', nivel: 'write' }]);
    db2.close();
  });

  it('014: si ya tenía `matcher`, no se lo degrada y se limpia la fila huérfana', () => {
    const db = openDb(DB_MIG);
    db.prepare("INSERT INTO users (id, username, pass_hash, is_admin, activo, creado_en, actualizado_en) VALUES (91, 'ambos', 'x', 0, 1, ?, ?)").run(new Date().toISOString(), new Date().toISOString());
    db.prepare("INSERT INTO user_permisos (user_id, herramienta, nivel) VALUES (91, 'cobertura', 'read')").run();
    db.prepare("INSERT INTO user_permisos (user_id, herramienta, nivel) VALUES (91, 'matcher', 'write')").run();
    db.close();

    const db2 = openDb(DB_MIG);
    const permisos = db2.prepare('SELECT herramienta, nivel FROM user_permisos WHERE user_id = 91').all();
    expect(permisos).toEqual([{ herramienta: 'matcher', nivel: 'write' }]);
    db2.close();
  });

  it('014: no toca los permisos de quien nunca tuvo `cobertura`', () => {
    const db = openDb(DB_MIG);
    db.prepare("INSERT INTO users (id, username, pass_hash, is_admin, activo, creado_en, actualizado_en) VALUES (92, 'ajeno', 'x', 0, 1, ?, ?)").run(new Date().toISOString(), new Date().toISOString());
    db.prepare("INSERT INTO user_permisos (user_id, herramienta, nivel) VALUES (92, 'preparacion', 'write')").run();
    db.close();

    const db2 = openDb(DB_MIG);
    expect(db2.prepare('SELECT herramienta, nivel FROM user_permisos WHERE user_id = 92').all())
      .toEqual([{ herramienta: 'preparacion', nivel: 'write' }]);
    db2.close();
  });

  // Hallazgo del revisor: el bloque recreaba la tabla sin transacción y con el error tragado.
  // Abrir la base dos veces tiene que dejarla igual; si la segunda pasada volviera a migrar,
  // borraría la tabla ya migrada y con ella la sesión de todos.
  it('012: abrir la base dos veces deja la sesión por usuario intacta', () => {
    const db = openDb(DB_MIG);
    db.prepare("INSERT INTO cobertura_sesion (user_id, direccion, marca_actual, actualizado_en) VALUES (1, 'wc_ml', 'Metha', ?)").run(new Date().toISOString());
    db.close();

    const db2 = openDb(DB_MIG);
    const cols = db2.prepare('PRAGMA table_info(cobertura_sesion)').all().map((c) => c.name);
    expect(cols).toContain('user_id');
    expect(cols).toContain('direccion');
    expect(db2.prepare('SELECT marca_actual FROM cobertura_sesion WHERE user_id = 1').get()?.marca_actual).toBe('Metha');
    db2.close();
  });
});
