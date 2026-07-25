import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'fs';
import express from 'express';
import request from 'supertest';
import { openDb } from '../db/index.js';
import { inventarioRouter, looksLikeEan } from '../routes/inventario.js';

vi.mock('../lib/wooStock.js', async () => {
  const actual = await vi.importActual('../lib/wooStock.js');
  return { ...actual, setStockWc: vi.fn() };
});
import { setStockWc } from '../lib/wooStock.js';

const TEST_DB = './test/tmp-inventario.sqlite';
const CFG = { url: 'https://fusionbikes.com.ar', ck: 'ck_x', cs: 'cs_x' };
const now = () => new Date().toISOString();

function buildApp(db, usuario = 'operario1') {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { username: usuario, is_admin: 0 }; next(); });
  app.use('/api/inventario', inventarioRouter(db, CFG));
  return app;
}

function insertProducto(db, extra) {
  const base = {
    id_woo: 1, nombre: 'Producto', sku: 'FB-1', tipo: 'simple', id_padre: null,
    stock: 5, categorias_json: null, img: null, precio: null, atributos_json: null,
    marca: null, gtin: null, actualizado_en: now(),
  };
  const row = { ...base, ...extra };
  db.prepare(`
    INSERT INTO catalogo_cache
      (id_woo, nombre, sku, tipo, id_padre, stock, categorias_json, img, precio, atributos_json, marca, gtin, actualizado_en)
    VALUES
      (@id_woo, @nombre, @sku, @tipo, @id_padre, @stock, @categorias_json, @img, @precio, @atributos_json, @marca, @gtin, @actualizado_en)
  `).run(row);
  return row;
}

describe('looksLikeEan', () => {
  it('reconoce un EAN-13 válido (checksum GS1 correcto)', () => {
    // Dígito de control calculado a mano con el algoritmo de gtinCheckOk para
    // los primeros 12 dígitos "779123456789" (pesos 3/1 alternados desde la
    // derecha): suma ponderada = 132 → check = (10 - 132%10) % 10 = 8.
    // Por eso el código de test es 7791234567898 (no ...5 como en el brief original).
    expect(looksLikeEan('7791234567898')).toBe(true);
  });
  it('rechaza un código con checksum inválido', () => {
    expect(looksLikeEan('7791234567890')).toBe(false);
  });
  it('rechaza un SKU alfanumérico', () => {
    expect(looksLikeEan('FB-123')).toBe(false);
  });
  it('rechaza longitudes no válidas de EAN (ni 8/12/13/14 dígitos)', () => {
    expect(looksLikeEan('12345')).toBe(false);
  });

  // El algoritmo alterna el peso 3/1 según la paridad de la posición contada desde
  // la derecha — con solo un caso de 13 dígitos cubierto no queda probado que la
  // paridad se calcule bien quie para longitudes 8/12/14 (donde el punto de partida
  // de la alternancia cae distinto). Checksums verificados a mano con el mismo
  // algoritmo de gtinCheckOk.
  it('reconoce un EAN-8 válido (checksum GS1 correcto)', () => {
    expect(looksLikeEan('96385074')).toBe(true);
  });
  it('rechaza un EAN-8 con checksum inválido', () => {
    expect(looksLikeEan('96385070')).toBe(false);
  });
  it('reconoce un UPC-A / EAN-12 válido (checksum GS1 correcto)', () => {
    expect(looksLikeEan('036000291452')).toBe(true);
  });
  it('reconoce un EAN-14 (GTIN-14) válido (checksum GS1 correcto)', () => {
    expect(looksLikeEan('07791234567898')).toBe(true);
  });
  it('rechaza un EAN-14 con checksum inválido', () => {
    expect(looksLikeEan('07791234567890')).toBe(false);
  });
});

describe('GET /api/inventario/alcance-opciones', () => {
  afterEach(() => { if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB); });

  it('devuelve categorías y marcas distintas de catalogo_cache, sin duplicados', async () => {
    const db = openDb(TEST_DB);
    insertProducto(db, { id_woo: 1, sku: 'FB-1', marca: 'Bell', categorias_json: '["Cascos"]' });
    insertProducto(db, { id_woo: 2, sku: 'FB-2', marca: 'Bell', categorias_json: '["Cascos","Accesorios"]' });
    insertProducto(db, { id_woo: 3, sku: 'FB-3', marca: 'Continental', categorias_json: '["Cubiertas"]' });

    const res = await request(buildApp(db)).get('/api/inventario/alcance-opciones');

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.marcas.sort()).toEqual(['Bell', 'Continental']);
    expect(res.body.categorias.sort()).toEqual(['Accesorios', 'Cascos', 'Cubiertas']);
  });
});

describe('GET /api/inventario/sesion-activa', () => {
  afterEach(() => { if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB); });

  it('devuelve null si el usuario no tiene sesión abierta', async () => {
    const db = openDb(TEST_DB);
    const res = await request(buildApp(db)).get('/api/inventario/sesion-activa');
    expect(res.status).toBe(200);
    expect(res.body.sesion).toBeNull();
  });

  it('devuelve la sesión abierta propia, no la de otro usuario', async () => {
    const db = openDb(TEST_DB);
    db.prepare(`CREATE TABLE IF NOT EXISTS inventario_sesiones (
      id INTEGER PRIMARY KEY AUTOINCREMENT, usuario TEXT NOT NULL, categoria TEXT, marca TEXT,
      estado TEXT NOT NULL DEFAULT 'abierta', creado_en TEXT NOT NULL, confirmado_en TEXT)`).run();
    db.prepare("INSERT INTO inventario_sesiones (usuario, marca, estado, creado_en) VALUES ('otro_operario','Bell','abierta',?)").run(now());
    db.prepare("INSERT INTO inventario_sesiones (usuario, marca, estado, creado_en) VALUES ('operario1','Continental','abierta',?)").run(now());

    const res = await request(buildApp(db, 'operario1')).get('/api/inventario/sesion-activa');

    expect(res.status).toBe(200);
    expect(res.body.sesion).toBeTruthy();
    expect(res.body.sesion.marca).toBe('Continental');
  });
});

describe('POST /api/inventario/sesiones', () => {
  afterEach(() => { if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB); });

  it('crea una sesión con el alcance elegido', async () => {
    const db = openDb(TEST_DB);
    const res = await request(buildApp(db)).post('/api/inventario/sesiones').send({ marca: 'Bell' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.sesion.marca).toBe('Bell');
    expect(res.body.sesion.estado).toBe('abierta');
  });

  it('rechaza sin categoría ni marca (alcance obligatorio)', async () => {
    const db = openDb(TEST_DB);
    const res = await request(buildApp(db)).post('/api/inventario/sesiones').send({});
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });

  it('rechaza con 409 si otra sesión abierta ya cubre la misma marca, mostrando el dueño', async () => {
    const db = openDb(TEST_DB);
    insertProducto(db, { id_woo: 1, sku: 'FB-1', marca: 'Bell' });
    await request(buildApp(db, 'juan')).post('/api/inventario/sesiones').send({ marca: 'Bell' });

    const res = await request(buildApp(db, 'ana')).post('/api/inventario/sesiones').send({ marca: 'Bell' });

    expect(res.status).toBe(409);
    expect(res.body.ok).toBe(false);
    expect(res.body.ocupada_por).toBe('juan');
  });

  it('permite crear sesión con marca distinta aunque otra esté abierta', async () => {
    const db = openDb(TEST_DB);
    await request(buildApp(db, 'juan')).post('/api/inventario/sesiones').send({ marca: 'Bell' });

    const res = await request(buildApp(db, 'ana')).post('/api/inventario/sesiones').send({ marca: 'Continental' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('rechaza si el usuario ya tiene una sesión abierta propia', async () => {
    const db = openDb(TEST_DB);
    await request(buildApp(db, 'juan')).post('/api/inventario/sesiones').send({ marca: 'Bell' });

    const res = await request(buildApp(db, 'juan')).post('/api/inventario/sesiones').send({ marca: 'Continental' });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/ya ten[eé]s una sesión/i);
  });

  it('rechaza con 409 si el alcance de categoría se cruza aunque la otra sesión tenga también marca definida', async () => {
    const db = openDb(TEST_DB);
    insertProducto(db, { id_woo: 1, sku: 'FB-1', marca: 'Bell', categorias_json: '["Cascos"]' });
    await request(buildApp(db, 'juan')).post('/api/inventario/sesiones').send({ categoria: 'Cascos', marca: 'Bell' });

    const res = await request(buildApp(db, 'ana')).post('/api/inventario/sesiones').send({ categoria: 'Cascos' });

    expect(res.status).toBe(409);
    expect(res.body.ocupada_por).toBe('juan');
  });

  it('rechaza con 409 el caso cruzado: sesión por categoría vs. sesión por marca que comparten un producto real', async () => {
    const db = openDb(TEST_DB);
    // "Casco Bell": entra en el alcance de "categoria=Cascos" Y en el de "marca=Bell",
    // aunque ningún campo coincida literalmente entre las dos sesiones.
    insertProducto(db, { id_woo: 1, sku: 'FB-1', marca: 'Bell', categorias_json: '["Cascos"]' });
    await request(buildApp(db, 'juan')).post('/api/inventario/sesiones').send({ categoria: 'Cascos' });

    const res = await request(buildApp(db, 'ana')).post('/api/inventario/sesiones').send({ marca: 'Bell' });

    expect(res.status).toBe(409);
    expect(res.body.ocupada_por).toBe('juan');
  });

  it('permite alcances que no comparten ningún producto real, aunque suene similar', async () => {
    const db = openDb(TEST_DB);
    insertProducto(db, { id_woo: 1, sku: 'FB-1', marca: 'Bell', categorias_json: '["Cascos"]' });
    insertProducto(db, { id_woo: 2, sku: 'FB-2', marca: 'Continental', categorias_json: '["Cubiertas"]' });
    await request(buildApp(db, 'juan')).post('/api/inventario/sesiones').send({ categoria: 'Cascos' });

    const res = await request(buildApp(db, 'ana')).post('/api/inventario/sesiones').send({ marca: 'Continental' });

    expect(res.status).toBe(200);
  });
});

describe('GET /api/inventario/sesiones/:id', () => {
  afterEach(() => { if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB); });

  it('devuelve items contados + pendientes del alcance (comparado contra stock real)', async () => {
    const db = openDb(TEST_DB);
    insertProducto(db, { id_woo: 1, sku: 'FB-1', marca: 'Bell', stock: 10, nombre: 'Casco A' });
    insertProducto(db, { id_woo: 2, sku: 'FB-2', marca: 'Bell', stock: 4, nombre: 'Casco B' });

    const crear = await request(buildApp(db, 'juan')).post('/api/inventario/sesiones').send({ marca: 'Bell' });
    const sesionId = crear.body.sesion.id;
    db.prepare("INSERT INTO inventario_conteos (sesion_id, ean, sku, cantidad, actualizado_en) VALUES (?,?,?,?,?)")
      .run(sesionId, '1234567890128', 'FB-1', 7, now());

    const res = await request(buildApp(db, 'juan')).get(`/api/inventario/sesiones/${sesionId}`);

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).toMatchObject({ sku: 'FB-1', cantidad: 7, stock_woo: 10 });
    expect(res.body.pendientes).toHaveLength(1);
    expect(res.body.pendientes[0].sku).toBe('FB-2');
  });
});

describe('POST /api/inventario/sesiones/:id/escanear', () => {
  afterEach(() => { if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB); });

  async function crearSesion(db, usuario, body) {
    const r = await request(buildApp(db, usuario)).post('/api/inventario/sesiones').send(body);
    return r.body.sesion.id;
  }

  it('escanea un SKU directo: crea/incrementa la fila con ese sku', async () => {
    const db = openDb(TEST_DB);
    insertProducto(db, { id_woo: 1, sku: 'FB-1', marca: 'Bell' });
    const id = await crearSesion(db, 'juan', { marca: 'Bell' });

    const r1 = await request(buildApp(db, 'juan')).post(`/api/inventario/sesiones/${id}/escanear`).send({ codigo: 'FB-1' });
    expect(r1.body.item.sku).toBe('FB-1');
    expect(r1.body.item.cantidad).toBe(1);

    const r2 = await request(buildApp(db, 'juan')).post(`/api/inventario/sesiones/${id}/escanear`).send({ codigo: 'FB-1' });
    expect(r2.body.item.cantidad).toBe(2);
  });

  it('escanea un EAN conocido (en ean_sku): resuelve el sku automáticamente', async () => {
    const db = openDb(TEST_DB);
    insertProducto(db, { id_woo: 1, sku: 'FB-1', marca: 'Bell' });
    db.prepare('CREATE TABLE IF NOT EXISTS ean_sku (ean TEXT PRIMARY KEY, sku TEXT NOT NULL, actualizado_en TEXT NOT NULL)').run();
    db.prepare("INSERT INTO ean_sku (ean, sku, actualizado_en) VALUES ('1234567890128','FB-1',?)").run(now());
    const id = await crearSesion(db, 'juan', { marca: 'Bell' });

    const r = await request(buildApp(db, 'juan')).post(`/api/inventario/sesiones/${id}/escanear`).send({ codigo: '1234567890128' });

    expect(r.body.item.sku).toBe('FB-1');
    expect(r.body.item.ean).toBe('1234567890128');
  });

  it('escanea un EAN NO reconocido: crea fila con sku null (sin asociar)', async () => {
    const db = openDb(TEST_DB);
    const id = await crearSesion(db, 'juan', { marca: 'Bell' });

    const r = await request(buildApp(db, 'juan')).post(`/api/inventario/sesiones/${id}/escanear`).send({ codigo: '1234567890128' });

    expect(r.status).toBe(200);
    expect(r.body.item.sku).toBeNull();
    expect(r.body.item.sin_asociar).toBe(true);
  });

  it('rechaza escanear en la sesión de otro usuario', async () => {
    const db = openDb(TEST_DB);
    const id = await crearSesion(db, 'juan', { marca: 'Bell' });

    const r = await request(buildApp(db, 'ana')).post(`/api/inventario/sesiones/${id}/escanear`).send({ codigo: 'FB-1' });

    expect(r.status).toBe(404);
  });

  it('rechaza escanear sobre una sesión ya descartada/confirmada', async () => {
    const db = openDb(TEST_DB);
    const id = await crearSesion(db, 'juan', { marca: 'Bell' });
    db.prepare("UPDATE inventario_sesiones SET estado='descartada' WHERE id=?").run(id);

    const r = await request(buildApp(db, 'juan')).post(`/api/inventario/sesiones/${id}/escanear`).send({ codigo: 'FB-1' });

    expect(r.status).toBe(400);
    expect(r.body.ok).toBe(false);
  });
});

describe('POST /api/inventario/sesiones/:id/asociar', () => {
  afterEach(() => { if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB); });

  it('asocia un EAN sin sku a un SKU existente y siembra ean_sku', async () => {
    const db = openDb(TEST_DB);
    insertProducto(db, { id_woo: 1, sku: 'FB-1', marca: 'Bell' });
    db.prepare('CREATE TABLE IF NOT EXISTS ean_sku (ean TEXT PRIMARY KEY, sku TEXT NOT NULL, actualizado_en TEXT NOT NULL)').run();
    const crear = await request(buildApp(db, 'juan')).post('/api/inventario/sesiones').send({ marca: 'Bell' });
    const id = crear.body.sesion.id;
    await request(buildApp(db, 'juan')).post(`/api/inventario/sesiones/${id}/escanear`).send({ codigo: '1234567890128' });

    const r = await request(buildApp(db, 'juan')).post(`/api/inventario/sesiones/${id}/asociar`).send({ ean: '1234567890128', sku: 'FB-1' });

    expect(r.status).toBe(200);
    expect(r.body.item.sku).toBe('FB-1');
    const fila = db.prepare("SELECT sku FROM ean_sku WHERE ean='1234567890128'").get();
    expect(fila.sku).toBe('FB-1');
  });

  it('rechaza asociar a un SKU que no existe en el catálogo', async () => {
    const db = openDb(TEST_DB);
    db.prepare('CREATE TABLE IF NOT EXISTS ean_sku (ean TEXT PRIMARY KEY, sku TEXT NOT NULL, actualizado_en TEXT NOT NULL)').run();
    const crear = await request(buildApp(db, 'juan')).post('/api/inventario/sesiones').send({ marca: 'Bell' });
    const id = crear.body.sesion.id;
    await request(buildApp(db, 'juan')).post(`/api/inventario/sesiones/${id}/escanear`).send({ codigo: '1234567890128' });

    const r = await request(buildApp(db, 'juan')).post(`/api/inventario/sesiones/${id}/asociar`).send({ ean: '1234567890128', sku: 'NO-EXISTE' });

    expect(r.status).toBe(400);
  });

  it('rechaza asociar un EAN que nunca se escaneó en esta sesión, sin sembrar ean_sku', async () => {
    const db = openDb(TEST_DB);
    insertProducto(db, { id_woo: 1, sku: 'FB-1', marca: 'Bell' });
    db.prepare('CREATE TABLE IF NOT EXISTS ean_sku (ean TEXT PRIMARY KEY, sku TEXT NOT NULL, actualizado_en TEXT NOT NULL)').run();
    const crear = await request(buildApp(db, 'juan')).post('/api/inventario/sesiones').send({ marca: 'Bell' });
    const id = crear.body.sesion.id;

    const r = await request(buildApp(db, 'juan')).post(`/api/inventario/sesiones/${id}/asociar`).send({ ean: '1234567890128', sku: 'FB-1' });

    expect(r.status).toBe(404);
    expect(r.body.ok).toBe(false);
    const fila = db.prepare("SELECT sku FROM ean_sku WHERE ean='1234567890128'").get();
    expect(fila).toBeUndefined();
  });

  it('rechaza asociar sobre una sesión ya descartada', async () => {
    const db = openDb(TEST_DB);
    insertProducto(db, { id_woo: 1, sku: 'FB-1', marca: 'Bell' });
    db.prepare('CREATE TABLE IF NOT EXISTS ean_sku (ean TEXT PRIMARY KEY, sku TEXT NOT NULL, actualizado_en TEXT NOT NULL)').run();
    const crear = await request(buildApp(db, 'juan')).post('/api/inventario/sesiones').send({ marca: 'Bell' });
    const id = crear.body.sesion.id;
    await request(buildApp(db, 'juan')).post(`/api/inventario/sesiones/${id}/escanear`).send({ codigo: '1234567890128' });
    db.prepare("UPDATE inventario_sesiones SET estado='descartada' WHERE id=?").run(id);

    const r = await request(buildApp(db, 'juan')).post(`/api/inventario/sesiones/${id}/asociar`).send({ ean: '1234567890128', sku: 'FB-1' });

    expect(r.status).toBe(400);
    expect(r.body.ok).toBe(false);
  });
});

describe('DELETE /api/inventario/sesiones/:id/items/:itemId', () => {
  afterEach(() => { if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB); });

  it('elimina una fila contada (deshacer)', async () => {
    const db = openDb(TEST_DB);
    insertProducto(db, { id_woo: 1, sku: 'FB-1', marca: 'Bell' });
    const crear = await request(buildApp(db, 'juan')).post('/api/inventario/sesiones').send({ marca: 'Bell' });
    const id = crear.body.sesion.id;
    const esc = await request(buildApp(db, 'juan')).post(`/api/inventario/sesiones/${id}/escanear`).send({ codigo: 'FB-1' });
    const itemId = esc.body.item.id;

    const r = await request(buildApp(db, 'juan')).delete(`/api/inventario/sesiones/${id}/items/${itemId}`);

    expect(r.status).toBe(200);
    const fila = db.prepare('SELECT * FROM inventario_conteos WHERE id=?').get(itemId);
    expect(fila).toBeUndefined();
  });

  it('rechaza eliminar en una sesión que no está abierta (evita dejar confirmada_con_errores pegada)', async () => {
    const db = openDb(TEST_DB);
    const crear = await request(buildApp(db, 'juan')).post('/api/inventario/sesiones').send({ marca: 'Bell' });
    const id = crear.body.sesion.id;
    const esc = await request(buildApp(db, 'juan')).post(`/api/inventario/sesiones/${id}/escanear`).send({ codigo: '1234567890128' });
    await request(buildApp(db, 'juan')).post(`/api/inventario/sesiones/${id}/descartar`);

    const r = await request(buildApp(db, 'juan')).delete(`/api/inventario/sesiones/${id}/items/${esc.body.item.id}`);

    expect(r.status).toBe(400);
  });
});

describe('POST /api/inventario/sesiones/:id/descartar', () => {
  afterEach(() => { if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB); vi.clearAllMocks(); });

  it('cierra la sesión sin ajustar stock', async () => {
    const db = openDb(TEST_DB);
    const crear = await request(buildApp(db, 'juan')).post('/api/inventario/sesiones').send({ marca: 'Bell' });
    const id = crear.body.sesion.id;

    const r = await request(buildApp(db, 'juan')).post(`/api/inventario/sesiones/${id}/descartar`);

    expect(r.status).toBe(200);
    expect(setStockWc).not.toHaveBeenCalled();
    const sesion = db.prepare('SELECT estado FROM inventario_sesiones WHERE id=?').get(id);
    expect(sesion.estado).toBe('descartada');
  });
});

describe('POST /api/inventario/sesiones/:id/confirmar', () => {
  afterEach(() => { if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB); vi.clearAllMocks(); });

  it('bloquea con 409 si hay ítems sin asociar', async () => {
    const db = openDb(TEST_DB);
    const crear = await request(buildApp(db, 'juan')).post('/api/inventario/sesiones').send({ marca: 'Bell' });
    const id = crear.body.sesion.id;
    await request(buildApp(db, 'juan')).post(`/api/inventario/sesiones/${id}/escanear`).send({ codigo: '1234567890128' });

    const r = await request(buildApp(db, 'juan')).post(`/api/inventario/sesiones/${id}/confirmar`);

    expect(r.status).toBe(409);
    expect(setStockWc).not.toHaveBeenCalled();
  });

  it('ajusta stock por cada ítem contado y marca la sesión confirmada', async () => {
    const db = openDb(TEST_DB);
    insertProducto(db, { id_woo: 1, sku: 'FB-1', marca: 'Bell' });
    insertProducto(db, { id_woo: 2, sku: 'FB-2', marca: 'Bell' });
    setStockWc.mockResolvedValue();
    const crear = await request(buildApp(db, 'juan')).post('/api/inventario/sesiones').send({ marca: 'Bell' });
    const id = crear.body.sesion.id;
    await request(buildApp(db, 'juan')).post(`/api/inventario/sesiones/${id}/escanear`).send({ codigo: 'FB-1' });
    await request(buildApp(db, 'juan')).post(`/api/inventario/sesiones/${id}/escanear`).send({ codigo: 'FB-2' });

    const r = await request(buildApp(db, 'juan')).post(`/api/inventario/sesiones/${id}/confirmar`);

    expect(r.status).toBe(200);
    expect(r.body.ajustados).toBe(2);
    expect(setStockWc).toHaveBeenCalledTimes(2);
    const sesion = db.prepare('SELECT estado, confirmado_en FROM inventario_sesiones WHERE id=?').get(id);
    expect(sesion.estado).toBe('confirmada');
    expect(sesion.confirmado_en).toBeTruthy();
  });

  it('fail-closed por ítem: un PUT que falla no aborta el resto', async () => {
    const db = openDb(TEST_DB);
    insertProducto(db, { id_woo: 1, sku: 'FB-1', marca: 'Bell' });
    insertProducto(db, { id_woo: 2, sku: 'FB-2', marca: 'Bell' });
    setStockWc.mockRejectedValueOnce(new Error('Woo caído')).mockResolvedValueOnce();
    const crear = await request(buildApp(db, 'juan')).post('/api/inventario/sesiones').send({ marca: 'Bell' });
    const id = crear.body.sesion.id;
    await request(buildApp(db, 'juan')).post(`/api/inventario/sesiones/${id}/escanear`).send({ codigo: 'FB-1' });
    await request(buildApp(db, 'juan')).post(`/api/inventario/sesiones/${id}/escanear`).send({ codigo: 'FB-2' });

    const r = await request(buildApp(db, 'juan')).post(`/api/inventario/sesiones/${id}/confirmar`);

    expect(r.status).toBe(200);
    expect(r.body.ajustados).toBe(1);
    expect(r.body.fallidos).toBe(1);
    expect(setStockWc).toHaveBeenCalledTimes(2);
  });

  it('rechaza confirmar una sesión ya confirmada (evita doble ajuste)', async () => {
    const db = openDb(TEST_DB);
    insertProducto(db, { id_woo: 1, sku: 'FB-1', marca: 'Bell' });
    setStockWc.mockResolvedValue();
    const crear = await request(buildApp(db, 'juan')).post('/api/inventario/sesiones').send({ marca: 'Bell' });
    const id = crear.body.sesion.id;
    await request(buildApp(db, 'juan')).post(`/api/inventario/sesiones/${id}/escanear`).send({ codigo: 'FB-1' });
    await request(buildApp(db, 'juan')).post(`/api/inventario/sesiones/${id}/confirmar`);
    vi.clearAllMocks();

    const r = await request(buildApp(db, 'juan')).post(`/api/inventario/sesiones/${id}/confirmar`);

    expect(r.status).toBe(400);
    expect(setStockWc).not.toHaveBeenCalled();
  });

  it('evita doble ajuste ante dos /confirmar simultáneos sobre la misma sesión (carrera real)', async () => {
    const db = openDb(TEST_DB);
    insertProducto(db, { id_woo: 1, sku: 'FB-1', marca: 'Bell' });
    insertProducto(db, { id_woo: 2, sku: 'FB-2', marca: 'Bell' });
    setStockWc.mockImplementation(() => new Promise(r => setTimeout(r, 50)));
    const crear = await request(buildApp(db, 'juan')).post('/api/inventario/sesiones').send({ marca: 'Bell' });
    const id = crear.body.sesion.id;
    await request(buildApp(db, 'juan')).post(`/api/inventario/sesiones/${id}/escanear`).send({ codigo: 'FB-1' });
    await request(buildApp(db, 'juan')).post(`/api/inventario/sesiones/${id}/escanear`).send({ codigo: 'FB-2' });

    const app = buildApp(db, 'juan');
    const [r1, r2] = await Promise.all([
      request(app).post(`/api/inventario/sesiones/${id}/confirmar`),
      request(app).post(`/api/inventario/sesiones/${id}/confirmar`),
    ]);

    expect(setStockWc).toHaveBeenCalledTimes(2); // N ítems, no 2N
    // El request que pierde la carrera puede recibir 409 (perdió el claim atómico)
    // o 400 (llegó después y encontró la sesión ya en 'confirmando', no 'abierta',
    // en el chequeo temprano) — ambos indican que fue bloqueado correctamente.
    const ganador = [r1, r2].find(r => r.status === 200);
    const perdedor = [r1, r2].find(r => r.status !== 200);
    expect(ganador).toBeTruthy();
    expect(perdedor).toBeTruthy();
    expect([400, 409]).toContain(perdedor.status);
    expect(ganador.body.ajustados).toBe(2);
  });
});

describe('GET /api/inventario/sesiones (historial)', () => {
  afterEach(() => { if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB); vi.clearAllMocks(); });

  it('devuelve solo sesiones cerradas del usuario, no las abiertas ni las de otro', async () => {
    const db = openDb(TEST_DB);
    setStockWc.mockResolvedValue();
    const c1 = await request(buildApp(db, 'juan')).post('/api/inventario/sesiones').send({ marca: 'Bell' });
    await request(buildApp(db, 'juan')).post(`/api/inventario/sesiones/${c1.body.sesion.id}/descartar`);
    await request(buildApp(db, 'juan')).post('/api/inventario/sesiones').send({ marca: 'Continental' }); // queda abierta
    await request(buildApp(db, 'ana')).post('/api/inventario/sesiones').send({ marca: 'Shimano' });

    const r = await request(buildApp(db, 'juan')).get('/api/inventario/sesiones');

    expect(r.body.data).toHaveLength(1);
    expect(r.body.data[0].estado).toBe('descartada');
  });
});

describe('PATCH /api/inventario/sesiones/:id/items/:itemId', () => {
  afterEach(() => { if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB); });

  it('fija la cantidad directamente, incluido 0, sin borrar la fila', async () => {
    const db = openDb(TEST_DB);
    insertProducto(db, { id_woo: 1, sku: 'FB-1', marca: 'Bell' });
    const crear = await request(buildApp(db, 'juan')).post('/api/inventario/sesiones').send({ marca: 'Bell' });
    const id = crear.body.sesion.id;
    const esc = await request(buildApp(db, 'juan')).post(`/api/inventario/sesiones/${id}/escanear`).send({ codigo: 'FB-1' });
    const itemId = esc.body.item.id;

    const r = await request(buildApp(db, 'juan')).patch(`/api/inventario/sesiones/${id}/items/${itemId}`).send({ cantidad: 0 });

    expect(r.status).toBe(200);
    expect(r.body.item.cantidad).toBe(0);
    const fila = db.prepare('SELECT * FROM inventario_conteos WHERE id=?').get(itemId);
    expect(fila).toBeTruthy();
    expect(fila.cantidad).toBe(0);
  });

  it('rechaza cantidad negativa', async () => {
    const db = openDb(TEST_DB);
    insertProducto(db, { id_woo: 1, sku: 'FB-1', marca: 'Bell' });
    const crear = await request(buildApp(db, 'juan')).post('/api/inventario/sesiones').send({ marca: 'Bell' });
    const id = crear.body.sesion.id;
    const esc = await request(buildApp(db, 'juan')).post(`/api/inventario/sesiones/${id}/escanear`).send({ codigo: 'FB-1' });

    const r = await request(buildApp(db, 'juan')).patch(`/api/inventario/sesiones/${id}/items/${esc.body.item.id}`).send({ cantidad: -1 });

    expect(r.status).toBe(400);
  });
});

describe('POST /api/inventario/sesiones/:id/confirmar — reintento real tras falla parcial', () => {
  afterEach(() => { if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB); vi.clearAllMocks(); });

  it('deja la sesión en confirmada_con_errores si hubo fallos, y permite reintentar SOLO los fallidos', async () => {
    const db = openDb(TEST_DB);
    insertProducto(db, { id_woo: 1, sku: 'FB-1', marca: 'Bell' });
    insertProducto(db, { id_woo: 2, sku: 'FB-2', marca: 'Bell' });
    setStockWc.mockRejectedValueOnce(new Error('Woo caído')).mockResolvedValueOnce();
    const crear = await request(buildApp(db, 'juan')).post('/api/inventario/sesiones').send({ marca: 'Bell' });
    const id = crear.body.sesion.id;
    await request(buildApp(db, 'juan')).post(`/api/inventario/sesiones/${id}/escanear`).send({ codigo: 'FB-1' });
    await request(buildApp(db, 'juan')).post(`/api/inventario/sesiones/${id}/escanear`).send({ codigo: 'FB-2' });

    const r1 = await request(buildApp(db, 'juan')).post(`/api/inventario/sesiones/${id}/confirmar`);
    expect(r1.status).toBe(200);
    expect(r1.body.ajustados).toBe(1);
    expect(r1.body.fallidos).toBe(1);
    const sesionTrasR1 = db.prepare('SELECT estado FROM inventario_sesiones WHERE id=?').get(id);
    expect(sesionTrasR1.estado).toBe('confirmada_con_errores');

    setStockWc.mockResolvedValueOnce(); // el reintento ahora sí resuelve
    const r2 = await request(buildApp(db, 'juan')).post(`/api/inventario/sesiones/${id}/confirmar`);

    expect(r2.status).toBe(200);
    expect(r2.body.ajustados).toBe(1); // solo el que faltaba
    expect(r2.body.fallidos).toBe(0);
    expect(setStockWc).toHaveBeenCalledTimes(3); // 2 del primer intento + 1 del reintento, nunca re-ajusta el que ya salió bien
    const sesionFinal = db.prepare('SELECT estado FROM inventario_sesiones WHERE id=?').get(id);
    expect(sesionFinal.estado).toBe('confirmada');
  });

  it('marca confirmada (sin _con_errores) cuando no hay fallos', async () => {
    const db = openDb(TEST_DB);
    insertProducto(db, { id_woo: 1, sku: 'FB-1', marca: 'Bell' });
    setStockWc.mockResolvedValue();
    const crear = await request(buildApp(db, 'juan')).post('/api/inventario/sesiones').send({ marca: 'Bell' });
    const id = crear.body.sesion.id;
    await request(buildApp(db, 'juan')).post(`/api/inventario/sesiones/${id}/escanear`).send({ codigo: 'FB-1' });

    const r = await request(buildApp(db, 'juan')).post(`/api/inventario/sesiones/${id}/confirmar`);

    expect(r.body.fallidos).toBe(0);
    const sesion = db.prepare('SELECT estado FROM inventario_sesiones WHERE id=?').get(id);
    expect(sesion.estado).toBe('confirmada');
  });
});

describe('GET /api/inventario/sesiones (historial) — incluye confirmada_con_errores', () => {
  afterEach(() => { if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB); vi.clearAllMocks(); });

  it('lista sesiones en confirmada_con_errores junto con confirmada/descartada', async () => {
    const db = openDb(TEST_DB);
    insertProducto(db, { id_woo: 1, sku: 'FB-1', marca: 'Bell' });
    setStockWc.mockRejectedValue(new Error('Woo caído'));
    const crear = await request(buildApp(db, 'juan')).post('/api/inventario/sesiones').send({ marca: 'Bell' });
    const id = crear.body.sesion.id;
    await request(buildApp(db, 'juan')).post(`/api/inventario/sesiones/${id}/escanear`).send({ codigo: 'FB-1' });
    await request(buildApp(db, 'juan')).post(`/api/inventario/sesiones/${id}/confirmar`);

    const r = await request(buildApp(db, 'juan')).get('/api/inventario/sesiones');

    expect(r.body.data).toHaveLength(1);
    expect(r.body.data[0].estado).toBe('confirmada_con_errores');
  });
});
