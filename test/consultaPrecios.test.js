import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'fs';
import express from 'express';
import request from 'supertest';
import axios from 'axios';
import { openDb } from '../db/index.js';
import { consultaPreciosRouter, pareceEan } from '../routes/consultaPrecios.js';

vi.mock('axios');

const TEST_DB = './test/tmp-consulta-precios.sqlite';

const CFG = { url: 'https://fusionbikes.com.ar', ck: 'ck_x', cs: 'cs_x' };

function appConDatos(cfg = {}) {
  const db = openDb(TEST_DB);
  const now = new Date().toISOString();
  db.prepare(
    'INSERT INTO catalogo_cache (id_woo, nombre, sku, tipo, stock, categorias_json, img, precio, marca, actualizado_en) VALUES (?,?,?,?,?,?,?,?,?,?)'
  ).run(1, 'Cinta SUPACAZ Bling', 'FB-40', 'simple', 3, '["CINTAS Y PUÑOS"]', 'https://x/a.jpg', 15000, 'SUPACAZ', now);
  db.prepare('INSERT INTO ean_sku (ean, sku, actualizado_en) VALUES (?,?,?)').run('7791234567890', 'FB-40', now);
  const app = express();
  app.use(express.json());
  app.use('/api/consulta-precios', consultaPreciosRouter(db, cfg));
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
      // precio de CONTADO = 2/3 del de lista (15000) → 10000, no el precio de lista.
      categorias: ['CINTAS Y PUÑOS'], precio: 10000, stock: 3, img: 'https://x/a.jpg',
    });
    db.close();
  });

  it('precio null en catalogo_cache → producto.precio null (no rompe)', async () => {
    const { app, db } = appConDatos();
    const now = new Date().toISOString();
    db.prepare('INSERT INTO catalogo_cache (id_woo, nombre, sku, tipo, stock, precio, actualizado_en) VALUES (?,?,?,?,?,?,?)')
      .run(3, 'Producto sin precio', 'FB-SINPRECIO', 'simple', 5, null, now);
    const res = await request(app).get('/api/consulta-precios/buscar?q=FB-SINPRECIO');
    expect(res.status).toBe(200);
    expect(res.body.found).toBe(true);
    expect(res.body.producto.precio).toBe(null);
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
  afterEach(() => { if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB); vi.resetAllMocks(); });

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

  it('re-enseñar el mismo EAN con pisar_mapa=true sobreescribe el SKU (upsert)', async () => {
    const { app, db } = appConDatos();
    const now = new Date().toISOString();
    // segundo producto para reasignar
    db.prepare('INSERT INTO catalogo_cache (id_woo, nombre, sku, tipo, stock, precio, actualizado_en) VALUES (?,?,?,?,?,?,?)')
      .run(2, 'Otro producto', 'FB-99', 'simple', 1, 100, now);
    // Reasignar EAN 7791234567890 de FB-40 a FB-99 con pisar_mapa=true
    await request(app).post('/api/consulta-precios/ean').send({ ean: '7791234567890', sku: 'FB-99', pisar_mapa: true });
    const guardado = db.prepare('SELECT sku FROM ean_sku WHERE ean = ?').get('7791234567890');
    expect(guardado.sku).toBe('FB-99');
    db.close();
  });

  it('SKU homónimo: no elige una fila arbitraria al enseñar sin id_woo', async () => {
    const { app, db } = appConDatos();
    db.prepare('INSERT INTO catalogo_cache (id_woo,nombre,sku,tipo,stock,precio,actualizado_en) VALUES (?,?,?,?,?,?,?)')
      .run(2, 'Otra variante', 'FB-40', 'simple', 1, 100, new Date().toISOString());
    const res = await request(app).post('/api/consulta-precios/ean')
      .send({ ean: '7000000000002', sku: 'FB-40' });
    expect(res.status).toBe(400);
    expect(res.body.codigo).toBe('sku_ambiguo');
    expect(db.prepare('SELECT 1 FROM ean_sku WHERE ean=?').get('7000000000002')).toBeUndefined();
    db.close();
  });

  it('rechaza id_woo no entero con 400', async () => {
    const { app, db } = appConDatos();
    const res = await request(app).post('/api/consulta-precios/ean')
      .send({ ean: '7000000000002', sku: 'FB-40', id_woo: 'abc' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('id_woo debe ser un número entero');
    db.close();
  });

  it('rechaza id_woo inexistente con 400 específico', async () => {
    const { app, db } = appConDatos();
    const res = await request(app).post('/api/consulta-precios/ean')
      .send({ ean: '7000000000003', sku: 'FB-40', id_woo: 999 });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('id_woo 999 no existe');
    db.close();
  });

  it('rechaza fila con sku vacío resolvida por id_woo con 400', async () => {
    const { app, db } = appConDatos();
    const now = new Date().toISOString();
    // Insertar fila con SKU vacío (caso real del hallazgo)
    db.prepare('INSERT INTO catalogo_cache (id_woo,nombre,sku,tipo,stock,precio,actualizado_en) VALUES (?,?,?,?,?,?,?)')
      .run(99, 'Producto sin SKU', '', 'simple', 1, 100, now);
    const res = await request(app).post('/api/consulta-precios/ean')
      .send({ ean: '7000000000004', sku: 'FB-40', id_woo: 99 });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('id_woo 99 no existe o no tiene SKU asignado');
    db.close();
  });

  it('Fix 1: rechaza sku↔id_woo incoherentes con 400 sku_id_woo_incoherente', async () => {
    const { app, db } = appConDatos();
    const now = new Date().toISOString();
    // Crear segundo producto con SKU distinto
    db.prepare('INSERT INTO catalogo_cache (id_woo,nombre,sku,tipo,stock,precio,actualizado_en) VALUES (?,?,?,?,?,?,?)')
      .run(2, 'Otro producto', 'FB-99', 'simple', 1, 100, now);
    // Intentar enseñar EAN con sku=FB-40 pero id_woo=2 (que tiene sku=FB-99)
    const res = await request(app).post('/api/consulta-precios/ean')
      .send({ ean: '7000000000005', sku: 'FB-40', id_woo: 2 });
    expect(res.status).toBe(400);
    expect(res.body.codigo).toBe('sku_id_woo_incoherente');
    expect(res.body.error).toContain('No coinciden');
    // Verificar que NO se guardó nada
    expect(db.prepare('SELECT 1 FROM ean_sku WHERE ean=?').get('7000000000005')).toBeUndefined();
    db.close();
  });

  it('Fix 2: rechaza id_woo boolean con 400', async () => {
    const { app, db } = appConDatos();
    const res = await request(app).post('/api/consulta-precios/ean')
      .send({ ean: '7000000000006', sku: 'FB-40', id_woo: true });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('id_woo debe ser un número entero');
    db.close();
  });

  it('Fix 2: rechaza id_woo array con 400', async () => {
    const { app, db } = appConDatos();
    const res = await request(app).post('/api/consulta-precios/ean')
      .send({ ean: '7000000000007', sku: 'FB-40', id_woo: [1] });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('id_woo debe ser un número entero');
    db.close();
  });

  it('Fix 3: conflicto_mapa cuando EAN ya estaba mapeado a otro SKU', async () => {
    const { app, db } = appConDatos();
    const now = new Date().toISOString();
    // Segundo producto
    db.prepare('INSERT INTO catalogo_cache (id_woo,nombre,sku,tipo,stock,precio,actualizado_en) VALUES (?,?,?,?,?,?,?)')
      .run(2, 'Otro producto', 'FB-99', 'simple', 1, 100, now);
    // Primer mapeo: EAN → FB-40
    db.prepare('INSERT INTO ean_sku (ean, sku, actualizado_en) VALUES (?,?,?)').run('7000000000008', 'FB-40', now);
    // Intentar reasignar el mismo EAN a FB-99 sin pisar_mapa
    const res = await request(app).post('/api/consulta-precios/ean')
      .send({ ean: '7000000000008', sku: 'FB-99' });
    expect(res.status).toBe(200);
    expect(res.body.codigo).toMatchObject({ estado: 'conflicto_mapa', sku_actual: 'FB-40' });
    // Verificar que NO se cambió el mapa
    expect(db.prepare('SELECT sku FROM ean_sku WHERE ean=?').get('7000000000008').sku).toBe('FB-40');
    db.close();
  });

  it('Fix 3: pisar_mapa=true reemplaza el mapa antiguo', async () => {
    const { app, db } = appConDatos();
    const now = new Date().toISOString();
    // Segundo producto
    db.prepare('INSERT INTO catalogo_cache (id_woo,nombre,sku,tipo,stock,precio,actualizado_en) VALUES (?,?,?,?,?,?,?)')
      .run(2, 'Otro producto', 'FB-99', 'simple', 1, 100, now);
    // Primer mapeo: EAN → FB-40
    db.prepare('INSERT INTO ean_sku (ean, sku, actualizado_en) VALUES (?,?,?)').run('7000000000009', 'FB-40', now);
    // Reasignar con pisar_mapa=true
    const res = await request(app).post('/api/consulta-precios/ean')
      .send({ ean: '7000000000009', sku: 'FB-99', pisar_mapa: true });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    // Verificar que SÍ cambió el mapa
    expect(db.prepare('SELECT sku FROM ean_sku WHERE ean=?').get('7000000000009').sku).toBe('FB-99');
    db.close();
  });
});

describe('POST /api/consulta-precios/asociar — subida opcional a Woo', () => {
  afterEach(() => { if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB); vi.resetAllMocks(); });

  it('GTIN válido sin código: sube a Woo, actualiza cache y conserva el mapa EAN', async () => {
    const { app, db } = appConDatos(CFG);
    axios.request.mockResolvedValueOnce({ status: 200, data: {}, headers: {} });
    const res = await request(app).post('/api/consulta-precios/asociar')
      .send({ ean: '7791234567898', sku: 'FB-40' });
    expect(res.status).toBe(200);
    expect(res.body.codigo).toMatchObject({ estado: 'subido', gtin: '7791234567898' });
    expect(axios.request).toHaveBeenCalledWith(expect.objectContaining({
      url: 'https://fusionbikes.com.ar/wp-json/wc/v3/products/1', method: 'patch',
      data: { global_unique_id: '7791234567898' },
    }));
    expect(db.prepare('SELECT gtin FROM catalogo_cache WHERE id_woo=1').get().gtin).toBe('7791234567898');
    expect(db.prepare('SELECT sku FROM ean_sku WHERE ean=?').get('7791234567898').sku).toBe('FB-40');
    db.close();
  });

  it('código no válido: enseña localmente y nunca llama a Woo', async () => {
    const { app, db } = appConDatos(CFG);
    const res = await request(app).post('/api/consulta-precios/asociar')
      .send({ ean: '7791234567890', sku: 'FB-40' });
    expect(res.body.codigo.estado).toBe('no_valido');
    expect(axios.request).not.toHaveBeenCalled();
    expect(db.prepare('SELECT sku FROM ean_sku WHERE ean=?').get('7791234567890').sku).toBe('FB-40');
    db.close();
  });

  it('otro GTIN existente: devuelve conflicto sin escribir ni mapear', async () => {
    const { app, db } = appConDatos(CFG);
    db.prepare('UPDATE catalogo_cache SET gtin=? WHERE id_woo=1').run('7791234500001');
    const res = await request(app).post('/api/consulta-precios/asociar')
      .send({ ean: '7791234567898', sku: 'FB-40' });
    expect(res.body.codigo).toMatchObject({ estado: 'conflicto', gtin_actual: '7791234500001' });
    expect(axios.request).not.toHaveBeenCalled();
    expect(db.prepare('SELECT sku FROM ean_sku WHERE ean=?').get('7791234567898')).toBeUndefined();
    db.close();
  });

  it('pisar_codigo explícito: reemplaza en Woo y limpia el mapa del código anterior', async () => {
    const { app, db } = appConDatos(CFG);
    db.prepare('UPDATE catalogo_cache SET gtin=? WHERE id_woo=1').run('7791234500001');
    db.prepare('INSERT INTO ean_sku (ean, sku, actualizado_en) VALUES (?,?,?)').run('7791234500001', 'FB-40', new Date().toISOString());
    axios.request.mockResolvedValueOnce({ status: 200, data: {}, headers: {} });
    const res = await request(app).post('/api/consulta-precios/asociar')
      .send({ ean: '7791234567898', sku: 'FB-40', pisar_codigo: true });
    expect(res.body.codigo.estado).toBe('subido');
    expect(db.prepare('SELECT gtin FROM catalogo_cache WHERE id_woo=1').get().gtin).toBe('7791234567898');
    expect(db.prepare('SELECT 1 FROM ean_sku WHERE ean=?').get('7791234500001')).toBeUndefined();
    db.close();
  });

  it('Woo falla: conserva la asociación local y no finge actualizar el cache', async () => {
    const { app, db } = appConDatos(CFG);
    axios.request.mockRejectedValueOnce(new Error('ECONNRESET'));
    const res = await request(app).post('/api/consulta-precios/asociar')
      .send({ ean: '7791234567898', sku: 'FB-40' });
    expect(res.body.codigo).toMatchObject({ estado: 'fallo', motivo: 'woo' });
    expect(db.prepare('SELECT gtin FROM catalogo_cache WHERE id_woo=1').get().gtin).toBeNull();
    expect(db.prepare('SELECT sku FROM ean_sku WHERE ean=?').get('7791234567898').sku).toBe('FB-40');
    db.close();
  });

  it('SKU homónimo: exige id_woo y no llama a Woo', async () => {
    const { app, db } = appConDatos(CFG);
    db.prepare('INSERT INTO catalogo_cache (id_woo,nombre,sku,tipo,stock,precio,actualizado_en) VALUES (?,?,?,?,?,?,?)')
      .run(2, 'Otra variante', 'FB-40', 'simple', 1, 100, new Date().toISOString());
    const res = await request(app).post('/api/consulta-precios/asociar')
      .send({ ean: '7791234567898', sku: 'FB-40' });
    expect(res.status).toBe(400);
    expect(res.body.codigo).toBe('sku_ambiguo');
    expect(axios.request).not.toHaveBeenCalled();
    db.close();
  });

  it('rechaza id_woo no entero con 400', async () => {
    const { app, db } = appConDatos(CFG);
    const res = await request(app).post('/api/consulta-precios/asociar')
      .send({ ean: '7791234567898', sku: 'FB-40', id_woo: '1.5' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('id_woo debe ser un número entero');
    expect(axios.request).not.toHaveBeenCalled();
    db.close();
  });

  it('rechaza id_woo inexistente con 400 específico', async () => {
    const { app, db } = appConDatos(CFG);
    const res = await request(app).post('/api/consulta-precios/asociar')
      .send({ ean: '7791234567898', sku: 'FB-40', id_woo: 999 });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('id_woo 999 no existe');
    expect(axios.request).not.toHaveBeenCalled();
    db.close();
  });

  it('rechaza fila con sku vacío resolvida por id_woo con 400', async () => {
    const { app, db } = appConDatos(CFG);
    const now = new Date().toISOString();
    // Insertar fila con SKU vacío (caso real del hallazgo)
    db.prepare('INSERT INTO catalogo_cache (id_woo,nombre,sku,tipo,stock,precio,actualizado_en) VALUES (?,?,?,?,?,?,?)')
      .run(99, 'Producto sin SKU', '', 'simple', 1, 100, now);
    const res = await request(app).post('/api/consulta-precios/asociar')
      .send({ ean: '7791234567898', sku: 'FB-40', id_woo: 99 });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('id_woo 99 no existe o no tiene SKU asignado');
    expect(axios.request).not.toHaveBeenCalled();
    db.close();
  });

  it('Fix 1: rechaza sku↔id_woo incoherentes en /asociar con 400 sku_id_woo_incoherente', async () => {
    const { app, db } = appConDatos(CFG);
    const now = new Date().toISOString();
    // Crear segundo producto con SKU distinto
    db.prepare('INSERT INTO catalogo_cache (id_woo,nombre,sku,tipo,stock,precio,actualizado_en) VALUES (?,?,?,?,?,?,?)')
      .run(2, 'Otro producto', 'FB-99', 'simple', 1, 100, now);
    // Intentar asociar GTIN con sku=FB-40 pero id_woo=2 (que tiene sku=FB-99)
    const res = await request(app).post('/api/consulta-precios/asociar')
      .send({ ean: '7791234567800', sku: 'FB-40', id_woo: 2 });
    expect(res.status).toBe(400);
    expect(res.body.codigo).toBe('sku_id_woo_incoherente');
    expect(res.body.error).toContain('No coinciden');
    expect(axios.request).not.toHaveBeenCalled();
    expect(db.prepare('SELECT 1 FROM ean_sku WHERE ean=?').get('7791234567800')).toBeUndefined();
    db.close();
  });

  it('Fix 2: rechaza id_woo boolean en /asociar con 400', async () => {
    const { app, db } = appConDatos(CFG);
    const res = await request(app).post('/api/consulta-precios/asociar')
      .send({ ean: '7791234567801', sku: 'FB-40', id_woo: false });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('id_woo debe ser un número entero');
    expect(axios.request).not.toHaveBeenCalled();
    db.close();
  });

  it('Fix 2: rechaza id_woo array en /asociar con 400', async () => {
    const { app, db } = appConDatos(CFG);
    const res = await request(app).post('/api/consulta-precios/asociar')
      .send({ ean: '7791234567802', sku: 'FB-40', id_woo: [99] });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('id_woo debe ser un número entero');
    expect(axios.request).not.toHaveBeenCalled();
    db.close();
  });

  it('Fix 3: conflicto_mapa en /asociar cuando GTIN es no-válido y EAN estaba mapeado a otro SKU', async () => {
    const { app, db } = appConDatos(CFG);
    const now = new Date().toISOString();
    // Segundo producto
    db.prepare('INSERT INTO catalogo_cache (id_woo,nombre,sku,tipo,stock,precio,actualizado_en) VALUES (?,?,?,?,?,?,?)')
      .run(2, 'Otro producto', 'FB-99', 'simple', 1, 100, now);
    // Primer mapeo: EAN no-válido → FB-40
    db.prepare('INSERT INTO ean_sku (ean, sku, actualizado_en) VALUES (?,?,?)').run('7791234500010', 'FB-40', now);
    // Intentar reasignar a FB-99 sin pisar_mapa
    const res = await request(app).post('/api/consulta-precios/asociar')
      .send({ ean: '7791234500010', sku: 'FB-99' });
    expect(res.status).toBe(200);
    expect(res.body.codigo).toMatchObject({ estado: 'conflicto_mapa', sku_actual: 'FB-40' });
    expect(axios.request).not.toHaveBeenCalled();
    expect(db.prepare('SELECT sku FROM ean_sku WHERE ean=?').get('7791234500010').sku).toBe('FB-40');
    db.close();
  });

  it('Fix 3: pisar_mapa=true en /asociar reemplaza el mapa antiguo', async () => {
    const { app, db } = appConDatos(CFG);
    const now = new Date().toISOString();
    // Segundo producto
    db.prepare('INSERT INTO catalogo_cache (id_woo,nombre,sku,tipo,stock,precio,actualizado_en) VALUES (?,?,?,?,?,?,?)')
      .run(2, 'Otro producto', 'FB-99', 'simple', 1, 100, now);
    // Primer mapeo: EAN no-válido → FB-40
    db.prepare('INSERT INTO ean_sku (ean, sku, actualizado_en) VALUES (?,?,?)').run('7791234500009', 'FB-40', now);
    // Reasignar con pisar_mapa=true
    const res = await request(app).post('/api/consulta-precios/asociar')
      .send({ ean: '7791234500009', sku: 'FB-99', pisar_mapa: true });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(axios.request).not.toHaveBeenCalled();
    expect(db.prepare('SELECT sku FROM ean_sku WHERE ean=?').get('7791234500009').sku).toBe('FB-99');
    db.close();
  });

  it('HIGH FIX: conflicto_mapa con Woo exitoso — no pisa el mapa sin pisar_mapa:true', async () => {
    const { app, db } = appConDatos(CFG);
    const now = new Date().toISOString();
    // Segundo producto
    db.prepare('INSERT INTO catalogo_cache (id_woo,nombre,sku,tipo,stock,precio,actualizado_en) VALUES (?,?,?,?,?,?,?)')
      .run(2, 'Otro producto', 'FB-99', 'simple', 1, 100, now);
    // Primer mapeo: EAN → FB-99
    db.prepare('INSERT INTO ean_sku (ean, sku, actualizado_en) VALUES (?,?,?)').run('7791234567898', 'FB-99', now);
    // Intentar asociar ese EAN (GTIN válido) a FB-40 (que sube bien a Woo)
    axios.request.mockResolvedValueOnce({ status: 200, data: {}, headers: {} });
    const res = await request(app).post('/api/consulta-precios/asociar')
      .send({ ean: '7791234567898', sku: 'FB-40' });
    expect(res.status).toBe(200);
    // El conflicto de mapa debe detectarse ANTES de Woo, así que no lo llamamos
    expect(axios.request).not.toHaveBeenCalled();
    expect(res.body.codigo).toMatchObject({ estado: 'conflicto_mapa', sku_actual: 'FB-99' });
    // Verificar que el mapa NO cambió
    expect(db.prepare('SELECT sku FROM ean_sku WHERE ean=?').get('7791234567898').sku).toBe('FB-99');
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

  it('"%" y "_" se buscan como texto literal, no como comodín que matchea todo', async () => {
    const { app, db } = appConDatos();
    const porcentaje = await request(app).get('/api/consulta-precios/buscar-sku?q=%');
    expect(porcentaje.body.data).toEqual([]);
    const guionBajo = await request(app).get('/api/consulta-precios/buscar-sku?q=_');
    expect(guionBajo.body.data).toEqual([]);
    db.close();
  });
});
