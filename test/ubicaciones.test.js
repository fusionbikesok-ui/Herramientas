import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'fs';
import express from 'express';
import request from 'supertest';
import { openDb } from '../db/index.js';
import { inventarioRouter } from '../routes/inventario.js';

vi.mock('../lib/wooStock.js', async () => {
  const actual = await vi.importActual('../lib/wooStock.js');
  return { ...actual, setStockWc: vi.fn(), setStockWcDelta: vi.fn() };
});
import { setStockWcDelta } from '../lib/wooStock.js';

vi.mock('../routes/woo.js', () => ({ wooFetch: vi.fn() }));
vi.mock('axios');

const TEST_DB = './test/tmp-ubicaciones.sqlite';
const CFG = { url: 'https://fusionbikes.com.ar', ck: 'ck_x', cs: 'cs_x' };
const now = () => new Date().toISOString();

function buildApp(db, usuario = 'jose', isAdmin = true) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { username: usuario, is_admin: isAdmin ? 1 : 0 }; next(); });
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
}

afterEach(() => {
  for (const f of [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) {
    if (fs.existsSync(f)) fs.rmSync(f);
  }
  vi.clearAllMocks();
});

describe('ubicaciones — CRUD', () => {
  it('crea una ubicación (admin) y la lista', async () => {
    const db = openDb(TEST_DB);
    const app = buildApp(db);
    const crear = await request(app).post('/api/inventario/ubicaciones').send({ zona: 'A', estante: '1' });
    expect(crear.status).toBe(200);
    expect(crear.body.ubicacion.estado).toBe('bootstrap');

    const lista = await request(app).get('/api/inventario/ubicaciones');
    expect(lista.body.ubicaciones).toHaveLength(1);
    expect(lista.body.ubicaciones[0].skus_registrados).toBe(0);
  });

  it('rechaza crear una ubicación duplicada (zona+estante)', async () => {
    const db = openDb(TEST_DB);
    const app = buildApp(db);
    await request(app).post('/api/inventario/ubicaciones').send({ zona: 'A', estante: '1' });
    const dup = await request(app).post('/api/inventario/ubicaciones').send({ zona: 'A', estante: '1' });
    expect(dup.status).toBe(409);
  });

  it('crear/mapear ubicación sin admin responde 403', async () => {
    const db = openDb(TEST_DB);
    const app = buildApp(db, 'operario', false);
    const crear = await request(app).post('/api/inventario/ubicaciones').send({ zona: 'A', estante: '1' });
    expect(crear.status).toBe(403);
  });

  it('marca una ubicación como mapeada', async () => {
    const db = openDb(TEST_DB);
    const app = buildApp(db);
    const crear = await request(app).post('/api/inventario/ubicaciones').send({ zona: 'A', estante: '1' });
    const id = crear.body.ubicacion.id;
    const mapear = await request(app).post(`/api/inventario/ubicaciones/${id}/mapear`);
    expect(mapear.status).toBe(200);
    expect(mapear.body.ubicacion.estado).toBe('mapeada');
  });
});

describe('sesión con alcance por ubicación', () => {
  it('categoria/marca Y ubicacion_id juntos se rechazan (mutuamente excluyentes)', async () => {
    const db = openDb(TEST_DB);
    const app = buildApp(db);
    const crear = await request(app).post('/api/inventario/ubicaciones').send({ zona: 'A', estante: '1' });
    const res = await request(app).post('/api/inventario/sesiones')
      .send({ marcas: ['Trek'], ubicacion_id: crear.body.ubicacion.id });
    expect(res.status).toBe(400);
  });

  it('rechaza ubicacion_id inexistente o inactiva', async () => {
    const db = openDb(TEST_DB);
    const app = buildApp(db);
    const res = await request(app).post('/api/inventario/sesiones').send({ ubicacion_id: 999 });
    expect(res.status).toBe(400);
  });

  it('dos sesiones sobre la MISMA ubicación recién creada (sin ningún SKU todavía) se rechazan', async () => {
    const db = openDb(TEST_DB);
    const app = buildApp(db);
    const ubic = await request(app).post('/api/inventario/ubicaciones').send({ zona: 'A', estante: '1' });
    const ubicacionId = ubic.body.ubicacion.id;

    const s1 = await request(buildApp(db, 'jose')).post('/api/inventario/sesiones').send({ ubicacion_id: ubicacionId });
    expect(s1.status).toBe(200);

    // Ubicación todavía sin ningún SKU asociado (bootstrap): el chequeo por SKU
    // compartido no alcanzaría a detectar el choque, así que hace falta comparar
    // el id de ubicación directamente (hallazgo del revisor, 2026-08-25).
    const s2 = await request(buildApp(db, 'joaco')).post('/api/inventario/sesiones').send({ ubicacion_id: ubicacionId });
    expect(s2.status).toBe(409);
    expect(s2.body.ocupada_por).toBe('jose');
  });

  it('captura automática: escanear un SKU dentro de la sesión lo asocia solo a la ubicación activa', async () => {
    const db = openDb(TEST_DB);
    insertProducto(db, { id_woo: 1, sku: 'FB-1', stock: 5, no_contable: 0 });
    const app = buildApp(db);
    const ubic = await request(app).post('/api/inventario/ubicaciones').send({ zona: 'A', estante: '1' });
    const ubicacionId = ubic.body.ubicacion.id;

    // Sesión por ubicación: no hay alcance previo (nada registrado en producto_ubicacion
    // todavía), así que el alcance congelado arranca vacío — eso es correcto: recién se va
    // poblando a medida que se escanea (ciclo 0 de bootstrap).
    const crear = await request(app).post('/api/inventario/sesiones').send({ ubicacion_id: ubicacionId });
    expect(crear.status).toBe(200);
    const idSesion = crear.body.sesion.id;

    const escaneo = await request(app).post(`/api/inventario/sesiones/${idSesion}/escanear`).send({ codigo: 'FB-1' });
    expect(escaneo.status).toBe(200);

    const asociados = db.prepare('SELECT * FROM producto_ubicacion WHERE ubicacion_id=?').all(ubicacionId);
    expect(asociados).toHaveLength(1);
    expect(asociados[0].sku).toBe('FB-1');
    expect(asociados[0].confirmado_por).toBe('jose');
  });

  it('no duplica la fila si el mismo SKU se escanea dos veces en la misma ubicación', async () => {
    const db = openDb(TEST_DB);
    insertProducto(db, { id_woo: 1, sku: 'FB-1', stock: 5 });
    const app = buildApp(db);
    const ubic = await request(app).post('/api/inventario/ubicaciones').send({ zona: 'A', estante: '1' });
    const crear = await request(app).post('/api/inventario/sesiones').send({ ubicacion_id: ubic.body.ubicacion.id });
    const idSesion = crear.body.sesion.id;

    await request(app).post(`/api/inventario/sesiones/${idSesion}/escanear`).send({ codigo: 'FB-1' });
    await request(app).post(`/api/inventario/sesiones/${idSesion}/escanear`).send({ codigo: 'FB-1' });

    const asociados = db.prepare('SELECT * FROM producto_ubicacion WHERE ubicacion_id=?').all(ubic.body.ubicacion.id);
    expect(asociados).toHaveLength(1);
  });

  it('una sesión por ubicación y otra por marca que comparten SKUs no pueden coexistir (anti-solape)', async () => {
    const db = openDb(TEST_DB);
    insertProducto(db, { id_woo: 1, sku: 'FB-1', marca: 'Trek', stock: 5 });
    const app = buildApp(db, 'jose');
    const ubic = await request(app).post('/api/inventario/ubicaciones').send({ zona: 'A', estante: '1' });
    const ubicacionId = ubic.body.ubicacion.id;

    const s1 = await request(app).post('/api/inventario/sesiones').send({ ubicacion_id: ubicacionId });
    await request(app).post(`/api/inventario/sesiones/${s1.body.sesion.id}/escanear`).send({ codigo: 'FB-1' });
    // FB-1 ahora está asociado a la ubicación. Otro usuario abre por marca Trek: se
    // solapa porque FB-1 es Trek Y está en esa ubicación.
    await request(app).post(`/api/inventario/sesiones/${s1.body.sesion.id}/descartar`);

    const s2 = await request(buildApp(db, 'joaco')).post('/api/inventario/sesiones').send({ ubicacion_id: ubicacionId });
    expect(s2.status).toBe(200);
    const choque = await request(buildApp(db, 'jose')).post('/api/inventario/sesiones').send({ marcas: ['Trek'] });
    expect(choque.status).toBe(409);
    expect(choque.body.ocupada_por).toBe('joaco');
  });
});

describe('cerrar-sin-stock con alcance por ubicación — Rupturas 3 y 6', () => {
  function setup(db) {
    insertProducto(db, { id_woo: 1, sku: 'FB-1', stock: 0 }); // se va a asociar a la ubicación
    insertProducto(db, { id_woo: 2, sku: 'FB-2', stock: 0 }); // overflow: en dos ubicaciones
    insertProducto(db, { id_woo: 3, sku: 'FB-3', stock: 0 }); // nunca escaneado, sin ubicación
  }

  it('con la ubicación sin mapear, cierre en cero masivo se rechaza (400), no falla silenciosamente', async () => {
    const db = openDb(TEST_DB);
    setup(db);
    const app = buildApp(db);
    const ubic = await request(app).post('/api/inventario/ubicaciones').send({ zona: 'A', estante: '1' });
    const crear = await request(app).post('/api/inventario/sesiones').send({ ubicacion_id: ubic.body.ubicacion.id });
    const idSesion = crear.body.sesion.id;
    await request(app).post(`/api/inventario/sesiones/${idSesion}/escanear`).send({ codigo: 'FB-1' });

    const cierre = await request(app).post(`/api/inventario/sesiones/${idSesion}/cerrar-sin-stock`).send({ todos: true });
    expect(cierre.status).toBe(400);
  });

  it('mapeada: cierra en cero solo los SKUs sin overflow y con ubicación registrada', async () => {
    const db = openDb(TEST_DB);
    setup(db);
    const app = buildApp(db);
    const ubicA = await request(app).post('/api/inventario/ubicaciones').send({ zona: 'A', estante: '1' });
    const ubicB = await request(app).post('/api/inventario/ubicaciones').send({ zona: 'B', estante: '2' });
    const idA = ubicA.body.ubicacion.id;
    const idB = ubicB.body.ubicacion.id;

    // FB-2 queda con overflow: registrado en ubicación B también (simulando un escaneo previo ahí).
    db.prepare('INSERT INTO producto_ubicacion (sku, ubicacion_id, principal, confirmado_en, confirmado_por) VALUES (?,?,0,?,?)')
      .run('FB-2', idB, now(), 'joaco');

    const crear = await request(app).post('/api/inventario/sesiones').send({ ubicacion_id: idA });
    const idSesion = crear.body.sesion.id;
    // Escanear FB-1 y FB-2 en esta sesión (ubicación A) — FB-2 queda con overflow (A y B).
    await request(app).post(`/api/inventario/sesiones/${idSesion}/escanear`).send({ codigo: 'FB-1' });
    await request(app).post(`/api/inventario/sesiones/${idSesion}/escanear`).send({ codigo: 'FB-2' });
    // FB-1 no se cuenta, se descarta (cantidad 1 quedaría contado; para este test lo borramos
    // para que caiga en pendientes sin_stock igual que FB-2 y FB-3).
    const items = await request(app).get(`/api/inventario/sesiones/${idSesion}`);
    for (const it of items.body.items) {
      await request(app).delete(`/api/inventario/sesiones/${idSesion}/items/${it.id}`);
    }

    await request(app).post(`/api/inventario/ubicaciones/${idA}/mapear`);

    const cierre = await request(app).post(`/api/inventario/sesiones/${idSesion}/cerrar-sin-stock`).send({ todos: true });
    expect(cierre.status).toBe(200);
    // FB-1: en alcance, ubicación única (A) → se cierra.
    expect(cierre.body.skus).toContain('FB-1');
    // FB-2: overflow (A y B) → excluido, nunca se auto-cierra.
    expect(cierre.body.skus).not.toContain('FB-2');
    expect(cierre.body.excluidos_por_ubicacion).toContain('FB-2');
    // FB-3 nunca se escaneó en esta sesión: en una sesión por ubicación el alcance se
    // construye ÚNICAMENTE a partir de lo que ya está en producto_ubicacion (bootstrap
    // vacío al crear la sesión, ver congelarAlcance), así que FB-3 ni siquiera es
    // candidato — no aparece ni en `skus` ni en `excluidos_por_ubicacion`. La regla de
    // "nunca cerrar un SKU sin ubicación registrada" queda satisfecha por construcción:
    // un SKU solo entra al alcance de una sesión por ubicación vía capturarUbicacion(),
    // que siempre le crea al menos una fila en producto_ubicacion primero.
    expect(cierre.body.skus).not.toContain('FB-3');
    expect(cierre.body.excluidos_por_ubicacion || []).not.toContain('FB-3');
  });
});
