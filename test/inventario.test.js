import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'fs';
import express from 'express';
import request from 'supertest';
import { openDb } from '../db/index.js';
import { inventarioRouter, looksLikeEan, productoEnAlcance, productoEnAlcanceOr, parseLista, parseSeleccionQuery, migrarSesionesAlcanceMulti } from '../routes/inventario.js';

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
    expect(res.body.marcas).toEqual([
      { nombre: 'Bell', productos: 2 },
      { nombre: 'Continental', productos: 1 },
    ]);
    expect(res.body.categorias).toEqual([
      { nombre: 'Accesorios', productos: 1 },
      { nombre: 'Cascos', productos: 2 },
      { nombre: 'Cubiertas', productos: 1 },
    ]);
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
    // La sesión venía del esquema viejo (columna `marca` string) y la migración
    // la envolvió en un array de un elemento sin romperla.
    expect(res.body.sesion.marcas).toEqual(['Continental']);
  });
});

describe('POST /api/inventario/sesiones', () => {
  afterEach(() => { if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB); });

  it('crea una sesión con el alcance elegido', async () => {
    const db = openDb(TEST_DB);
    const res = await request(buildApp(db)).post('/api/inventario/sesiones').send({ marca: 'Bell' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.sesion.marcas).toEqual(['Bell']);
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

// ─── Alcance: AND entre dimensiones (pendientes) vs OR (anti-solape) ─────────

describe('productoEnAlcance (alcance de una sesión)', () => {
  it('con categoría Y marca seleccionadas exige AMBAS (AND), no cualquiera', () => {
    expect(productoEnAlcance(['Cascos'], 'Bell', ['Cascos'], ['Bell'])).toBe(true);
    expect(productoEnAlcance(['Cascos'], 'Giro', ['Cascos'], ['Bell'])).toBe(false); // casco de otra marca
    expect(productoEnAlcance(['Cubiertas'], 'Bell', ['Cascos'], ['Bell'])).toBe(false); // Bell de otra categoría
  });

  it('con una sola dimensión seleccionada usa esa dimensión', () => {
    expect(productoEnAlcance(['Cascos'], 'Giro', ['Cascos'], [])).toBe(true);
    expect(productoEnAlcance(['Cubiertas'], 'Bell', [], ['Bell'])).toBe(true);
    expect(productoEnAlcance(['Cubiertas'], 'Giro', [], ['Bell'])).toBe(false);
  });

  it('OR dentro de cada dimensión (cualquiera de las categorías / marcas elegidas)', () => {
    expect(productoEnAlcance(['Cubiertas'], 'Bell', ['Cascos', 'Cubiertas'], ['Bell', 'Giro'])).toBe(true);
    expect(productoEnAlcance(['Cubiertas'], 'Shimano', ['Cascos', 'Cubiertas'], ['Bell', 'Giro'])).toBe(false);
  });

  it('sin ninguna selección no incluye nada', () => {
    expect(productoEnAlcance(['Cascos'], 'Bell', [], [])).toBe(false);
  });

  it('acepta el formato viejo (string suelto) además de arrays', () => {
    expect(productoEnAlcance(['Cascos'], 'Bell', 'Cascos', 'Bell')).toBe(true);
    expect(productoEnAlcance(['Cascos'], 'Giro', 'Cascos', 'Bell')).toBe(false);
  });
});

describe('productoEnAlcanceOr (anti-solape entre usuarios) — semántica intacta', () => {
  it('mantiene el OR intencional: alcanza con que coincida categoría O marca', () => {
    expect(productoEnAlcanceOr(['Cascos'], 'Giro', ['Cascos'], ['Bell'])).toBe(true);
    expect(productoEnAlcanceOr(['Cubiertas'], 'Bell', ['Cascos'], ['Bell'])).toBe(true);
    expect(productoEnAlcanceOr(['Cubiertas'], 'Giro', ['Cascos'], ['Bell'])).toBe(false);
  });
});

describe('parseLista', () => {
  it('normaliza arrays, JSON string, string suelto, null y vacíos', () => {
    expect(parseLista(['a', ' b ', '', 'a'])).toEqual(['a', 'b']);
    expect(parseLista('["a","b"]')).toEqual(['a', 'b']);
    expect(parseLista('Cascos')).toEqual(['Cascos']);
    expect(parseLista(null)).toEqual([]);
    expect(parseLista('')).toEqual([]);
  });
});

describe('POST /api/inventario/sesiones — alcance múltiple (AND categoría+marca)', () => {
  afterEach(() => { if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB); });

  it('los pendientes con categoría Y marca son SOLO la intersección (bug OR corregido)', async () => {
    const db = openDb(TEST_DB);
    insertProducto(db, { id_woo: 1, sku: 'FB-1', nombre: 'Casco Bell', marca: 'Bell', categorias_json: '["Cascos"]' });
    insertProducto(db, { id_woo: 2, sku: 'FB-2', nombre: 'Casco Giro', marca: 'Giro', categorias_json: '["Cascos"]' });
    insertProducto(db, { id_woo: 3, sku: 'FB-3', nombre: 'Cubierta Bell', marca: 'Bell', categorias_json: '["Cubiertas"]' });

    const crear = await request(buildApp(db, 'juan')).post('/api/inventario/sesiones')
      .send({ categorias: ['Cascos'], marcas: ['Bell'] });
    const r = await request(buildApp(db, 'juan')).get('/api/inventario/sesiones/' + crear.body.sesion.id);

    expect(r.body.pendientes.map(p => p.sku)).toEqual(['FB-1']);
  });

  it('acepta varias categorías y varias marcas (OR dentro de cada dimensión)', async () => {
    const db = openDb(TEST_DB);
    insertProducto(db, { id_woo: 1, sku: 'FB-1', marca: 'Bell', categorias_json: '["Cascos"]' });
    insertProducto(db, { id_woo: 2, sku: 'FB-2', marca: 'Giro', categorias_json: '["Cubiertas"]' });
    insertProducto(db, { id_woo: 3, sku: 'FB-3', marca: 'Shimano', categorias_json: '["Cascos"]' });

    const crear = await request(buildApp(db, 'juan')).post('/api/inventario/sesiones')
      .send({ categorias: ['Cascos', 'Cubiertas'], marcas: ['Bell', 'Giro'] });
    const r = await request(buildApp(db, 'juan')).get('/api/inventario/sesiones/' + crear.body.sesion.id);

    expect(r.body.pendientes.map(p => p.sku).sort()).toEqual(['FB-1', 'FB-2']);
  });

  it('el anti-solape sigue usando OR: categoría de uno vs marca de otro con producto compartido choca', async () => {
    const db = openDb(TEST_DB);
    insertProducto(db, { id_woo: 1, sku: 'FB-1', marca: 'Bell', categorias_json: '["Cascos"]' });
    await request(buildApp(db, 'juan')).post('/api/inventario/sesiones').send({ categorias: ['Cascos'], marcas: ['Bell'] });

    const r = await request(buildApp(db, 'ana')).post('/api/inventario/sesiones').send({ marcas: ['Bell'] });

    expect(r.status).toBe(409);
    expect(r.body.ocupada_por).toBe('juan');
  });
});

describe('Migración de sesiones abiertas (string → array)', () => {
  afterEach(() => { if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB); });

  function crearTablaVieja(db) {
    db.prepare('CREATE TABLE IF NOT EXISTS inventario_sesiones (' +
      'id INTEGER PRIMARY KEY AUTOINCREMENT, usuario TEXT NOT NULL, categoria TEXT, marca TEXT,' +
      "estado TEXT NOT NULL DEFAULT 'abierta', creado_en TEXT NOT NULL, confirmado_en TEXT)").run();
  }

  it('convierte categoria/marca en arrays y preserva id, estado y fechas', async () => {
    const db = openDb(TEST_DB);
    crearTablaVieja(db);
    const creado = now();
    db.prepare("INSERT INTO inventario_sesiones (id, usuario, categoria, marca, estado, creado_en) VALUES (7,'juan','Cascos','Bell','abierta',?)").run(creado);
    db.prepare("INSERT INTO inventario_sesiones (id, usuario, categoria, marca, estado, creado_en, confirmado_en) VALUES (8,'ana',NULL,'Giro','confirmada',?,?)").run(creado, creado);

    buildApp(db, 'juan'); // dispara ensureTables → migración

    const filas = db.prepare('SELECT * FROM inventario_sesiones ORDER BY id').all();
    expect(filas.map(f => f.id)).toEqual([7, 8]);
    expect(JSON.parse(filas[0].categorias)).toEqual(['Cascos']);
    expect(JSON.parse(filas[0].marcas)).toEqual(['Bell']);
    expect(filas[0].creado_en).toBe(creado);
    expect(JSON.parse(filas[1].categorias)).toEqual([]);
    expect(JSON.parse(filas[1].marcas)).toEqual(['Giro']);
    expect(filas[1].estado).toBe('confirmada');
  });

  it('es idempotente: correr ensureTables de nuevo no rompe ni duplica nada', async () => {
    const db = openDb(TEST_DB);
    crearTablaVieja(db);
    db.prepare("INSERT INTO inventario_sesiones (usuario, categoria, estado, creado_en) VALUES ('juan','Cascos','abierta',?)").run(now());

    buildApp(db, 'juan');
    buildApp(db, 'juan');

    const filas = db.prepare('SELECT * FROM inventario_sesiones').all();
    expect(filas).toHaveLength(1);
    expect(JSON.parse(filas[0].categorias)).toEqual(['Cascos']);
  });

  it('una sesión abierta migrada sigue devolviendo sus pendientes', async () => {
    const db = openDb(TEST_DB);
    crearTablaVieja(db);
    insertProducto(db, { id_woo: 1, sku: 'FB-1', marca: 'Bell', categorias_json: '["Cascos"]' });
    db.prepare("INSERT INTO inventario_sesiones (id, usuario, categoria, estado, creado_en) VALUES (3,'juan','Cascos','abierta',?)").run(now());

    const r = await request(buildApp(db, 'juan')).get('/api/inventario/sesiones/3');

    expect(r.status).toBe(200);
    expect(r.body.pendientes.map(p => p.sku)).toEqual(['FB-1']);
  });
});

describe('POST /api/inventario/alcance-preview', () => {
  afterEach(() => { if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB); });

  it('devuelve productos, unidades esperadas y split con/sin stock del alcance', async () => {
    const db = openDb(TEST_DB);
    insertProducto(db, { id_woo: 1, sku: 'FB-1', marca: 'Bell', categorias_json: '["Cascos"]', stock: 3 });
    insertProducto(db, { id_woo: 2, sku: 'FB-2', marca: 'Bell', categorias_json: '["Cascos"]', stock: 0 });
    insertProducto(db, { id_woo: 3, sku: 'FB-3', marca: 'Giro', categorias_json: '["Cascos"]', stock: 9 });

    const r = await request(buildApp(db)).post('/api/inventario/alcance-preview')
      .send({ categorias: ['Cascos'], marcas: ['Bell'] });

    expect(r.status).toBe(200);
    expect(r.body.productos).toBe(2);
    expect(r.body.unidades_esperadas).toBe(3);
    expect(r.body.con_stock).toEqual({ productos: 1, unidades: 3 });
    expect(r.body.sin_stock).toEqual({ productos: 1 });
    expect(r.body.supera_umbral).toBe(false);
  });

  it('el preview coincide exactamente con los pendientes que se abren después', async () => {
    const db = openDb(TEST_DB);
    insertProducto(db, { id_woo: 1, sku: 'FB-1', marca: 'Bell', categorias_json: '["Cascos"]', stock: 3 });
    insertProducto(db, { id_woo: 2, sku: 'FB-2', marca: 'Giro', categorias_json: '["Cascos"]', stock: 1 });

    const prev = await request(buildApp(db, 'juan')).post('/api/inventario/alcance-preview').send({ categorias: ['Cascos'], marcas: ['Bell'] });
    const crear = await request(buildApp(db, 'juan')).post('/api/inventario/sesiones').send({ categorias: ['Cascos'], marcas: ['Bell'] });
    const ses = await request(buildApp(db, 'juan')).get('/api/inventario/sesiones/' + crear.body.sesion.id);

    expect(ses.body.pendientes).toHaveLength(prev.body.productos);
  });

  it('sin selección devuelve todo en cero, no el catálogo entero', async () => {
    const db = openDb(TEST_DB);
    insertProducto(db, { id_woo: 1, sku: 'FB-1', marca: 'Bell', categorias_json: '["Cascos"]', stock: 3 });

    const r = await request(buildApp(db)).post('/api/inventario/alcance-preview').send({ categorias: [], marcas: [] });

    expect(r.body.productos).toBe(0);
    expect(r.body.unidades_esperadas).toBe(0);
  });
});

describe('Orden y bloque congelado de pendientes', () => {
  afterEach(() => { if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB); });

  it('ordena con-stock primero y después por categoría, marca y nombre', async () => {
    const db = openDb(TEST_DB);
    insertProducto(db, { id_woo: 1, sku: 'SIN-1', nombre: 'Zeta', marca: 'Bell', categorias_json: '["Cascos"]', stock: 0 });
    insertProducto(db, { id_woo: 2, sku: 'CON-2', nombre: 'Beta', marca: 'Bell', categorias_json: '["Cascos"]', stock: 2 });
    insertProducto(db, { id_woo: 3, sku: 'CON-1', nombre: 'Alfa', marca: 'Bell', categorias_json: '["Cascos"]', stock: 5 });

    const crear = await request(buildApp(db, 'juan')).post('/api/inventario/sesiones').send({ marcas: ['Bell'] });
    const r = await request(buildApp(db, 'juan')).get('/api/inventario/sesiones/' + crear.body.sesion.id);

    expect(r.body.pendientes.map(p => p.sku)).toEqual(['CON-1', 'CON-2', 'SIN-1']);
    expect(r.body.pendientes.map(p => p.bloque)).toEqual(['con_stock', 'con_stock', 'sin_stock']);
    expect(r.body.resumen).toMatchObject({ pendientes_con_stock: 2, pendientes_sin_stock: 1 });
  });

  it('el bloque queda CONGELADO al abrir: si el stock cambia después, el ítem no salta de bloque', async () => {
    const db = openDb(TEST_DB);
    insertProducto(db, { id_woo: 1, sku: 'FB-1', nombre: 'Casco', marca: 'Bell', stock: 0 });
    const crear = await request(buildApp(db, 'juan')).post('/api/inventario/sesiones').send({ marcas: ['Bell'] });

    db.prepare("UPDATE catalogo_cache SET stock=99 WHERE sku='FB-1'").run(); // cambio por otra vía

    const r = await request(buildApp(db, 'juan')).get('/api/inventario/sesiones/' + crear.body.sesion.id);
    expect(r.body.pendientes[0].bloque).toBe('sin_stock');
    expect(r.body.pendientes[0].stock_inicial).toBe(0);
    expect(r.body.pendientes[0].stock_woo).toBe(99); // el stock actual sí se muestra al día
  });

  it('el ítem escaneado guarda su bloque congelado', async () => {
    const db = openDb(TEST_DB);
    insertProducto(db, { id_woo: 1, sku: 'FB-1', marca: 'Bell', stock: 4 });
    const crear = await request(buildApp(db, 'juan')).post('/api/inventario/sesiones').send({ marcas: ['Bell'] });
    const id = crear.body.sesion.id;

    await request(buildApp(db, 'juan')).post('/api/inventario/sesiones/' + id + '/escanear').send({ codigo: 'FB-1' });

    const fila = db.prepare('SELECT bloque FROM inventario_conteos WHERE sesion_id=?').get(id);
    expect(fila.bloque).toBe('con_stock');
  });
});

describe('Hallazgo fuera de alcance', () => {
  afterEach(() => { if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB); });

  it('registra el escaneo fuera de alcance con aviso, sin descartarlo ni bloquear', async () => {
    const db = openDb(TEST_DB);
    insertProducto(db, { id_woo: 1, sku: 'FB-1', marca: 'Bell' });
    insertProducto(db, { id_woo: 2, sku: 'FB-9', marca: 'Giro' });
    const crear = await request(buildApp(db, 'juan')).post('/api/inventario/sesiones').send({ marcas: ['Bell'] });
    const id = crear.body.sesion.id;

    const esc = await request(buildApp(db, 'juan')).post('/api/inventario/sesiones/' + id + '/escanear').send({ codigo: 'FB-9' });

    expect(esc.status).toBe(200);
    expect(esc.body.item.fuera_de_alcance).toBe(true);
    expect(esc.body.item.cantidad).toBe(1);

    const ses = await request(buildApp(db, 'juan')).get('/api/inventario/sesiones/' + id);
    expect(ses.body.resumen.fuera_de_alcance).toBe(1);
    expect(ses.body.items.find(i => i.sku === 'FB-9').fuera_de_alcance).toBe(true);
  });

  it('un producto dentro del alcance no se marca como hallazgo', async () => {
    const db = openDb(TEST_DB);
    insertProducto(db, { id_woo: 1, sku: 'FB-1', marca: 'Bell' });
    const crear = await request(buildApp(db, 'juan')).post('/api/inventario/sesiones').send({ marcas: ['Bell'] });

    const esc = await request(buildApp(db, 'juan'))
      .post('/api/inventario/sesiones/' + crear.body.sesion.id + '/escanear').send({ codigo: 'FB-1' });

    expect(esc.body.item.fuera_de_alcance).toBe(false);
  });
});

describe('POST /api/inventario/sesiones/:id/cerrar-sin-stock', () => {
  afterEach(() => { if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB); vi.clearAllMocks(); });

  async function sesionConSinStock(db) {
    insertProducto(db, { id_woo: 1, sku: 'CON-1', marca: 'Bell', stock: 2 });
    insertProducto(db, { id_woo: 2, sku: 'SIN-1', marca: 'Bell', stock: 0 });
    insertProducto(db, { id_woo: 3, sku: 'SIN-2', marca: 'Bell', stock: 0 });
    const crear = await request(buildApp(db, 'juan')).post('/api/inventario/sesiones').send({ marcas: ['Bell'] });
    return crear.body.sesion.id;
  }

  it('cierra en 0 todos los sin-stock pendientes y los marca confirmado_por_omision', async () => {
    const db = openDb(TEST_DB);
    const id = await sesionConSinStock(db);

    const r = await request(buildApp(db, 'juan')).post('/api/inventario/sesiones/' + id + '/cerrar-sin-stock').send({ todos: true });

    expect(r.status).toBe(200);
    expect(r.body.cerrados).toBe(2);
    const filas = db.prepare('SELECT * FROM inventario_conteos WHERE sesion_id=? ORDER BY sku').all(id);
    expect(filas.map(f => f.sku)).toEqual(['SIN-1', 'SIN-2']);
    expect(filas.every(f => f.cantidad === 0 && f.confirmado_por_omision === 1 && f.bloque === 'sin_stock')).toBe(true);
  });

  it('permite cerrar solo los SKUs elegidos (ítem por ítem)', async () => {
    const db = openDb(TEST_DB);
    const id = await sesionConSinStock(db);

    const r = await request(buildApp(db, 'juan')).post('/api/inventario/sesiones/' + id + '/cerrar-sin-stock').send({ skus: ['SIN-2'] });

    expect(r.body.cerrados).toBe(1);
    const filas = db.prepare('SELECT sku FROM inventario_conteos WHERE sesion_id=?').all(id);
    expect(filas.map(f => f.sku)).toEqual(['SIN-2']);
  });

  it('nunca pisa un conteo ya hecho a mano ni toca los con-stock', async () => {
    const db = openDb(TEST_DB);
    const id = await sesionConSinStock(db);
    await request(buildApp(db, 'juan')).post('/api/inventario/sesiones/' + id + '/escanear').send({ codigo: 'SIN-1' });

    await request(buildApp(db, 'juan')).post('/api/inventario/sesiones/' + id + '/cerrar-sin-stock').send({ todos: true });

    const sin1 = db.prepare("SELECT * FROM inventario_conteos WHERE sesion_id=? AND sku='SIN-1'").get(id);
    expect(sin1.cantidad).toBe(1);
    expect(sin1.confirmado_por_omision).toBe(0);
    const con1 = db.prepare("SELECT * FROM inventario_conteos WHERE sesion_id=? AND sku='CON-1'").get(id);
    expect(con1).toBeUndefined();
  });

  it('los ítems cerrados por omisión se ajustan en Woo como 0 al confirmar', async () => {
    const db = openDb(TEST_DB);
    const id = await sesionConSinStock(db);
    setStockWc.mockResolvedValue();

    await request(buildApp(db, 'juan')).post('/api/inventario/sesiones/' + id + '/cerrar-sin-stock').send({ todos: true });
    const r = await request(buildApp(db, 'juan')).post('/api/inventario/sesiones/' + id + '/confirmar');

    expect(r.body.ajustados).toBe(2);
    expect(setStockWc).toHaveBeenCalledWith(CFG, db, 'SIN-1', 0);
  });

  it('rechaza cerrar sobre una sesión que no está abierta', async () => {
    const db = openDb(TEST_DB);
    const id = await sesionConSinStock(db);
    await request(buildApp(db, 'juan')).post('/api/inventario/sesiones/' + id + '/descartar');

    const r = await request(buildApp(db, 'juan')).post('/api/inventario/sesiones/' + id + '/cerrar-sin-stock').send({ todos: true });

    expect(r.status).toBe(400);
  });

  it('rechaza cerrar en la sesión de otro usuario', async () => {
    const db = openDb(TEST_DB);
    const id = await sesionConSinStock(db);

    const r = await request(buildApp(db, 'ana')).post('/api/inventario/sesiones/' + id + '/cerrar-sin-stock').send({ todos: true });

    expect(r.status).toBe(404);
  });
});

describe('GET /api/inventario/alcance-opciones — conteo condicionado a la selección', () => {
  afterEach(() => { if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB); });

  function catalogoMixto(db) {
    insertProducto(db, { id_woo: 1, sku: 'FB-1', marca: 'Bell', categorias_json: '["Cascos"]' });
    insertProducto(db, { id_woo: 2, sku: 'FB-2', marca: 'Giro', categorias_json: '["Cascos"]' });
    insertProducto(db, { id_woo: 3, sku: 'FB-3', marca: 'Maxxis', categorias_json: '["Cubiertas"]' });
  }

  it('sin query params mantiene el conteo global', async () => {
    const db = openDb(TEST_DB);
    catalogoMixto(db);

    const r = await request(buildApp(db)).get('/api/inventario/alcance-opciones');

    expect(r.body.categorias).toEqual([
      { nombre: 'Cascos', productos: 2 },
      { nombre: 'Cubiertas', productos: 1 },
    ]);
    expect(r.body.marcas).toEqual([
      { nombre: 'Bell', productos: 1 },
      { nombre: 'Giro', productos: 1 },
      { nombre: 'Maxxis', productos: 1 },
    ]);
  });

  it('con categoría elegida, las marcas que no intersectan quedan en 0 (chip deshabilitado, no oculto)', async () => {
    const db = openDb(TEST_DB);
    catalogoMixto(db);

    const r = await request(buildApp(db)).get('/api/inventario/alcance-opciones?categorias=Cascos');

    expect(r.body.marcas).toEqual([
      { nombre: 'Bell', productos: 1 },
      { nombre: 'Giro', productos: 1 },
      { nombre: 'Maxxis', productos: 0 }, // no intersecta, pero sigue estando en la lista
    ]);
  });

  it('con marca elegida, las categorías se condicionan a esa marca', async () => {
    const db = openDb(TEST_DB);
    catalogoMixto(db);

    const r = await request(buildApp(db)).get('/api/inventario/alcance-opciones?marcas=Maxxis');

    expect(r.body.categorias).toEqual([
      { nombre: 'Cascos', productos: 0 },
      { nombre: 'Cubiertas', productos: 1 },
    ]);
  });

  it('acepta varias opciones separadas por | (formato del frontend) y por coma', async () => {
    const db = openDb(TEST_DB);
    catalogoMixto(db);

    const pipe = await request(buildApp(db)).get('/api/inventario/alcance-opciones?categorias=Cascos|Cubiertas');
    const coma = await request(buildApp(db)).get('/api/inventario/alcance-opciones?categorias=Cascos,Cubiertas');

    const esperado = [
      { nombre: 'Bell', productos: 1 },
      { nombre: 'Giro', productos: 1 },
      { nombre: 'Maxxis', productos: 1 },
    ];
    expect(pipe.body.marcas).toEqual(esperado);
    expect(coma.body.marcas).toEqual(esperado);
    expect(pipe.body.seleccion.categorias).toEqual(['Cascos', 'Cubiertas']);
  });

  it('el conteo condicionado coincide con el preview de esa combinación', async () => {
    const db = openDb(TEST_DB);
    catalogoMixto(db);

    const op = await request(buildApp(db)).get('/api/inventario/alcance-opciones?categorias=Cascos');
    const prev = await request(buildApp(db)).post('/api/inventario/alcance-preview').send({ categorias: ['Cascos'], marcas: ['Bell'] });

    expect(op.body.marcas.find(m => m.nombre === 'Bell').productos).toBe(prev.body.productos);
  });

  it('parseSeleccionQuery normaliza array repetido, string con separadores y vacíos', () => {
    expect(parseSeleccionQuery(['a|b', 'c'])).toEqual(['a', 'b', 'c']);
    expect(parseSeleccionQuery('a,b|c')).toEqual(['a', 'b', 'c']);
    expect(parseSeleccionQuery('')).toEqual([]);
    expect(parseSeleccionQuery(undefined)).toEqual([]);
  });
});

describe('Hallazgos de revisión — cerrar-sin-stock, omisión y migración', () => {
  afterEach(() => { if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB); vi.clearAllMocks(); });

  async function sesionConSinStock(db) {
    insertProducto(db, { id_woo: 1, sku: 'CON-1', marca: 'Bell', stock: 2 });
    insertProducto(db, { id_woo: 2, sku: 'SIN-1', marca: 'Bell', stock: 0 });
    insertProducto(db, { id_woo: 3, sku: 'SIN-2', marca: 'Bell', stock: 0 });
    const crear = await request(buildApp(db, 'juan')).post('/api/inventario/sesiones').send({ marcas: ['Bell'] });
    return crear.body.sesion.id;
  }

  it('fail-closed: un body vacío NO cierra nada en 0 (400)', async () => {
    const db = openDb(TEST_DB);
    const id = await sesionConSinStock(db);

    const r = await request(buildApp(db, 'juan')).post('/api/inventario/sesiones/' + id + '/cerrar-sin-stock').send({});

    expect(r.status).toBe(400);
    expect(db.prepare('SELECT COUNT(*) n FROM inventario_conteos WHERE sesion_id=?').get(id).n).toBe(0);
  });

  it('fail-closed: `{skus: []}` tampoco cierra nada (400)', async () => {
    const db = openDb(TEST_DB);
    const id = await sesionConSinStock(db);

    const r = await request(buildApp(db, 'juan')).post('/api/inventario/sesiones/' + id + '/cerrar-sin-stock').send({ skus: [] });

    expect(r.status).toBe(400);
    expect(db.prepare('SELECT COUNT(*) n FROM inventario_conteos WHERE sesion_id=?').get(id).n).toBe(0);
  });

  it('volver a escanear un ítem cerrado en 0 lo deja de marcar como confirmado por omisión', async () => {
    const db = openDb(TEST_DB);
    const id = await sesionConSinStock(db);
    await request(buildApp(db, 'juan')).post('/api/inventario/sesiones/' + id + '/cerrar-sin-stock').send({ todos: true });
    expect(db.prepare("SELECT confirmado_por_omision c FROM inventario_conteos WHERE sesion_id=? AND sku='SIN-1'").get(id).c).toBe(1);

    const esc = await request(buildApp(db, 'juan')).post('/api/inventario/sesiones/' + id + '/escanear').send({ codigo: 'SIN-1' });

    expect(esc.body.item.cantidad).toBe(1);
    const fila = db.prepare("SELECT * FROM inventario_conteos WHERE sesion_id=? AND sku='SIN-1'").get(id);
    expect(fila.confirmado_por_omision).toBe(0);
  });

  it('la migración es atómica: si falla, la tabla original no se pierde', async () => {
    const db = openDb(TEST_DB);
    db.prepare('CREATE TABLE IF NOT EXISTS inventario_sesiones (' +
      'id INTEGER PRIMARY KEY AUTOINCREMENT, usuario TEXT, categoria TEXT, marca TEXT,' +
      "estado TEXT NOT NULL DEFAULT 'abierta', creado_en TEXT NOT NULL, confirmado_en TEXT)").run();
    // usuario NULL legado: viola el NOT NULL de la tabla nueva → la migración falla entera.
    db.prepare("INSERT INTO inventario_sesiones (usuario, categoria, estado, creado_en) VALUES (NULL,'Cascos','abierta',?)").run(now());

    expect(() => migrarSesionesAlcanceMulti(db)).toThrow();

    const filas = db.prepare('SELECT * FROM inventario_sesiones').all();
    expect(filas).toHaveLength(1);
    expect(filas[0].categoria).toBe('Cascos'); // sigue con el esquema viejo, sin datos perdidos
    const sobrante = db.prepare("SELECT name FROM sqlite_master WHERE name='inventario_sesiones_mig'").get();
    expect(sobrante).toBeUndefined();
  });

  it('GET /sesiones/:id resuelve nombre y diferencia de varios ítems en una sola consulta', async () => {
    const db = openDb(TEST_DB);
    insertProducto(db, { id_woo: 1, sku: 'FB-1', nombre: 'Casco A', marca: 'Bell', stock: 5 });
    insertProducto(db, { id_woo: 2, sku: 'FB-2', nombre: 'Casco B', marca: 'Bell', stock: 1 });
    const crear = await request(buildApp(db, 'juan')).post('/api/inventario/sesiones').send({ marcas: ['Bell'] });
    const id = crear.body.sesion.id;
    await request(buildApp(db, 'juan')).post('/api/inventario/sesiones/' + id + '/escanear').send({ codigo: 'FB-1' });
    await request(buildApp(db, 'juan')).post('/api/inventario/sesiones/' + id + '/escanear').send({ codigo: 'FB-2' });
    await request(buildApp(db, 'juan')).post('/api/inventario/sesiones/' + id + '/escanear').send({ codigo: '1234567890128' });

    const r = await request(buildApp(db, 'juan')).get('/api/inventario/sesiones/' + id);

    expect(r.body.items).toHaveLength(3);
    expect(r.body.items[0]).toMatchObject({ sku: 'FB-1', nombre: 'Casco A', stock_woo: 5, diferencia: -4 });
    expect(r.body.items[1]).toMatchObject({ sku: 'FB-2', nombre: 'Casco B', stock_woo: 1, diferencia: 0 });
    // ítem sin asociar: no está en el catálogo, se devuelve sin nombre ni diferencia
    expect(r.body.items[2]).toMatchObject({ sku: null, nombre: null, stock_woo: null, diferencia: null });
  });
});
