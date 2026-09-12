import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import Database from 'better-sqlite3';
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
      'conversation_messages',
      'conversations',
      'despacho_controles',
      'despacho_escaneos',
      'despacho_horarios',
      'despacho_horarios_auditoria',
      'despacho_horarios_meta',
      'despacho_lote_eventos',
      'despacho_lote_items',
      'despacho_lotes',
      'device_tokens',
      'ean_sku',
      'errores_descartados',
      'etiquetas_cola',
      'gestion_pedido_cambios',
      'gestion_pedido_clientes',
      'gestion_pedido_entregas',
      'gestion_pedido_eventos',
      'gestion_pedido_importaciones',
      'gestion_pedido_items',
      'gestion_pedido_reintegros',
      'gestion_pedidos',
      'gestion_recuperacion_contactos',
      'gestion_recuperacion_oportunidades',
      'guardia_ml_aprendizajes',
      'guardia_ml_casos',
      'guardia_ml_config',
      'guardia_ml_eventos',
      'guardia_ml_operaciones',
      'guardia_ml_pedidos_retenidos',
      'guardia_ml_stock_compartido',
      'guardia_ml_stock_compartido_eventos',
      'identidad_casos',
      'identidad_comandos',
      'identidad_config',
      'identidad_decisiones',
      'identidad_eventos_integracion',
      'identidad_evidencias',
      'identidad_excepciones',
      'identidad_exclusiones_canal',
      'identidad_familias',
      'identidad_historial',
      'identidad_notas',
      'identidad_operacion_pasos',
      'identidad_operaciones',
      'identidad_reglas_familia',
      'identidad_tareas_publicacion',
      'identidades_canal',
      'identificadores_producto',
      'inbox_assignments',
      'inbox_items',
      'incidentes_email_outbox',
      'incidentes_operativos',
      'incidentes_operativos_historial',
      'integration_event_history',
      'integration_events',
      'integration_jobs',
      'inventario_diferencias',
      'mapeo_fusion',
      'matcher_candidatos_cache',
      'metricas_ciclo_sync',
      // Captura de qué cambió en una publicación de ML, campo por campo (migración 087).
      'ml_cambios_observados',
      'ml_oauth_token',
      'ml_precio_auditoria',
      'ml_precios_cache',
      'ml_publicacion_cambios',
      'ml_publicaciones_cache',
      'ml_reactivacion_frenada',
      // Cadencia adaptativa del scan y huella para medir la cobertura del webhook (086).
      'ml_scan_huella',
      'ml_scan_ramp',
      'ml_shipment_estado',
      'ml_sku_push_fallos',
      'ml_stock_estado',
      'ml_vinculos_revisados',
      'mobile_action_keys',
      'mobile_refresh_tokens',
      'notificaciones_enviadas',
      'notificaciones_usuario',
      'notification_deliveries',
      'operational_day_events',
      'operational_days',
      'ordenes_ml_procesadas',
      'ordenes_ml_wc_pedidos',
      'password_reset_tokens',
      'pedidos',
      'pendientes_mapeo',
      'pick_wave_assignments',
      'pick_wave_claims',
      'pick_wave_helpers',
      'pick_wave_items',
      'pick_wave_returns',
      'pick_wave_shortages',
      'pick_waves',
      'preferencias_notificacion',
      'preparacion_devolucion_items',
      'preparacion_devoluciones',
      'preparacion_fotos_holds',
      'producto_fusion_atributos',
      'productos_fusion',
      'recepcion_documentos',
      'recepcion_items',
      'recepciones',
      'sku_matcher_decisiones',
      'skus_config_ml',
      'stock_exception_events',
      'stock_exception_woo_outbox',
      'stock_incidents',
      'stock_movements',
      'stock_negativo_alertas',
      'stock_rollout_skus',
      'stock_supplier_return_events',
      'stock_supplier_returns',
      'stock_tasks',
      'sync_estado',
      'sync_log',
      'user_notifications',
      'user_permisos',
      'users',
      'warehouse_pick_zones',
      'warranty_attachments',
      'warranty_cases',
      'warranty_events',
      'warranty_stock_commitments',
      'warranty_woo_outbox',
      'woo_webhooks_estado',
      'workshop_events',
      'workshop_evidence',
      'workshop_jobs',
      'workshop_parts',
      'workshop_woo_outbox'
    ]);
    expect(db.pragma('user_version', { simple: true })).toBe(30);
    const refreshDevice = db.prepare('PRAGMA table_info(mobile_refresh_tokens)').all()
      .find((column) => column.name === 'device_id');
    expect(refreshDevice.notnull).toBe(1);
    db.close();
    const reopened = openDb(TEST_DB);
    expect(reopened.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='guardia_ml_operaciones'").get()).toBeTruthy();
    expect(reopened.prepare('PRAGMA table_info(guardia_ml_operaciones)').all().some((c) => c.name === 'claim_hasta')).toBe(true);
    reopened.close();
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

  it('030 migra una base pre-Hito7 con refresh legacy no nulo y conserva sus filas', () => {
    const legacyDb = new Database(TEST_DB);
    legacyDb.exec(fs.readFileSync('./db/schema.sql', 'utf8'));
    legacyDb.exec(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE,
        pass_hash TEXT NOT NULL,
        is_admin INTEGER NOT NULL DEFAULT 0,
        activo INTEGER NOT NULL DEFAULT 1,
        email TEXT,
        creado_en TEXT NOT NULL,
        actualizado_en TEXT NOT NULL
      );
      INSERT INTO users (id, username, pass_hash, creado_en, actualizado_en)
      VALUES (1, 'legacy-user', 'hash', '2026-08-29T00:00:00.000Z', '2026-08-29T00:00:00.000Z');
      CREATE TABLE device_tokens (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        token TEXT NOT NULL,
        plataforma TEXT NOT NULL,
        creado_en TEXT NOT NULL,
        actualizado_en TEXT NOT NULL,
        revocado_en TEXT
      );
      INSERT INTO device_tokens (id, user_id, token, plataforma, creado_en, actualizado_en)
      VALUES (7, 1, 'legacy-token', 'android', '2026-08-29T00:00:00.000Z', '2026-08-29T00:00:00.000Z');
      CREATE TABLE mobile_refresh_tokens (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        device_id INTEGER REFERENCES device_tokens(id),
        token_hash TEXT NOT NULL UNIQUE,
        family_id TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        usado_en TEXT,
        revocado_en TEXT,
        creado_en TEXT NOT NULL
      );
      INSERT INTO mobile_refresh_tokens
        (token_hash, user_id, device_id, family_id, expires_at, creado_en)
      VALUES ('legacy-refresh', 1, 7, 'legacy-family', '2099-01-01T00:00:00.000Z', '2026-08-29T00:00:00.000Z');
    `);
    legacyDb.close();

    const db = openDb(TEST_DB);
    const refreshDevice = db.prepare('PRAGMA table_info(mobile_refresh_tokens)').all()
      .find((column) => column.name === 'device_id');
    expect(refreshDevice.notnull).toBe(1);
    expect(db.prepare('SELECT device_id FROM mobile_refresh_tokens WHERE token_hash = ?')
      .get('legacy-refresh').device_id).toBe(7);
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_device_tokens_unique_active'").get())
      .toBeTruthy();
    expect(db.pragma('user_version', { simple: true })).toBe(30);
    db.close();
  });

  it('030 hace rollback si falla el índice único y conserva user_version=29 de Claims', () => {
    const legacyDb = new Database(TEST_DB);
    legacyDb.exec(fs.readFileSync('./db/schema.sql', 'utf8'));
    legacyDb.exec(`
      CREATE TABLE device_tokens (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        token TEXT NOT NULL,
        plataforma TEXT NOT NULL,
        creado_en TEXT NOT NULL,
        actualizado_en TEXT NOT NULL,
        revocado_en TEXT
      );
      INSERT INTO device_tokens (user_id, token, plataforma, creado_en, actualizado_en)
      VALUES
        (1, 'duplicate-active-token', 'ios', '2026-08-29T00:00:00.000Z', '2026-08-29T00:00:00.000Z'),
        (2, 'duplicate-active-token', 'ios', '2026-08-29T00:00:01.000Z', '2026-08-29T00:00:01.000Z');
    `);
    legacyDb.close();

    expect(() => openDb(TEST_DB)).toThrow(/Migración 030 no aplicada|UNIQUE/);

    const afterFailure = new Database(TEST_DB);
    expect(afterFailure.pragma('user_version', { simple: true })).toBe(29);
    expect(afterFailure.prepare('SELECT COUNT(*) AS count FROM device_tokens').get().count).toBe(2);
    expect(afterFailure.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_device_tokens_unique_active'").get())
      .toBeUndefined();
    expect(afterFailure.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'preferencias_notificacion'").get())
      .toBeUndefined();
    afterFailure.close();
  });

  it('030 aborta ante refresh huérfano, conserva la tabla y deja user_version=29', () => {
    const legacyDb = new Database(TEST_DB);
    legacyDb.exec(fs.readFileSync('./db/schema.sql', 'utf8'));
    legacyDb.exec(`
      CREATE TABLE device_tokens (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        token TEXT NOT NULL,
        plataforma TEXT NOT NULL,
        creado_en TEXT NOT NULL,
        actualizado_en TEXT NOT NULL,
        revocado_en TEXT
      );
      CREATE TABLE mobile_refresh_tokens (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        token_hash TEXT NOT NULL UNIQUE,
        user_id INTEGER NOT NULL,
        device_id INTEGER REFERENCES device_tokens(id),
        expires_at TEXT NOT NULL,
        revocado_en TEXT,
        reemplazado_por TEXT,
        creado_en TEXT NOT NULL
      );
      INSERT INTO mobile_refresh_tokens
        (token_hash, user_id, device_id, expires_at, creado_en)
      VALUES ('orphan-hash', 1, NULL, '2099-01-01T00:00:00.000Z', '2026-08-29T00:00:00.000Z');
    `);
    legacyDb.close();

    expect(() => openDb(TEST_DB)).toThrow(/Migración 030 no aplicada|huérfano/);

    const afterFailure = new Database(TEST_DB);
    const refreshDevice = afterFailure.prepare('PRAGMA table_info(mobile_refresh_tokens)').all()
      .find((column) => column.name === 'device_id');
    expect(refreshDevice.notnull).toBe(0);
    expect(afterFailure.prepare('SELECT device_id FROM mobile_refresh_tokens').get().device_id).toBeNull();
    expect(afterFailure.pragma('user_version', { simple: true })).toBe(29);
    afterFailure.close();
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
