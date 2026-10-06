import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import express from 'express';
import request from 'supertest';

vi.mock('../lib/mlClient.js', () => ({ mlFetch: vi.fn(), bootstrapToken: vi.fn(), getAccessToken: vi.fn() }));
import { mlFetch } from '../lib/mlClient.js';
import { openDb } from '../db/index.js';
import { syncRouter } from '../routes/sync.js';

const TEST_DB = './test/pausadas-con-stock-endpoints.sqlite';
const CFG = { clientId: 'cid', clientSecret: 'cs', userId: '99999' };

function sembrar(db, n, { sub = 'paused_by_seller', stock = 5, modo = null } = {}) {
  const sku = `FB-${n}`;
  db.prepare(`INSERT INTO catalogo_cache (id_woo, nombre, sku, tipo, stock, precio, regular_price, actualizado_en)
    VALUES (?, 'Prod', ?, 'simple', ?, 300000, 300000, datetime('now'))`).run(1000 + n, sku, stock);
  db.prepare(`INSERT INTO sku_matcher_decisiones (clave, sku, wc_nombre, accion, actualizado_en)
    VALUES (?, ?, 'WC', 'confirmar', datetime('now'))`).run(`MLA${n}|`, sku);
  db.prepare(`INSERT INTO ml_publicaciones_cache
    (clave, item_id, variation_id, titulo, status, sub_status, es_variante, seller_sku, available_quantity, actualizado_en)
    VALUES (?, ?, '', 'Pub', 'paused', ?, 0, ?, 0, datetime('now'))`).run(`MLA${n}|`, `MLA${n}`, sub, sku);
  if (modo) db.prepare("INSERT INTO skus_config_ml (sku,nombre,modo,reserva,actualizado_en) VALUES (?,'x',?,0,datetime('now'))").run(sku, modo);
}

describe('Pausadas con stock en Woo: endpoints', () => {
  let db, app;
  beforeEach(() => {
    db = openDb(TEST_DB);
    vi.clearAllMocks();
    mlFetch.mockResolvedValue({ status: 200, data: {} });
    app = express();
    app.use(express.json());
    app.use('/api/sync', syncRouter(db, { ml: CFG }));
  });
  afterEach(() => { db.close(); for (const s of ['', '-wal', '-shm']) if (fs.existsSync(TEST_DB + s)) fs.unlinkSync(TEST_DB + s); });

  it('GET lista con causa, resumen y solo_local; ?causa filtra y una causa inválida da 400', async () => {
    sembrar(db, 1); sembrar(db, 2, { sub: 'out_of_stock' }); sembrar(db, 3, { modo: 'solo_local' });
    const r = await request(app).get('/api/sync/pausadas-con-stock');
    expect(r.status).toBe(200);
    expect(r.body.total).toBe(3);
    expect(r.body.resumen).toMatchObject({ paused_by_seller: 1, out_of_stock: 1, solo_local: 1 });
    expect(r.body.solo_local).toMatchObject({ skus: 1 });
    const f = await request(app).get('/api/sync/pausadas-con-stock?causa=paused_by_seller');
    expect(f.body.data.map((x) => x.item_id)).toEqual(['MLA1']);
    expect((await request(app).get('/api/sync/pausadas-con-stock?causa=inventada')).status).toBe(400);
  });

  it('POST reactivar valida el cuerpo', async () => {
    expect((await request(app).post('/api/sync/pausadas-con-stock/reactivar').send({})).status).toBe(400);
    const muchos = Array.from({ length: 51 }, (_, i) => `MLA${i}`);
    expect((await request(app).post('/api/sync/pausadas-con-stock/reactivar').send({ itemIds: muchos })).status).toBe(400);
  });

  it('POST reactivar levanta una paused_by_seller a pedido, y rechaza solo_local sin tocar ML por ella', async () => {
    sembrar(db, 1); sembrar(db, 3, { modo: 'solo_local' });
    mlFetch.mockImplementation(async (_db, _cfg, metodo, path) => {
      if (metodo === 'get' && path.startsWith('/items/bulk?ids=')) {
        const ids = path.match(/ids=([^&]*)/)[1].split(',');
        return { status: 200, data: ids.map((id) => ({ code: 200, body: { id, status: 'paused', sub_status: ['paused_by_seller'], price: 400000, category_id: 'MLA1234', listing_type_id: 'gold_special', shipping: { free_shipping: false } } })) };
      }
      if (metodo === 'get' && path.includes('listing_prices')) return { status: 200, data: { sale_fee_amount: 40000 } };
      return { status: 200, data: {} };
    });
    const r = await request(app).post('/api/sync/pausadas-con-stock/reactivar').send({ itemIds: ['MLA1', 'MLA3', 'MLA999'] });
    expect(r.status).toBe(200);
    expect(r.body.no_reactivables.sort()).toEqual(['MLA3', 'MLA999']);
    const puts = mlFetch.mock.calls.filter((c) => c[2] === 'put').map((c) => c[3]);
    expect(puts.some((u) => u.includes('MLA1'))).toBe(true);
    expect(puts.some((u) => u.includes('MLA3'))).toBe(false);
  });

  it('el reactivador automático NO toma las paused_by_seller (sólo la acción manual)', async () => {
    sembrar(db, 1);
    const { getReactivablesRows } = await import('../routes/sync.js');
    expect(getReactivablesRows(db).map((x) => x.item_id)).not.toContain('MLA1');
  });

  it('dashboard trae los contadores nuevos', async () => {
    sembrar(db, 1); sembrar(db, 3, { modo: 'solo_local' });
    const r = await request(app).get('/api/sync/dashboard');
    expect(r.body.pausadas_con_stock).toMatchObject({ paused_by_seller: 1, solo_local: 1 });
    expect(r.body.solo_local.skus).toBe(1);
  });

  it('dashboard avisa de las correcciones de identidad encoladas sin ejecutar hace más de 2 h', async () => {
    const antes = await request(app).get('/api/sync/dashboard');
    expect(antes.body.identidad_encoladas).toMatchObject({ n: 0, fuera_de_canario: 0 });
    db.prepare(`INSERT INTO ml_publicaciones_cache (clave,item_id,variation_id,titulo,status,seller_sku,seller_sku_presente,available_quantity,atributos_json,actualizado_en)
      VALUES ('MLA77|','MLA77','','P','active','FB-A',1,1,'[]','2026-09-01T00:00:00.000Z')`).run();
    db.prepare(`INSERT INTO catalogo_cache (id_woo,nombre,sku,tipo,stock,actualizado_en) VALUES (77,'W','FB-B','simple',1,'2026-09-01T00:00:00.000Z')`).run();
    const prod = db.prepare(`INSERT INTO productos_fusion (primary_woo_id,nombre_canonico,estado,creado_en,actualizado_en) VALUES (77,'W','activo','2026-09-01','2026-09-01')`).run().lastInsertRowid;
    const caso = db.prepare(`INSERT INTO identidad_casos (direccion,ml_key,producto_id,clasificacion,estado,severidad,evidencia_fingerprint,expected_version,primera_deteccion_en,ultima_deteccion_en)
      VALUES ('ml_fusion','MLA77|',?,'t','pendiente','normal','fp',1,'2026-09-01','2026-09-01')`).run(prod).lastInsertRowid;
    const dec = db.prepare(`INSERT INTO identidad_decisiones (caso_id,producto_id,tipo,operation_id,expected_version,evidencia_fingerprint,decidida_por,decidida_en)
      VALUES (?,?,'vincular','dd',1,'fp','t','2026-09-01')`).run(caso, prod).lastInsertRowid;
    db.prepare(`INSERT INTO identidad_operaciones (operation_id,tipo,caso_id,decision_id,producto_id,ml_key,sku_anterior,sku_objetivo,stock_objetivo,estado,iniciada_en,actualizada_en)
      VALUES ('oo','correccion_sku',?,?,?,'MLA77|','FB-A','FB-B',1,'pendiente','2026-09-01T00:00:00.000Z','2026-09-01T00:00:00.000Z')`).run(caso, dec, prod);
    const r = await request(app).get('/api/sync/dashboard');
    expect(r.body.identidad_encoladas.n).toBe(1);
    expect(r.body.identidad_encoladas.mas_vieja_horas).toBeGreaterThan(2);
  });

  it('revisar sin reactivar ofrece reactivar si sigue pausada con stock en Woo', async () => {
    sembrar(db, 1);
    const id = db.prepare(`INSERT INTO ml_publicacion_cambios (clave,item_id,sku,campo,valor_anterior,valor_nuevo,pausada,detectado_en)
      VALUES ('MLA1|','MLA1','FB-1','SALE_FORMAT','Unidad','Pack',1,datetime('now'))`).run().lastInsertRowid;
    const r = await request(app).post(`/api/sync/cambios-formato/${id}/revisar`).send({});
    expect(r.body.oferta_reactivar).toEqual({ item_id: 'MLA1', stock_woo: 5 });
    expect(mlFetch).not.toHaveBeenCalled();
  });

  it('un aviso de catálogo (vacío→producto, solo_aviso) NO bloquea al reactivador ni a la lista', async () => {
    sembrar(db, 1, { sub: 'out_of_stock' });
    db.prepare(`INSERT INTO ml_publicacion_cambios (clave,item_id,sku,campo,valor_anterior,valor_nuevo,pausada,pausa_error,detectado_en,solo_aviso)
      VALUES ('MLA1|','MLA1','FB-1','catalog_product_id',NULL,'MLA9',0,'catálogo nuevo: no se pausa, revisar',datetime('now'),1)`).run();
    const { getReactivablesRows } = await import('../routes/sync.js');
    expect(getReactivablesRows(db).map((x) => x.item_id)).toContain('MLA1');
    const r = await request(app).get('/api/sync/pausadas-con-stock');
    expect(r.body.data[0]).toMatchObject({ item_id: 'MLA1', reactivable: true });
    // El mismo aviso sin la marca sí bloquea (comportamiento previo para pausas reales del vigía).
    db.prepare('UPDATE ml_publicacion_cambios SET solo_aviso=0').run();
    expect(getReactivablesRows(db).map((x) => x.item_id)).not.toContain('MLA1');
    // y el aviso sigue visible para revisar
    db.prepare('UPDATE ml_publicacion_cambios SET solo_aviso=1').run();
    expect((await request(app).get('/api/sync/cambios-formato')).body.total).toBe(1);
  });
});
