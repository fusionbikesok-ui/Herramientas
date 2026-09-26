import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import express from 'express';
import request from 'supertest';

vi.mock('../lib/mlClient.js', () => ({ mlFetch: vi.fn(), bootstrapToken: vi.fn(), getAccessToken: vi.fn() }));
import { mlFetch } from '../lib/mlClient.js';
import { openDb } from '../db/index.js';
import { getReactivablesRows, syncRouter } from '../routes/sync.js';

const TEST_DB = './test/vigia-endpoints.sqlite';
const CFG = { clientId: 'cid', clientSecret: 'cs', userId: '99999' };

function sembrarPausada(db, clave = 'MLA1|', sku = 'FB-1') {
  db.prepare(`INSERT INTO catalogo_cache (id_woo, nombre, sku, tipo, stock, actualizado_en)
    VALUES (1, 'Cubierta', ?, 'simple', 5, datetime('now'))`).run(sku);
  // SIN ESTA FILA EL TEST NO MIDE NADA. getReactivablesRows se apoya en COMPUTED_STOCK_CTE
  // (routes/sync.js:224), que arranca `FROM sku_matcher_decisiones` con accion IN
  // ('asignar','confirmar'): sin una decisión, la consulta devuelve [] pase lo que pase y los
  // tres casos "pasarían" por la razón equivocada.
  db.prepare(`INSERT INTO sku_matcher_decisiones (clave, sku, wc_nombre, accion, actualizado_en)
    VALUES (?, ?, 'WC Cubierta', 'confirmar', datetime('now'))`).run(clave, sku);
  db.prepare(`INSERT INTO ml_publicaciones_cache
    (clave, item_id, variation_id, titulo, status, sub_status, es_variante, seller_sku, available_quantity, actualizado_en)
    VALUES (?, 'MLA1', '', 'Cubierta', 'paused', 'out_of_stock', 0, ?, 0, datetime('now'))`).run(clave, sku);
}

describe('el reactivador respeta las pausas del vigía', () => {
  let db, app;
  beforeEach(() => {
    db = openDb(TEST_DB);
    vi.clearAllMocks();
    app = express();
    app.use(express.json());
    app.use('/api/sync', syncRouter(db, { ml: CFG }));
  });
  afterEach(() => { db.close(); if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB); });

  it('sin cambios del vigía, la publicación es reactivable', () => {
    sembrarPausada(db);
    expect(getReactivablesRows(db).map(r => r.clave)).toContain('MLA1|');
  });

  it('con un cambio SIN revisar, el reactivador la saltea', () => {
    sembrarPausada(db);
    db.prepare(`INSERT INTO ml_publicacion_cambios (clave, item_id, campo, valor_anterior, valor_nuevo, pausada, detectado_en)
      VALUES ('MLA1|','MLA1','catalog_product_id',NULL,'MLA44441017',1,datetime('now'))`).run();
    expect(getReactivablesRows(db).map(r => r.clave)).not.toContain('MLA1|');
  });

  it('revisado el cambio, vuelve a ser reactivable', () => {
    sembrarPausada(db);
    db.prepare(`INSERT INTO ml_publicacion_cambios (clave, item_id, campo, valor_anterior, valor_nuevo, pausada, detectado_en, revisado_en, revisado_por)
      VALUES ('MLA1|','MLA1','catalog_product_id',NULL,'MLA44441017',1,datetime('now'),datetime('now'),'jose')`).run();
    expect(getReactivablesRows(db).map(r => r.clave)).toContain('MLA1|');
  });

  it('stock vuelto reabre el aviso bloqueado y no lo lista hasta revisión humana', () => {
    sembrarPausada(db);
    const id = db.prepare(`INSERT INTO ml_publicacion_cambios
      (clave,item_id,campo,valor_anterior,valor_nuevo,pausada,pausa_error,detectado_en,revisado_en,revisado_por,bloquea_reactivador)
      VALUES ('MLA1|','MLA1','catalog_product_id',NULL,'MLA2',0,'sin stock',datetime('now'),datetime('now'),'vigia-auto',1)`).run().lastInsertRowid;
    db.prepare("UPDATE ml_publicaciones_cache SET available_quantity=3").run();
    expect(getReactivablesRows(db)).toHaveLength(0);
    expect(db.prepare('SELECT revisado_en,bloquea_reactivador,pausa_error FROM ml_publicacion_cambios WHERE id=?').get(id))
      .toMatchObject({ revisado_en: null, bloquea_reactivador: 0 });
    expect(db.prepare('SELECT pausa_error FROM ml_publicacion_cambios WHERE id=?').get(id).pausa_error).toContain('reabierto: volvió el stock');
  });

  it('GET cambios-formato agrupa variaciones y conserva sus ids', async () => {
    sembrarPausada(db);
    const ins = db.prepare(`INSERT INTO ml_publicacion_cambios (clave,item_id,sku,campo,valor_anterior,valor_nuevo,pausada,detectado_en)
      VALUES (?, 'MLA1', ?, 'catalog_product_id', NULL, 'MLA2', 1, datetime('now'))`);
    ins.run('MLA1|11','FB-1'); ins.run('MLA1|12','FB-2');
    const r = await request(app).get('/api/sync/cambios-formato');
    expect(r.body.data).toHaveLength(1);
    expect(r.body.data[0].ids).toHaveLength(2);
    expect(r.body.total).toBe(1);
  });

  it('GET /cambios-formato devuelve los sin revisar con su antes y después', async () => {
    sembrarPausada(db);
    db.prepare(`INSERT INTO ml_publicacion_cambios (clave, item_id, sku, campo, valor_anterior, valor_nuevo, pausada, detectado_en)
      VALUES ('MLA1|','MLA1','FB-1','catalog_product_id',NULL,'MLA44441017',1,datetime('now'))`).run();
    const r = await request(app).get('/api/sync/cambios-formato');
    expect(r.status).toBe(200);
    expect(r.body.data).toHaveLength(1);
    expect(r.body.data[0]).toMatchObject({ campo: 'catalog_product_id', valor_nuevo: 'MLA44441017', pausada: 1 });
    expect(r.body.data[0].titulo).toBe('Cubierta');
  });

  it('revisar sin reactivar marca revisado y NO toca ML', async () => {
    sembrarPausada(db);
    const info = db.prepare(`INSERT INTO ml_publicacion_cambios (clave, item_id, campo, valor_anterior, valor_nuevo, pausada, detectado_en)
      VALUES ('MLA1|','MLA1','SALE_FORMAT','Unidad','Pack',1,datetime('now'))`).run();
    const r = await request(app).post(`/api/sync/cambios-formato/${info.lastInsertRowid}/revisar`).send({});
    expect(r.status).toBe(200);
    expect(r.body.reactivada).toBe(false);
    expect(mlFetch).not.toHaveBeenCalled();
    expect(db.prepare('SELECT revisado_en FROM ml_publicacion_cambios WHERE id=?').get(info.lastInsertRowid).revisado_en).toBeTruthy();
  });

  it('revisar con reactivar:true despausa en ML', async () => {
    sembrarPausada(db);
    mlFetch.mockResolvedValue({ status: 200, data: {} });
    const info = db.prepare(`INSERT INTO ml_publicacion_cambios (clave, item_id, campo, valor_anterior, valor_nuevo, pausada, detectado_en)
      VALUES ('MLA1|','MLA1','SALE_FORMAT','Unidad','Pack',1,datetime('now'))`).run();
    const r = await request(app).post(`/api/sync/cambios-formato/${info.lastInsertRowid}/revisar`).send({ reactivar: true });
    expect(r.body.reactivada).toBe(true);
    expect(mlFetch).toHaveBeenCalledWith(db, CFG, 'put', '/items/MLA1', { status: 'active' });
  });

  it('reactivar sin stock en ML: cierra el aviso y deja que la reactive el reactivador cuando haya stock', async () => {
    sembrarPausada(db);
    mlFetch
      .mockResolvedValueOnce({ status: 400, data: { message: 'Item without available_quantity' } })
      .mockResolvedValueOnce({ status: 200, data: { status: 'paused', sub_status: ['out_of_stock'], available_quantity: 0 } });
    const info = db.prepare(`INSERT INTO ml_publicacion_cambios (clave, item_id, campo, valor_anterior, valor_nuevo, pausada, detectado_en)
      VALUES ('MLA1|','MLA1','catalog_product_id','MLA1','MLA2',1,datetime('now'))`).run();
    const r = await request(app).post(`/api/sync/cambios-formato/${info.lastInsertRowid}/revisar`).send({ reactivar: true });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, reactivada: false, pendiente_stock: true });
    expect(db.prepare('SELECT revisado_en FROM ml_publicacion_cambios WHERE id=?').get(info.lastInsertRowid).revisado_en).toBeTruthy();
  });

  it('ML rechaza por otro motivo: 409 con el mensaje de ML (nunca 502) y el aviso sigue abierto', async () => {
    sembrarPausada(db);
    mlFetch
      .mockResolvedValueOnce({ status: 400, data: { message: 'item.status.invalid' } })
      .mockResolvedValueOnce({ status: 200, data: { status: 'under_review', sub_status: [], available_quantity: 3 } });
    const info = db.prepare(`INSERT INTO ml_publicacion_cambios (clave, item_id, campo, valor_anterior, valor_nuevo, pausada, detectado_en)
      VALUES ('MLA1|','MLA1','catalog_product_id','MLA1','MLA2',1,datetime('now'))`).run();
    const r = await request(app).post(`/api/sync/cambios-formato/${info.lastInsertRowid}/revisar`).send({ reactivar: true });
    expect(r.status).toBe(409);
    expect(r.body.ok).toBe(false);
    expect(r.body.error).toContain('item.status.invalid');
    expect(db.prepare('SELECT revisado_en FROM ml_publicacion_cambios WHERE id=?').get(info.lastInsertRowid).revisado_en).toBeNull();
  });

  it('revisar cierra todas las variaciones abiertas de la misma publicación', async () => {
    sembrarPausada(db);
    const ins = db.prepare(`INSERT INTO ml_publicacion_cambios (clave, item_id, campo, valor_anterior, valor_nuevo, pausada, detectado_en)
      VALUES (?, 'MLA1', 'catalog_product_id', NULL, 'MLA9', 1, datetime('now'))`);
    const a = ins.run('MLA1|11').lastInsertRowid; ins.run('MLA1|12'); ins.run('MLA1|13');
    const r = await request(app).post(`/api/sync/cambios-formato/${a}/revisar`).send({});
    expect(r.status).toBe(200);
    expect(r.body.cerrados).toBe(3);
    expect(db.prepare("SELECT COUNT(*) n FROM ml_publicacion_cambios WHERE item_id='MLA1' AND revisado_en IS NULL").get().n).toBe(0);
  });

  it('revisar NO cierra un cambio de otro campo de la misma publicación', async () => {
    sembrarPausada(db);
    const a = db.prepare(`INSERT INTO ml_publicacion_cambios (clave, item_id, campo, valor_anterior, valor_nuevo, pausada, detectado_en)
      VALUES ('MLA1|11','MLA1','catalog_product_id',NULL,'MLA9',1,datetime('now'))`).run().lastInsertRowid;
    const b = db.prepare(`INSERT INTO ml_publicacion_cambios (clave, item_id, campo, valor_anterior, valor_nuevo, pausada, detectado_en)
      VALUES ('MLA1|11','MLA1','UNITS_PER_PACK','1','2',1,datetime('now'))`).run().lastInsertRowid;
    const r = await request(app).post(`/api/sync/cambios-formato/${a}/revisar`).send({});
    expect(r.body.cerrados).toBe(1);
    expect(db.prepare('SELECT revisado_en FROM ml_publicacion_cambios WHERE id=?').get(b).revisado_en).toBeNull();
  });

  it('revisar un id inexistente da 404', async () => {
    const r = await request(app).post('/api/sync/cambios-formato/9999/revisar').send({});
    expect(r.status).toBe(404);
  });
});
