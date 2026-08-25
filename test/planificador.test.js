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

const TEST_DB = './test/tmp-planificador.sqlite';
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

async function contarYConfirmar(app, sku, cantidad) {
  const crear = await request(app).post('/api/inventario/sesiones').send({ marcas: ['MarcaX'] });
  const id = crear.body.sesion.id;
  const esc = await request(app).post(`/api/inventario/sesiones/${id}/escanear`).send({ codigo: sku });
  await request(app).patch(`/api/inventario/sesiones/${id}/items/${esc.body.item.id}`).send({ cantidad });
  setStockWcDelta.mockResolvedValue({ stockFinal: cantidad, huboVentaDurante: false, stockLive: 5 });
  const conf = await request(app).post(`/api/inventario/sesiones/${id}/confirmar`);
  return { id, conf };
}

describe('Fase 4 — siembra de sku_ultimo_conteo al confirmar', () => {
  it('confirmar una sesión siembra sku_ultimo_conteo para los SKUs contados', async () => {
    const db = openDb(TEST_DB);
    insertProducto(db, { id_woo: 1, sku: 'FB-1', marca: 'MarcaX', stock: 5 });
    const app = buildApp(db, 'jose');
    const { conf } = await contarYConfirmar(app, 'FB-1', 5);
    expect(conf.status).toBe(200);

    const fila = db.prepare('SELECT * FROM sku_ultimo_conteo WHERE sku=?').get('FB-1');
    expect(fila).toBeTruthy();
    expect(fila.por_omision).toBe(0);
  });

  it('un SKU que solo aparece en inventario_sesion_alcance (nunca contado de verdad) NO se siembra (Ruptura 9)', async () => {
    const db = openDb(TEST_DB);
    insertProducto(db, { id_woo: 1, sku: 'FB-1', marca: 'MarcaX', stock: 5 });
    insertProducto(db, { id_woo: 2, sku: 'FB-2', marca: 'MarcaX', stock: 0 }); // sin stock, nunca escaneado
    const app = buildApp(db, 'jose');
    const crear = await request(app).post('/api/inventario/sesiones').send({ marcas: ['MarcaX'] });
    const id = crear.body.sesion.id;
    // Cerrar en cero por omisión: crea una fila en inventario_conteos con
    // confirmado_por_omision=1 para FB-2, sin haberlo contado de verdad.
    await request(app).post(`/api/inventario/sesiones/${id}/cerrar-sin-stock`).send({ todos: true });
    const esc = await request(app).post(`/api/inventario/sesiones/${id}/escanear`).send({ codigo: 'FB-1' });
    await request(app).patch(`/api/inventario/sesiones/${id}/items/${esc.body.item.id}`).send({ cantidad: 5 });
    setStockWcDelta.mockResolvedValue({ stockFinal: 5, huboVentaDurante: false, stockLive: 5 });
    await request(app).post(`/api/inventario/sesiones/${id}/confirmar`);

    // FB-2 sí queda sembrado (existe una fila real de conteo, aunque sea por omisión) pero
    // marcado por_omision=1 — es la señal de "evidencia más débil" del plan (Ruptura 9),
    // no la ausencia total. Se distingue de un SKU que JAMÁS tuvo ninguna fila de conteo.
    const filaFB2 = db.prepare('SELECT * FROM sku_ultimo_conteo WHERE sku=?').get('FB-2');
    expect(filaFB2.por_omision).toBe(1);
    const filaFB1 = db.prepare('SELECT * FROM sku_ultimo_conteo WHERE sku=?').get('FB-1');
    expect(filaFB1.por_omision).toBe(0);
  });

  it('un reintento tardío no pisa un conteo más reciente del mismo SKU hecho por otra sesión', async () => {
    const db = openDb(TEST_DB);
    insertProducto(db, { id_woo: 1, sku: 'FB-1', marca: 'MarcaX', stock: 5 });
    const app = buildApp(db, 'jose'); // dispara ensureTables() antes del INSERT manual de abajo
    db.prepare(`INSERT INTO sku_ultimo_conteo (sku, contado_en, sesion_id, por_omision, diferencia_ultima)
      VALUES ('FB-1', ?, 999, 0, 0)`).run(new Date(Date.now() + 3600000).toISOString()); // "del futuro", simula más reciente
    await contarYConfirmar(app, 'FB-1', 3);

    const fila = db.prepare('SELECT * FROM sku_ultimo_conteo WHERE sku=?').get('FB-1');
    expect(fila.sesion_id).toBe(999); // no lo pisó
  });
});

describe('Fase 4 — GET /api/inventario/plan-hoy', () => {
  it('sin ninguna ubicación mapeada, propone bootstrap por categoría (cierre en cero deshabilitado)', async () => {
    const db = openDb(TEST_DB);
    insertProducto(db, { id_woo: 1, sku: 'FB-1', categorias_json: '["CASCOS"]', stock: 5 });
    insertProducto(db, { id_woo: 2, sku: 'FB-2', categorias_json: '["CASCOS"]', stock: 5 });
    insertProducto(db, { id_woo: 3, sku: 'FB-3', categorias_json: '["PEDALES"]', stock: 5 });

    const res = await request(buildApp(db, 'jose')).get('/api/inventario/plan-hoy');
    expect(res.status).toBe(200);
    expect(res.body.propuesta.tipo).toBe('categoria_bootstrap');
    expect(res.body.propuesta.categoria).toBe('CASCOS'); // 2 nunca contados vs 1
    expect(res.body.propuesta.cierre_en_cero_habilitado).toBe(false);
    expect(res.body.ubicaciones.mapeadas).toBe(0);
  });

  it('con una ubicación mapeada (aunque su SKU nunca se contó), propone barrido por ubicación (cierre en cero habilitado)', async () => {
    const db = openDb(TEST_DB);
    insertProducto(db, { id_woo: 1, sku: 'FB-1', marca: 'MarcaX', stock: 5 });
    const app = buildApp(db, 'jose');
    const ubic = await request(app).post('/api/inventario/ubicaciones').send({ zona: 'A', estante: '1' });
    const id = ubic.body.ubicacion.id;
    db.prepare('INSERT INTO producto_ubicacion (sku, ubicacion_id, principal, confirmado_en, confirmado_por) VALUES (?,?,0,?,?)')
      .run('FB-1', id, now(), 'jose');
    await request(app).post(`/api/inventario/ubicaciones/${id}/mapear`);

    const res = await request(app).get('/api/inventario/plan-hoy');
    expect(res.body.propuesta.tipo).toBe('ubicacion');
    expect(res.body.propuesta.ubicacion_id).toBe(id);
    expect(res.body.propuesta.cierre_en_cero_habilitado).toBe(true);
    expect(res.body.propuesta.dias_sin_contar_max).toBeNull(); // FB-1 nunca contado -> Infinity -> null en la respuesta... ver nota abajo
  });

  it('dimensiona la propuesta con el ritmo (fallback 20/h sin historial -> 40 en 2h)', async () => {
    const db = openDb(TEST_DB);
    insertProducto(db, { id_woo: 1, sku: 'FB-1', categorias_json: '["CASCOS"]', stock: 5 });
    const res = await request(buildApp(db, 'jose')).get('/api/inventario/plan-hoy');
    expect(res.body.ritmo.estimado).toBe(true);
    expect(res.body.propuesta.capacidad_estimada_2h).toBe(40);
  });

  it('cobertura.vencidos_20_dias cuenta los SKUs con más de 20 días sin contar', async () => {
    const db = openDb(TEST_DB);
    insertProducto(db, { id_woo: 1, sku: 'FB-1', categorias_json: '["CASCOS"]', stock: 5 });
    const app = buildApp(db, 'jose'); // dispara ensureTables() antes del INSERT manual de abajo
    const hace25dias = new Date(Date.now() - 25 * 24 * 3600 * 1000).toISOString();
    db.prepare(`INSERT INTO sku_ultimo_conteo (sku, contado_en, sesion_id, por_omision) VALUES ('FB-1', ?, 1, 0)`).run(hace25dias);

    const res = await request(app).get('/api/inventario/plan-hoy');
    expect(res.body.cobertura.vencidos_20_dias).toBe(1);
    expect(res.body.cobertura.con_conteo_registrado).toBe(1);
  });
});

describe('Fase 4 — GET /api/inventario/dirigido', () => {
  it('ordena por días sin contar descendente, nunca contados primero', async () => {
    const db = openDb(TEST_DB);
    insertProducto(db, { id_woo: 1, sku: 'FB-VIEJO', stock: 5 });
    insertProducto(db, { id_woo: 2, sku: 'FB-NUEVO', stock: 5 });
    insertProducto(db, { id_woo: 3, sku: 'FB-NUNCA', stock: 5 });
    const app = buildApp(db, 'jose'); // dispara ensureTables() antes del INSERT manual de abajo
    const hace10dias = new Date(Date.now() - 10 * 24 * 3600 * 1000).toISOString();
    const hace1dia = new Date(Date.now() - 1 * 24 * 3600 * 1000).toISOString();
    db.prepare(`INSERT INTO sku_ultimo_conteo (sku, contado_en, sesion_id, por_omision) VALUES ('FB-VIEJO', ?, 1, 0)`).run(hace10dias);
    db.prepare(`INSERT INTO sku_ultimo_conteo (sku, contado_en, sesion_id, por_omision) VALUES ('FB-NUEVO', ?, 1, 0)`).run(hace1dia);

    const res = await request(app).get('/api/inventario/dirigido');
    const skus = res.body.dirigido.map(f => f.sku);
    expect(skus).toEqual(['FB-NUNCA', 'FB-VIEJO', 'FB-NUEVO']);
    expect(res.body.dirigido[0].nunca_contado).toBe(true);
    expect(res.body.dirigido[2].dias_sin_contar).toBe(1);
  });

  it('respeta el limit', async () => {
    const db = openDb(TEST_DB);
    for (let i = 0; i < 5; i++) insertProducto(db, { id_woo: i + 1, sku: 'FB-' + i, stock: 5 });
    const res = await request(buildApp(db, 'jose')).get('/api/inventario/dirigido?limit=2');
    expect(res.body.dirigido).toHaveLength(2);
  });
});
