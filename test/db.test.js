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
      'mapeo_fusion',
      'ml_oauth_token',
      'ml_publicaciones_cache',
      'ml_stock_estado',
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
});
