import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import express from 'express';
import request from 'supertest';
import { openDb } from '../db/index.js';
import { consultaPreciosRouter, pareceEan } from '../routes/consultaPrecios.js';

const TEST_DB = './test/tmp-consulta-precios.sqlite';

function appConDatos() {
  const db = openDb(TEST_DB);
  const now = new Date().toISOString();
  db.prepare(
    'INSERT INTO catalogo_cache (id_woo, nombre, sku, tipo, stock, categorias_json, img, precio, marca, actualizado_en) VALUES (?,?,?,?,?,?,?,?,?,?)'
  ).run(1, 'Cinta SUPACAZ Bling', 'FB-40', 'simple', 3, '["CINTAS Y PUÑOS"]', 'https://x/a.jpg', 15000, 'SUPACAZ', now);
  db.prepare('INSERT INTO ean_sku (ean, sku, actualizado_en) VALUES (?,?,?)').run('7791234567890', 'FB-40', now);
  const app = express();
  app.use(express.json());
  app.use('/api/consulta-precios', consultaPreciosRouter(db));
  return { app, db };
}

describe('pareceEan', () => {
  it('acepta 8/12/13/14 dígitos', () => {
    expect(pareceEan('12345678')).toBe(true);
    expect(pareceEan('7791234567890')).toBe(true);
    expect(pareceEan('12345678901234')).toBe(true);
  });
  it('rechaza con letras, guiones o largo no-EAN', () => {
    expect(pareceEan('FB-40')).toBe(false);
    expect(pareceEan('123')).toBe(false);
    expect(pareceEan('7791234567890123456')).toBe(false);
  });
});

describe('GET /api/consulta-precios/buscar', () => {
  afterEach(() => { if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB); });

  it('encuentra por SKU', async () => {
    const { app, db } = appConDatos();
    const res = await request(app).get('/api/consulta-precios/buscar?q=FB-40');
    expect(res.status).toBe(200);
    expect(res.body.found).toBe(true);
    expect(res.body.tipo).toBe('sku');
    expect(res.body.producto).toMatchObject({
      sku: 'FB-40', nombre: 'Cinta SUPACAZ Bling', marca: 'SUPACAZ',
      categorias: ['CINTAS Y PUÑOS'], precio: 15000, stock: 3, img: 'https://x/a.jpg',
    });
    db.close();
  });

  it('encuentra por EAN conocido', async () => {
    const { app, db } = appConDatos();
    const res = await request(app).get('/api/consulta-precios/buscar?q=7791234567890');
    expect(res.body.found).toBe(true);
    expect(res.body.tipo).toBe('ean');
    expect(res.body.producto.sku).toBe('FB-40');
    db.close();
  });

  it('EAN desconocido que parece EAN → needsSku', async () => {
    const { app, db } = appConDatos();
    const res = await request(app).get('/api/consulta-precios/buscar?q=7790000000000');
    expect(res.body.found).toBe(false);
    expect(res.body.needsSku).toBe(true);
    expect(res.body.ean).toBe('7790000000000');
    db.close();
  });

  it('EAN conocido cuyo SKU ya no está → skuHuerfano', async () => {
    const { app, db } = appConDatos();
    const now = new Date().toISOString();
    db.prepare('INSERT INTO ean_sku (ean, sku, actualizado_en) VALUES (?,?,?)').run('7799999999999', 'FB-BORRADO', now);
    const res = await request(app).get('/api/consulta-precios/buscar?q=7799999999999');
    expect(res.body.found).toBe(false);
    expect(res.body.skuHuerfano).toBe('FB-BORRADO');
    db.close();
  });

  it('basura → found:false sin needsSku', async () => {
    const { app, db } = appConDatos();
    const res = await request(app).get('/api/consulta-precios/buscar?q=XYZ-NADA');
    expect(res.body.found).toBe(false);
    expect(res.body.needsSku).toBeFalsy();
    db.close();
  });

  it('q vacía → found:false', async () => {
    const { app, db } = appConDatos();
    const res = await request(app).get('/api/consulta-precios/buscar?q=');
    expect(res.status).toBe(200);
    expect(res.body.found).toBe(false);
    db.close();
  });
});

describe('POST /api/consulta-precios/ean', () => {
  afterEach(() => { if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB); });

  it('rechaza SKU inexistente con 400', async () => {
    const { app, db } = appConDatos();
    const res = await request(app).post('/api/consulta-precios/ean').send({ ean: '7000000000001', sku: 'NO-EXISTE' });
    expect(res.status).toBe(400);
    db.close();
  });

  it('enseña un EAN nuevo y devuelve el producto', async () => {
    const { app, db } = appConDatos();
    const res = await request(app).post('/api/consulta-precios/ean').send({ ean: '7000000000001', sku: 'FB-40' });
    expect(res.status).toBe(200);
    expect(res.body.producto.sku).toBe('FB-40');
    const guardado = db.prepare('SELECT sku FROM ean_sku WHERE ean = ?').get('7000000000001');
    expect(guardado.sku).toBe('FB-40');
    db.close();
  });

  it('re-enseñar el mismo EAN sobreescribe el SKU (upsert)', async () => {
    const { app, db } = appConDatos();
    const now = new Date().toISOString();
    // segundo producto para reasignar
    db.prepare('INSERT INTO catalogo_cache (id_woo, nombre, sku, tipo, stock, precio, actualizado_en) VALUES (?,?,?,?,?,?,?)')
      .run(2, 'Otro producto', 'FB-99', 'simple', 1, 100, now);
    await request(app).post('/api/consulta-precios/ean').send({ ean: '7791234567890', sku: 'FB-99' });
    const guardado = db.prepare('SELECT sku FROM ean_sku WHERE ean = ?').get('7791234567890');
    expect(guardado.sku).toBe('FB-99');
    db.close();
  });
});

describe('POST /api/consulta-precios/importar', () => {
  afterEach(() => { if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB); });

  it('importa pares válidos e ignora incompletos', async () => {
    const { app, db } = appConDatos();
    const res = await request(app).post('/api/consulta-precios/importar').send({
      pares: [
        { ean: '7000000000002', sku: 'FB-40' },
        { ean: '', sku: 'FB-40' },
        { ean: '7000000000003', sku: '' },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.recibidos).toBe(3);
    expect(res.body.importados).toBe(1);
    db.close();
  });
});

describe('GET /api/consulta-precios/buscar-sku', () => {
  afterEach(() => { if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB); });

  it('autocompleta por sku o nombre', async () => {
    const { app, db } = appConDatos();
    const res = await request(app).get('/api/consulta-precios/buscar-sku?q=supacaz');
    expect(res.body.data.some(r => r.sku === 'FB-40')).toBe(true);
    db.close();
  });
});
