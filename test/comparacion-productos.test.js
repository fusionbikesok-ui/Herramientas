import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import express from 'express';
import request from 'supertest';

vi.mock('../lib/mlClient.js', () => ({ mlFetch: vi.fn(), bootstrapToken: vi.fn(), getAccessToken: vi.fn() }));
import { mlFetch } from '../lib/mlClient.js';
import { openDb } from '../db/index.js';
import { syncRouter } from '../routes/sync.js';

const TEST_DB = './test/comparacion-productos.sqlite';
const attrs = (o) => Object.entries(o).map(([id, value_name]) => ({ id, name: id, value_name }));

describe('GET /cambios-formato/:id/comparacion', () => {
  let db, app, id;
  beforeEach(() => {
    db = openDb(TEST_DB); vi.clearAllMocks();
    db.prepare(`INSERT INTO ml_publicaciones_cache (clave,item_id,variation_id,titulo,status,atributos_json,actualizado_en)
      VALUES ('MLA1|','MLA1','','Cubierta','paused',?,datetime('now'))`).run(JSON.stringify(attrs({ BRAND: 'Pirelli', WHEEL_SIZE: '700c' })));
    id = db.prepare(`INSERT INTO ml_publicacion_cambios (clave,item_id,campo,valor_anterior,valor_nuevo,detectado_en)
      VALUES ('MLA1|','MLA1','catalog_product_id','MLA_OLD','MLA_NEW',datetime('now'))`).run().lastInsertRowid;
    app = express(); app.use(express.json()); app.use('/api/sync', syncRouter(db, { ml: { userId: '1' } }));
  });
  afterEach(() => { db.close(); if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB); });
  const get = () => request(app).get(`/api/sync/cambios-formato/${id}/comparacion`);

  it('marca borrado (404) sin link, y el nuevo activo con link', async () => {
    mlFetch.mockImplementation(async (_d, _c, _m, ruta) => ruta.endsWith('MLA_OLD') ? { status: 404 }
      : { status: 200, data: { name: 'Nuevo', status: 'active', attributes: attrs({ BRAND: 'Pirelli', WHEEL_SIZE: '700c' }) } });
    const r = (await get()).body;
    expect(r.viejo).toMatchObject({ borrado: true, link: null });
    expect(r.nuevo.link).toBe('https://www.mercadolibre.com.ar/p/MLA_NEW');
    expect(r.veredicto).toBe('coincide');
  });

  it('producto inactivo no tiene link y las diferencias marcan no coincide', async () => {
    mlFetch.mockImplementation(async (_d, _c, _m, ruta) => ruta.endsWith('MLA_OLD')
      ? { status: 200, data: { name: 'Viejo', status: 'inactive', attributes: attrs({ BRAND: 'Pirelli', WHEEL_SIZE: '700c' }) } }
      : { status: 200, data: { name: 'Nuevo', status: 'inactive', attributes: attrs({ BRAND: 'Pirelli', WHEEL_SIZE: '29' }) } });
    const r = (await get()).body;
    expect(r.viejo.link).toBeNull(); expect(r.nuevo.link).toBeNull();
    expect(r.diferencias).toEqual([expect.objectContaining({ atributo: 'WHEEL_SIZE', viejo: '700c', nuevo: '29', publicacion: '700c', coincide_nuevo: false })]);
    expect(r.veredicto).toBe('no_coincide');
  });

  it('cachea: la segunda apertura no llama a ML', async () => {
    mlFetch.mockResolvedValue({ status: 200, data: { name: 'x', status: 'active', attributes: [] } });
    await get(); const n = mlFetch.mock.calls.length; await get();
    expect(n).toBe(2); expect(mlFetch.mock.calls.length).toBe(2);
  });

  it('un 429 no se cachea ni se toma por borrado', async () => {
    mlFetch.mockResolvedValue({ status: 429 });
    expect((await get()).body.ok).toBe(false);
    expect(db.prepare('SELECT COUNT(*) n FROM ml_productos_cache').get().n).toBe(0);
  });
});
