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
      'ean_sku',
      'errores_descartados',
      'mapeo_fusion',
      'ml_oauth_token',
      'ml_precio_auditoria',
      'ml_publicaciones_cache',
      'ml_reactivacion_frenada',
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
